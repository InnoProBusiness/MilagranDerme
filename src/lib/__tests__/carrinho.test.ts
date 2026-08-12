import { describe, it, expect } from 'vitest'
import { deInteiro } from '@/lib/money'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'

const KIT = { kitId: 'k1', nome: 'Kit Milagran', precoUnitario: deInteiro(100000) }

describe('montarCarrinho', () => {
  it('preco e linear: 3 kits custam 3x o preco unitario', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 3 }])
    expect(r.subtotal).toBe(300000)
    expect(r.total).toBe(300000)
  })

  it('frete e zero e marcado como a definir', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 1 }])
    expect(r.frete).toBe(0)
    expect(r.freteADefinir).toBe(true)
  })

  it('desconto sai do subtotal e nao do frete', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 2 }], deInteiro(20000))
    expect(r.subtotal).toBe(200000)
    expect(r.desconto).toBe(20000)
    expect(r.total).toBe(180000)
  })

  it('limita o desconto ao subtotal — total nunca fica negativo', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 1 }], deInteiro(500000))
    expect(r.desconto).toBe(100000)
    expect(r.total).toBe(0)
  })

  it('rejeita carrinho vazio', () => {
    expect(() => montarCarrinho([])).toThrow(/vazio/)
  })

  it('rejeita quantidade zero ou negativa', () => {
    expect(() => montarCarrinho([{ ...KIT, quantidade: 0 }])).toThrow(/quantidade/i)
    expect(() => montarCarrinho([{ ...KIT, quantidade: -1 }])).toThrow(/quantidade/i)
  })

  it('rejeita quantidade acima do teto', () => {
    expect(() => montarCarrinho([{ ...KIT, quantidade: QUANTIDADE_MAXIMA + 1 }]))
      .toThrow(/maxima/i)
  })

  it('aceita exatamente o teto', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: QUANTIDADE_MAXIMA }])
    expect(r.subtotal).toBe(100000 * QUANTIDADE_MAXIMA)
  })

  it('soma varios kits diferentes', () => {
    const r = montarCarrinho([
      { ...KIT, quantidade: 2 },
      { kitId: 'k2', nome: 'Kit Duo', precoUnitario: deInteiro(180000), quantidade: 1 },
    ])
    expect(r.subtotal).toBe(380000)
    expect(r.linhas).toHaveLength(2)
    expect(r.linhas[0]!.total).toBe(200000)
  })
})
