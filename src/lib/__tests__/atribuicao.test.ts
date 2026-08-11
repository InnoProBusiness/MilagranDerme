import { describe, it, expect } from 'vitest'
import {
  assinarAtribuicao, verificarAtribuicao, NOME_COOKIE_ATRIBUICAO,
  JANELA_ATRIBUICAO_DIAS, type Atribuicao,
} from '@/lib/atribuicao'

const SEGREDO = 'a'.repeat(64)
const base: Atribuicao = {
  slug: 'maria',
  em: Date.parse('2026-08-11T12:00:00Z'),
  utmSource: 'instagram',
  utmMedium: 'bio',
  utmCampaign: 'lancamento',
}

describe('cookie de atribuicao', () => {
  it('usa o prefixo __Host-, que proibe subdominio sobrescrever', () => {
    expect(NOME_COOKIE_ATRIBUICAO).toBe('__Host-mg_attr')
  })

  it('faz ida e volta preservando todos os campos', () => {
    const v = verificarAtribuicao(assinarAtribuicao(base, SEGREDO), SEGREDO,
      new Date('2026-08-12T12:00:00Z'))
    expect(v).toEqual(base)
  })

  it('rejeita payload adulterado', () => {
    const assinado = assinarAtribuicao(base, SEGREDO)
    const [payload, sig] = assinado.split('.')
    const outro = Buffer.from(
      JSON.stringify({ ...base, slug: 'joao' }),
    ).toString('base64url')
    expect(verificarAtribuicao(`${outro}.${sig}`, SEGREDO,
      new Date('2026-08-12T12:00:00Z'))).toBeNull()
    expect(payload).not.toBe(outro)
  })

  it('rejeita assinatura de outro segredo', () => {
    const assinado = assinarAtribuicao(base, SEGREDO)
    expect(verificarAtribuicao(assinado, 'b'.repeat(64),
      new Date('2026-08-12T12:00:00Z'))).toBeNull()
  })

  it('rejeita valor malformado sem estourar', () => {
    for (const lixo of ['', '.', 'abc', 'a.b.c', 'nao-base64.xx']) {
      expect(() => verificarAtribuicao(lixo, SEGREDO)).not.toThrow()
      expect(verificarAtribuicao(lixo, SEGREDO)).toBeNull()
    }
  })

  it('aceita dentro da janela de 30 dias', () => {
    const quase = new Date(base.em + (JANELA_ATRIBUICAO_DIAS - 1) * 86_400_000)
    expect(verificarAtribuicao(assinarAtribuicao(base, SEGREDO), SEGREDO, quase))
      .not.toBeNull()
  })

  it('expira depois da janela de 30 dias', () => {
    const depois = new Date(base.em + (JANELA_ATRIBUICAO_DIAS + 1) * 86_400_000)
    expect(verificarAtribuicao(assinarAtribuicao(base, SEGREDO), SEGREDO, depois))
      .toBeNull()
  })

  it('aceita atribuicao sem UTM', () => {
    const semUtm: Atribuicao = { slug: 'ana', em: base.em, utmSource: null, utmMedium: null, utmCampaign: null }
    expect(verificarAtribuicao(assinarAtribuicao(semUtm, SEGREDO), SEGREDO,
      new Date('2026-08-12T12:00:00Z'))).toEqual(semUtm)
  })
})
