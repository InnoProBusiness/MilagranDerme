import type { Selectable } from 'kysely'
import { getDb } from '@/lib/db'
import type { Pedidos, OrigemAtribuicao } from '@/lib/db-types'
import { deInteiro, type Centavos } from '@/lib/money'

// kysely-codegen ja gera um union literal 'link' | 'cupom' | 'casa' |
// 'rep_inativo' a partir do ENUM origem_atribuicao do Postgres (ver
// migrations/1754900300000_pedidos.sql). Reexportar em vez de redeclarar
// evita que o tipo do repositorio e o ENUM do banco divirjam com o tempo.
export type { OrigemAtribuicao }

export type EntradaPedido = {
  origem: OrigemAtribuicao
  representanteId: string | null
  percentualComissao: number | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  subtotal: Centavos
  desconto: Centavos
  frete: Centavos
}

export type Pedido = {
  id: string
  numero: number
  status: string
  origem: OrigemAtribuicao
  representanteId: string | null
  percentualComissaoSnapshot: number | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  subtotalCentavos: Centavos
  descontoCentavos: Centavos
  freteCentavos: Centavos
  totalCentavos: Centavos
  criadoEm: Date
}

function paraPedido(l: Selectable<Pedidos>): Pedido {
  return {
    id: l.id,
    numero: Number(l.numero),
    status: l.status,
    origem: l.origem,
    representanteId: l.representante_id,
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
 */
export async function criarPedido(e: EntradaPedido): Promise<Pedido> {
  const total = (e.subtotal - e.desconto + e.frete) as Centavos

  const linha = await getDb()
    .insertInto('pedidos')
    .values({
      origem: e.origem,
      representante_id: e.representanteId,
      percentual_comissao_snapshot: e.percentualComissao,
      utm_source: e.utmSource,
      utm_medium: e.utmMedium,
      utm_campaign: e.utmCampaign,
      subtotal_centavos: e.subtotal,
      desconto_centavos: e.desconto,
      frete_centavos: e.frete,
      total_centavos: total,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return paraPedido(linha)
}
