import type { Selectable, Transaction } from 'kysely'
import { sql } from 'kysely'
import { getDb } from '@/lib/db'
import type {
  DB, Pedidos, PedidoItens, CanalVenda, MetodoPagamento, OrigemAtribuicao, PedidoStatus,
} from '@/lib/db-types'
import { deInteiro, type Centavos } from '@/lib/money'
import {
  transicaoPermitida, geraCreditoDeComissao, geraEstornoDeComissao,
} from '@/lib/pedido-status'

// kysely-codegen ja gera unions literais a partir dos ENUMs do Postgres
// (ver migrations/1754900300000_pedidos.sql): origem_atribuicao vira
// 'link' | 'cupom' | 'casa' | 'rep_inativo' e pedido_status vira os nove
// estados — oito da migration original mais 'em_transito', acrescentado por
// migrations/1755300200000_status_em_transito.sql. Reexportar em vez de
// redeclarar evita que o tipo do repositorio e o ENUM do banco divirjam com o
// tempo — e e o que da a maquina de estados do Plano 3 uma checagem de
// exaustividade de verdade no switch.
//
// canal_venda e metodo_pagamento entram na mesma lista porque aparecem na
// SUPERFICIE deste modulo (EntradaPedido.canal, VendaAdmin.metodoPagamento):
// quem importa VendaAdmin precisa dos dois unions para tipar a tela do painel
// sem ir buscar em @/lib/db-types por fora. metodo_pagamento tambem e
// reexportado por src/repositories/pagamentos.ts — e o MESMO tipo vindo do
// mesmo ENUM, entao nao ha duas verdades, so dois caminhos ate uma.
export type { CanalVenda, MetodoPagamento, OrigemAtribuicao, PedidoStatus }

/**
 * O preco que o chamador enviou nao bate com kits.preco_centavos lido dentro
 * da transacao — o preco mudou entre a vitrine e o checkout.
 *
 * CLASSE, e nao um prefixo de string: a rota (src/app/api/pedidos/route.ts)
 * mapeia isto para um 422 com mensagem curada, e nenhum teste percebia se
 * alguem reescrevesse a frase — o `mensagem.startsWith('preco_divergente')`
 * simplesmente deixava de casar e o comprador passava a ver 500. Com
 * `instanceof`, o vinculo e verificado pelo compilador. Mesmo padrao de
 * RecusaDeCupom.
 *
 * Os tres numeros ficam em campos proprios (alem da mensagem) para que o log
 * do servidor tenha o diagnostico completo sem que nada disso precise ser
 * ecoado ao cliente.
 */
export class PrecoDivergenteError extends Error {
  constructor(
    readonly kitId: string,
    readonly precoCatalogoCentavos: number,
    readonly precoEnviadoCentavos: number,
  ) {
    super(
      `preco_divergente: catalogo do kit ${kitId} tem ${precoCatalogoCentavos} ` +
        `centavos, mas o checkout enviou ${precoEnviadoCentavos}`,
    )
    this.name = 'PrecoDivergenteError'
  }
}

export type ItemDoPedido = {
  kitId: string
  quantidade: number
  precoUnitarioCentavos: Centavos
}

export type EntradaPedido = {
  origem: OrigemAtribuicao
  /**
   * ONDE a venda aconteceu: balcao do evento ('presencial') ou loja
   * ('online'). Nao confundir com `origem`, logo acima — os dois eixos sao
   * ORTOGONAIS e a migration explica por que
   * (migrations/1755300100000_pedidos_canal_logistica.sql): `origem` e
   * ATRIBUICAO DE COMISSAO, amarrada a presenca de representante_id pelo
   * CHECK pedido_origem_coerente. Uma venda de balcao pode perfeitamente ter
   * vindo do link de uma representante.
   *
   * OBRIGATORIO de proposito, embora a coluna tenha DEFAULT 'online' no
   * banco. A alternativa era `canal?: CanalVenda` com o mesmo default aqui, e
   * ela foi recusada: canal decide de QUAL estoque a unidade sai (o presencial
   * tem teto rigido de 50 unidades, o online nao tem teto — §4) e separa o
   * relatorio de §17. Quem escreve um caminho de criacao novo tem que declarar
   * o que aquela venda e, e o compilador e quem cobra. O DEFAULT do banco
   * continua existindo como rede para INSERT cru, nao como conveniencia deste
   * repositorio.
   *
   * CONGELADO depois da criacao pelo trigger pedido_atribuicao_imutavel_trg:
   * nenhum caminho pode fazer UPDATE nesta coluna. O valor certo tem que
   * entrar no INSERT.
   */
  canal: CanalVenda
  representanteId: string | null
  percentualComissao: number | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  desconto: Centavos
  frete: Centavos
  itens: ItemDoPedido[]
  /**
   * Opcionais e sempre null quando ausentes: os testes existentes (Tarefas
   * 1 e 5) chamam criarPedido sem cliente, endereco ou cupom nenhum, e
   * continuam validos. A Tarefa 9 (checkout) e quem sempre preenche os
   * tres — sao o elo entre o pedido e quem comprou, e entre o pedido e o
   * cupom_usos gravado na mesma transacao.
   */
  clienteId?: string | null
  enderecoId?: string | null
  cupomId?: string | null
  /**
   * QUEM operou a venda, quando ela passou por uma pessoa: o vendedor logado
   * no balcao (src/app/api/vendas-presenciais/route.ts). Venda online nao tem
   * vendedor — o comprador se atende sozinho — e por isso a coluna e nullable
   * no banco, com o CHECK pedido_presencial_tem_vendedor
   * (migrations/1755300300000_usuarios_sessoes.sql) exigindo o valor apenas
   * quando canal = 'presencial'.
   *
   * De novo: NAO e o representante. Representante e quem trouxe o cliente e
   * leva comissao; vendedor e quem estava atras do balcao. A mesma venda pode
   * ter os dois, e sao pessoas diferentes.
   *
   * CONGELADO pelo mesmo trigger que congela representante_id: passar a venda
   * de um vendedor para outro por UPDATE reescreveria o relatorio de §17
   * depois do fato (numero com premiacao amarrada) e faria o ON DELETE
   * RESTRICT deixar de enxergar a dependencia, liberando a exclusao da conta
   * original.
   */
  vendedorId?: string | null
  /**
   * Prazo de entrega que a cotacao do Clube Envios devolveu no momento da
   * compra (src/lib/frete.ts), em dias. Diferente de canal e vendedorId, esta
   * coluna NAO e congelada: transportadora troca de prazo e a tela de
   * logistica precisa poder corrigir o numero. E ESTIMATIVA, nao promessa.
   *
   * Opcional porque venda presencial nao tem entrega nenhuma (§2: o comprador
   * sai com o kit na mao) e porque os pedidos anteriores a este plano nunca
   * tiveram cotacao. NUNCA passar 0 para dizer "nao sei": o CHECK
   * pedido_prazo_valido recusa, exatamente para que "entrega em 0 dias" nao
   * chegue a aparecer na tela do comprador.
   */
  prazoDiasEstimado?: number | null
}

export type Pedido = {
  id: string
  numero: number
  /**
   * Chave publica da URL de confirmacao (/pedido/<token> — ver
   * migrations/1755100000000_pedido_token.sql). NAO expor `numero` na URL:
   * ele e um bigint sequencial e a pagina e publica sem autenticacao, entao
   * uma chave previsivel deixaria qualquer visitante andar /pedido/1,
   * /pedido/2... e ler a contagem e o faturamento de todos os pedidos.
   */
  token: string
  status: PedidoStatus
  origem: OrigemAtribuicao
  canal: CanalVenda
  representanteId: string | null
  vendedorId: string | null
  percentualComissaoSnapshot: number | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  subtotalCentavos: Centavos
  descontoCentavos: Centavos
  freteCentavos: Centavos
  totalCentavos: Centavos
  criadoEm: Date
  /**
   * LOGISTICA. Estes quatro nascem vazios e sao preenchidos DEPOIS da
   * criacao, conforme a entrega anda — o oposto exato das colunas congeladas
   * acima. Quem escreve neles e registrarRastreio e avancarStatusDoPedido,
   * mais abaixo neste arquivo; nada mais.
   *
   * enviadoEm fica null para sempre na venda presencial: ela vai de 'pago'
   * direto a 'entregue' sem Correios (§2).
   */
  rastreioCodigo: string | null
  rastreioTransportadora: string | null
  enviadoEm: Date | null
  prazoDiasEstimado: number | null
}

function paraPedido(l: Selectable<Pedidos>): Pedido {
  return {
    id: l.id,
    numero: Number(l.numero),
    token: l.token,
    status: l.status,
    origem: l.origem,
    canal: l.canal,
    representanteId: l.representante_id,
    vendedorId: l.vendedor_id,
    percentualComissaoSnapshot:
      l.percentual_comissao_snapshot === null ? null : Number(l.percentual_comissao_snapshot),
    utmSource: l.utm_source,
    utmMedium: l.utm_medium,
    utmCampaign: l.utm_campaign,
    // As colunas de dinheiro ja estao em centavos inteiros no banco:
    // deInteiro apenas atesta o tipo, sem multiplicar por 100. Usar
    // centavos() aqui multiplicaria de novo, silenciosamente, porque as
    // duas funcoes devolvem o mesmo tipo Centavos e o erro nao apareceria
    // na compilacao.
    subtotalCentavos: deInteiro(l.subtotal_centavos),
    descontoCentavos: deInteiro(l.desconto_centavos),
    freteCentavos: deInteiro(l.frete_centavos),
    totalCentavos: deInteiro(l.total_centavos),
    criadoEm: l.criado_em,
    rastreioCodigo: l.rastreio_codigo,
    rastreioTransportadora: l.rastreio_transportadora,
    enviadoEm: l.enviado_em,
    prazoDiasEstimado: l.prazo_dias_estimado,
  }
}

/**
 * Congela a atribuicao da venda no momento da criacao. representante_id,
 * percentual_comissao_snapshot e os UTM nunca sao recalculados depois: se o
 * cadastro do representante mudar amanha, o pedido de hoje continua valendo
 * o que valia hoje. As constraints do banco (pedido_atribuicao_coerente,
 * pedido_origem_coerente, pedido_total_confere, pedido_desconto_nao_excede)
 * sao a linha de defesa real — este repositorio nao reimplementa nenhuma
 * delas em JavaScript.
 *
 * `canal` e `vendedor_id` entraram na MESMA lista de congelados quando o
 * trigger foi reescrito (migrations/1755300100000_pedidos_canal_logistica.sql
 * e migrations/1755300300000_usuarios_sessoes.sql). Consequencia pratica para
 * quem chama: os dois valores tem que estar certos AQUI, no INSERT, porque
 * nao existe UPDATE possivel depois — nenhum caminho do sistema pode
 * "corrigir o canal" de um pedido ja fechado. E o mesmo motivo pelo qual a
 * rota do checkout recota o frete antes de criar o pedido em vez de gravar
 * zero e ajustar depois (src/app/api/pedidos/route.ts).
 *
 * `prazo_dias_estimado` e a excecao declarada: entra na criacao vindo da
 * cotacao, mas continua editavel por /admin/logistica.
 *
 * O subtotal NAO vem da aplicacao: e a soma dos itens, e quem garante isso
 * e o trigger CONSTRAINT DEFERRABLE pedido_subtotal_confere_trg (migrations/
 * 1755000000000_pedido_itens.sql), que roda no COMMIT desta transacao — nao
 * a cada INSERT. A soma calculada aqui em JS e so o valor a gravar em
 * subtotal_centavos; se ela nao bater com a soma real dos itens que o banco
 * ve, o COMMIT falha. A comissao do representante incide sobre esse valor
 * amarrado ao banco, nao sobre uma soma que a aplicacao poderia errar. Um
 * segundo trigger deferido, pedido_itens_obrigatorios_trg, garante que todo
 * pedido tem ao menos um item — o guard de itens.length abaixo e so uma
 * mensagem melhor antes do round trip, nao a garantia de verdade.
 *
 * O preco de cada item TAMBEM nao e confiado ao chamador: precoUnitarioCentavos
 * e validado contra kits.preco_centavos dentro desta mesma transacao antes de
 * gravar o item, e uma divergencia lanca em vez de gravar em silencio — ver o
 * comentario no loop abaixo.
 *
 * Aceita uma transacao externa opcional (`trx`), no mesmo formato de
 * salvarClienteComEndereco (src/repositories/clientes.ts): quando presente,
 * a escrita entra na transacao do chamador em vez de abrir uma propria. O
 * checkout (Tarefa 9) chama esta funcao de dentro da mesma transacao que
 * salva cliente/endereco e resgata o cupom — sem isso, o resgate do cupom e
 * a criacao do pedido ficariam em transacoes diferentes, e um dos dois
 * podia commitar sem o outro.
 */
export async function criarPedido(e: EntradaPedido, trx?: Transaction<DB>): Promise<Pedido> {
  if (e.itens.length === 0) {
    throw new Error('Pedido sem itens nao pode ser criado')
  }

  const subtotal = e.itens.reduce(
    (acc, i) => acc + i.precoUnitarioCentavos * i.quantidade,
    0,
  ) as Centavos
  const total = (subtotal - e.desconto + e.frete) as Centavos

  const executar = async (t: Transaction<DB>) => {
    const linha = await t
      .insertInto('pedidos')
      .values({
        origem: e.origem,
        canal: e.canal,
        representante_id: e.representanteId,
        vendedor_id: e.vendedorId ?? null,
        percentual_comissao_snapshot: e.percentualComissao,
        utm_source: e.utmSource,
        utm_medium: e.utmMedium,
        utm_campaign: e.utmCampaign,
        subtotal_centavos: subtotal,
        desconto_centavos: e.desconto,
        frete_centavos: e.frete,
        total_centavos: total,
        cliente_id: e.clienteId ?? null,
        endereco_id: e.enderecoId ?? null,
        cupom_id: e.cupomId ?? null,
        prazo_dias_estimado: e.prazoDiasEstimado ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    // Nome e preco vem do catalogo AGORA e viram snapshot na linha do item:
    // se o preco do kit mudar amanha, o pedido de hoje continua valendo o
    // que valia hoje — mesmo principio do percentual_comissao_snapshot.
    for (const item of e.itens) {
      const kit = await t
        .selectFrom('kits')
        .select(['nome', 'preco_centavos'])
        .where('id', '=', item.kitId)
        .executeTakeFirstOrThrow()

      // O preco vem do CHAMADOR (o carrinho, que leu a vitrine em algum
      // momento antes do checkout) mas nunca e confiado as cegas: se
      // divergir do catalogo agora, o preco mudou entre a vitrine e o
      // checkout — cobrar um valor diferente do que foi mostrado e um
      // defeito por si so, entao isto lanca em vez de sobrescrever em
      // silencio com o valor do catalogo ou com o valor do chamador.
      if (item.precoUnitarioCentavos !== kit.preco_centavos) {
        throw new PrecoDivergenteError(
          item.kitId, kit.preco_centavos, item.precoUnitarioCentavos,
        )
      }

      await t
        .insertInto('pedido_itens')
        .values({
          pedido_id: linha.id,
          kit_id: item.kitId,
          nome_snapshot: kit.nome,
          preco_unitario_centavos: item.precoUnitarioCentavos,
          quantidade: item.quantidade,
          total_centavos: item.precoUnitarioCentavos * item.quantidade,
        })
        .execute()
    }

    return paraPedido(linha)
  }

  if (trx) return executar(trx)
  return getDb().transaction().execute(executar)
}

export type ItemPedido = {
  id: string
  kitId: string
  nomeSnapshot: string
  precoUnitarioCentavos: Centavos
  quantidade: number
  totalCentavos: Centavos
}

export type PedidoComItens = Pedido & {
  itens: ItemPedido[]
  /**
   * E-mail do comprador, para prefixar o formulario de cartao na etapa de
   * pagamento. SO o e-mail: CPF e whatsapp NAO entram aqui, porque esta
   * pagina e publica (protegida apenas pelo token inadivinhavel) e o CPF vai
   * do banco direto ao gateway dentro de /api/pagamentos, sem passar pelo
   * navegador. null em pedidos antigos, criados antes de o checkout exigir
   * cliente.
   */
  clienteEmail: string | null
}

function paraItemPedido(l: Selectable<PedidoItens>): ItemPedido {
  return {
    id: l.id,
    kitId: l.kit_id,
    nomeSnapshot: l.nome_snapshot,
    precoUnitarioCentavos: deInteiro(l.preco_unitario_centavos),
    quantidade: l.quantidade,
    totalCentavos: deInteiro(l.total_centavos),
  }
}

export type PedidoParaEmail = {
  numero: number
  token: string
  /**
   * O e-mail de confirmacao RAMIFICA por canal (src/lib/email-pedido.ts): a
   * compra de balcao termina com o kit na mao do comprador (§2) e a compra
   * online comeca a esperar a postagem depois do lancamento (§3). Ate
   * 16/08/2026 a copy era uma so e prometia "avisaremos assim que o pedido for
   * enviado" para TODO pedido — mentira para quem acabou de sair do evento com
   * a sacola. Por isso o canal e um campo desta leitura, e nao um parametro
   * novo de enviarConfirmacaoDePedido: os tres chamadores dela (webhook,
   * /api/pagamentos e o balcao) tem o pedidoId em maos e nenhum precisa
   * carregar o canal so para repassa-lo.
   */
  canal: CanalVenda
  totalCentavos: Centavos
  clienteNome: string
  clienteEmail: string
  itens: Array<{ nome: string; quantidade: number; totalCentavos: Centavos }>
}

/**
 * Le o necessario para montar o e-mail de confirmacao de pagamento.
 *
 * Devolve null quando o pedido nao tem cliente vinculado — pedidos criados
 * pelos testes de repositorio e pelos fluxos anteriores ao checkout. Sem
 * e-mail nao ha o que enviar, e isso nao e erro.
 */
export async function buscarPedidoParaEmail(pedidoId: string): Promise<PedidoParaEmail | null> {
  const l = await getDb()
    .selectFrom('pedidos')
    .innerJoin('clientes', 'clientes.id', 'pedidos.cliente_id')
    .select([
      'pedidos.numero as numero', 'pedidos.token as token',
      'pedidos.canal as canal', 'pedidos.total_centavos as total',
      'clientes.nome as nome', 'clientes.email as email',
    ])
    .where('pedidos.id', '=', pedidoId)
    .executeTakeFirst()

  if (!l) return null

  const itens = await getDb()
    .selectFrom('pedido_itens')
    .select(['nome_snapshot', 'quantidade', 'total_centavos'])
    .where('pedido_id', '=', pedidoId)
    .orderBy('criado_em', 'asc')
    .orderBy('id', 'asc')
    .execute()

  return {
    numero: Number(l.numero),
    token: l.token,
    canal: l.canal,
    totalCentavos: deInteiro(l.total),
    clienteNome: l.nome,
    clienteEmail: l.email,
    itens: itens.map((i) => ({
      nome: i.nome_snapshot,
      quantidade: i.quantidade,
      totalCentavos: deInteiro(i.total_centavos),
    })),
  }
}

// Formato de uuid, sem validar a versao/variante especifica — so o
// suficiente para descartar lixo obvio (uma palavra, um numero, uma URL
// meio digitada) ANTES de consultar o banco. Sem isto, um token que nao
// parece uuid vira "invalid input syntax for type uuid" do Postgres — um
// 500 — em vez do 404 que a pagina de confirmacao espera para uma URL
// invalida.
const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Le um pedido pelo token publico (a chave da URL de confirmacao,
 * /pedido/<token> — ver migrations/1755100000000_pedido_token.sql) junto
 * dos seus itens. Usada pela pagina de confirmacao (Tarefa 9) — nunca pelo
 * fluxo de criacao, que ja tem a linha inteira em maos a partir de
 * criarPedido.
 *
 * DELIBERADAMENTE nao busca por `numero`: numero e um bigint sequencial e a
 * pagina e publica sem autenticacao nenhuma. Buscar por ele deixaria
 * qualquer visitante andar /pedido/1, /pedido/2, /pedido/3... e ler a
 * contagem de pedidos e o faturamento inteiro da empresa. token e um uuid
 * v4 (gen_random_uuid() no banco) — nao adivinhavel por enumeracao.
 */
export async function buscarPedidoComItensPorToken(token: string): Promise<PedidoComItens | null> {
  if (!FORMATO_UUID.test(token)) return null

  const linha = await getDb()
    .selectFrom('pedidos')
    // LEFT: pedidos anteriores ao checkout (Tarefas 1 e 5 do Plano 2, e os
    // testes que ainda criam pedido sem cliente) tem cliente_id NULL. Um
    // innerJoin faria esta pagina devolver 404 para eles.
    .leftJoin('clientes', 'clientes.id', 'pedidos.cliente_id')
    .selectAll('pedidos')
    .select('clientes.email as cliente_email')
    .where('pedidos.token', '=', token)
    .executeTakeFirst()
  if (!linha) return null

  const itens = await getDb()
    .selectFrom('pedido_itens')
    .selectAll()
    // criado_em sozinho nao ordena de forma deterministica: e o instante de
    // INICIO da transacao (now() dentro de uma unica transacao devolve o
    // mesmo valor em todo INSERT), entao todo item de UM pedido carrega o
    // MESMO timestamp — dois itens do mesmo pedido podem trocar de ordem
    // entre uma leitura e outra. `id` como desempate torna o resultado
    // estavel, mesmo raciocinio do desempate por slug em listarKitsAtivos
    // (src/repositories/produtos.ts).
    .where('pedido_id', '=', linha.id)
    .orderBy('criado_em', 'asc')
    .orderBy('id', 'asc')
    .execute()

  return {
    ...paraPedido(linha),
    itens: itens.map(paraItemPedido),
    clienteEmail: linha.cliente_email,
  }
}

/**
 * A transicao pedida nao existe na maquina de estados (TRANSICOES em
 * src/lib/pedido-status.ts).
 *
 * CLASSE despachada por instanceof, pelo mesmo motivo de PrecoDivergenteError
 * la em cima: a rota do painel (src/app/api/admin/pedidos/[id]/route.ts) mapeia
 * isto para um 422 com mensagem curada, e um `mensagem.startsWith(...)` faria
 * a reescrita da frase virar 500 silencioso, sem nenhum teste ficar vermelho.
 *
 * Os tres campos existem para o log do servidor. Nada disso precisa chegar ao
 * navegador — o painel ja sabe em que pedido clicou.
 */
export class TransicaoInvalidaError extends Error {
  constructor(
    readonly pedidoId: string,
    readonly de: PedidoStatus,
    readonly para: PedidoStatus,
  ) {
    super(`transicao_invalida: pedido ${pedidoId} nao pode ir de ${de} para ${para}`)
    this.name = 'TransicaoInvalidaError'
  }
}

/**
 * A transicao existe na maquina de estados, mas mexe no LIVRO-RAZAO DE
 * COMISSAO — e este nao e o caminho que escreve nele.
 *
 * ACRESCIMO AO PLANO 4, e nao um capricho. Ate agora conciliarPagamento
 * (src/repositories/conciliacao.ts) era, nas palavras do proprio doc comment
 * dele, "o UNICO caminho do sistema que move pedidos.status"; esta funcao e a
 * segunda escritora daquela coluna, e a diferenca entre as duas e que ela nao
 * toca em `comissoes`. Sem esta recusa, um admin marcando 'reembolsado' na tela
 * causaria DOIS estragos de uma vez: (1) o credito da representante ficaria
 * parado no saldo dela por uma venda que deixou de existir, e (2) — o pior — o
 * webhook de estorno que chegasse depois encontraria o pedido JA em
 * 'reembolsado', pedidoAposPagamento devolveria null por alvo === atual, e o
 * estorno automatico nunca aconteceria. O clique no painel ENGOLIRIA a
 * correcao automatica.
 *
 * O criterio nao e uma lista de status escrita a mao aqui: sao os mesmos
 * predicados geraCreditoDeComissao/geraEstornoDeComissao que a conciliacao usa
 * (src/lib/pedido-status.ts). Enquanto os dois lados perguntarem para a mesma
 * funcao, nao ha como as regras divergirem.
 *
 * O que ISTO NAO PROIBE: cancelar pedido que nunca foi pago
 * ('pendente' -> 'cancelado' nao gera estorno nenhum) e toda a logistica
 * ('pago' -> 'enviado' -> 'em_transito' -> 'entregue', e o pulo direto
 * 'pago' -> 'entregue' da venda presencial de §2). Dinheiro entra e sai pelo
 * provedor; o painel move a caixa, nao o caixa.
 */
export class TransicaoFinanceiraError extends Error {
  constructor(
    readonly pedidoId: string,
    readonly de: PedidoStatus,
    readonly para: PedidoStatus,
  ) {
    super(
      `transicao_financeira: pedido ${pedidoId} nao pode ir de ${de} para ${para} por aqui — ` +
        'esta transicao mexe na comissao e so conciliarPagamento escreve no livro-razao',
    )
    this.name = 'TransicaoFinanceiraError'
  }
}

/**
 * Move pedidos.status pela mao da operacao: o painel de logistica (§17) e o
 * balcao do evento (§10). O caminho automatico, movido pelo pagamento, e
 * conciliarPagamento — ver TransicaoFinanceiraError acima para a divisao exata
 * de trabalho entre os dois.
 *
 * TRAVA A LINHA DO PEDIDO COM `FOR UPDATE` COMO PRIMEIRO STATEMENT, no molde
 * exato de conciliarPagamento (src/repositories/conciliacao.ts). O motivo aqui
 * e o mesmo, com atores diferentes: no dia do evento, duas pessoas com o painel
 * aberto clicando no mesmo pedido leriam ambas 'pago', ambas achariam a
 * transicao valida e ambas escreveriam — e o segundo UPDATE carimbaria de novo
 * um `entregue_em` que ja existia, movendo a data de entrega de um pedido ja
 * entregue. Com o lock, a segunda so le depois do COMMIT da primeira, ve o
 * status ja no alvo e devolve `mudou: false`.
 *
 * ORDEM DE LOCK: se algum caminho precisar travar `estoques` tambem, o lock de
 * `pedidos` vem SEMPRE PRIMEIRO — a mesma regra registrada em
 * src/repositories/estoque.ts. Inverter em um unico caminho basta para produzir
 * deadlock entre o webhook e o painel.
 *
 * O lock precisa viver ate o COMMIT do chamador, entao a transacao e
 * OBRIGATORIA: NAO EXISTE versao sem `trx`, de proposito. Abrir uma transacao
 * propria aqui devolveria o controle ao chamador com a linha ja liberada, e o
 * lock nao teria protegido nada.
 *
 * IDEMPOTENCIA: chamar duas vezes para o mesmo alvo devolve
 * `{ mudou: false }` SEM LANCAR. O painel e uma tela operada em pe, com fila
 * na frente, e clique duplo ali e rotina — transformar isso em erro vermelho
 * ensinaria a operacao a ignorar erro vermelho.
 *
 * CARIMBOS. `enviado_em` na ENTRADA em 'enviado' e `entregue_em` na ENTRADA em
 * 'entregue'. Ate este plano, `entregue_em` nao tinha ESCRITOR NENHUM em todo
 * o codigo — a coluna existe desde migrations/1754900300000_pedidos.sql e
 * nunca recebeu um valor. Os dois usam o `?? agora` no molde de `pago_em` da
 * conciliacao: se a linha ja tem carimbo, ele fica. Um pedido que voltasse a
 * um estado e reentrasse manteria a PRIMEIRA data — a data em que a coisa
 * aconteceu de verdade, que e a unica que serve para prazo de entrega e para
 * discussao com transportadora.
 *
 * `agora` e parametro (e nao now() do banco) pelo mesmo motivo de
 * saldoDoRepresentante: e o que deixa o teste posicionar o relogio sem esperar
 * o tempo passar.
 *
 * Pedido inexistente lanca (NoResultError do Kysely) em vez de devolver null:
 * um PATCH para um id que nao existe nao pode responder 200.
 */
export async function avancarStatusDoPedido(
  pedidoId: string,
  novo: PedidoStatus,
  trx: Transaction<DB>,
  agora: Date = new Date(),
): Promise<{ mudou: boolean; de: PedidoStatus; para: PedidoStatus }> {
  const pedido = await trx
    .selectFrom('pedidos')
    .select(['id', 'status', 'enviado_em', 'entregue_em'])
    .where('id', '=', pedidoId)
    .forUpdate()
    .executeTakeFirstOrThrow()

  const de = pedido.status

  // Ja esta onde se queria chegar. Nao e erro, e o clique duplo do painel.
  if (de === novo) {
    return { mudou: false, de, para: de }
  }

  if (!transicaoPermitida(de, novo)) {
    throw new TransicaoInvalidaError(pedidoId, de, novo)
  }

  if (geraCreditoDeComissao(de, novo) || geraEstornoDeComissao(de, novo)) {
    throw new TransicaoFinanceiraError(pedidoId, de, novo)
  }

  const enviadoEm = novo === 'enviado' ? (pedido.enviado_em ?? agora) : pedido.enviado_em
  const entregueEm = novo === 'entregue' ? (pedido.entregue_em ?? agora) : pedido.entregue_em

  // Os dois carimbos vao no MESMO UPDATE do status, e nao em escritas
  // separadas: status 'entregue' com entregue_em NULL (ou o contrario) e um
  // estado que a tela do comprador nao sabe exibir, e uma falha entre dois
  // UPDATEs deixaria exatamente isso gravado. As tres colunas ficam de fora do
  // trigger de imutabilidade de proposito (ver o cabecalho de
  // migrations/1755300100000_pedidos_canal_logistica.sql).
  await trx
    .updateTable('pedidos')
    .set({ status: novo, enviado_em: enviadoEm, entregue_em: entregueEm })
    .where('id', '=', pedidoId)
    .execute()

  return { mudou: true, de, para: novo }
}

/**
 * Grava o codigo de rastreio e a transportadora, da tela /admin/logistica.
 *
 * SEM `trx` e sem lock, ao contrario de avancarStatusDoPedido: aqui nao ha
 * decisao tomada a partir do valor lido — a operacao digitou um codigo e ele
 * substitui o que estava la. Duas escritas concorrentes terminam com a segunda
 * valendo, que e o resultado certo para "corrigi o codigo que eu tinha
 * digitado errado".
 *
 * As duas colunas nao sao congeladas pelo trigger de imutabilidade justamente
 * para isto (ver migrations/1755300100000_pedidos_canal_logistica.sql): se
 * estivessem, a logistica nao conseguiria gravar rastreio nenhum.
 *
 * NAO mexe no status. Postar o objeto e mover para 'enviado' e outra acao, com
 * outra garantia (o lock de avancarStatusDoPedido) — juntar as duas aqui
 * significaria que corrigir um digito do codigo re-carimbaria `enviado_em`.
 *
 * O formato do codigo NAO e validado aqui: nao existe formato unico (Correios,
 * transportadora regional e motoboy do evento escrevem diferente) e um regex
 * inventado neste arquivo recusaria rastreio legitimo no dia do evento. Campo
 * vazio e recusado no schema Zod da rota, que e onde a entrada do usuario e
 * validada em todo o projeto.
 *
 * `executeTakeFirstOrThrow` sobre o RETURNING, e nao `execute()`: um UPDATE que
 * nao acha a linha e um sucesso silencioso para o Kysely, e a rota responderia
 * 200 para um pedido que nao existe.
 */
export async function registrarRastreio(
  pedidoId: string,
  e: { codigo: string; transportadora: string },
): Promise<void> {
  await getDb()
    .updateTable('pedidos')
    .set({ rastreio_codigo: e.codigo, rastreio_transportadora: e.transportadora })
    .where('id', '=', pedidoId)
    .returning('id')
    .executeTakeFirstOrThrow()
}

/**
 * "Pedido cujo dinheiro entrou e nao voltou" — a definicao de venda para todo
 * numero do painel (§17).
 *
 * 'cancelado' e 'reembolsado' ficam de fora: faturamento e o que ficou, nao o
 * que passou pela conta. 'pendente' e 'aguardando_pagamento' tambem, por
 * motivo oposto — carrinho abandonado nao e venda, e conta-lo aqui inflaria o
 * relatorio do evento com gente que nunca pagou.
 *
 * ESTA LISTA TEM UMA IRMA: `estavaPago` dentro de geraEstornoDeComissao
 * (src/lib/pedido-status.ts). As duas descrevem o mesmo conjunto por motivos
 * diferentes (uma decide estorno de comissao, a outra o que entra no
 * relatorio), e um valor novo no ENUM pedido_status precisa entrar nas DUAS no
 * mesmo commit. Esquecer esta aqui nao quebra nada visivelmente: so faz
 * desaparecer do faturamento uma venda que existe.
 */
const STATUS_PAGOS: readonly PedidoStatus[] = [
  'pago', 'em_preparacao', 'enviado', 'em_transito', 'entregue',
]

export type VendaAdmin = {
  id: string
  numero: number
  token: string
  criadoEm: Date
  canal: CanalVenda
  status: PedidoStatus
  clienteNome: string | null
  clienteEmail: string | null
  clienteWhatsapp: string | null
  /** Ja formatado para a celula da tabela: "2x Kit Milagran, 1x Kit Teste". */
  itens: string
  quantidade: number
  subtotalCentavos: Centavos
  descontoCentavos: Centavos
  freteCentavos: Centavos
  totalCentavos: Centavos
  metodoPagamento: MetodoPagamento | null
  vendedorNome: string | null
  representanteNome: string | null
}

/**
 * A tabela de vendas do painel (§17).
 *
 * COLUNAS NOMEADAS UMA A UMA, NUNCA `selectAll`. Esta consulta cruza
 * `clientes`, e `clientes` guarda CPF (migrations/1755000100000_clientes.sql).
 * Um `.selectAll('clientes')` aqui derramaria o CPF de todo comprador na
 * resposta JSON de /api/admin/vendas — dado que nenhuma tela do painel mostra
 * e que ninguem precisa ver para conferir uma venda. E o mesmo raciocinio que
 * separa buscarPedidoParaPagamento (que carrega CPF porque o gateway exige) de
 * buscarPedidoComItensPorToken (que nao carrega).
 *
 * OS ITENS E O PAGAMENTO VEM POR SUBCONSULTA CORRELACIONADA, e nao por JOIN, e
 * isso e uma decisao sobre DINHEIRO. `pedido_itens` e `pagamentos` sao os dois
 * um-para-muitos do pedido; juntar os dois com JOIN multiplica as linhas (um
 * pedido de 2 itens com 2 tentativas de pagamento vira 4 linhas) e qualquer
 * SUM sobre isso devolveria o total do pedido dobrado na tela do dono da
 * empresa. A subconsulta agrega ANTES de voltar para a linha do pedido, entao
 * nao ha o que multiplicar.
 *
 * `quantidade::text` explicito no string_agg: `integer || text` deixa o
 * Postgres escolher entre mais de um operador `||` e o erro seria em tempo de
 * execucao, no CI, nao aqui.
 *
 * O METODO exibido e o do pagamento APROVADO, quando existe. Um pedido tem
 * varias tentativas (cartao recusado e depois Pix e o caso comum), e mostrar a
 * ultima tentativa faria a tela dizer "cartao" para uma venda recebida em Pix.
 * Sem nenhuma aprovada, cai na mais recente — que e a informacao util para
 * quem esta investigando por que o pedido nao pagou.
 */
export async function listarVendasAdmin(
  f?: { canal?: CanalVenda; status?: PedidoStatus },
): Promise<VendaAdmin[]> {
  let q = getDb()
    .selectFrom('pedidos')
    // LEFT em todos: pedido antigo pode nao ter cliente, venda online nao tem
    // vendedor e venda da casa nao tem representante. Um innerJoin faria cada
    // um desses casos sumir da tabela de vendas — silenciosamente.
    .leftJoin('clientes', 'clientes.id', 'pedidos.cliente_id')
    .leftJoin('usuarios', 'usuarios.id', 'pedidos.vendedor_id')
    .leftJoin('representantes', 'representantes.id', 'pedidos.representante_id')
    .select([
      'pedidos.id as id',
      'pedidos.numero as numero',
      'pedidos.token as token',
      'pedidos.criado_em as criado_em',
      'pedidos.canal as canal',
      'pedidos.status as status',
      'pedidos.subtotal_centavos as subtotal',
      'pedidos.desconto_centavos as desconto',
      'pedidos.frete_centavos as frete',
      'pedidos.total_centavos as total',
      'clientes.nome as cliente_nome',
      'clientes.email as cliente_email',
      'clientes.whatsapp as cliente_whatsapp',
      'usuarios.nome as vendedor_nome',
      'representantes.nome as representante_nome',
      sql<string>`COALESCE((
        SELECT string_agg(i.quantidade::text || 'x ' || i.nome_snapshot, ', '
                          ORDER BY i.nome_snapshot, i.id)
        FROM pedido_itens i WHERE i.pedido_id = pedidos.id
      ), '')`.as('itens'),
      sql<number>`COALESCE((
        SELECT SUM(i.quantidade) FROM pedido_itens i WHERE i.pedido_id = pedidos.id
      ), 0)`.as('quantidade'),
      sql<MetodoPagamento | null>`(
        SELECT g.metodo FROM pagamentos g WHERE g.pedido_id = pedidos.id
        ORDER BY (g.status = 'aprovado') DESC, g.criado_em DESC, g.id DESC
        LIMIT 1
      )`.as('metodo'),
    ])
    // Mais recente primeiro: no dia do evento a pergunta e sempre "o que
    // acabou de entrar". `id` desempata porque criado_em nao e unico — varios
    // pedidos podem cair no mesmo instante, e sem desempate a mesma consulta
    // devolveria ordens diferentes entre dois F5.
    .orderBy('pedidos.criado_em', 'desc')
    .orderBy('pedidos.id', 'desc')

  // Filtros ausentes NAO viram `where canal = null`: cada um so entra na
  // consulta quando o painel realmente pediu.
  if (f?.canal) q = q.where('pedidos.canal', '=', f.canal)
  if (f?.status) q = q.where('pedidos.status', '=', f.status)

  const linhas = await q.execute()

  return linhas.map((l) => ({
    id: l.id,
    numero: Number(l.numero),
    token: l.token,
    criadoEm: l.criado_em,
    canal: l.canal,
    status: l.status,
    clienteNome: l.cliente_nome,
    clienteEmail: l.cliente_email,
    clienteWhatsapp: l.cliente_whatsapp,
    itens: l.itens,
    // SUM devolve int8/numeric, que o driver pode entregar como string.
    // Number() explicito aqui evita "2" + "3" = "23" na coluna de quantidade,
    // mesma armadilha ja documentada em saldoDoRepresentante.
    quantidade: Number(l.quantidade),
    // Colunas ja em centavos inteiros: deInteiro ATESTA o tipo, nao converte.
    // centavos() multiplicaria por 100 sem erro de compilacao.
    subtotalCentavos: deInteiro(l.subtotal),
    descontoCentavos: deInteiro(l.desconto),
    freteCentavos: deInteiro(l.frete),
    totalCentavos: deInteiro(l.total),
    metodoPagamento: l.metodo,
    vendedorNome: l.vendedor_nome,
    representanteNome: l.representante_nome,
  }))
}

export type LogisticaAdmin = {
  id: string
  numero: number
  status: PedidoStatus
  criadoEm: Date
  clienteNome: string | null
  cep: string | null
  rua: string | null
  /**
   * Numero do ENDERECO, com underline no fim para nao colidir com `numero`, que
   * neste tipo e o numero do PEDIDO. Nome feio de proposito: o feio aqui e
   * preferivel a duas coisas diferentes chamadas "numero" na mesma linha de
   * uma etiqueta de envio.
   */
  numero_: string | null
  complemento: string | null
  bairro: string | null
  cidade: string | null
  estado: string | null
  rastreioCodigo: string | null
  rastreioTransportadora: string | null
  prazoDiasEstimado: number | null
  enviadoEm: Date | null
}

/**
 * A fila da expedicao (§17): o que ha para despachar e o que ja foi.
 *
 * O RECORTE E "TEM PARA ONDE DESPACHAR E O DINHEIRO ENTROU", nao "canal =
 * online". Filtrar por canal seria descrever a intencao pelo rotulo em vez de
 * pelo fato: o que define uma linha desta tela e existir um endereco de
 * entrega. A venda de balcao sai na mao do comprador (§2) e nunca tem
 * endereco, entao cai fora sozinha — sem isso, os 50 kits do evento
 * apareceriam aqui como 50 linhas em branco, empurrando para baixo os pedidos
 * online que realmente precisam ser postados.
 *
 * Pedido nao pago tambem fica fora: nada a postar antes de o dinheiro entrar.
 * 'entregue' PERMANECE na lista de proposito — e por esta tela que a operacao
 * reencontra o codigo de rastreio de um pedido ja entregue quando o comprador
 * liga perguntando.
 *
 * ORDEM CRESCENTE por data, ao contrario da tabela de vendas: aqui a pergunta
 * nao e "o que entrou agora" e sim "o que esta parado ha mais tempo". O pedido
 * mais antigo sem rastreio e, literalmente, o comprador que esta esperando ha
 * mais dias.
 *
 * CPF de novo fora da lista de colunas, pelo mesmo motivo de listarVendasAdmin
 * — e aqui com um agravante: esta e a tela cuja tabela costuma ser copiada e
 * colada para uma transportadora.
 */
export async function listarLogisticaAdmin(): Promise<LogisticaAdmin[]> {
  const linhas = await getDb()
    .selectFrom('pedidos')
    .leftJoin('clientes', 'clientes.id', 'pedidos.cliente_id')
    // INNER aqui e o filtro descrito no doc comment, escrito como join: sem
    // endereco nao ha entrega, e o pedido nao pertence a esta tela. E o unico
    // join nao-LEFT das leituras administrativas, e e proposital.
    .innerJoin('enderecos', 'enderecos.id', 'pedidos.endereco_id')
    .select([
      'pedidos.id as id',
      'pedidos.numero as numero',
      'pedidos.status as status',
      'pedidos.criado_em as criado_em',
      'pedidos.rastreio_codigo as rastreio_codigo',
      'pedidos.rastreio_transportadora as rastreio_transportadora',
      'pedidos.prazo_dias_estimado as prazo',
      'pedidos.enviado_em as enviado_em',
      'clientes.nome as cliente_nome',
      'enderecos.cep as cep',
      'enderecos.rua as rua',
      'enderecos.numero as endereco_numero',
      'enderecos.complemento as complemento',
      'enderecos.bairro as bairro',
      'enderecos.cidade as cidade',
      'enderecos.estado as estado',
    ])
    .where('pedidos.status', 'in', STATUS_PAGOS)
    .orderBy('pedidos.criado_em', 'asc')
    .orderBy('pedidos.id', 'asc')
    .execute()

  return linhas.map((l) => ({
    id: l.id,
    numero: Number(l.numero),
    status: l.status,
    criadoEm: l.criado_em,
    clienteNome: l.cliente_nome,
    cep: l.cep,
    rua: l.rua,
    numero_: l.endereco_numero,
    complemento: l.complemento,
    bairro: l.bairro,
    cidade: l.cidade,
    estado: l.estado,
    rastreioCodigo: l.rastreio_codigo,
    rastreioTransportadora: l.rastreio_transportadora,
    prazoDiasEstimado: l.prazo,
    enviadoEm: l.enviado_em,
  }))
}

export type ResumoDeVendas = {
  pedidosPagos: number
  faturamentoCentavos: Centavos
  porCanal: Array<{ canal: CanalVenda; pedidos: number; totalCentavos: Centavos }>
  porMetodo: Array<{ metodo: MetodoPagamento; pedidos: number; totalCentavos: Centavos }>
}

/**
 * Os numeros do topo do painel (§17): quanto vendeu, por canal e por forma de
 * pagamento.
 *
 * `pedidosPagos` e `faturamentoCentavos` sao SOMADOS A PARTIR DE `porCanal`,
 * em JavaScript, em vez de sairem de um terceiro SELECT com COUNT/SUM. Duas
 * consultas separadas rodam em instantes diferentes: uma venda que entrasse
 * entre elas faria o total do topo nao fechar com a soma das linhas logo
 * abaixo, na tela do dono da empresa, sem que nada estivesse quebrado. Derivar
 * torna a divergencia impossivel por construcao.
 *
 * `porMetodo` sai de `pagamentos`, e nao de `pedidos`: o metodo e um fato do
 * pagamento aprovado, e o valor somado e o que o provedor aprovou. Isso tem uma
 * consequencia DESEJADA — se a soma de porMetodo nao bater com
 * faturamentoCentavos, houve pagamento aprovado em duplicidade (o comprador
 * pagou duas vezes) ou um pedido marcado como pago sem pagamento aprovado. Sao
 * exatamente os dois casos que a operacao precisa enxergar; achatar os dois
 * lados para o mesmo numero esconderia dinheiro cobrado a mais de um cliente
 * real.
 */
export async function resumoDeVendas(): Promise<ResumoDeVendas> {
  const canais = await getDb()
    .selectFrom('pedidos')
    .select([
      'canal',
      sql<number>`COUNT(*)`.as('pedidos'),
      sql<number>`COALESCE(SUM(total_centavos), 0)`.as('total'),
    ])
    .where('status', 'in', STATUS_PAGOS)
    .groupBy('canal')
    .orderBy('canal', 'asc')
    .execute()

  const metodos = await getDb()
    .selectFrom('pagamentos')
    .innerJoin('pedidos', 'pedidos.id', 'pagamentos.pedido_id')
    .select([
      'pagamentos.metodo as metodo',
      // DISTINCT no pedido: duas tentativas aprovadas do mesmo pedido sao um
      // problema de cobranca, nao dois pedidos. O valor logo abaixo continua
      // somando as duas — ver o comentario do doc sobre por que a divergencia
      // entre os dois numeros e informacao, e nao defeito.
      sql<number>`COUNT(DISTINCT pagamentos.pedido_id)`.as('pedidos'),
      sql<number>`COALESCE(SUM(pagamentos.valor_centavos), 0)`.as('total'),
    ])
    .where('pagamentos.status', '=', 'aprovado')
    .where('pedidos.status', 'in', STATUS_PAGOS)
    .groupBy('pagamentos.metodo')
    .orderBy('pagamentos.metodo', 'asc')
    .execute()

  // Number() em toda agregacao pelo mesmo motivo de saldoDoRepresentante:
  // COUNT e SUM voltam como int8/numeric e podem chegar em string. Somar
  // strings devolveria concatenacao, e o faturamento do evento apareceria como
  // um numero absurdo em vez de errado por pouco — o que ao menos e visivel.
  const porCanal = canais.map((l) => ({
    canal: l.canal,
    pedidos: Number(l.pedidos),
    totalCentavos: deInteiro(Number(l.total)),
  }))
  const porMetodo = metodos.map((l) => ({
    metodo: l.metodo,
    pedidos: Number(l.pedidos),
    totalCentavos: deInteiro(Number(l.total)),
  }))

  return {
    pedidosPagos: porCanal.reduce((acc, c) => acc + c.pedidos, 0),
    faturamentoCentavos: deInteiro(porCanal.reduce((acc, c) => acc + c.totalCentavos, 0)),
    porCanal,
    porMetodo,
  }
}

export type CompradorAdmin = {
  clienteId: string
  nome: string
  email: string
  whatsapp: string
  pedidos: number
  totalCentavos: Centavos
  ultimoPedidoEm: Date
}

/**
 * Quem ja comprou (§17).
 *
 * NAO E UMA TABELA — e derivado de `clientes` + `pedidos`. So os tres tipos que
 * NAO compraram (interessado, representante, distribuidor) viram linha em
 * `leads` (migrations/1755300400000_leads.sql). Duplicar comprador em `leads`
 * criaria duas listas que divergem no primeiro cadastro atualizado.
 *
 * LGPD/CPF: as colunas devolvidas sao nome, e-mail e whatsapp — o suficiente
 * para a Milagran falar com quem comprou, que e o proposito declarado da tela.
 * CPF fica FORA, e por isso as colunas sao nomeadas uma a uma: e um documento
 * de identidade coletado para o gateway de pagamento exigir, nao para virar
 * mala direta. Um `selectAll('clientes')` aqui seria a diferenca entre exportar
 * uma lista de contatos e vazar uma base de CPFs.
 *
 * So conta pedido pago (STATUS_PAGOS): quem abandonou o carrinho nao e
 * comprador, e apareceria nesta lista com total zero, empurrando para baixo
 * quem realmente comprou.
 */
export async function listarCompradores(): Promise<CompradorAdmin[]> {
  const linhas = await getDb()
    .selectFrom('clientes')
    .innerJoin('pedidos', 'pedidos.cliente_id', 'clientes.id')
    .select([
      'clientes.id as id',
      'clientes.nome as nome',
      'clientes.email as email',
      'clientes.whatsapp as whatsapp',
      sql<number>`COUNT(*)`.as('pedidos'),
      sql<number>`COALESCE(SUM(pedidos.total_centavos), 0)`.as('total'),
      sql<Date>`MAX(pedidos.criado_em)`.as('ultimo'),
    ])
    .where('pedidos.status', 'in', STATUS_PAGOS)
    // Agrupar por todas as colunas selecionadas que nao sao agregacao. Postgres
    // aceitaria so `clientes.id` (a PK funcionalmente determina o resto), mas
    // escrever a lista inteira mantem a consulta valida se alguem um dia trocar
    // o agrupamento por e-mail.
    .groupBy(['clientes.id', 'clientes.nome', 'clientes.email', 'clientes.whatsapp'])
    .orderBy('ultimo', 'desc')
    .orderBy('id', 'asc')
    .execute()

  return linhas.map((l) => ({
    clienteId: l.id,
    nome: l.nome,
    email: l.email,
    whatsapp: l.whatsapp,
    pedidos: Number(l.pedidos),
    totalCentavos: deInteiro(Number(l.total)),
    ultimoPedidoEm: l.ultimo,
  }))
}

/**
 * "Prometido e ainda nao pago" — o oposto exato de STATUS_PAGOS, e a terceira
 * lista irma daquela e de `estavaPago` (src/lib/pedido-status.ts).
 *
 * OS DOIS ESTADOS ENTRAM, e nao so 'aguardando_pagamento'. Os rotulos de §12
 * dizem o porque em portugues claro (ROTULOS_STATUS, src/lib/pedido-status.ts):
 * 'pendente' e "Aguardando pagamento" e 'aguardando_pagamento' e "Aguardando
 * confirmacao do pagamento" — os dois sao pedido criado com dinheiro ainda nao
 * confirmado. Contar so o segundo esconderia justamente o pedido cuja rota de
 * pagamento morreu entre chamar o Mercado Pago e gravar o status novo, que e o
 * caso que a propria tabela TRANSICOES documenta ao permitir
 * 'pendente' -> 'pago'.
 */
const STATUS_RESERVADOS: readonly PedidoStatus[] = ['pendente', 'aguardando_pagamento']

export type ReservaAdmin = {
  kitId: string
  canal: CanalVenda
  /** Unidades em pedidos criados cujo pagamento ainda nao foi confirmado. */
  reservado: number
}

/**
 * Quantas unidades de cada kit estao presas em pedido nao pago, por canal — a
 * coluna "Reservado" do painel de estoque (§17, GET /api/admin/estoque).
 *
 * RESERVA AQUI NAO SEGURA ESTOQUE NENHUM, e essa e a informacao mais
 * importante deste doc comment. A decisao do cliente de 16/08 (§4) e que a
 * unidade sai do livro-razao no PAGAMENTO, nunca na criacao do pedido —
 * carrinho abandonado nao pode segurar kit. Entao este numero nao aparece em
 * `saldosPorKit` (src/repositories/estoque.ts) e nao desconta de `disponivel`:
 * ele existe para a operacao ver o que esta em curso, e nada mais. Descontar
 * seria reintroduzir pela porta dos fundos a reserva que o cliente recusou.
 *
 * CONSEQUENCIA QUE QUEM MONTA A TELA PRECISA SABER: no canal PRESENCIAL a
 * mesma unidade pode estar contada duas vezes, em `vendido` e aqui. A venda de
 * balcao baixa o estoque NA CRIACAO do pedido (§10,
 * src/app/api/vendas-presenciais/route.ts, porque o comprador leva o kit na
 * hora) e o pedido so sai de 'pendente' quando o webhook confirma — na janela
 * entre as duas coisas ela e vendida E reservada. Nao ha erro nisso: sao duas
 * perguntas diferentes ("saiu da caixa?" e "o dinheiro entrou?"). Somar as duas
 * colunas, porem, conta kit que nao existe — e por isso que §17 pede
 * "Reservado" na tabela do online e nao na do presencial.
 *
 * NAO FILTRA por kit com linha em `estoques`: um kit vendido sem estoque
 * cadastrado tem que aparecer para alguem cadastrar o estoque, nao sumir. Quem
 * junta os dois lados e a rota, por (kitId, canal).
 *
 * `canal` vem de `pedidos`, e nao de `estoques`: e o canal da VENDA, congelado
 * na linha do pedido desde a criacao pelo trigger de imutabilidade — o mesmo
 * valor que conciliarPagamento usa para decidir de qual estoque baixar.
 */
export async function reservadosPorKit(): Promise<ReservaAdmin[]> {
  const linhas = await getDb()
    .selectFrom('pedido_itens')
    .innerJoin('pedidos', 'pedidos.id', 'pedido_itens.pedido_id')
    .select([
      'pedido_itens.kit_id as kit_id',
      'pedidos.canal as canal',
      sql<number>`COALESCE(SUM(pedido_itens.quantidade), 0)`.as('reservado'),
    ])
    .where('pedidos.status', 'in', STATUS_RESERVADOS)
    .groupBy(['pedido_itens.kit_id', 'pedidos.canal'])
    // Ordem explicita pelo mesmo motivo de saldosPorKit
    // (src/repositories/estoque.ts): sem ORDER BY a ordem fica a merce da
    // varredura do Postgres e a tabela do painel troca de posicao entre dois
    // refreshes do mesmo minuto. O par (kit_id, canal) e o proprio agrupamento,
    // entao nao ha empate possivel.
    .orderBy('pedido_itens.kit_id')
    .orderBy('pedidos.canal')
    .execute()

  return linhas.map((l) => ({
    kitId: l.kit_id,
    canal: l.canal,
    // Number() em toda agregacao, pelo mesmo motivo ja documentado em
    // listarVendasAdmin: SUM devolve int8/numeric e o driver pode entregar
    // string — "2" + "3" viraria "23" na coluna de reservados.
    reservado: Number(l.reservado),
  }))
}
