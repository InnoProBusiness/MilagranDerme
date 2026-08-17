import { sql, type Kysely, type Transaction } from 'kysely'
import { getDb } from '@/lib/db'
import type { CanalVenda, DB } from '@/lib/db-types'

/**
 * ESTOQUE COMO LIVRO-RAZAO, no molde de src/repositories/comissoes.ts.
 *
 * NAO existe coluna de saldo em lugar nenhum do banco. Disponivel e
 * SUM(quantidade) sobre estoque_movimentos, sempre derivado
 * (migrations/1755300000000_canal_e_estoque.sql). Um contador mantido a mao e
 * a origem classica do estoque que nao fecha: basta um dos caminhos de escrita
 * esquecer de atualiza-lo — e o webhook do Mercado Pago tem varios — e o
 * numero corrompe em silencio, sem ninguem conseguir dizer depois qual dos
 * dois valores esta certo. No dia 25/08 esse numero e o que decide se o
 * proximo comprador da fila leva kit ou nao.
 *
 * Corrigir um lancamento errado e lancar o oposto (`ajustarEstoque`), nunca
 * editar a linha: o trigger estoque_movimento_append_only_trg recusa UPDATE e
 * DELETE em estoque_movimentos, exatamente como o livro-razao de comissao.
 *
 * OS DOIS CANAIS TEM POLITICAS OPOSTAS, e isso e dado, nao codigo:
 *   presencial  ilimitado = false — teto rigido de 50 (§2/§4, seed em
 *               migrations/1755300700000_seed_estoque.sql). O que esta na
 *               caixa do evento e o que existe, e a 51a venda e recusada.
 *   online      ilimitado = true — pre-venda, sem teto. A baixa e registrada
 *               para o painel de §17 e nunca recusada por saldo.
 * `ilimitado` desliga a RECUSA, jamais a contabilidade.
 *
 * OS DOIS ESTOQUES SAO SEPARADOS (§4): vender online nao tira unidade da caixa
 * do evento e vice-versa. Sao duas linhas de `estoques` para o mesmo kit,
 * garantidas distintas por estoque_kit_canal_unico, e todo movimento pertence
 * a UMA delas. Nenhuma funcao deste arquivo soma os dois canais.
 */

// kysely-codegen ja gera a uniao literal a partir do ENUM canal_venda
// (migrations/1755300000000_canal_e_estoque.sql): 'presencial' | 'online'.
// Reexportar em vez de redeclarar e o que impede o tipo daqui e o ENUM do
// banco de divergirem com o tempo, e e o que da exaustividade verificada pelo
// compilador a todo switch por canal nas rotas — mesma decisao ja tomada para
// OrigemAtribuicao e PedidoStatus em src/repositories/pedidos.ts.
export type { CanalVenda }

/**
 * A baixa levaria um estoque de teto rigido abaixo de zero.
 *
 * CLASSE, e nao um prefixo de string: quem trata isto precisa distinguir
 * "acabaram os kits" de uma falha de infraestrutura, e a diferenca entre um
 * 409 legivel na tela do vendedor (§10, POST /api/vendas-presenciais) e um 500
 * nao pode depender de as duas pontas continuarem escrevendo a mesma palavra.
 * Com `instanceof`, o vinculo e verificado pelo compilador. Mesmo padrao de
 * PrecoDivergenteError (src/repositories/pedidos.ts) e CpfDivergenteError
 * (src/repositories/clientes.ts).
 *
 * ATENCAO A QUEM CHAMA A PARTIR DA CONCILIACAO: em
 * src/repositories/conciliacao.ts este erro NAO pode derrubar a conciliacao de
 * um pagamento ja aprovado. O dinheiro entrou; o pedido tem que ficar pago. La
 * ele e registrado no log e a conciliacao segue com `estoqueBaixado: false`,
 * deixando a divergencia visivel no painel para a operacao resolver. Isso e
 * escolha, nao esquecimento — e esta escrita naquele arquivo tambem.
 *
 * Os tres numeros ficam em campos proprios, alem da mensagem, para que o log
 * do servidor tenha o diagnostico completo sem que a rota precise ecoar nada
 * disso ao comprador.
 */
export class EstoqueInsuficienteError extends Error {
  constructor(
    readonly canal: CanalVenda,
    readonly disponivel: number,
    readonly solicitado: number,
  ) {
    super(
      `estoque_insuficiente: canal ${canal} tem ${disponivel} unidade(s) ` +
        `disponivel(is) e a baixa pedia ${solicitado}`,
    )
    this.name = 'EstoqueInsuficienteError'
  }
}

export type SaldoEstoque = {
  estoqueId: string
  kitId: string
  canal: CanalVenda
  /** true = pre-venda sem teto. Ver o cabecalho deste arquivo. */
  ilimitado: boolean
  /**
   * SUM das entradas apenas — quantas unidades ja entraram na caixa. E o
   * "de N" do contador da vitrine (§5/§11: "Ultimos 3 de 50"). Nao muda
   * quando alguem compra.
   */
  total: number
  /** -SUM das baixas, como numero positivo: quantas ja sairam por venda paga. */
  vendido: number
  /**
   * SUM de TODOS os movimentos (entrada + baixa + estorno + ajuste). E o
   * numero que decide se a proxima venda presencial acontece.
   *
   * Pode ficar NEGATIVO em dois casos legitimos: canal ilimitado (online, que
   * nunca recebe entrada — a baixa la e so registro) e um ajuste de inventario
   * maior que o saldo. Quem exibe precisa tratar isso; ver o comentario de
   * `ajustarEstoque`.
   */
  disponivel: number
}

/**
 * A consulta de saldo, compartilhada por `saldoDoEstoque` e `saldosPorKit`.
 *
 * LEFT JOIN de proposito: um estoque recem-criado, ainda sem movimento nenhum,
 * precisa aparecer com zeros em vez de sumir do resultado — e exatamente o
 * estado do canal online, que por decisao do seed nunca recebe entrada.
 *
 * FILTER (WHERE tipo = ...) em vez de tres subconsultas: uma varredura so dos
 * movimentos daquele estoque, pelo indice estoque_movimentos_estoque. Esta e a
 * consulta mais quente do evento — o contador de escassez faz polling de 15s
 * (§11) em cima dela.
 */
function consultaDeSaldo(db: Kysely<DB>) {
  return db
    .selectFrom('estoques')
    .leftJoin('estoque_movimentos', 'estoque_movimentos.estoque_id', 'estoques.id')
    .select([
      'estoques.id as estoque_id',
      'estoques.kit_id as kit_id',
      'estoques.canal as canal',
      'estoques.ilimitado as ilimitado',
      sql<number>`COALESCE(SUM(estoque_movimentos.quantidade) FILTER (WHERE estoque_movimentos.tipo = 'entrada'), 0)`.as('total'),
      // A baixa e gravada negativa (CHECK movimento_baixa_negativa), entao
      // "vendido" e o simetrico dela. Negar aqui, e nao no TypeScript, mantem
      // o sinal como assunto de uma linha so.
      sql<number>`COALESCE(-SUM(estoque_movimentos.quantidade) FILTER (WHERE estoque_movimentos.tipo = 'baixa'), 0)`.as('vendido'),
      sql<number>`COALESCE(SUM(estoque_movimentos.quantidade), 0)`.as('disponivel'),
    ])
    .groupBy(['estoques.id', 'estoques.kit_id', 'estoques.canal', 'estoques.ilimitado'])
}

function paraSaldo(l: {
  estoque_id: string
  kit_id: string
  canal: CanalVenda
  ilimitado: boolean
  total: number
  vendido: number
  disponivel: number
}): SaldoEstoque {
  // Number() explicito pelo mesmo motivo documentado em
  // src/repositories/comissoes.ts (saldoDoRepresentante): SUM() de uma coluna
  // integer nao volta como integer, e o parser global de INT8 de src/lib/db.ts
  // nao cobre todos os tipos que o driver pode entregar aqui. Sem esta
  // conversao, "48" + 1 vira "481" no contador da vitrine.
  return {
    estoqueId: l.estoque_id,
    kitId: l.kit_id,
    canal: l.canal,
    ilimitado: l.ilimitado,
    total: Number(l.total),
    vendido: Number(l.vendido),
    disponivel: Number(l.disponivel),
  }
}

/**
 * Saldo de UM kit em UM canal. Devolve null quando nao existe linha de
 * `estoques` para esse par — kit que nunca foi configurado para aquele balcao.
 * Nao e erro: e a resposta correta para "quantos kits deste tem no evento?"
 * quando o kit nem entra no evento.
 *
 * Aceita transacao opcional para poder ser lida DENTRO da transacao que baixa
 * (a rota de venda presencial confere o saldo e baixa no mesmo bloco, §10).
 * Sem `trx` ela le fora de transacao, e ai o numero e um retrato do instante —
 * bom para vitrine e painel, nunca para decidir uma venda.
 *
 * NAO abre transacao propria quando `trx` vem ausente, ao contrario do idioma
 * `executar` usado nas escritas deste projeto (criarPedido,
 * salvarClienteComEndereco): aquele idioma existe para agrupar ESCRITAS que
 * precisam cair ou passar juntas. Uma unica leitura ja e atomica no Postgres, e
 * envolve-la numa transacao explicita so custaria um round trip de BEGIN/COMMIT
 * na consulta mais frequente do evento.
 */
export async function saldoDoEstoque(
  kitId: string,
  canal: CanalVenda,
  trx?: Transaction<DB>,
): Promise<SaldoEstoque | null> {
  const db: Kysely<DB> = trx ?? getDb()

  const linha = await consultaDeSaldo(db)
    .where('estoques.kit_id', '=', kitId)
    .where('estoques.canal', '=', canal)
    .executeTakeFirst()

  return linha ? paraSaldo(linha) : null
}

/**
 * Todo estoque de todo kit, um registro por canal — a leitura do painel de
 * §17 (/api/admin/estoque).
 *
 * A ordenacao e explicita e dupla pelo mesmo motivo de listarKitsAtivos
 * (src/repositories/produtos.ts): sem ORDER BY, a ordem fica a merce da
 * varredura do Postgres, que nao e garantida, e a tabela do painel trocaria de
 * ordem entre dois refreshes do mesmo minuto. kit_id e uuid e nao tem
 * significado para quem le — quem monta a tela junta com o nome do kit; o que
 * este ORDER BY entrega e estabilidade, e o par (kit_id, canal) e unico por
 * estoque_kit_canal_unico, entao nao ha empate possivel.
 */
export async function saldosPorKit(): Promise<SaldoEstoque[]> {
  const linhas = await consultaDeSaldo(getDb())
    .orderBy('estoques.kit_id')
    .orderBy('estoques.canal')
    .execute()

  return linhas.map(paraSaldo)
}

/** Disponivel = SUM(quantidade) de todos os movimentos daquele estoque. */
async function disponivelDoEstoque(estoqueId: string, trx: Transaction<DB>): Promise<number> {
  const { disponivel } = await trx
    .selectFrom('estoque_movimentos')
    .select(sql<number>`COALESCE(SUM(quantidade), 0)`.as('disponivel'))
    .where('estoque_id', '=', estoqueId)
    .executeTakeFirstOrThrow()

  return Number(disponivel)
}

/**
 * Tira `quantidade` unidades do estoque daquele kit naquele canal, amarrando a
 * saida ao pedido que a causou. E a funcao que impede vender o mesmo kit duas
 * vezes no dia do evento.
 *
 * EXIGE TRANSACAO — nao existe versao sem, pelo mesmo motivo de
 * conciliarPagamento (src/repositories/conciliacao.ts): o `FOR UPDATE` na linha
 * de `estoques` precisa viver ate o COMMIT do CHAMADOR. Se esta funcao abrisse
 * a propria transacao, o lock cairia no fim dela e a janela entre "conferi o
 * saldo" e "gravei o pedido" ficaria destravada — que e exatamente a janela em
 * que duas vendas simultaneas prometem a mesma ultima unidade.
 *
 * ORDEM DE LOCK OBRIGATORIA: `pedidos` ANTES de `estoques`.
 * conciliarPagamento (src/repositories/conciliacao.ts:45-53) trava a linha do
 * pedido com FOR UPDATE como PRIMEIRO statement e so depois chega aqui; esta
 * funcao trava `estoques` DEPOIS, sempre. Se algum caminho novo inverter a
 * ordem — travar estoques e so entao o pedido — duas entregas concorrentes do
 * mesmo webhook do Mercado Pago DEADLOCKAM: cada transacao segurando o que a
 * outra espera, e o Postgres matando uma delas com deadlock detected. Qualquer
 * codigo novo que trave as duas tabelas tem que respeitar esta ordem.
 *
 * IDEMPOTENCIA: devolve `false` quando ja existe baixa deste pedido neste
 * estoque, sem baixar de novo. E o caso normal, nao erro — o Mercado Pago
 * reenvia a mesma notificacao ate receber 2xx, e um "approved" reentregue nao
 * pode tirar uma segunda unidade da caixa. Mesma convencao de "nada a fazer"
 * do `pedidoAposPagamento` devolvendo null (src/lib/pedido-status.ts).
 *
 * A checagem em JavaScript aqui NAO e uma corrida, ao contrario da que
 * creditarComissao (src/repositories/comissoes.ts) deliberadamente nao faz:
 * toda baixa passa antes pelo `FOR UPDATE` da MESMA linha de `estoques`, entao
 * duas transacoes concorrentes do mesmo pedido serializam ali e a segunda so le
 * depois que a primeira commitou. O indice unico parcial
 * estoque_baixa_unica_por_pedido continua sendo a rede embaixo disso — para o
 * caminho que um dia esqueca o lock, ou para um INSERT cru — e nao o
 * substituto da checagem.
 *
 * Devolve `false` tambem quando NAO EXISTE linha de estoque para aquele kit e
 * canal. Poderia lancar, e a decisao de nao lancar e deliberada: quem chama e a
 * conciliacao de um pagamento que JA aconteceu, dentro da transacao que marca o
 * pedido como pago. Uma excecao aqui desfaz aquele COMMIT inteiro e o comprador
 * fica com o dinheiro debitado e o pedido pendente, por causa de um kit que
 * ninguem cadastrou no evento. A divergencia aparece no painel (o kit
 * simplesmente nao tem linha em `saldosPorKit`), que e o lugar certo para ela.
 *
 * Lanca EstoqueInsuficienteError SO quando `ilimitado = false` e a baixa
 * levaria o saldo abaixo de zero. No canal online (`ilimitado = true`) o
 * movimento e registrado e a funcao segue, mesmo com saldo negativo — decisao
 * do cliente em 16/08.
 *
 * ATENCAO PARA QUEM CHAMA: uma violacao de constraint do Postgres carrega a
 * linha inteira na propriedade `detail` do erro, e a linha de movimento traz o
 * pedido_id. So `error.message` (ou `error.constraint`) e seguro para logar ou
 * repassar; nunca o objeto de erro cru nem `detail` — mesma regra registrada em
 * src/repositories/clientes.ts.
 */
export async function baixarEstoque(
  e: {
    kitId: string
    canal: CanalVenda
    pedidoId: string
    quantidade: number
    motivo?: string
  },
  trx: Transaction<DB>,
): Promise<boolean> {
  // O sinal negativo e assunto deste arquivo, nunca do chamador: quem passa
  // -2 aqui esta pedindo uma baixa de duas unidades com o sinal ja trocado, e
  // o INSERT gravaria +2 — uma "baixa" que AUMENTA o disponivel. O CHECK
  // movimento_baixa_negativa pegaria o caso, mas com uma mensagem sobre
  // constraint em vez de sobre a chamada errada.
  if (!Number.isInteger(e.quantidade) || e.quantidade <= 0) {
    throw new Error(
      `Quantidade de baixa precisa ser inteira e positiva, recebido: ${e.quantidade}`,
    )
  }

  // LOCK. Vem antes de qualquer leitura de saldo e depois do lock de `pedidos`
  // — ver ORDEM DE LOCK no doc comment acima. A linha de `estoques` e o ponto
  // de serializacao de TODAS as baixas daquele kit naquele canal: e ela que faz
  // duas vendas simultaneas da ultima unidade virarem uma fila de duas.
  const estoque = await trx
    .selectFrom('estoques')
    .select(['id', 'ilimitado'])
    .where('kit_id', '=', e.kitId)
    .where('canal', '=', e.canal)
    .forUpdate()
    .executeTakeFirst()

  if (!estoque) return false

  const jaBaixado = await trx
    .selectFrom('estoque_movimentos')
    .select('id')
    .where('estoque_id', '=', estoque.id)
    .where('pedido_id', '=', e.pedidoId)
    .where('tipo', '=', 'baixa')
    .executeTakeFirst()

  if (jaBaixado) return false

  if (!estoque.ilimitado) {
    // Lido DEPOIS do lock, de proposito: antes dele o numero seria o mesmo que
    // a outra transacao concorrente esta prestes a invalidar.
    const disponivel = await disponivelDoEstoque(estoque.id, trx)
    if (disponivel - e.quantidade < 0) {
      throw new EstoqueInsuficienteError(e.canal, disponivel, e.quantidade)
    }
  }

  await trx
    .insertInto('estoque_movimentos')
    .values({
      estoque_id: estoque.id,
      pedido_id: e.pedidoId,
      tipo: 'baixa',
      quantidade: -e.quantidade,
      // Texto do painel ("Pedido #1042"), nao chave de nada. O vazio e o
      // DEFAULT da coluna e continua sendo um movimento perfeitamente
      // rastreavel: pedido_id ja diz de qual venda ele saiu.
      motivo: e.motivo ?? '',
    })
    .execute()

  return true
}

/**
 * Devolve a prateleira toda unidade que este pedido tirou — reembolso ou
 * cancelamento. Um pedido pode ter tirado de mais de um estoque (dois kits
 * diferentes na mesma compra), entao percorre todas as baixas dele.
 *
 * Devolve `false` quando nao ha nada a estornar: pedido que nunca chegou a ser
 * pago, ou pedido cujo estorno ja foi lancado antes. E o caso normal de um
 * webhook de reembolso reentregue, nao erro — mesma convencao de `false` de
 * `baixarEstoque`.
 *
 * EXIGE TRANSACAO pelo mesmo motivo da baixa, e trava a MESMA linha de
 * `estoques` antes de decidir. Sem o lock, dois reembolsos concorrentes do
 * mesmo pedido leem "ainda nao estornado" ao mesmo tempo e os dois inserem: um
 * deles morre em estoque_estorno_unico_por_pedido e derruba a transacao de uma
 * conciliacao que deveria ter sido um no-op silencioso.
 *
 * Percorre as baixas ordenadas por estoque_id para que duas transacoes que
 * mexam no mesmo conjunto de estoques peguem os locks na MESMA ordem. Ordem
 * livre entre varios estoques e a receita classica de deadlock entre dois
 * reembolsos simultaneos de pedidos com os mesmos dois kits.
 *
 * O estorno e POSITIVO (CHECK movimento_estorno_positivo) e tem exatamente a
 * magnitude da baixa: nao ha estorno parcial neste plano — quem devolve metade
 * de um pedido lanca um `ajuste`, com motivo escrito.
 */
export async function estornarEstoque(
  pedidoId: string,
  trx: Transaction<DB>,
): Promise<boolean> {
  const baixas = await trx
    .selectFrom('estoque_movimentos')
    .select(['estoque_id', 'quantidade', 'motivo'])
    .where('pedido_id', '=', pedidoId)
    .where('tipo', '=', 'baixa')
    .orderBy('estoque_id')
    .execute()

  if (baixas.length === 0) return false

  let estornou = false

  for (const baixa of baixas) {
    await trx
      .selectFrom('estoques')
      .select('id')
      .where('id', '=', baixa.estoque_id)
      .forUpdate()
      .executeTakeFirstOrThrow()

    const jaEstornado = await trx
      .selectFrom('estoque_movimentos')
      .select('id')
      .where('estoque_id', '=', baixa.estoque_id)
      .where('pedido_id', '=', pedidoId)
      .where('tipo', '=', 'estorno')
      .executeTakeFirst()

    if (jaEstornado) continue

    await trx
      .insertInto('estoque_movimentos')
      .values({
        estoque_id: baixa.estoque_id,
        pedido_id: pedidoId,
        tipo: 'estorno',
        // A baixa esta gravada negativa; negar devolve a unidade.
        quantidade: -baixa.quantidade,
        // Carrega o motivo da baixa, no molde de estornarComissao
        // (src/repositories/comissoes.ts): no extrato do painel as duas linhas
        // ficam legiveis como um par.
        motivo: baixa.motivo === '' ? 'Estorno' : `Estorno — ${baixa.motivo}`,
      })
      .execute()

    estornou = true
  }

  return estornou
}

/**
 * Correcao de inventario feita a mao pelo admin: quebra, perda, contagem que
 * nao bateu, reposicao de ultima hora. Positivo sobe, negativo desce.
 *
 * E o UNICO jeito de mexer no saldo sem uma venda por tras, e existe porque o
 * livro-razao e append-only: nao ha UPDATE possivel numa linha de movimento
 * (trigger estoque_movimento_append_only_trg). Corrigir = lancar o oposto.
 *
 * NAO RECUSA por saldo, nem quando o estoque tem teto rigido — e a unica
 * escrita deste arquivo que pode deixar `disponivel` negativo. Duas razoes.
 * Primeira, o contrato do plano reserva EstoqueInsuficienteError a baixa de uma
 * VENDA, que e onde a recusa protege o comprador de receber promessa sem kit.
 * Segunda, recusar uma correcao porque o numero que ela vem corrigir nao
 * permite e circular: se o saldo do sistema ja esta errado, e justamente o
 * ajuste que conserta. Um disponivel negativo no painel e leitura de que a
 * conferencia fisica e a contabilidade divergiram — e essa informacao vale
 * mais visivel do que escondida atras de uma recusa. Quem exibe precisa tratar
 * o negativo (ver src/lib/escassez.ts, que descreve os niveis a partir do
 * disponivel).
 *
 * SEM transacao propria: o unico write e um INSERT, atomico por si so. O SELECT
 * anterior so resolve o id do estoque; se a linha sumisse entre os dois (nao
 * some — estoque_movimentos referencia `estoques` com ON DELETE RESTRICT), o
 * INSERT falharia por chave estrangeira, nunca gravaria movimento no lugar
 * errado. Nao ha lock porque nao ha decisao tomada a partir do saldo: um ajuste
 * concorrente com uma baixa produz a soma dos dois, que e o resultado correto.
 *
 * Tambem nao aceita `trx`, ao contrario da baixa e do estorno: ajuste e acao de
 * tela administrativa, nunca parte da transacao de um pagamento. Se um dia
 * precisar entrar numa transacao alheia, a assinatura muda em cima do idioma da
 * casa (`executar`), e nao com um segundo caminho paralelo.
 */
export async function ajustarEstoque(e: {
  kitId: string
  canal: CanalVenda
  quantidade: number
  motivo: string
}): Promise<void> {
  // Movimento de zero unidade nao e fato nenhum — so sujaria o extrato. O
  // CHECK movimento_quantidade_nao_zero e a garantia; isto aqui e so a
  // mensagem melhor, antes do round trip.
  if (!Number.isInteger(e.quantidade) || e.quantidade === 0) {
    throw new Error(
      `Quantidade de ajuste precisa ser um inteiro diferente de zero, recebido: ${e.quantidade}`,
    )
  }

  // Motivo obrigatorio de verdade, e nao so no tipo. O ajuste e o unico
  // movimento sem pedido do outro lado: sem o texto, a linha do extrato nao
  // responde por que o saldo mudou, e a conferencia com o estoque fisico no
  // fim do dia perde o unico rastro que tinha. A coluna aceita '' (DEFAULT da
  // migration, usado pelas baixas, que tem pedido_id) — por isso a exigencia
  // mora aqui.
  if (e.motivo.trim() === '') {
    throw new Error('Ajuste de estoque exige motivo escrito: e o unico rastro de por que o saldo mudou')
  }

  const estoque = await getDb()
    .selectFrom('estoques')
    .select('id')
    .where('kit_id', '=', e.kitId)
    .where('canal', '=', e.canal)
    .executeTakeFirst()

  // Aqui LANCA, ao contrario do `false` de baixarEstoque para o mesmo caso: o
  // chamador e uma tela de admin operada por uma pessoa que acabou de digitar
  // um numero, nao a conciliacao de um pagamento ja aprovado. Um ajuste que
  // some em silencio e pior do que um erro na tela — a pessoa iria embora
  // achando que corrigiu o estoque do evento.
  if (!estoque) {
    throw new Error(
      `Nao existe estoque do kit ${e.kitId} no canal ${e.canal}: crie a linha de estoque antes de ajustar`,
    )
  }

  await getDb()
    .insertInto('estoque_movimentos')
    .values({
      estoque_id: estoque.id,
      // Sempre null: ajuste nao nasce de venda nenhuma, e o CHECK
      // movimento_pedido_coerente recusa ajuste com pedido.
      pedido_id: null,
      tipo: 'ajuste',
      quantidade: e.quantidade,
      motivo: e.motivo,
    })
    .execute()
}
