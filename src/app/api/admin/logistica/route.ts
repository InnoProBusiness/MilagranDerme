import { exigirPapel } from '@/lib/guarda'
import { listarLogisticaAdmin } from '@/repositories/pedidos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/logistica — a fila da expedicao (§17): o que ha para
 * despachar, para onde, e o rastreio do que ja saiu.
 *
 * HANDLER FINO ao extremo: a rota nao decide recorte nenhum. Quem define que
 * esta tela e "pedido pago que tem endereco" — e nao "pedido do canal online" —
 * e listarLogisticaAdmin (src/repositories/pedidos.ts), junto com a razao por
 * extenso: a venda de balcao sai na mao do comprador e nunca tem endereco,
 * entao ela cai fora sozinha pelo INNER JOIN, sem ninguem precisar lembrar de
 * filtrar por canal. Reescrever esse recorte aqui criaria uma segunda verdade
 * sobre o que a expedicao tem a fazer.
 *
 * A ESCRITA correspondente e PATCH /api/admin/pedidos/[id]: e por la que o
 * codigo de rastreio entra e que o pedido anda de 'pago' ate 'entregue'.
 */

/**
 * Mesmo motivo das outras rotas do painel — e aqui e o caso mais literal de
 * todos: o corpo desta resposta e o endereco residencial completo de cada
 * comprador (CEP, rua, numero, complemento, bairro). Uma copia disso em cache
 * compartilhado e uma lista de enderecos servida a quem pedir a URL.
 */
const SEM_CACHE = { 'Cache-Control': 'no-store' } as const

export async function GET(req: Request) {
  // Primeira coisa do handler, antes de qualquer leitura de banco — ver
  // src/lib/guarda.ts e src/app/api/__tests__/admin-guarda.test.ts.
  const usuario = await exigirPapel(req, ['admin'])
  if (usuario instanceof Response) return usuario

  const pedidos = await listarLogisticaAdmin()

  return Response.json({ pedidos }, { headers: SEM_CACHE })
}

/**
 * Demais verbos: 405 com `Allow`, padrao da casa
 * (src/app/api/pedidos/route.ts).
 */
function metodoNaoPermitido() {
  return Response.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET' },
  })
}

export const POST = metodoNaoPermitido
export const PUT = metodoNaoPermitido
export const PATCH = metodoNaoPermitido
export const DELETE = metodoNaoPermitido
