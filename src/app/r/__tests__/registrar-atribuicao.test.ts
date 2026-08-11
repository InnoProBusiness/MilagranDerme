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

  it('atribuicao nova grava o instante de "agora", nao um valor arbitrario', () => {
    const agora = new Date(emAgosto)
    const r = resolverAtribuicao({
      slugVisitado: 'maria', atual: null,
      utm: { source: null, medium: null, campaign: null },
      agora,
    })
    expect(r.efetiva.em).toBe(agora.getTime())
  })

  it('LAST CLICK: usa o instante da nova visita, NAO o da atribuicao anterior', () => {
    // Sem este teste, um bug que devolvesse atual.em ao transferir a
    // atribuicao passaria pelos outros 5 testes (nenhum deles olha para
    // .em num last click) e o representante novo herdaria o que sobrou da
    // janela de 30 dias do antigo — silenciosamente. O gap de 20 dias entre
    // os dois "agora" garante que um mutante que devolva o valor errado
    // falhe de forma obvia, nao por 1ms de diferenca de relogio.
    const novoInstante = emAgosto + 20 * 86_400_000
    const r = resolverAtribuicao({
      slugVisitado: 'joao', atual: existente,
      utm: { source: null, medium: null, campaign: null },
      agora: new Date(novoInstante),
    })
    expect(r.efetiva.em).toBe(novoInstante)
    expect(r.efetiva.em).not.toBe(existente.em)
  })
})
