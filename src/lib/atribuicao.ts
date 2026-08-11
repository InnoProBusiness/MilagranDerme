import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Prefixo __Host-: o navegador so aceita o cookie se ele for Secure,
 * Path=/ e SEM atributo Domain. Isso impede que qualquer subdominio
 * sobrescreva a atribuicao pelo navegador — defesa em profundidade
 * gratuita, complementar ao HMAC.
 */
export const NOME_COOKIE_ATRIBUICAO = '__Host-mg_attr'
export const JANELA_ATRIBUICAO_DIAS = 30

export type Atribuicao = {
  slug: string
  /** Instante da primeira visita, em epoch ms. */
  em: number
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
}

function assinar(payload: string, segredo: string): string {
  return createHmac('sha256', segredo).update(payload).digest('base64url')
}

export function assinarAtribuicao(a: Atribuicao, segredo: string): string {
  const payload = Buffer.from(JSON.stringify(a)).toString('base64url')
  return `${payload}.${assinar(payload, segredo)}`
}

export function verificarAtribuicao(
  valor: string,
  segredo: string,
  agora: Date = new Date(),
): Atribuicao | null {
  const partes = valor.split('.')
  if (partes.length !== 2) return null
  const [payload, assinaturaRecebida] = partes as [string, string]
  if (!payload || !assinaturaRecebida) return null

  const esperada = assinar(payload, segredo)
  // timingSafeEqual estoura se os buffers tiverem tamanhos diferentes —
  // caso tipico de atacante sondando o endpoint. Comparar tamanho antes.
  const a = Buffer.from(assinaturaRecebida)
  const b = Buffer.from(esperada)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let dados: unknown
  try {
    dados = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  if (typeof dados !== 'object' || dados === null) return null
  const d = dados as Record<string, unknown>
  if (typeof d.slug !== 'string' || typeof d.em !== 'number') return null

  const limite = d.em + JANELA_ATRIBUICAO_DIAS * 86_400_000
  if (agora.getTime() > limite) return null

  const texto = (v: unknown): string | null => (typeof v === 'string' ? v : null)

  return {
    slug: d.slug,
    em: d.em,
    utmSource: texto(d.utmSource),
    utmMedium: texto(d.utmMedium),
    utmCampaign: texto(d.utmCampaign),
  }
}
