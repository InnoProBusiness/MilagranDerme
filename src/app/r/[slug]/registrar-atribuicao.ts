import type { Atribuicao } from '@/lib/atribuicao'

const MAX_UTM = 120

export type Utm = {
  source: string | null
  medium: string | null
  campaign: string | null
}

function limitar(v: string | null): string | null {
  if (v === null) return null
  const limpo = v.trim()
  return limpo === '' ? null : limpo.slice(0, MAX_UTM)
}

/**
 * REGRA DE CONFLITO — LAST CLICK.
 *
 * Se o visitante ja tem atribuicao a um representante e entra pelo link de
 * outro, a atribuicao passa para o mais recente. Escolhemos last click
 * porque e a regra defensavel numa conversa entre pessoas que se conhecem:
 * quem falou com o cliente por ultimo foi quem fechou.
 *
 * Revisitar o MESMO representante nao reinicia a janela de 30 dias — senao
 * bastaria pedir ao cliente para reabrir o link para estender a atribuicao
 * indefinidamente.
 *
 * Esta e a regra do cookie. A hierarquia completa (cupom > last click >
 * first click) se completa no momento da criacao do pedido, no Plano 2,
 * onde o cupom informado tem prioridade sobre o cookie.
 */
export function resolverAtribuicao(params: {
  slugVisitado: string
  atual: Atribuicao | null
  utm: Utm
  agora: Date
}): { cookieNovo: Atribuicao | null; efetiva: Atribuicao } {
  const { slugVisitado, atual, utm, agora } = params

  if (atual && atual.slug === slugVisitado) {
    return { cookieNovo: null, efetiva: atual }
  }

  const nova: Atribuicao = {
    slug: slugVisitado,
    em: agora.getTime(),
    utmSource: limitar(utm.source),
    utmMedium: limitar(utm.medium),
    utmCampaign: limitar(utm.campaign),
  }
  return { cookieNovo: nova, efetiva: nova }
}
