import type { Transaction } from 'kysely'
import type { CanalVenda, DB, PagamentoStatus, PedidoStatus } from '@/lib/db-types'
import { deInteiro } from '@/lib/money'
import {
  pedidoAposPagamento, geraCreditoDeComissao, geraEstornoDeComissao,
} from '@/lib/pedido-status'
import { creditarComissao, estornarComissao } from '@/repositories/comissoes'
import {
  baixarEstoque, estornarEstoque, EstoqueInsuficienteError,
} from '@/repositories/estoque'

export type ResultadoConciliacao = {
  mudou: boolean
  de: PedidoStatus
  para: PedidoStatus
  /** Centavos creditados ao representante nesta conciliacao, se houve. */
  comissaoCreditada: number | null
  /** Centavos revertidos (numero negativo), se houve. */
  comissaoEstornada: number | null
  /**
   * ESTA conciliacao gravou ao menos um movimento de baixa em
   * estoque_movimentos.
   *
   * Leia o campo como "esta chamada mexeu no estoque", e NUNCA como "o pedido
   * tem estoque baixado" — sao perguntas diferentes e a segunda so o
   * livro-razao responde (saldosPorKit / estoque_movimentos em
   * src/repositories/estoque.ts). `false` cobre TRES casos que nao se
   * distinguem daqui:
   *   1. o pedido nao entrou em 'pago' agora (o caso mais comum: reentrega do
   *      mesmo webhook, que ja cai no no-op de pedidoAposPagamento);
   *   2. a baixa daquele pedido JA existia — e o que acontece em toda venda
   *      presencial, que baixa na criacao (§10) e nao na confirmacao;
   *   3. a baixa foi RECUSADA por falta de saldo, ou o kit nem tem linha de
   *      estoque naquele canal.
   * So o caso 3 e divergencia, e ele deixa rastro proprio: uma linha de
   * console.error aqui e um saldo que nao fecha no painel de §17. Achatar os
   * tres num booleano e proposital — o campo existe para o chamador saber se
   * precisa reler o estoque, nao para diagnosticar.
   */
  estoqueBaixado: boolean
  /** Mesma leitura de `estoqueBaixado`, do lado do estorno. */
  estoqueEstornado: boolean
}

/**
 * O caminho AUTOMATICO que move pedidos.status, e o unico que escreve no
 * livro-razao de comissao e no livro-razao de estoque a partir de um pagamento.
 *
 * Tanto a rota que cria o pagamento (quando o cartao aprova na hora) quanto o
 * webhook chamam esta funcao. Se cada uma tivesse a sua propria copia da
 * regra, um cartao aprovado sincronamente e o webhook do mesmo pagamento
 * chegando logo depois poderiam creditar comissao duas vezes por caminhos
 * diferentes — e so um dos dois teria a protecao. Vale palavra por palavra
 * para a baixa de estoque, acrescentada aqui pelo Plano 4: e por isso que ela
 * mora DENTRO desta funcao e nao nas duas rotas.
 *
 * (Ate o Plano 4 este arquivo era o UNICO escritor de pedidos.status. Hoje ha
 * um segundo, avancarStatusDoPedido em src/repositories/pedidos.ts, que move a
 * logistica pela mao da operacao e recusa por TransicaoFinanceiraError toda
 * transicao que mexeria em dinheiro. A divisao esta escrita la.)
 *
 * TRAVA A LINHA DO PEDIDO COM `FOR UPDATE` como primeiro statement. Duas
 * entregas concorrentes do mesmo webhook (o Mercado Pago reenvia ate receber
 * 2xx) leriam ambas status 'aguardando_pagamento', ambas decidiriam transitar
 * para 'pago' e ambas tentariam creditar. Com o lock, a segunda so le depois
 * que a primeira commitou — e ai `pedidoAposPagamento` devolve null. O indice
 * comissao_um_credito_por_pedido continua sendo a rede embaixo disso.
 *
 * O lock e mantido ate o COMMIT do chamador, que por isso PRECISA passar a
 * transacao. Nao ha versao sem `trx` de proposito.
 *
 * ORDEM DE LOCK DE TODO O SISTEMA, definida aqui: `pedidos` PRIMEIRO,
 * `estoques` DEPOIS. O SELECT ... FOR UPDATE logo abaixo e o primeiro
 * statement; a baixa e o estorno de estoque, que travam a linha de `estoques`,
 * vem no fim da funcao. Ver o bloco de estoque mais abaixo e o doc comment de
 * baixarEstoque (src/repositories/estoque.ts) — a regra so vale se as duas
 * pontas continuarem obedecendo.
 */
export async function conciliarPagamento(
  pedidoId: string,
  statusPagamento: PagamentoStatus,
  trx: Transaction<DB>,
  agora: Date = new Date(),
): Promise<ResultadoConciliacao> {
  const pedido = await trx
    .selectFrom('pedidos')
    .select([
      'id', 'numero', 'status', 'representante_id', 'percentual_comissao_snapshot',
      'subtotal_centavos', 'desconto_centavos', 'pago_em',
      // De QUAL estoque a unidade sai. Vem da linha do pedido, congelada pelo
      // trigger pedido_atribuicao_imutavel_trg desde a criacao
      // (migrations/1755300100000_pedidos_canal_logistica.sql), e nunca de um
      // parametro do chamador: o webhook do Mercado Pago nao sabe se a venda
      // foi de balcao ou de loja, e adivinhar aqui tiraria kit da caixa do
      // evento por causa de uma compra online.
      'canal',
    ])
    .where('id', '=', pedidoId)
    .forUpdate()
    .executeTakeFirstOrThrow()

  const de = pedido.status
  const para = pedidoAposPagamento(statusPagamento, de)

  if (para === null) {
    return {
      mudou: false, de, para: de,
      comissaoCreditada: null, comissaoEstornada: null,
      // Nao ha status novo, entao nao ha fato de estoque: a reentrega do mesmo
      // "approved" cai aqui e nao chega perto de baixarEstoque. A idempotencia
      // do proprio estoque (estoque_baixa_unica_por_pedido) e a segunda rede,
      // para o caminho que um dia passe por cima desta.
      estoqueBaixado: false, estoqueEstornado: false,
    }
  }

  // pago_em e carimbado uma unica vez, na entrada em 'pago', e nunca
  // reescrito depois — e dele que sai a carencia de 30 dias da comissao.
  // Um segundo webhook nao chega aqui (para seria null), mas um reembolso
  // seguido de uma nova aprovacao chegaria, e mover pago_em ali estenderia a
  // carencia de um credito que ja existe.
  const pagoEm = para === 'pago' ? (pedido.pago_em ?? agora) : pedido.pago_em

  await trx
    .updateTable('pedidos')
    .set({ status: para, pago_em: pagoEm })
    .where('id', '=', pedidoId)
    .execute()

  let comissaoCreditada: number | null = null
  let comissaoEstornada: number | null = null

  // Venda da casa (representante_id NULL) nao gera lancamento nenhum — e o
  // caso normal de toda venda do perfil oficial, nao uma excecao.
  if (
    geraCreditoDeComissao(de, para) &&
    pedido.representante_id !== null &&
    pedido.percentual_comissao_snapshot !== null
  ) {
    // BASE DE CALCULO: subtotal menos desconto, SEM frete. Os dois valores
    // vem das colunas congeladas do pedido, protegidas pelo trigger de
    // imutabilidade — nunca de um recalculo sobre o catalogo de hoje.
    const base = deInteiro(pedido.subtotal_centavos - pedido.desconto_centavos)
    const lancamento = await creditarComissao(
      {
        pedidoId,
        representanteId: pedido.representante_id,
        base,
        // O percentual e o snapshot do momento da venda, nao o cadastro
        // atual do representante: mudar a comissao dele amanha nao pode
        // reprecificar o que ja foi vendido.
        percentual: Number(pedido.percentual_comissao_snapshot),
        pagoEm: pagoEm ?? agora,
      },
      trx,
      Number(pedido.numero),
    )
    comissaoCreditada = lancamento.valorCentavos
  }

  if (geraEstornoDeComissao(de, para)) {
    const lancamento = await estornarComissao(pedidoId, trx)
    comissaoEstornada = lancamento?.valorCentavos ?? null
  }

  // ---------------------------------------------------------------------
  // ESTOQUE. SEMPRE DEPOIS DO LOCK DO PEDIDO, NUNCA ANTES.
  //
  // ORDEM DE LOCK OBRIGATORIA: `pedidos` primeiro (o SELECT ... FOR UPDATE la
  // no topo desta funcao), `estoques` depois. Nunca o contrario, em nenhum
  // caminho. baixarEstoque e estornarEstoque (src/repositories/estoque.ts)
  // travam a linha de `estoques` do kit e do canal com FOR UPDATE; se algum
  // caminho travasse `estoques` antes de `pedidos`, duas entregas concorrentes
  // do MESMO webhook — que e o caso normal em producao, e nao a excecao, porque
  // o Mercado Pago reenvia ate receber 2xx — ficariam cada uma segurando a
  // linha que a outra espera. O Postgres resolve isso matando uma delas com
  // "deadlock detected": a rota devolve 5xx, a notificacao e reentregue, e no
  // meio tempo existe um pagamento aprovado cujo pedido nao mudou de status.
  // A regra esta escrita nas duas pontas de proposito — ela so vale enquanto as
  // duas obedecerem.
  //
  // Vem DEPOIS da comissao pela mesma razao pela qual a comissao vem depois do
  // UPDATE de status: o efeito colateral e consequencia do fato, e ler o codigo
  // na ordem em que as coisas acontecem e o que torna a ordem de lock evidente
  // para quem mexer aqui depois.
  // ---------------------------------------------------------------------
  let estoqueBaixado = false
  let estoqueEstornado = false

  // ENTRAR em 'pago' e o unico gatilho de baixa no fluxo online: §4 decidiu que
  // a unidade sai no PAGAMENTO, nunca na criacao do pedido — carrinho
  // abandonado nao segura estoque. `para === 'pago'` ja implica `de !== 'pago'`,
  // porque pedidoAposPagamento devolve null quando o alvo e o status atual.
  if (para === 'pago') {
    estoqueBaixado = await baixarEstoqueDoPedido(
      pedidoId, pedido.canal, Number(pedido.numero), trx,
    )
  }

  // ENTRAR em 'reembolsado' OU 'cancelado' devolve a unidade a prateleira.
  //
  // O criterio aqui NAO e geraEstornoDeComissao(de, para), e a diferenca e
  // deliberada. Aquele predicado exige que o pedido ESTIVESSE pago, porque so
  // pedido pago chegou a gerar credito de comissao. Estoque nao segue essa
  // regra: a venda presencial (§10, src/app/api/vendas-presenciais/route.ts)
  // baixa a unidade NA CRIACAO do pedido, antes de qualquer confirmacao do
  // provedor, porque o comprador esta na frente do vendedor e vai sair com o
  // kit na mao. Se o pagamento dele for cancelado, o pedido vai de 'pendente'
  // direto a 'cancelado' sem nunca ter passado por 'pago' — e aquele kit
  // precisa voltar para a caixa do evento do mesmo jeito. Reusar o predicado da
  // comissao aqui deixaria a unidade sumida do sistema para sempre, com o kit
  // fisico parado na caixa e o painel anunciando um a menos para a fila.
  //
  // Nao ha risco de estorno indevido: estornarEstoque devolve false quando o
  // pedido nunca teve baixa (o caso normal do pedido online cancelado antes de
  // pagar) e quando o estorno ja foi lancado antes.
  if (para === 'reembolsado' || para === 'cancelado') {
    estoqueEstornado = await estornarEstoque(pedidoId, trx)
  }

  return {
    mudou: true, de, para,
    comissaoCreditada, comissaoEstornada,
    estoqueBaixado, estoqueEstornado,
  }
}

/**
 * Baixa do estoque as unidades de um pedido que ACABOU de entrar em 'pago', no
 * canal em que a venda aconteceu.
 *
 * UMA CHAMADA POR ITEM, e uma unica chamada por kit. Quem garante a segunda
 * parte e o indice pedido_itens_kit_unico
 * (migrations/1755000000000_pedido_itens.sql): um kit aparece uma vez por
 * pedido, e quantidade e coluna, nao linha repetida. Se aquele indice caisse, a
 * segunda linha do mesmo kit bateria na idempotencia de baixarEstoque (que e
 * por pedido e estoque, nao por linha de item) e o pedido sairia baixado a
 * MENOS do que vendeu — silenciosamente.
 *
 * Os itens vem ordenados por kit_id para que duas conciliacoes concorrentes que
 * toquem o mesmo conjunto de kits peguem os locks de `estoques` na MESMA ordem.
 * Ordem livre entre varios estoques e a receita classica de deadlock entre dois
 * pagamentos simultaneos de pedidos com os mesmos dois kits — mesmo cuidado ja
 * tomado em estornarEstoque (src/repositories/estoque.ts), que percorre as
 * baixas ordenadas por estoque_id.
 *
 * ------------------------------------------------------------------
 * DECISAO CRITICA — E UMA ESCOLHA, NAO UM ESQUECIMENTO:
 * um EstoqueInsuficienteError aqui NAO derruba a conciliacao.
 * ------------------------------------------------------------------
 *
 * Quando esta funcao roda, o dinheiro JA ENTROU: o provedor aprovou a cobranca
 * e o comprador ja foi debitado. O pedido TEM que ficar pago. Deixar a excecao
 * subir desfaria o COMMIT inteiro — o UPDATE de status, o credito de comissao e
 * a marcacao do evento de webhook — e o pedido voltaria a 'pendente' com o
 * dinheiro cobrado. Pior: a rota devolveria 5xx, o Mercado Pago reentregaria a
 * notificacao, a nova entrega encontraria o mesmo estoque zerado e falharia
 * igual, em laco, ate o provedor desistir. O comprador ficaria com a cobranca e
 * sem pedido, e ninguem olharia um painel para descobrir isso.
 *
 * O QUE ESTA ESCOLHA CUSTA, dito por extenso: a Milagran pode terminar o dia
 * tendo vendido mais unidades do que tem na caixa. E uma venda a mais para
 * resolver a mao — reposicao, ou reembolso combinado com o comprador. A
 * divergencia fica VISIVEL, e nao escondida: sobra a linha de console.error
 * abaixo e, no painel de §17, um `disponivel` que nao fecha com a contagem
 * fisica (saldosPorKit em src/repositories/estoque.ts). Trocar uma venda a mais
 * por um pagamento perdido seria o negocio errado nos dois sentidos.
 *
 * POR QUE E SEGURO CONTINUAR A TRANSACAO DEPOIS DO catch: este erro e levantado
 * pela APLICACAO, em JavaScript, antes de qualquer statement falhar no banco —
 * baixarEstoque le o saldo e decide. Uma violacao de constraint do Postgres
 * seria outra historia: ela poe a transacao em estado abortado (25P02) e todo
 * statement seguinte falha com "current transaction is aborted", inclusive o
 * COMMIT. E exatamente por isso que o catch e ESTREITO — so
 * EstoqueInsuficienteError e engolido, e qualquer outro erro e relancado para
 * derrubar a transacao, que e o que tem que acontecer com ele.
 *
 * LOG: so `erro.message`. Nunca o objeto de erro cru e nunca `error.detail` do
 * Postgres, que carrega a LINHA INTEIRA envolvida — nome, CPF e whatsapp do
 * comprador iriam para o stdout do container e dali para o log agregado do
 * Swarm. Mesma regra registrada em src/repositories/clientes.ts e em
 * src/app/api/pedidos/route.ts (mensagemSeguraDoErro).
 */
async function baixarEstoqueDoPedido(
  pedidoId: string,
  canal: CanalVenda,
  numero: number,
  trx: Transaction<DB>,
): Promise<boolean> {
  const itens = await trx
    .selectFrom('pedido_itens')
    .select(['kit_id', 'quantidade'])
    .where('pedido_id', '=', pedidoId)
    .orderBy('kit_id')
    .execute()

  let baixouAlgo = false

  for (const item of itens) {
    try {
      const baixou = await baixarEstoque(
        {
          kitId: item.kit_id,
          canal,
          pedidoId,
          quantidade: item.quantidade,
          // Texto do extrato do painel, no formato que a migration usa de
          // exemplo ("Pedido #1042"). Nao e chave de nada: quem amarra o
          // movimento a venda e pedido_id.
          motivo: `Pedido #${numero}`,
        },
        trx,
      )
      // `false` aqui e "nada a fazer", nao falha: ou a baixa deste pedido ja
      // existia (venda presencial, que baixa na criacao, e reentrega de
      // webhook), ou o kit nao tem linha de estoque naquele canal. Os dois
      // casos estao documentados em baixarEstoque.
      if (baixou) baixouAlgo = true
    } catch (erro) {
      if (!(erro instanceof EstoqueInsuficienteError)) throw erro

      // Um item sem saldo nao impede os outros itens do mesmo pedido de
      // baixarem: o try/catch e por ITEM de proposito. Metade baixada e mais
      // proxima da verdade do que nenhuma, e o kit que faltou esta identificado
      // na mensagem.
      console.error(
        '[conciliacao] pagamento aprovado sem estoque para baixar; pedido segue pago:',
        erro.message,
      )
    }
  }

  return baixouAlgo
}
