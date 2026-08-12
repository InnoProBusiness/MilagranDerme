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

  // Enquanto a politica de frete nao existir, o resumo nao devolve frete
  // nenhum: nem um valor que alguma tela possa imprimir como "R$ 0,00", nem
  // uma flag booleana que alguem possa virar achando que com isso o frete
  // passou a funcionar. O texto que as telas mostram no lugar vive em
  // src/components/linha-frete.tsx, num componente so.
  it('nao expoe frete nenhum: nem valor para imprimir, nem flag para virar', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 1 }])
    expect(r).not.toHaveProperty('frete')
    expect(r).not.toHaveProperty('freteADefinir')
    // E o total nao ganha nem perde nada por conta de frete.
    expect(r.total).toBe(r.subtotal)
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

  it('rejeita quantidade fracionada', () => {
    expect(() => montarCarrinho([{ ...KIT, quantidade: 1.5 }])).toThrow(/quantidade/i)
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

  it('rejeita carrinho com subtotal acima do teto (overflow de integer)', () => {
    // Cada linha com QUANTIDADE_MAXIMA e precoUnitario de 100000 totaliza 2.000.000.
    // 1074 linhas excedem o integer limit de Postgres (2.147.483.647).
    const linhas = Array.from({ length: 1074 }, (_, i) => ({
      kitId: `k${i}`,
      nome: `Kit ${i}`,
      precoUnitario: deInteiro(100000),
      quantidade: QUANTIDADE_MAXIMA,
    }))
    expect(() => montarCarrinho(linhas)).toThrow(/carrinho total nao pode exceder/i)
  })
})
