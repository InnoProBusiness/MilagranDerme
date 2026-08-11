import { describe, it, expect } from 'vitest'
import {
  centavos, deInteiro, formatarBRL, multiplicar, aplicarPercentual, calcularComissao,
} from '@/lib/money'

describe('centavos', () => {
  it('converte reais para centavos sem erro de ponto flutuante', () => {
    expect(centavos(19.90)).toBe(1990)
    expect(centavos(0.1) + centavos(0.2)).toBe(centavos(0.3))
  })

  it('rejeita valor com mais de duas casas decimais', () => {
    expect(() => centavos(19.999)).toThrow(/duas casas/)
  })

  it('rejeita valor nao finito', () => {
    expect(() => centavos(Number.NaN)).toThrow(/finito/)
  })
})

describe('deInteiro', () => {
  it('marca um inteiro que ja esta em centavos, sem converter', () => {
    expect(deInteiro(1990)).toBe(1990)
  })

  it('rejeita valor nao inteiro — centavos fracionarios nao existem', () => {
    expect(() => deInteiro(19.5)).toThrow(/inteiro/)
  })
})

describe('formatarBRL', () => {
  it('formata no padrao brasileiro', () => {
    expect(formatarBRL(deInteiro(1990))).toBe('R$ 19,90')
    expect(formatarBRL(deInteiro(1234567))).toBe('R$ 12.345,67')
  })

  it('formata zero e negativo', () => {
    expect(formatarBRL(deInteiro(0))).toBe('R$ 0,00')
    expect(formatarBRL(deInteiro(-500))).toBe('-R$ 5,00')
  })

  it('formata o mesmo valor vindo de reais ou de centavos', () => {
    expect(formatarBRL(centavos(19.90))).toBe(formatarBRL(deInteiro(1990)))
  })
})

describe('multiplicar', () => {
  it('multiplica por quantidade inteira', () => {
    expect(multiplicar(deInteiro(1990), 3)).toBe(5970)
  })

  it('rejeita quantidade nao inteira', () => {
    expect(() => multiplicar(deInteiro(1990), 1.5)).toThrow(/inteira/)
  })

  it('rejeita quantidade negativa', () => {
    expect(() => multiplicar(deInteiro(1990), -1)).toThrow(/inteira/)
  })
})

describe('aplicarPercentual', () => {
  it('arredonda meio para cima, de forma deterministica', () => {
    // 1990 centavos * 15% = 298,5 -> 299
    expect(aplicarPercentual(deInteiro(1990), 15)).toBe(299)
  })

  it('nao acumula erro em valores que geram divisao inexata', () => {
    // 3333 centavos * 33% = 1099,89 -> 1100
    expect(aplicarPercentual(deInteiro(3333), 33)).toBe(1100)
  })

  it('rejeita percentual fora de 0..100', () => {
    expect(() => aplicarPercentual(deInteiro(100), -1)).toThrow(/percentual/)
    expect(() => aplicarPercentual(deInteiro(100), 101)).toThrow(/percentual/)
  })

  it('rejeita valor negativo — percentual deve ser aplicado com sign explícito', () => {
    expect(() => aplicarPercentual(deInteiro(-1990), 15)).toThrow(/nao-negativo/)
  })

  it('devolve zero quando o valor e zero', () => {
    expect(aplicarPercentual(deInteiro(0), 20)).toBe(0)
  })

  it('respeita os limites 0 e 100 do percentual', () => {
    // 0% de qualquer valor = 0
    expect(aplicarPercentual(deInteiro(1990), 0)).toBe(0)
    // 100% retorna o valor original
    expect(aplicarPercentual(deInteiro(1990), 100)).toBe(1990)
  })
})

describe('calcularComissao', () => {
  it('incide sobre o subtotal ja com desconto, sem frete', () => {
    // Pedido: 3 kits a R$ 199,90 = R$ 599,70
    // Cupom MARIA10 (10%) = -R$ 59,97 -> R$ 539,73
    // Frete NAO entra na base.
    // Comissao 20% sobre 53973 centavos = 10794,6 -> 10795
    expect(calcularComissao(centavos(539.73), 20)).toBe(10795)
  })

  it('devolve zero quando o subtotal e zero', () => {
    expect(calcularComissao(deInteiro(0), 20)).toBe(0)
  })

  it('rejeita base negativa — estorno e lancamento proprio, nao comissao negativa', () => {
    expect(() => calcularComissao(deInteiro(-100), 20)).toThrow(/negativa/)
  })
})
