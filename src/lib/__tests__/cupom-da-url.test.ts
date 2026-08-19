import { describe, it, expect } from 'vitest'
import { cupomDaUrl, TAMANHO_MAXIMO_CUPOM } from '@/lib/cupom-da-url'

/**
 * O link de campanha (`/?cupom=CODIGO`) so PREENCHE o campo do formulario.
 * Estes testes fixam a normalizacao; quem decide se ha desconto e o servidor,
 * e isso tem teste proprio contra o banco em
 * src/repositories/__tests__/cupons.test.ts.
 */
describe('cupomDaUrl', () => {
  it('sobe para maiusculas', () => {
    // O CHECK cupom_codigo_formato do banco so aceita caixa alta. Sem esta
    // normalizacao, um link compartilhado em minusculas — o que aplicativo de
    // mensagem faz o tempo todo — nao acharia o cupom.
    expect(cupomDaUrl('lancamento200')).toBe('LANCAMENTO200')
  })

  it('tira espaco das pontas', () => {
    expect(cupomDaUrl('  PRE800  ')).toBe('PRE800')
  })

  it('ausencia, vazio e so-espaco viram string vazia', () => {
    expect(cupomDaUrl(undefined)).toBe('')
    expect(cupomDaUrl('')).toBe('')
    expect(cupomDaUrl('   ')).toBe('')
  })

  // O Next entrega array quando o parametro se repete (?cupom=A&cupom=B).
  // Vale o primeiro: uma URL malformada nao pode virar erro de runtime numa
  // pagina de venda.
  it('parametro repetido usa o primeiro', () => {
    expect(cupomDaUrl(['pre800', 'outro'])).toBe('PRE800')
    expect(cupomDaUrl([])).toBe('')
  })

  it('corta no mesmo teto do schema da rota', () => {
    const longo = 'A'.repeat(80)
    expect(cupomDaUrl(longo)).toHaveLength(TAMANHO_MAXIMO_CUPOM)
  })

  // Tipo inesperado (numero, objeto) nao deve derrubar a pagina.
  it('valor de tipo estranho vira vazio em vez de lancar', () => {
    expect(cupomDaUrl(42 as unknown as string)).toBe('')
    expect(cupomDaUrl({} as unknown as string)).toBe('')
  })
})
