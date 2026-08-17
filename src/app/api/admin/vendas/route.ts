import { z } from 'zod'
import { exigirPapel } from '@/lib/guarda'
import {
  listarVendasAdmin, resumoDeVendas,
  type CanalVenda, type PedidoStatus,
} from '@/repositories/pedidos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/vendas — a tabela de vendas e os numeros do topo do painel
 * (§17 do documento do cliente de 16/08/2026).
 *
 * HANDLER FINO: nao ha uma linha de SQL aqui. Quem sabe ler venda e
 * src/repositories/pedidos.ts (listarVendasAdmin e resumoDeVendas), inclusive a
 * decisao de nunca fazer `selectAll('clientes')` para que o CPF de nenhum
 * comprador atravesse esta resposta. Esta rota so decide quem pode ver, valida
 * o filtro e serializa.
 */

/**
 * `Cache-Control: no-store` EM TODA RESPOSTA DE DADO, sem excecao.
 *
 * O corpo devolvido aqui carrega nome, e-mail e whatsapp de todo comprador do
 * lancamento, mais o faturamento da empresa. Um cache compartilhado na frente
 * da aplicacao (a CDN da Vercel, um proxy reverso, o cache do proprio
 * navegador em maquina compartilhada do escritorio) guarda por URL e serve a
 * quem pedir a mesma URL depois — e /api/admin/vendas e sempre a mesma URL. Sem
 * este cabecalho, a resposta de um admin logado pode ser entregue a uma
 * requisicao sem sessao nenhuma, e nao ha 401 que conserte isso porque a
 * requisicao nem chega ao servidor. exigirPapel (src/lib/guarda.ts) ja marca
 * assim as suas proprias recusas, pelo mesmo motivo.
 */
const SEM_CACHE = { 'Cache-Control': 'no-store' } as const

/**
 * OS VALORES SAO ESCRITOS A MAO, MAS NAO FICAM SOLTOS. O Zod valida em tempo de
 * execucao e os tipos do banco (CanalVenda, PedidoStatus, reexportados do ENUM
 * por src/repositories/pedidos.ts) so existem em tempo de compilacao — nao ha
 * como derivar a lista do tipo, entao a duplicacao e inevitavel. O que ela nao
 * pode ser e silenciosa: o `satisfies { [K in X]: K }` exige que as chaves
 * cubram o ENUM inteiro (chave faltando nao compila), proibe chave a mais
 * (excesso de propriedade) e amarra cada valor a propria chave (um
 * 'em_transito: "em_trasito"' com erro de digitacao nao compila).
 *
 * O dia em que o ENUM ganhar um valor novo — a migration
 * 1755300200000_status_em_transito.sql ja fez isso uma vez — a compilacao deste
 * arquivo quebra e alguem decide, por escrito, se o painel filtra por ele. A
 * alternativa (uma lista solta) deixaria o valor novo fora do filtro em
 * silencio: a tela ofereceria um status que a API responde com 422.
 */
const CANAIS = {
  presencial: 'presencial',
  online: 'online',
} as const satisfies { [K in CanalVenda]: K }

const STATUS = {
  pendente: 'pendente',
  aguardando_pagamento: 'aguardando_pagamento',
  pago: 'pago',
  em_preparacao: 'em_preparacao',
  enviado: 'enviado',
  em_transito: 'em_transito',
  entregue: 'entregue',
  cancelado: 'cancelado',
  reembolsado: 'reembolsado',
} as const satisfies { [K in PedidoStatus]: K }

/**
 * NAO SE CHAMA `Corpo` porque nao ha corpo: um GET nao tem body, e o que chega
 * do usuario aqui e a querystring. O padrao da casa (o schema de modulo do
 * mesmo nome em src/app/api/pedidos/route.ts) vale palavra por palavra em tudo
 * o mais — schema de modulo, `.strict()`, safeParse, erro achatado.
 *
 * O `.strict()` E A PARTE QUE IMPORTA, e o motivo e o mesmo do corpo do
 * checkout, com outra consequencia: `?canall=online` (um L a mais) sem
 * `.strict()` seria um filtro IGNORADO — a rota devolveria a tabela inteira e a
 * tela mostraria venda de todos os canais como se fosse o recorte pedido. Filtro
 * que falha em silencio e pior do que filtro que nao existe. Com `.strict()`,
 * o erro de digitacao e 422 explicito.
 *
 * A querystring NUNCA e interpolada em consulta nenhuma: o valor so chega ao
 * repositorio depois de virar um literal do ENUM aqui, e listarVendasAdmin usa
 * o parametrizador do Kysely (`.where('pedidos.canal', '=', ...)`) do outro
 * lado. Sao duas defesas independentes contra injecao, e nenhuma das duas
 * depende da outra.
 */
const Filtros = z.object({
  canal: z.enum(CANAIS).optional(),
  status: z.enum(STATUS).optional(),
}).strict()

export async function GET(req: Request) {
  // PRIMEIRA COISA DO HANDLER, antes de ler querystring e antes de qualquer
  // toque no banco. A ordem e contrato, nao estilo: uma consulta disparada
  // antes da checagem ja gastou conexao do pool (que tem 5) por conta de quem
  // nao esta autenticado, e um erro que vazasse dali dentro descreveria dado
  // que essa pessoa nao pode ver. src/app/api/__tests__/admin-guarda.test.ts
  // percorre todas as rotas /api/admin/* exigindo 401 sem cookie e 403 com
  // sessao de vendedor.
  const usuario = await exigirPapel(req, ['admin'])
  if (usuario instanceof Response) return usuario

  // Object.fromEntries em vez de ler parametro por parametro: e o que faz o
  // `.strict()` enxergar o que veio a mais. Lendo so `canal` e `status` da
  // querystring, qualquer outro parametro seria descartado antes do Zod e o
  // erro de digitacao voltaria a passar despercebido.
  const filtros = Filtros.safeParse(Object.fromEntries(new URL(req.url).searchParams))
  if (!filtros.success) {
    // Erro achatado, sem detalhe de campo — mesmo formato do resto da casa. O
    // painel e uma tela interna e a lista de valores validos e o proprio ENUM;
    // ecoar o relatorio do Zod aqui so acrescentaria vocabulario interno a uma
    // resposta que ninguem le a olho nu.
    return Response.json({ error: 'filtro_invalido' }, { status: 422, headers: SEM_CACHE })
  }

  // Duas leituras independentes, disparadas juntas: nenhuma depende do
  // resultado da outra e a tela mostra as duas ao mesmo tempo.
  //
  // O RESUMO NAO RESPEITA OS FILTROS, e isso e deliberado. `resumoDeVendas` e o
  // numero do lancamento inteiro — quanto vendeu, por canal e por forma de
  // pagamento. Se ele encolhesse junto com o filtro da tabela, o dono da
  // empresa clicaria em "canal: presencial" e leria um "faturamento" que nao e
  // o faturamento, sem nada na tela avisando do recorte. O recorte pertence a
  // tabela; o total, ao evento.
  const [vendas, resumo] = await Promise.all([
    listarVendasAdmin(filtros.data),
    resumoDeVendas(),
  ])

  return Response.json({ vendas, resumo }, { headers: SEM_CACHE })
}

/**
 * Os demais verbos respondem 405 com `Allow`, no padrao da casa
 * (src/app/api/pedidos/route.ts). Sem estes handlers o Next devolveria 405 por
 * conta propria, mas sem o cabecalho `Allow` e sem o corpo `{ error: ... }` que
 * todo cliente deste projeto espera.
 *
 * ESTA ROTA E SO LEITURA. Quem muda pedido e PATCH /api/admin/pedidos/[id]; um
 * POST aqui e sempre engano de quem chamou.
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
