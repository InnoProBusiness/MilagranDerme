import { describe, it, expect } from 'vitest'
import { deInteiro } from '@/lib/money'
import { calcularDesconto } from '@/lib/cupom'

describe('calcularDesconto', () => {
  it('percentual incide sobre o subtotal', () => {
    expect(calcularDesconto('percentual', 10, deInteiro(300000))).toBe(30000)
  })

  it('percentual arredonda meio para cima', () => {
    // 1990 * 15% = 298,5 -> 299, mesma regra do resto do sistema
    expect(calcularDesconto('percentual', 15, deInteiro(1990))).toBe(299)
  })

  it('fixo devolve o proprio valor em centavos', () => {
    expect(calcularDesconto('fixo', 5000, deInteiro(300000))).toBe(5000)
  })

  it('fixo nunca ultrapassa o subtotal', () => {
    expect(calcularDesconto('fixo', 500000, deInteiro(100000))).toBe(100000)
  })

  it('percentual de 100 zera o subtotal', () => {
    expect(calcularDesconto('percentual', 100, deInteiro(100000))).toBe(100000)
  })
})
