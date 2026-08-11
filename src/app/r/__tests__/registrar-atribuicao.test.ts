import { describe, it, expect } from 'vitest'
import { resolverAtribuicao } from '@/app/r/[slug]/registrar-atribuicao'
import type { Atribuicao } from '@/lib/atribuicao'

const emAgosto = Date.parse('2026-08-11T12:00:00Z')
const existente: Atribuicao = {
  slug: 'maria', em: emAgosto,
  utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
}

describe('resolucao de atribuicao', () => {
  it('grava a atribuicao quando nao existe nenhuma', () => {
    const r = resolverAtribuicao({
      slugVisitado: 'maria', atual: null,
      utm: { source: 'instagram', medium: 'bio', campaign: 'lancamento' },
      agora: new Date(emAgosto),
    })
    expect(r.efetiva.slug).toBe('maria')
    expect(r.cookieNovo?.slug).toBe('maria')
  })

  it('LAST CLICK: visitar outro representante transfere a atribuicao', () => {
    const r = resolverAtribuicao({
      slugVisitado: 'joao', atual: existente,
      utm: { source: null, medium: null, campaign: null },
      agora: new Date(emAgosto + 86_400_000),
    })
    expect(r.efetiva.slug).toBe('joao')
    expect(r.cookieNovo?.slug).toBe('joao')
  })

  it('revisitar o mesmo representante NAO reinicia a janela de 30 dias', () => {
    const r = resolverAtribuicao({
      slugVisitado: 'maria', atual: existente,
      utm: { source: null, medium: null, campaign: null },
      agora: new Date(emAgosto + 10 * 86_400_000),
    })
    expect(r.efetiva.em).toBe(emAgosto)
    expect(r.cookieNovo).toBeNull()
  })

  it('preserva o UTM da primeira visita quando a revisita nao traz UTM', () => {
    const r = resolverAtribuicao({
      slugVisitado: 'maria', atual: existente,
      utm: { source: null, medium: null, campaign: null },
      agora: new Date(emAgosto + 86_400_000),
    })
    expect(r.efetiva.utmSource).toBe('instagram')
  })

  it('troca de representante carrega o UTM da nova visita', () => {
    const r = resolverAtribuicao({
      slugVisitado: 'joao', atual: existente,
      utm: { source: 'whatsapp', medium: 'direct', campaign: 'agosto' },
      agora: new Date(emAgosto + 86_400_000),
    })
    expect(r.efetiva.utmSource).toBe('whatsapp')
    expect(r.efetiva.utmCampaign).toBe('agosto')
  })

  it('trunca UTM absurdamente longo em vez de gravar lixo no cookie', () => {
    const r = resolverAtribuicao({
      slugVisitado: 'maria', atual: null,
      utm: { source: 'x'.repeat(500), medium: null, campaign: null },
      agora: new Date(emAgosto),
    })
    expect(r.efetiva.utmSource!.length).toBeLessThanOrEqual(120)
  })
})
