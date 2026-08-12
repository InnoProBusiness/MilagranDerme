import type { Selectable, Transaction } from 'kysely'
import { getDb } from '@/lib/db'
import type { DB, Pagamentos, MetodoPagamento, PagamentoStatus } from '@/lib/db-types'
import { deInteiro, type Centavos } from '@/lib/money'

export type { MetodoPagamento, PagamentoStatus }

export type Pagamento = {
  id: string
  pedidoId: string
  provedor: string
  provedorId: string | null
  metodo: MetodoPagamento
  status: PagamentoStatus
  valorCentavos: Centavos
  parcelas: number
  criadoEm: Date
}

function paraPagamento(l: Selectable<Pagamentos>): Pagamento {
  return {
    id: l.id,
    pedidoId: l.pedido_id,
    provedor: l.provedor,
    provedorId: l.provedor_id,
    metodo: l.metodo,
    status: l.status,
    valorCentavos: deInteiro(l.valor_centavos),
    parcelas: l.parcelas,
    criadoEm: l.criado_em,
  }
}

/**
 * Abre a tentativa de pagamento ANTES de falar com o provedor.
 *
 * A ordem importa e nao e arbitraria: o id gerado aqui e usado como
 * X-Idempotency-Key na chamada ao Mercado Pago. Se a requisicao expirar sem
 * resposta e o comprador clicar de novo, a retentativa com a mesma chave
 * devolve o pagamento ja criado em vez de cobrar duas vezes. Criar a linha
 * depois da chamada tornaria essa chave impossivel — nao haveria identificador
 * estavel antes do round trip.
 *
 * provedor_id nasce NULL e e preenchido por vincularAoProvedor logo em
 * seguida. A janela entre os dois e o unico momento em que existe uma linha
 * sem contraparte no provedor; se o processo morrer exatamente ali, o webhook
 * reconcilia pelo external_reference (que e o id do pedido) e a linha orfa
 * fica visivel como tentativa que nao completou.
 */
export async function abrirPagamento(
  e: {
    pedidoId: string
    metodo: MetodoPagamento
    valor: Centavos
    parcelas: number
  },
  trx?: Transaction<DB>,
): Promise<Pagamento> {
  const executar = async (t: Transaction<DB> | ReturnType<typeof getDb>) => {
    const linha = await t
      .insertInto('pagamentos')
      .values({
        pedido_id: e.pedidoId,
        metodo: e.metodo,
        valor_centavos: e.valor,
        parcelas: e.parcelas,
        status: 'pendente',
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return paraPagamento(linha)
  }
  return trx ? executar(trx) : executar(getDb())
}

/** Grava o id do provedor e o status que ele devolveu na criacao. */
export async function vincularAoProvedor(
  id: string,
  provedorId: string,
  status: PagamentoStatus,
  trx?: Transaction<DB>,
): Promise<Pagamento> {
  const t = trx ?? getDb()
  const linha = await t
    .updateTable('pagamentos')
    .set({ provedor_id: provedorId, status, atualizado_em: new Date() })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow()
  return paraPagamento(linha)
}

/**
 * Atualiza o status de um pagamento identificado pelo id do PROVEDOR — que e
 * o unico identificador que o webhook carrega.
 *
 * Devolve null quando nao ha linha correspondente. Nao e erro: acontece
 * quando o processo morreu entre abrirPagamento e vincularAoProvedor, ou
 * quando um pagamento foi criado por fora (um teste no painel do Mercado
 * Pago, por exemplo). O webhook trata esse caso conciliando pelo pedido.
 */
export async function atualizarStatusPorProvedorId(
  provedorId: string,
  status: PagamentoStatus,
  trx: Transaction<DB>,
): Promise<Pagamento | null> {
  const linha = await trx
    .updateTable('pagamentos')
    .set({ status, atualizado_em: new Date() })
    .where('provedor_id', '=', provedorId)
    .returningAll()
    .executeTakeFirst()
  return linha ? paraPagamento(linha) : null
}

export type PedidoParaPagamento = {
  id: string
  numero: number
  status: string
  totalCentavos: Centavos
  clienteNome: string
  clienteEmail: string
  clienteCpf: string
}

/**
 * Le o pedido pelo token publico junto dos dados do comprador que o Mercado
 * Pago exige no campo `payer`.
 *
 * Existe separada de buscarPedidoComItensPorToken porque carrega CPF e
 * e-mail: a pagina de confirmacao (publica, sem autenticacao) usa aquela; so
 * a rota de pagamento, que fala com o gateway, usa esta.
 */
export async function buscarPedidoParaPagamento(
  token: string,
): Promise<PedidoParaPagamento | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) return null

  const l = await getDb()
    .selectFrom('pedidos')
    .innerJoin('clientes', 'clientes.id', 'pedidos.cliente_id')
    .select([
      'pedidos.id as id', 'pedidos.numero as numero', 'pedidos.status as status',
      'pedidos.total_centavos as total',
      'clientes.nome as nome', 'clientes.email as email', 'clientes.cpf as cpf',
    ])
    .where('pedidos.token', '=', token)
    .executeTakeFirst()

  if (!l) return null

  return {
    id: l.id,
    numero: Number(l.numero),
    status: l.status,
    totalCentavos: deInteiro(l.total),
    clienteNome: l.nome,
    clienteEmail: l.email,
    clienteCpf: l.cpf,
  }
}

export async function listarPagamentosDoPedido(pedidoId: string): Promise<Pagamento[]> {
  const linhas = await getDb()
    .selectFrom('pagamentos')
    .selectAll()
    .where('pedido_id', '=', pedidoId)
    .orderBy('criado_em', 'desc')
    .orderBy('id', 'desc')
    .execute()
  return linhas.map(paraPagamento)
}
