import type { Transaction } from 'kysely'
import { sql } from 'kysely'
import { getDb } from '@/lib/db'
import type { DB } from '@/lib/db-types'
import { deInteiro, calcularComissao, type Centavos } from '@/lib/money'
import { liberacaoDaComissao } from '@/lib/comissao'

export type EntradaCredito = {
  pedidoId: string
  representanteId: string
  /**
   * Base de calculo: subtotal JA COM o desconto do cupom, SEM frete. Quem
   * monta este valor e o webhook, a partir das colunas congeladas do pedido
   * — nunca de um numero recalculado a partir do catalogo atual.
   */
  base: Centavos
  percentual: number
  pagoEm: Date
}

export type Lancamento = {
  id: string
  representanteId: string
  pedidoId: string | null
  tipo: 'credito' | 'estorno' | 'saque' | 'ajuste'
  valorCentavos: Centavos
  disponivelEm: Date
  descricao: string
  criadoEm: Date
}

/**
 * Credita a comissao de um pedido pago.
 *
 * NAO faz nenhuma checagem de "ja creditou antes" em JavaScript, de proposito.
 * Quem garante credito unico por pedido e o indice
 * comissao_um_credito_por_pedido (migrations/1755200100000_comissoes.sql);
 * uma verificacao previa em JS seria uma corrida — dois webhooks concorrentes
 * do mesmo pagamento leriam "nao existe" ao mesmo tempo e os dois inseririam.
 * Uma violacao de unicidade aqui e um defeito de verdade e deve estourar, e
 * nao ser engolida com onConflict().doNothing().
 *
 * O chamador (a rota de webhook) ja segura a linha do pedido com FOR UPDATE
 * antes de chegar aqui; este indice e a segunda linha de defesa, nao a
 * primeira.
 */
export async function creditarComissao(
  e: EntradaCredito,
  trx: Transaction<DB>,
  numeroDoPedido?: number,
): Promise<Lancamento> {
  const valor = calcularComissao(e.base, e.percentual)
  if (valor <= 0) {
    throw new Error(
      `Comissao calculada e ${valor} centavos: nao ha o que creditar. ` +
        `Base ${e.base}, percentual ${e.percentual}.`,
    )
  }

  const linha = await trx
    .insertInto('comissoes')
    .values({
      representante_id: e.representanteId,
      pedido_id: e.pedidoId,
      tipo: 'credito',
      valor_centavos: valor,
      disponivel_em: liberacaoDaComissao(e.pagoEm),
      descricao: numeroDoPedido ? `Pedido #${numeroDoPedido}` : 'Venda',
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return paraLancamento(linha)
}

/**
 * Reverte o credito de um pedido que deixou de valer (reembolso ou
 * chargeback).
 *
 * Devolve null quando nao ha credito a reverter — pedido da casa, sem
 * representante, ou pedido que nunca chegou a ser pago. Nao e erro: e o caso
 * normal para toda venda do perfil oficial.
 *
 * O estorno COPIA o disponivel_em do credito original em vez de carimbar
 * agora. Se o credito ainda esta pendente, os dois lancamentos se anulam
 * dentro do pendente; carimbar now() faria o disponivel do representante
 * ficar negativo e o pendente positivo pelo mesmo valor, para uma venda que
 * simplesmente deixou de existir.
 */
export async function estornarComissao(
  pedidoId: string,
  trx: Transaction<DB>,
): Promise<Lancamento | null> {
  const credito = await trx
    .selectFrom('comissoes')
    .selectAll()
    .where('pedido_id', '=', pedidoId)
    .where('tipo', '=', 'credito')
    .executeTakeFirst()

  if (!credito) return null

  const linha = await trx
    .insertInto('comissoes')
    .values({
      representante_id: credito.representante_id,
      pedido_id: pedidoId,
      tipo: 'estorno',
      valor_centavos: -credito.valor_centavos,
      disponivel_em: credito.disponivel_em,
      descricao: `Estorno — ${credito.descricao}`,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return paraLancamento(linha)
}

export type SaldoDoRepresentante = {
  /** Ja liberado: disponivel_em <= agora. E o que pode ser sacado. */
  disponivel: Centavos
  /** Ainda em carencia: disponivel_em > agora. */
  pendente: Centavos
  /** Soma historica de todos os creditos, sem descontar estorno nem saque. */
  totalCreditado: Centavos
  /** Quanto ja saiu em saques, como numero positivo. */
  totalSacado: Centavos
}

/**
 * Saldo do representante, sempre derivado das linhas do livro-razao. Nao ha
 * coluna de saldo em lugar nenhum do banco — ver o cabecalho da migration.
 *
 * O corte entre disponivel e pendente usa a forma semiaberta com o instante
 * `agora` passado explicitamente, e nao now() do banco, para que o teste
 * consiga posicionar o relogio dos dois lados da carencia sem esperar
 * trinta dias.
 */
export async function saldoDoRepresentante(
  representanteId: string,
  agora: Date = new Date(),
): Promise<SaldoDoRepresentante> {
  const r = await getDb()
    .selectFrom('comissoes')
    .where('representante_id', '=', representanteId)
    .select([
      sql<number>`COALESCE(SUM(valor_centavos) FILTER (WHERE disponivel_em <= ${agora}), 0)`.as('disponivel'),
      sql<number>`COALESCE(SUM(valor_centavos) FILTER (WHERE disponivel_em > ${agora}), 0)`.as('pendente'),
      sql<number>`COALESCE(SUM(valor_centavos) FILTER (WHERE tipo = 'credito'), 0)`.as('creditado'),
      sql<number>`COALESCE(-SUM(valor_centavos) FILTER (WHERE tipo = 'saque'), 0)`.as('sacado'),
    ])
    .executeTakeFirstOrThrow()

  // SUM() em Postgres devolve numeric para integer, que o driver entrega como
  // string; o parser global de INT8 (src/lib/db.ts) nao cobre numeric. Number()
  // explicito aqui evita "12" + "34" = "1234" no extrato.
  return {
    disponivel: deInteiro(Number(r.disponivel)),
    pendente: deInteiro(Number(r.pendente)),
    totalCreditado: deInteiro(Number(r.creditado)),
    totalSacado: deInteiro(Number(r.sacado)),
  }
}

/** Extrato do representante, do mais recente para o mais antigo. */
export async function listarLancamentos(
  representanteId: string,
  limite = 100,
): Promise<Lancamento[]> {
  const linhas = await getDb()
    .selectFrom('comissoes')
    .selectAll()
    .where('representante_id', '=', representanteId)
    // criado_em sozinho nao desempata: varios lancamentos da mesma transacao
    // carregam o mesmo timestamp (now() e o inicio da transacao). Mesmo
    // desempate por id usado em buscarPedidoComItensPorToken.
    .orderBy('criado_em', 'desc')
    .orderBy('id', 'desc')
    .limit(limite)
    .execute()

  return linhas.map(paraLancamento)
}

function paraLancamento(l: {
  id: string
  representante_id: string
  pedido_id: string | null
  tipo: 'credito' | 'estorno' | 'saque' | 'ajuste'
  valor_centavos: number
  disponivel_em: Date
  descricao: string
  criado_em: Date
}): Lancamento {
  return {
    id: l.id,
    representanteId: l.representante_id,
    pedidoId: l.pedido_id,
    tipo: l.tipo,
    // A coluna ja esta em centavos inteiros: deInteiro apenas atesta o tipo.
    // centavos() aqui multiplicaria por 100 de novo, em silencio.
    valorCentavos: deInteiro(l.valor_centavos),
    disponivelEm: l.disponivel_em,
    descricao: l.descricao,
    criadoEm: l.criado_em,
  }
}
