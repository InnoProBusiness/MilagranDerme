import { describe, it, expect, afterEach } from 'vitest'
import {
  assinarAtribuicao, verificarAtribuicao, NOME_COOKIE_ATRIBUICAO,
  JANELA_ATRIBUICAO_DIAS, TAMANHO_MINIMO_SEGREDO, segredoDeAtribuicao,
  type Atribuicao,
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

describe('leitura do segredo (segredoDeAtribuicao)', () => {
  const original = process.env.ATRIBUICAO_SECRET
  afterEach(() => {
    if (original === undefined) delete process.env.ATRIBUICAO_SECRET
    else process.env.ATRIBUICAO_SECRET = original
  })

  it('devolve o segredo quando ele tem tamanho suficiente', () => {
    process.env.ATRIBUICAO_SECRET = SEGREDO
    expect(segredoDeAtribuicao()).toBe(SEGREDO)
  })

  it('estoura quando a variavel nao esta configurada', () => {
    delete process.env.ATRIBUICAO_SECRET
    expect(() => segredoDeAtribuicao()).toThrow(/ATRIBUICAO_SECRET ausente ou curta demais/)
  })

  it('estoura com segredo curto — "changeme" assina HMAC perfeitamente bem', () => {
    // Este e o caso que o antigo `if (!segredo) throw` deixava passar: um
    // segredo adivinhavel nao gera erro nenhum, so degrada em silencio a
    // unica coisa que impede alguem de forjar a propria atribuicao.
    process.env.ATRIBUICAO_SECRET = 'changeme'
    expect(() => segredoDeAtribuicao()).toThrow(/minimo 32 caracteres/)
  })

  it('aceita exatamente o tamanho minimo e recusa um caractere a menos', () => {
    process.env.ATRIBUICAO_SECRET = 'x'.repeat(TAMANHO_MINIMO_SEGREDO)
    expect(segredoDeAtribuicao()).toHaveLength(TAMANHO_MINIMO_SEGREDO)
    process.env.ATRIBUICAO_SECRET = 'x'.repeat(TAMANHO_MINIMO_SEGREDO - 1)
    expect(() => segredoDeAtribuicao()).toThrow()
  })

  it('nunca ecoa o valor lido na mensagem de erro', () => {
    process.env.ATRIBUICAO_SECRET = 'segredo-fraco-mas-identificavel'
    expect(() => segredoDeAtribuicao()).toThrow()
    try {
      segredoDeAtribuicao()
    } catch (e) {
      expect((e as Error).message).not.toContain('segredo-fraco-mas-identificavel')
    }
  })
})
