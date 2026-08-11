import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import {
  NOME_COOKIE_ATRIBUICAO, JANELA_ATRIBUICAO_DIAS,
  assinarAtribuicao, verificarAtribuicao, segredoDeAtribuicao,
} from '@/lib/atribuicao'
import { resolverAtribuicao } from '@/app/r/[slug]/registrar-atribuicao'
import { buscarRepresentanteAtivoPorSlug } from '@/repositories/representantes'

/**
 * Server Components nao podem escrever cookies durante o render (Next.js
 * so permite cookies().set() em Server Action ou Route Handler). Como
 * /r/[slug] precisa gravar o cookie de atribuicao na MESMA resposta que
 * serve a pagina — sem round-trip extra no cliente, que arriscaria perder
 * a atribuicao se o visitante sair antes de um segundo request completar —
 * a gravacao acontece aqui, antes da pagina renderizar. A logica pura
 * (resolverAtribuicao) e a mesma usada nos testes; o proxy so adapta
 * NextRequest/NextResponse a ela.
 *
 * Nome do arquivo: "proxy.ts", nao "middleware.ts" — a partir do Next.js 16
 * a convencao "middleware" foi renomeada para "proxy" (o antigo nome fica
 * deprecated, com aviso no build). Proxy roda em runtime Node.js sempre —
 * por isso node:crypto (usado em assinarAtribuicao/verificarAtribuicao) e
 * o driver pg (usado em buscarRepresentanteAtivoPorSlug) funcionam aqui sem
 * config extra. Ver https://nextjs.org/docs/messages/middleware-to-proxy
 */
export const config = {
  matcher: '/r/:slug',
}

/**
 * Extrai o slug da rota /r/<slug> EXATAMENTE como a pagina o enxerga.
 *
 * Isso nao e detalhe de estilo, e dinheiro: `nextUrl.pathname` nunca vem
 * percent-decoded (WHATWG URL preserva as sequencias %XX), enquanto o
 * `params.slug` que src/app/r/[slug]/page.tsx recebe do Next JA vem
 * decodificado. Sem o decode aqui, /r/mar%69a fazia o proxy procurar
 * "mar%69a" (nao existe -> sai sem cookie) e a pagina procurar "maria"
 * (existe -> renderiza 200). O visitante via a pagina da Maria, comprava, e
 * o pedido era gravado como venda da casa: Maria nao recebia e nada
 * registrava o ocorrido.
 *
 * decodeURIComponent lanca URIError em sequencia percent malformada
 * ("%E0%A4%A"); nesse caso o slug e tratado como inexistente (sem cookie,
 * requisicao segue), nunca como erro — um 500 no proxy derrubaria a pagina
 * inteira por causa de uma URL torta.
 */
function slugDaRota(pathname: string): string | null {
  // pathname.split('/').pop() pareceria equivalente, mas devolve '' para
  // "/r/maria/" (barra final) em vez de 'maria' — o regex ancorado no
  // segmento evita esse caso.
  const bruto = pathname.match(/^\/r\/([^/]+)/)?.[1]
  if (!bruto) return null
  try {
    return decodeURIComponent(bruto)
  } catch {
    return null
  }
}

/**
 * Migalha de log, nao framework de observabilidade. Todo caminho em que a
 * atribuicao se perde era indistinguivel de sucesso: um slug morto, um
 * cookie adulterado e uma visita normal produziam exatamente a mesma
 * resposta e zero linhas de log. Quando um representante diz "mandei
 * quarenta pessoas e me creditaram tres", isto e o que existe para
 * responder.
 *
 * Nunca recebe o valor do cookie, a assinatura nem o segredo. O slug vai
 * como propriedade de objeto (e nao concatenado na mensagem) para que o
 * inspect do Node escape quebras de linha — slug vem da URL e e conteudo
 * do visitante ate a consulta no banco dizer o contrario.
 */
function avisar(evento: string, dados: Record<string, string>): void {
  console.warn(`[atribuicao] ${evento}`, dados)
}

const MAX_SLUG_LOG = 64

export async function proxy(request: NextRequest) {
  const slugVisitado = slugDaRota(request.nextUrl.pathname)
  if (slugVisitado === null) {
    avisar('slug ignorado', {
      caminho: request.nextUrl.pathname.slice(0, MAX_SLUG_LOG),
      motivo: 'percent_encoding_invalido',
    })
    return NextResponse.next()
  }

  // Slug invalido/inativo nao deve tocar o cookie. Sem este check, um link
  // morto (representante desligado ou digitado errado) sofreria LAST CLICK
  // contra uma atribuicao valida existente e apagaria a atribuicao de quem
  // realmente fechou a venda — a pagina so vai devolver 404 depois, mas o
  // estrago no cookie ja estaria feito. O 404 em si continua sendo
  // responsabilidade da pagina (notFound()), que roda esta mesma consulta.
  // A pagina em src/app/r/[slug]/page.tsx faz esta MESMA consulta de novo,
  // de proposito — nao encaminhe o resultado daqui para la via header. Um
  // header so e confiavel se for removido de QUALQUER requisicao de
  // entrada em TODO caminho deste proxy, inclusive este early return, onde
  // os headers originais do cliente passam intactos; esquecer um caminho
  // vira um jeito de forjar atribuicao. Duas consultas baratas numa coluna
  // com indice unico custa menos do que esse invariante de seguranca.
  const representante = await buscarRepresentanteAtivoPorSlug(slugVisitado)
  if (!representante) {
    avisar('visita sem representante ativo', {
      slug: slugVisitado.slice(0, MAX_SLUG_LOG),
      motivo: 'slug_inexistente_ou_inativo',
    })
    return NextResponse.next()
  }

  const segredo = segredoDeAtribuicao()

  const bruto = request.cookies.get(NOME_COOKIE_ATRIBUICAO)?.value ?? null
  const atual = bruto ? verificarAtribuicao(bruto, segredo) : null
  if (bruto && !atual) {
    // Cookie existia e nao passou: assinatura invalida, payload adulterado
    // ou janela de 30 dias vencida. Sem esta linha, o caso e identico a
    // "visitante sem cookie" — inclusive quando a causa e um segredo
    // rotacionado, que invalida a atribuicao de TODO MUNDO de uma vez.
    avisar('cookie descartado', {
      slug: slugVisitado.slice(0, MAX_SLUG_LOG),
      motivo: 'assinatura_invalida_ou_expirado',
    })
  }

  const { cookieNovo } = resolverAtribuicao({
    slugVisitado,
    atual,
    utm: {
      source: request.nextUrl.searchParams.get('utm_source'),
      medium: request.nextUrl.searchParams.get('utm_medium'),
      campaign: request.nextUrl.searchParams.get('utm_campaign'),
    },
    agora: new Date(),
  })

  const response = NextResponse.next()
  if (cookieNovo) {
    response.cookies.set(NOME_COOKIE_ATRIBUICAO, assinarAtribuicao(cookieNovo, segredo), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: JANELA_ATRIBUICAO_DIAS * 86_400,
    })
  }
  return response
}
