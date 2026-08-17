import { z } from 'zod'
import { exigirPapel } from '@/lib/guarda'
import { listarLeads, type TipoLead } from '@/repositories/leads'
import { listarCompradores } from '@/repositories/pedidos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/leads — os quatro publicos de §17: interessados,
 * representantes, distribuidores e COMPRADORES.
 *
 * OS QUATRO NAO VEM DA MESMA TABELA, e nao e descuido. Os tres primeiros sao
 * `tipo_lead` em `leads` (migrations/1755300400000_leads.sql); comprador e
 * DERIVADO de clientes + pedidos (listarCompradores,
 * src/repositories/pedidos.ts). Duplicar comprador dentro de `leads` criaria
 * duas verdades sobre a mesma pessoa, divergindo na primeira escrita que
 * atualizasse uma e esquecesse a outra — a decisao esta escrita na propria
 * migration e nao se repete aqui.
 *
 * A consequencia pratica para quem consome esta rota: `?tipo=` filtra APENAS a
 * lista de leads, e 'comprador' nao e um valor aceito porque nao existe no ENUM
 * tipo_lead. A tela de quatro abas monta a quarta com a chave `compradores`.
 */

/**
 * Esta e a resposta mais sensivel do painel inteiro sob a otica da LGPD: e uma
 * lista de contato — nome, e-mail e whatsapp — de todo mundo que se cadastrou
 * ou comprou. Cache compartilhado nunca; ver o comentario longo em
 * src/app/api/admin/vendas/route.ts.
 */
const SEM_CACHE = { 'Cache-Control': 'no-store' } as const

/**
 * Mesmo raciocinio do mapa de canais/status em
 * src/app/api/admin/vendas/route.ts: a lista e escrita a mao porque Zod valida
 * em tempo de execucao e o tipo TipoLead so existe em tempo de compilacao, mas
 * o `satisfies { [K in TipoLead]: K }` faz o compilador cobrar a cobertura
 * exata do ENUM. Um quarto tipo de lead acrescentado a migration quebra a
 * compilacao aqui em vez de virar um filtro que a tela oferece e a API recusa.
 */
const TIPOS = {
  interessado: 'interessado',
  representante: 'representante',
  distribuidor: 'distribuidor',
} as const satisfies { [K in TipoLead]: K }

/**
 * NAO SE CHAMA `Corpo` porque um GET nao tem corpo — o que chega do usuario e a
 * querystring. Todo o resto do padrao da casa vale igual, `.strict()` incluso:
 * `?tipoo=representante` sem ele devolveria a lista INTEIRA de leads como se
 * fosse o recorte pedido, e quem estivesse ligando para os candidatos a
 * representante ligaria para todo mundo sem perceber.
 */
const Filtros = z.object({
  tipo: z.enum(TIPOS).optional(),
}).strict()

export async function GET(req: Request) {
  // Primeira coisa do handler, antes de qualquer leitura de banco.
  const usuario = await exigirPapel(req, ['admin'])
  if (usuario instanceof Response) return usuario

  // Object.fromEntries para que o `.strict()` enxergue parametro que veio a
  // mais — ler `tipo` sozinho descartaria o erro de digitacao antes do Zod.
  const filtros = Filtros.safeParse(Object.fromEntries(new URL(req.url).searchParams))
  if (!filtros.success) {
    return Response.json({ error: 'filtro_invalido' }, { status: 422, headers: SEM_CACHE })
  }

  // `compradores` VEM SEMPRE, com ou sem filtro, e a chave existe mesmo quando
  // a lista esta vazia. Duas razoes. A primeira e de contrato: uma chave que
  // aparece e some conforme a querystring obriga a tela a distinguir "nao veio"
  // de "veio vazio" — e a leitura errada dessa diferenca e uma aba de
  // compradores em branco no dia do evento. A segunda e conceitual: comprador
  // nao e um tipo de lead, entao `?tipo=` nao tem o que dizer sobre ele. Filtrar
  // uma lista pelo filtro da outra seria inventar uma relacao que nao existe.
  const [leads, compradores] = await Promise.all([
    listarLeads(filtros.data.tipo),
    listarCompradores(),
  ])

  return Response.json({ leads, compradores }, { headers: SEM_CACHE })
}

/**
 * Demais verbos: 405 com `Allow`, padrao da casa.
 *
 * CADASTRAR lead e POST /api/leads, que e PUBLICO e rate-limited — o
 * formulario da loja escreve por la. Esta rota e so a leitura do painel; um
 * POST aqui seria um segundo caminho de escrita para a mesma tabela, com outra
 * validacao e sem o freio de abuso.
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
