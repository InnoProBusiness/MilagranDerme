import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getDb, closeDb } from '@/lib/db'
import {
  baixarEstoque,
  estornarEstoque,
  ajustarEstoque,
  saldoDoEstoque,
  saldosPorKit,
  EstoqueInsuficienteError,
  type CanalVenda,
} from '@/repositories/estoque'

/**
 * O ARQUIVO DE TESTE MAIS IMPORTANTE DO PLANO 4: e o que prova que o mesmo kit
 * nao e vendido duas vezes no dia 25/08.
 *
 * ESTE ARQUIVO NAO APAGA NADA — nem entre testes, nem ao final, pelo mesmo
 * motivo ja registrado em conciliacao.test.ts.
 *
 * Os arquivos de repositorio mais antigos limpam as proprias linhas por slug.
 * Aqui isso e impossivel, e por construcao: estoque_movimentos tem o trigger
 * append-only (estoque_movimento_append_only_trg), que recusa DELETE linha a
 * linha DE PROPOSITO; estoque_movimentos.pedido_id referencia pedidos com ON
 * DELETE RESTRICT, entao nem os pedidos saem; estoques e referenciada pelos
 * movimentos com ON DELETE RESTRICT, e kits e referenciada por estoques do
 * mesmo jeito. A cadeia inteira e imovel de baixo para cima.
 *
 * Desligar o trigger para limpar seria pior em dois sentidos: `ALTER TABLE ...
 * DISABLE TRIGGER` toma lock ACCESS EXCLUSIVE e travaria os outros arquivos que
 * o Vitest roda em paralelo contra o mesmo Postgres, e um teste que precisa
 * desarmar a protecao para funcionar deixa de provar que a protecao existe. O
 * unico lugar do projeto autorizado a desliga-lo e o Down de
 * migrations/1755300700000_seed_estoque.sql, que diz por escrito por que.
 *
 * A alternativa e ISOLAMENTO POR IDENTIDADE, uma camada acima do isolamento
 * por namespace dos outros arquivos: todo identificador nasce sob o prefixo
 * `estoque-`/`MG-ESTOQUE-` deste arquivo (nenhum outro arquivo de teste usa
 * esses prefixos) E com um sufixo aleatorio novo a cada teste. Nenhuma asserção
 * olha para linha que este arquivo nao tenha acabado de criar, entao nem
 * execucao anterior nem arquivo vizinho rodando em paralelo interferem. O banco
 * local acumula linhas; o de CI nasce vazio a cada rodada.
 */
const PRECO_KIT_CENTAVOS = 100000
const NOME_KIT = 'Kit Estoque'
/**
 * Os 50 kits do evento (§2/§4), o mesmo numero que
 * migrations/1755300700000_seed_estoque.sql semeia em producao. Os testes de
 * teto contam a partir desta constante, nunca de um literal solto: e ela que
 * amarra "a 51a unidade e recusada" ao numero que existe de verdade na caixa.
 */
const ENTRADA_PRESENCIAL = 50

let idKit: string
let idVendedor: string
let idCliente: string
let idEndereco: string

/**
 * Reproduz, para um kit descartavel, exatamente o desenho do seed de producao:
 * duas linhas de estoque para o mesmo kit, com politicas OPOSTAS, e a carga
 * inicial do presencial como MOVIMENTO (nunca como coluna de saldo — nao existe
 * coluna de saldo).
 *
 * O canal online nasce sem entrada nenhuma, igual ao seed: `ilimitado = true`
 * faz o saldo deixar de ser teto, entao uma entrada la seria um numero sem
 * significado.
 *
 * O vendedor e o endereco existem so para satisfazer as duas constraints que o
 * canal exige de cada pedido — pedido_presencial_tem_vendedor
 * (migrations/1755300300000_usuarios_sessoes.sql) e pedido_online_tem_endereco
 * (migrations/1755300100000_pedidos_canal_logistica.sql).
 */
async function semear() {
  const db = getDb()
  const sufixo = randomUUID().slice(0, 8)

  const kit = await db.insertInto('kits').values({
    slug: `estoque-kit-${sufixo}`, nome: NOME_KIT, sku: `MG-ESTOQUE-${sufixo}`,
    preco_centavos: PRECO_KIT_CENTAVOS, unidades: 1, ordem: 99, ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idKit = kit.id

  const vendedor = await db.insertInto('usuarios').values({
    nome: 'Vendedora do Balcao', email: `estoque-vendedor-${sufixo}@exemplo.com`,
    // SEGURANCA: nao e senha de ninguem e nao autentica nada — o banco nao
    // valida o formato de senha_hash (quem produz e confere e src/lib/senha.ts).
    // Esta linha existe unicamente para que o pedido presencial tenha vendedor.
    senha_hash: 'scrypt$16384$8$1$naoexiste$naoexiste', papel: 'vendedor', ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idVendedor = vendedor.id

  const cliente = await db.insertInto('clientes').values({
    nome: 'Cliente Estoque', email: `estoque-cliente-${sufixo}@exemplo.com`,
    cpf: '11122233344', whatsapp: '11900000001',
  }).returning('id').executeTakeFirstOrThrow()
  idCliente = cliente.id

  const endereco = await db.insertInto('enderecos').values({
    cliente_id: idCliente, cep: '01310100', rua: 'Avenida Paulista',
    numero: '1000', bairro: 'Bela Vista', cidade: 'Sao Paulo', estado: 'SP',
  }).returning('id').executeTakeFirstOrThrow()
  idEndereco = endereco.id

  const presencial = await db.insertInto('estoques')
    .values({ kit_id: idKit, canal: 'presencial', ilimitado: false })
    .returning('id').executeTakeFirstOrThrow()

  await db.insertInto('estoques')
    .values({ kit_id: idKit, canal: 'online', ilimitado: true })
    .execute()

  await db.insertInto('estoque_movimentos').values({
    estoque_id: presencial.id, tipo: 'entrada', quantidade: ENTRADA_PRESENCIAL,
    motivo: 'Estoque de lancamento presencial 25/08/2026',
  }).execute()
}

/**
 * Pedido cru, e nao `criarPedido`.
 *
 * Este arquivo testa ESTOQUE; o pedido aqui e so o alvo da chave estrangeira
 * que amarra a baixa a venda. Ir por `criarPedido` (src/repositories/pedidos.ts)
 * prenderia este arquivo a extensao de `EntradaPedido` que o Plano 4 faz naquele
 * repositorio — enquanto os dois arquivos estao sendo escritos em paralelo, uma
 * ponta ou a outra ficaria vermelha por motivo nenhum ligado a estoque.
 *
 * O preco de nao usar `criarPedido` e ter que satisfazer a mao o que o banco
 * exige de um pedido, e isso esta explicito abaixo em vez de escondido:
 * pedido_itens_obrigatorios_trg e pedido_subtotal_confere_trg (CONSTRAINT
 * TRIGGERs deferidos de migrations/1755000000000_pedido_itens.sql) so rodam no
 * COMMIT, entao o item entra na MESMA transacao; pedido_total_confere amarra
 * total = subtotal - desconto + frete; pedido_origem_coerente exige
 * representante_id NULL para origem 'casa'.
 */
async function novoPedido(canal: CanalVenda): Promise<string> {
  return getDb().transaction().execute(async (trx) => {
    const pedido = await trx.insertInto('pedidos').values({
      origem: 'casa',
      canal,
      // Cada canal tem a sua exigencia, e ela e do BANCO, nao da rota.
      vendedor_id: canal === 'presencial' ? idVendedor : null,
      endereco_id: canal === 'online' ? idEndereco : null,
      cliente_id: idCliente,
      subtotal_centavos: PRECO_KIT_CENTAVOS,
      desconto_centavos: 0,
      frete_centavos: 0,
      total_centavos: PRECO_KIT_CENTAVOS,
    }).returning('id').executeTakeFirstOrThrow()

    await trx.insertInto('pedido_itens').values({
      pedido_id: pedido.id, kit_id: idKit, nome_snapshot: NOME_KIT,
      preco_unitario_centavos: PRECO_KIT_CENTAVOS, quantidade: 1,
      total_centavos: PRECO_KIT_CENTAVOS,
    }).execute()

    return pedido.id
  })
}

async function idDoEstoque(canal: CanalVenda): Promise<string> {
  const linha = await getDb().selectFrom('estoques').select('id')
    .where('kit_id', '=', idKit)
    .where('canal', '=', canal)
    .executeTakeFirstOrThrow()
  return linha.id
}

/**
 * Leva o presencial de ENTRADA_PRESENCIAL a exatamente `unidades`, com um
 * movimento 'ajuste' cru.
 *
 * A quantidade sai da CONSTANTE, e nao de uma leitura de saldo: se o teste
 * perguntasse ao proprio `saldoDoEstoque` quanto falta, um defeito naquela
 * funcao produziria um estoque semeado errado e o teste de concorrencia
 * passaria a nao provar nada — ficaria verde sobre um estoque que nunca chegou
 * a ter uma unidade so.
 */
async function deixarPresencialCom(unidades: number) {
  await getDb().insertInto('estoque_movimentos').values({
    estoque_id: await idDoEstoque('presencial'),
    tipo: 'ajuste',
    quantidade: unidades - ENTRADA_PRESENCIAL,
    motivo: 'Fixture de teste: reduzir o presencial',
  }).execute()
}

function baixar(canal: CanalVenda, pedidoId: string, quantidade: number, motivo?: string) {
  return getDb().transaction().execute((trx) =>
    baixarEstoque({ kitId: idKit, canal, pedidoId, quantidade, motivo }, trx))
}

function estornar(pedidoId: string) {
  return getDb().transaction().execute((trx) => estornarEstoque(pedidoId, trx))
}

async function contarMovimentos(pedidoId: string, tipo: 'baixa' | 'estorno'): Promise<number> {
  const linhas = await getDb().selectFrom('estoque_movimentos').select('id')
    .where('pedido_id', '=', pedidoId)
    .where('tipo', '=', tipo)
    .execute()
  return linhas.length
}

describe('estoque: saldo derivado dos movimentos', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('baixa reduz o disponivel e aparece como vendido', async () => {
    const pedido = await novoPedido('presencial')

    expect(await baixar('presencial', pedido, 2, 'Pedido do balcao')).toBe(true)

    const saldo = await saldoDoEstoque(idKit, 'presencial')
    expect(saldo).not.toBeNull()
    // total e SUM das entradas e nao se mexe com venda: e o "de 50" do
    // contador da vitrine (§5/§11).
    expect(saldo!.total).toBe(ENTRADA_PRESENCIAL)
    expect(saldo!.vendido).toBe(2)
    expect(saldo!.disponivel).toBe(ENTRADA_PRESENCIAL - 2)
    expect(saldo!.ilimitado).toBe(false)
  })

  it('saldo de kit sem estoque configurado e null, nao zero', async () => {
    const semEstoque = await getDb().insertInto('kits').values({
      slug: `estoque-kit-sem-${randomUUID().slice(0, 8)}`, nome: 'Kit Sem Estoque',
      sku: `MG-ESTOQUE-SEM-${randomUUID().slice(0, 8)}`, preco_centavos: 1000,
      unidades: 1, ordem: 99, ativo: true,
    }).returning('id').executeTakeFirstOrThrow()

    // null e "este kit nao entra neste balcao", que e diferente de "acabou".
    // Quem le precisa distinguir os dois para nao anunciar esgotado o que nunca
    // foi oferecido.
    expect(await saldoDoEstoque(semEstoque.id, 'presencial')).toBeNull()
  })

  it('saldosPorKit traz um registro por canal do kit', async () => {
    // saldosPorKit e leitura de painel: devolve TODO estoque da tabela, entao o
    // teste filtra pelo kit deste arquivo — os outros arquivos rodam em
    // paralelo contra o mesmo Postgres e a lista global nao e estavel.
    const doKit = (await saldosPorKit()).filter((s) => s.kitId === idKit)

    expect(doKit.map((s) => s.canal).sort()).toEqual(['online', 'presencial'])
    expect(doKit.find((s) => s.canal === 'presencial')!.ilimitado).toBe(false)
    expect(doKit.find((s) => s.canal === 'online')!.ilimitado).toBe(true)
    // O online nasce sem entrada nenhuma, igual ao seed de producao: aparece
    // com zeros em vez de sumir da lista (LEFT JOIN em consultaDeSaldo).
    expect(doKit.find((s) => s.canal === 'online')!.total).toBe(0)
  })
})

describe('estoque: idempotencia do webhook', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  // O CASO QUE O MERCADO PAGO PRODUZ EM PRODUCAO TODO DIA: a notificacao e
  // reenviada ate receber 2xx, e reenviada de novo a cada mudanca de status.
  // Sem esta checagem, cada reentrega de um "approved" tiraria mais uma unidade
  // da caixa: 50 kits fisicos virariam 40 no painel e o evento fecharia as
  // vendas com kit sobrando.
  it('DINHEIRO: reenvio do webhook devolve false e nao baixa a mesma unidade duas vezes', async () => {
    const pedido = await novoPedido('presencial')

    expect(await baixar('presencial', pedido, 1)).toBe(true)
    expect(await baixar('presencial', pedido, 1)).toBe(false)

    const saldo = await saldoDoEstoque(idKit, 'presencial')
    expect(saldo!.disponivel).toBe(ENTRADA_PRESENCIAL - 1)
    expect(saldo!.vendido).toBe(1)
    // A prova de que o `false` nao foi um lancamento compensatorio silencioso:
    // existe UMA linha de baixa, nao duas que se anulam.
    expect(await contarMovimentos(pedido, 'baixa')).toBe(1)
  })

  it('baixa em kit sem estoque naquele canal devolve false, sem lancar', async () => {
    // Decisao deliberada, documentada em src/repositories/estoque.ts: quem
    // chama e a conciliacao de um pagamento que JA aconteceu. Uma excecao aqui
    // desfaria o COMMIT que marca o pedido como pago e o comprador ficaria com
    // o dinheiro debitado e o pedido pendente por causa de um kit que ninguem
    // cadastrou no evento.
    const outroKit = await getDb().insertInto('kits').values({
      slug: `estoque-kit-orfao-${randomUUID().slice(0, 8)}`, nome: 'Kit Orfao',
      sku: `MG-ESTOQUE-ORFAO-${randomUUID().slice(0, 8)}`, preco_centavos: 1000,
      unidades: 1, ordem: 99, ativo: true,
    }).returning('id').executeTakeFirstOrThrow()

    const pedido = await novoPedido('presencial')
    const baixou = await getDb().transaction().execute((trx) =>
      baixarEstoque(
        { kitId: outroKit.id, canal: 'presencial', pedidoId: pedido, quantidade: 1 },
        trx,
      ))

    expect(baixou).toBe(false)
  })
})

describe('estoque: teto rigido do presencial e pre-venda online', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('DINHEIRO: o presencial recusa a 51a unidade com EstoqueInsuficienteError', async () => {
    const pedidoDosCinquenta = await novoPedido('presencial')
    expect(await baixar('presencial', pedidoDosCinquenta, ENTRADA_PRESENCIAL)).toBe(true)

    const pedidoDaFila = await novoPedido('presencial')
    const erro = await baixar('presencial', pedidoDaFila, 1).catch((e: unknown) => e)

    // CLASSE, nunca texto: e o que a rota de venda presencial usa para
    // distinguir "acabaram os kits" (409 com mensagem propria na tela do
    // vendedor, §10) de uma falha de infraestrutura.
    expect(erro).toBeInstanceOf(EstoqueInsuficienteError)
    const insuficiente = erro as EstoqueInsuficienteError
    expect(insuficiente.canal).toBe('presencial')
    expect(insuficiente.disponivel).toBe(0)
    expect(insuficiente.solicitado).toBe(1)

    // O saldo fica em ZERO, nunca em -1: a transacao recusada nao deixa rastro.
    const saldo = await saldoDoEstoque(idKit, 'presencial')
    expect(saldo!.disponivel).toBe(0)
    expect(saldo!.vendido).toBe(ENTRADA_PRESENCIAL)
    expect(await contarMovimentos(pedidoDaFila, 'baixa')).toBe(0)
  })

  it('DINHEIRO: recusa a compra que passaria do saldo, e nao so a que comeca esgotada', async () => {
    // Sobram 2, o comprador quer 3. O teto e sobre o RESULTADO da baixa, nao
    // sobre o estoque estar zerado antes dela — um `disponivel > 0` como
    // condicao deixaria vender 3 de 2.
    await deixarPresencialCom(2)
    const pedido = await novoPedido('presencial')

    const erro = await baixar('presencial', pedido, 3).catch((e: unknown) => e)

    expect(erro).toBeInstanceOf(EstoqueInsuficienteError)
    expect((erro as EstoqueInsuficienteError).disponivel).toBe(2)
    expect((await saldoDoEstoque(idKit, 'presencial'))!.disponivel).toBe(2)
  })

  it('canal ilimitado nao recusa: registra o movimento e segue', async () => {
    // Decisao do cliente em 16/08: o online e pre-venda, sem teto. O canal nao
    // recebe entrada nenhuma, entao a baixa leva o saldo a negativo — e isso e
    // o comportamento correto, nao um defeito. `ilimitado` desliga a RECUSA,
    // nunca a contabilidade: o painel de §17 continua sabendo quanto saiu.
    const pedido = await novoPedido('online')

    expect(await baixar('online', pedido, 3)).toBe(true)

    const saldo = await saldoDoEstoque(idKit, 'online')
    expect(saldo!.ilimitado).toBe(true)
    expect(saldo!.total).toBe(0)
    expect(saldo!.vendido).toBe(3)
    expect(saldo!.disponivel).toBe(-3)
  })

  it('DINHEIRO: baixa no canal online NAO consome o estoque presencial (§4)', async () => {
    // Os dois estoques sao SEPARADOS. Se uma venda online tirasse da caixa do
    // evento, o vendedor do balcao ficaria sem kit para entregar a quem esta na
    // frente dele — e a pre-venda online, que nao tem teto, esvaziaria os 50
    // sozinha.
    const pedidoOnline = await novoPedido('online')
    expect(await baixar('online', pedidoOnline, 5)).toBe(true)

    const presencial = await saldoDoEstoque(idKit, 'presencial')
    expect(presencial!.disponivel).toBe(ENTRADA_PRESENCIAL)
    expect(presencial!.vendido).toBe(0)

    const online = await saldoDoEstoque(idKit, 'online')
    expect(online!.vendido).toBe(5)

    // E o caminho inverso tambem: o balcao nao mexe no numero do online.
    const pedidoBalcao = await novoPedido('presencial')
    expect(await baixar('presencial', pedidoBalcao, 1)).toBe(true)
    expect((await saldoDoEstoque(idKit, 'online'))!.vendido).toBe(5)
  })
})

describe('estoque: estorno', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('estorno devolve a unidade ao estoque', async () => {
    const pedido = await novoPedido('presencial')
    await baixar('presencial', pedido, 2, 'Pedido do balcao')

    expect(await estornar(pedido)).toBe(true)

    const saldo = await saldoDoEstoque(idKit, 'presencial')
    expect(saldo!.disponivel).toBe(ENTRADA_PRESENCIAL)
    // A baixa NAO some do extrato — o estorno soma por cima. "vendido" continua
    // 2 porque a venda existiu de verdade e depois caiu; e essa a leitura que o
    // painel precisa dar a operacao no fim do dia.
    expect(saldo!.vendido).toBe(2)
    expect(saldo!.total).toBe(ENTRADA_PRESENCIAL)
  })

  it('estorno de pedido sem baixa devolve false', async () => {
    // Caso normal, nao erro: pedido cancelado antes de ser pago nunca tirou
    // unidade nenhuma da caixa.
    const pedido = await novoPedido('presencial')
    expect(await estornar(pedido)).toBe(false)
  })

  it('reembolso reentregue nao devolve a mesma unidade duas vezes', async () => {
    const pedido = await novoPedido('presencial')
    await baixar('presencial', pedido, 1)

    expect(await estornar(pedido)).toBe(true)
    expect(await estornar(pedido)).toBe(false)

    expect((await saldoDoEstoque(idKit, 'presencial'))!.disponivel).toBe(ENTRADA_PRESENCIAL)
    expect(await contarMovimentos(pedido, 'estorno')).toBe(1)
  })
})

describe('estoque: ajuste de inventario', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('ajuste negativo desce o disponivel sem mexer no total nem no vendido', async () => {
    await ajustarEstoque({
      kitId: idKit, canal: 'presencial', quantidade: -3,
      motivo: 'Quebra na conferencia da caixa',
    })

    const saldo = await saldoDoEstoque(idKit, 'presencial')
    expect(saldo!.disponivel).toBe(ENTRADA_PRESENCIAL - 3)
    // Perda nao e venda: ajuste nao entra em `vendido` nem em `total`, senao o
    // relatorio de faturamento por canal (§17) contaria kit quebrado como kit
    // vendido.
    expect(saldo!.vendido).toBe(0)
    expect(saldo!.total).toBe(ENTRADA_PRESENCIAL)
  })

  it('ajuste positivo repoe o estoque', async () => {
    await ajustarEstoque({
      kitId: idKit, canal: 'presencial', quantidade: 5,
      motivo: 'Caixa extra encontrada na expedicao',
    })
    expect((await saldoDoEstoque(idKit, 'presencial'))!.disponivel)
      .toBe(ENTRADA_PRESENCIAL + 5)
  })

  it('ajuste sem motivo escrito e recusado', async () => {
    // O ajuste e o unico movimento sem pedido do outro lado: sem o texto, a
    // linha do extrato nao responde por que o saldo mudou.
    await expect(ajustarEstoque({
      kitId: idKit, canal: 'presencial', quantidade: -1, motivo: '   ',
    })).rejects.toThrow(/motivo/)
  })

  it('ajuste em kit sem estoque naquele canal lanca em vez de sumir', async () => {
    // Ao contrario da baixa, que devolve false: aqui quem chama e uma tela de
    // admin operada por uma pessoa que acabou de digitar um numero. Um ajuste
    // que some em silencio faz ela ir embora achando que corrigiu o estoque.
    const outroKit = await getDb().insertInto('kits').values({
      slug: `estoque-kit-ajuste-${randomUUID().slice(0, 8)}`, nome: 'Kit Sem Estoque',
      sku: `MG-ESTOQUE-AJUSTE-${randomUUID().slice(0, 8)}`, preco_centavos: 1000,
      unidades: 1, ordem: 99, ativo: true,
    }).returning('id').executeTakeFirstOrThrow()

    await expect(ajustarEstoque({
      kitId: outroKit.id, canal: 'presencial', quantidade: 1, motivo: 'Contagem',
    })).rejects.toThrow(/estoque/)
  })
})

describe('estoque: garantias do banco', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('livro-razao recusa UPDATE: corrigir e lancar o oposto', async () => {
    const pedido = await novoPedido('presencial')
    await baixar('presencial', pedido, 1)

    await expect(
      getDb().updateTable('estoque_movimentos')
        .set({ quantidade: -999 })
        .where('pedido_id', '=', pedido)
        .execute(),
    ).rejects.toThrow(/estoque_movimento_append_only/)
  })

  it('livro-razao recusa DELETE', async () => {
    const pedido = await novoPedido('presencial')
    await baixar('presencial', pedido, 1)

    await expect(
      getDb().deleteFrom('estoque_movimentos')
        .where('pedido_id', '=', pedido)
        .execute(),
    ).rejects.toThrow(/estoque_movimento_append_only/)
  })

  // A REDE EMBAIXO DA CHECAGEM EM JAVASCRIPT, e nao a substituta dela: um
  // caminho novo que insira movimento sem passar por baixarEstoque continua
  // impedido de baixar duas vezes o mesmo pedido.
  it('banco recusa uma segunda baixa do mesmo pedido no mesmo estoque', async () => {
    const pedido = await novoPedido('presencial')
    await baixar('presencial', pedido, 1)

    await expect(getDb().insertInto('estoque_movimentos').values({
      estoque_id: await idDoEstoque('presencial'), pedido_id: pedido,
      tipo: 'baixa', quantidade: -1,
    }).execute()).rejects.toThrow(/estoque_baixa_unica_por_pedido/)
  })

  it('banco recusa um segundo estorno do mesmo pedido no mesmo estoque', async () => {
    const pedido = await novoPedido('presencial')
    await baixar('presencial', pedido, 1)
    await estornar(pedido)

    await expect(getDb().insertInto('estoque_movimentos').values({
      estoque_id: await idDoEstoque('presencial'), pedido_id: pedido,
      tipo: 'estorno', quantidade: 1,
    }).execute()).rejects.toThrow(/estoque_estorno_unico_por_pedido/)
  })

  it('banco recusa baixa com quantidade positiva', async () => {
    // Um bug de sinal na aplicacao viraria uma "baixa" que AUMENTA o
    // disponivel, e o painel mostraria kits que ja sairam da caixa.
    const pedido = await novoPedido('presencial')

    await expect(getDb().insertInto('estoque_movimentos').values({
      estoque_id: await idDoEstoque('presencial'), pedido_id: pedido,
      tipo: 'baixa', quantidade: 1,
    }).execute()).rejects.toThrow(/movimento_baixa_negativa/)
  })

  it('banco recusa movimento de quantidade zero', async () => {
    // Movimento de zero unidade nao e fato nenhum: so sujaria o extrato e
    // deixaria o painel com linha sem efeito.
    //
    // A regex aceita DOIS nomes de proposito, e isso e afirmacao sobre o
    // schema, nao frouxidao do teste: quantidade = 0 viola ao mesmo tempo
    // movimento_quantidade_nao_zero e a segunda perna de
    // movimento_baixa_negativa (`tipo <> 'baixa' AND quantidade <> 0`), e o
    // Postgres nao promete qual das CHECKs de uma mesma tabela reporta
    // primeiro. Fixar so um dos nomes deixaria o teste refem de uma ordem de
    // avaliacao que nao esta documentada em lugar nenhum.
    await expect(getDb().insertInto('estoque_movimentos').values({
      estoque_id: await idDoEstoque('presencial'), tipo: 'ajuste',
      quantidade: 0, motivo: 'Nada aconteceu',
    }).execute()).rejects.toThrow(/movimento_quantidade_nao_zero|movimento_baixa_negativa/)
  })

  it('banco recusa ajuste amarrado a um pedido', async () => {
    // movimento_pedido_coerente e pre-requisito da idempotencia: em Postgres
    // NULLs sao distintos entre si num indice unico, entao baixa/estorno com
    // pedido NULL desligariam os dois indices parciais em silencio.
    const pedido = await novoPedido('presencial')

    await expect(getDb().insertInto('estoque_movimentos').values({
      estoque_id: await idDoEstoque('presencial'), pedido_id: pedido,
      tipo: 'ajuste', quantidade: -1, motivo: 'Ajuste com pedido',
    }).execute()).rejects.toThrow(/movimento_pedido_coerente/)
  })

  it('banco recusa dois estoques do mesmo kit no mesmo canal', async () => {
    // Duas linhas para (kit, canal) fariam o saldo do evento depender de qual
    // das duas a consulta pegou primeiro.
    await expect(getDb().insertInto('estoques').values({
      kit_id: idKit, canal: 'presencial', ilimitado: false,
    }).execute()).rejects.toThrow(/estoque_kit_canal_unico/)
  })
})

describe('estoque: concorrencia', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  // A PROVA DE QUE O `FOR UPDATE` DE baixarEstoque E CARGA, NAO DECORACAO.
  //
  // Um `Promise.all` com as duas transacoes NAO serve aqui: foi o que o teste
  // equivalente de conciliacao.test.ts fazia antes, e ele continuava verde com
  // o `.forUpdate()` removido — as duas transacoes acabavam serializando por
  // conta do escalonamento do event loop, e o teste nao distinguia nada.
  //
  // Este aqui e deterministico: a transacao A baixa a ultima unidade mas fica
  // presa antes do COMMIT por uma barreira explicita. So entao B comeca. Com o
  // lock, B bloqueia no SELECT ... FOR UPDATE ate A commitar e, quando enfim le
  // o saldo, ve zero e recusa. SEM o lock, B le "1 disponivel" ao mesmo tempo
  // que A, os dois passam, e o mesmo ultimo kit e prometido a duas pessoas na
  // fila do evento — o disponivel termina em -1.
  it('DINHEIRO: duas baixas simultaneas do ultimo kit, so uma passa', async () => {
    await deixarPresencialCom(1)
    const pedidoA = await novoPedido('presencial')
    const pedidoB = await novoPedido('presencial')

    let liberarA!: () => void
    const aPodeCommitar = new Promise<void>((r) => { liberarA = r })
    let sinalizarQueABaixou!: () => void
    const aJaBaixou = new Promise<void>((r) => { sinalizarQueABaixou = r })

    const a = getDb().transaction().execute(async (trx) => {
      const r = await baixarEstoque(
        { kitId: idKit, canal: 'presencial', pedidoId: pedidoA, quantidade: 1 },
        trx,
      )
      sinalizarQueABaixou()
      await aPodeCommitar
      return r
    })

    // A ja gravou a baixa e ainda segura o lock da linha de `estoques`: e
    // exatamente a janela em que a segunda venda simultanea chega no balcao.
    await aJaBaixou
    const b = getDb().transaction().execute((trx) =>
      baixarEstoque(
        { kitId: idKit, canal: 'presencial', pedidoId: pedidoB, quantidade: 1 },
        trx,
      ))
    // O `.catch` e anexado AQUI, no mesmo tick em que a promise nasce: `b` vai
    // rejeitar com EstoqueInsuficienteError e um await tardio faria o Node
    // reportar unhandled rejection e derrubar a suite inteira antes da
    // asserção.
    const fimDeB = b.catch((e: unknown) => e)

    // ESTA PAUSA E O QUE DA SENTIDO AO TESTE, e nao um contorno de flakiness.
    // `b` acima e so uma Promise criada: nada garante que a transacao dela ja
    // tenha chegado a emitir o SELECT ... FOR UPDATE. Sem a pausa, `liberarA()`
    // roda antes disso, A commita, e B leria o saldo ja zerado de qualquer
    // jeito — inclusive sem lock nenhum. Foi exatamente assim que a primeira
    // versao do teste equivalente em conciliacao.test.ts ficou verde com o
    // `.forUpdate()` removido do repositorio.
    //
    // Com a pausa, B chega ao lock enquanto A ainda segura a linha: com o lock
    // B espera ali e so le depois do COMMIT (vendo zero, e recusando); sem o
    // lock B le "1 disponivel" da mesma foto que A leu, insere a segunda baixa
    // e o disponivel termina em -1, derrubando o teste.
    await new Promise((r) => setTimeout(r, 300))

    liberarA()

    expect(await a).toBe(true)
    expect(await fimDeB).toBeInstanceOf(EstoqueInsuficienteError)

    const saldo = await saldoDoEstoque(idKit, 'presencial')
    expect(saldo!.disponivel).toBe(0)
    expect(saldo!.vendido).toBe(1)
    expect(await contarMovimentos(pedidoA, 'baixa')).toBe(1)
    expect(await contarMovimentos(pedidoB, 'baixa')).toBe(0)
  })

  // O MESMO PEDIDO, e nao dois: duas entregas concorrentes do mesmo "approved"
  // do Mercado Pago. Aqui nao ha recusa por saldo — as duas cabem no estoque —
  // e o que impede a segunda unidade de sair e a idempotencia lida DEPOIS do
  // lock. Sem o lock, as duas transacoes leem "ainda nao baixado" ao mesmo
  // tempo, as duas inserem, e uma delas morre em
  // estoque_baixa_unica_por_pedido: a conciliacao inteira daquele pagamento
  // cairia por causa de um reenvio que deveria ser um no-op silencioso.
  it('DINHEIRO: duas entregas simultaneas do mesmo webhook baixam uma unidade so', async () => {
    const pedido = await novoPedido('presencial')

    let liberarA!: () => void
    const aPodeCommitar = new Promise<void>((r) => { liberarA = r })
    let sinalizarQueABaixou!: () => void
    const aJaBaixou = new Promise<void>((r) => { sinalizarQueABaixou = r })

    const a = getDb().transaction().execute(async (trx) => {
      const r = await baixarEstoque(
        { kitId: idKit, canal: 'presencial', pedidoId: pedido, quantidade: 1 },
        trx,
      )
      sinalizarQueABaixou()
      await aPodeCommitar
      return r
    })

    await aJaBaixou
    const b = getDb().transaction().execute((trx) =>
      baixarEstoque(
        { kitId: idKit, canal: 'presencial', pedidoId: pedido, quantidade: 1 },
        trx,
      ))
    const fimDeB = b.catch((e: unknown) => e)

    // Mesma barreira do teste anterior, e pelo mesmo motivo: sem ela B poderia
    // nem ter chegado ao lock quando A commita.
    await new Promise((r) => setTimeout(r, 300))

    liberarA()

    expect(await a).toBe(true)
    // "Nada a fazer", nao erro: a segunda entrega tem que virar no-op, e nao
    // uma violacao de indice que derruba a transacao do chamador.
    expect(await fimDeB).toBe(false)

    expect((await saldoDoEstoque(idKit, 'presencial'))!.disponivel)
      .toBe(ENTRADA_PRESENCIAL - 1)
    expect(await contarMovimentos(pedido, 'baixa')).toBe(1)
  })
})
