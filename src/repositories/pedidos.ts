import type { Selectable } from 'kysely'
import { getDb } from '@/lib/db'
import type { Pedidos, OrigemAtribuicao, PedidoStatus } from '@/lib/db-types'
import { deInteiro, type Centavos } from '@/lib/money'

// kysely-codegen ja gera unions literais a partir dos ENUMs do Postgres
// (ver migrations/1754900300000_pedidos.sql): origem_atribuicao vira
// 'link' | 'cupom' | 'casa' | 'rep_inativo' e pedido_status vira os oito
// estados. Reexportar em vez de redeclarar evita que o tipo do repositorio
// e o ENUM do banco divirjam com o tempo — e e o que da a maquina de
// estados do Plano 3 uma checagem de exaustividade de verdade no switch.
export type { OrigemAtribuicao, PedidoStatus }

export type ItemDoPedido = {
  kitId: string
  quantidade: number
  precoUnitarioCentavos: Centavos
}

export type EntradaPedido = {
  origem: OrigemAtribuicao
  representanteId: string | null
  percentualComissao: number | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  desconto: Centavos
  frete: Centavos
  itens: ItemDoPedido[]
}

export type Pedido = {
  id: string
  numero: number
  status: PedidoStatus
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
 *
 * O subtotal NAO vem da aplicacao: e a soma dos itens, e quem garante isso
 * e o trigger CONSTRAINT DEFERRABLE pedido_subtotal_confere_trg (migrations/
 * 1755000000000_pedido_itens.sql), que roda no COMMIT desta transacao — nao
 * a cada INSERT. A soma calculada aqui em JS e so o valor a gravar em
 * subtotal_centavos; se ela nao bater com a soma real dos itens que o banco
 * ve, o COMMIT falha. A comissao do representante incide sobre esse valor
 * amarrado ao banco, nao sobre uma soma que a aplicacao poderia errar.
 */
export async function criarPedido(e: EntradaPedido): Promise<Pedido> {
  if (e.itens.length === 0) {
    throw new Error('Pedido sem itens nao pode ser criado')
  }

  const subtotal = e.itens.reduce(
    (acc, i) => acc + i.precoUnitarioCentavos * i.quantidade,
    0,
  ) as Centavos
  const total = (subtotal - e.desconto + e.frete) as Centavos

  return getDb().transaction().execute(async (trx) => {
    const linha = await trx
      .insertInto('pedidos')
      .values({
        origem: e.origem,
        representante_id: e.representanteId,
        percentual_comissao_snapshot: e.percentualComissao,
        utm_source: e.utmSource,
        utm_medium: e.utmMedium,
        utm_campaign: e.utmCampaign,
        subtotal_centavos: subtotal,
        desconto_centavos: e.desconto,
        frete_centavos: e.frete,
        total_centavos: total,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    // Nome e preco vem do catalogo AGORA e viram snapshot na linha do item:
    // se o preco do kit mudar amanha, o pedido de hoje continua valendo o
    // que valia hoje — mesmo principio do percentual_comissao_snapshot.
    for (const item of e.itens) {
      const kit = await trx
        .selectFrom('kits')
        .select(['nome', 'preco_centavos'])
        .where('id', '=', item.kitId)
        .executeTakeFirstOrThrow()

      await trx
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
  })
}
