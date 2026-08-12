import type { Transaction } from 'kysely'
import type { DB, PagamentoStatus, PedidoStatus } from '@/lib/db-types'
import { deInteiro } from '@/lib/money'
import {
  pedidoAposPagamento, geraCreditoDeComissao, geraEstornoDeComissao,
} from '@/lib/pedido-status'
import { creditarComissao, estornarComissao } from '@/repositories/comissoes'

export type ResultadoConciliacao = {
  mudou: boolean
  de: PedidoStatus
  para: PedidoStatus
  /** Centavos creditados ao representante nesta conciliacao, se houve. */
  comissaoCreditada: number | null
  /** Centavos revertidos (numero negativo), se houve. */
  comissaoEstornada: number | null
}

/**
 * O UNICO caminho do sistema que move pedidos.status e o unico que escreve no
 * livro-razao de comissao a partir de um pagamento.
 *
 * Tanto a rota que cria o pagamento (quando o cartao aprova na hora) quanto o
 * webhook chamam esta funcao. Se cada uma tivesse a sua propria copia da
 * regra, um cartao aprovado sincronamente e o webhook do mesmo pagamento
 * chegando logo depois poderiam creditar comissao duas vezes por caminhos
 * diferentes — e so um dos dois teria a protecao.
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
    ])
    .where('id', '=', pedidoId)
    .forUpdate()
    .executeTakeFirstOrThrow()

  const de = pedido.status
  const para = pedidoAposPagamento(statusPagamento, de)

  if (para === null) {
    return { mudou: false, de, para: de, comissaoCreditada: null, comissaoEstornada: null }
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

  return { mudou: true, de, para, comissaoCreditada, comissaoEstornada }
}
