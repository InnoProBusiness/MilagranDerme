import { describe, it, expect } from 'vitest'
import { descontoParaPrecoFinal, precoComCupom } from '@/lib/cupom-preco'
import { calcularDesconto } from '@/lib/cupom'
import { centavos, deInteiro } from '@/lib/money'

const KIT = centavos(1000)

describe('descontoParaPrecoFinal', () => {
  // O caso que motivou o modulo: a oferta de pre-lancamento pedida por audio em
  // 19/08/2026 — kit de R$ 1.000,00 saindo a R$ 800,00.
  it('R$ 1.000,00 para sair a R$ 800,00 vira desconto de R$ 200,00', () => {
    expect(descontoParaPrecoFinal(KIT, centavos(800))).toBe(20000)
  })

  it('preco final igual ao preco nao gera desconto', () => {
    expect(descontoParaPrecoFinal(KIT, KIT)).toBe(0)
  })

  // Preco final ACIMA do preco e engano de digitacao. O resultado e zero, e
  // nunca um numero negativo: `cupom_valor_positivo` recusaria a linha, e a API
  // recusa antes disso — mas um negativo escapando daqui viraria, em qualquer
  // soma descuidada mais adiante, um cupom que AUMENTA o preco.
  it('preco final acima do preco nao vira desconto negativo', () => {
    expect(descontoParaPrecoFinal(KIT, centavos(1200))).toBe(0)
  })
})

describe('precoComCupom', () => {
  it('mostra o preco final do cupom fixo', () => {
    expect(precoComCupom(KIT, 'fixo', 20000)).toBe(80000)
  })

  it('mostra o preco final do cupom percentual', () => {
    expect(precoComCupom(KIT, 'percentual', 20)).toBe(80000)
  })

  it('desconto maior que o preco para em zero, nunca negativo', () => {
    expect(precoComCupom(KIT, 'fixo', 500000)).toBe(0)
    expect(precoComCupom(KIT, 'percentual', 100)).toBe(0)
  })

  /**
   * A AMARRA. A tela promete um preco ANTES de o cupom existir; o checkout
   * calcula o desconto DEPOIS, com calcularDesconto (src/lib/cupom.ts). Se as
   * duas contas divergirem por um centavo de arredondamento, a tela do painel
   * anuncia um preco que a loja nao pratica — e ninguem descobre por uma
   * excecao, so por uma reclamacao.
   *
   * Os percentuais escolhidos sao os que produzem meio centavo em cima de um
   * preco quebrado, que e onde duas regras de arredondamento diferentes se
   * separam.
   */
  it('concorda com calcularDesconto do checkout, inclusive no arredondamento', () => {
    const precos = [centavos(1000), deInteiro(99999), deInteiro(33333), deInteiro(1)]
    const percentuais = [1, 3, 7, 15, 20, 33, 50, 67, 99, 100]

    for (const preco of precos) {
      for (const p of percentuais) {
        expect(precoComCupom(preco, 'percentual', p))
          .toBe(preco - calcularDesconto('percentual', p, preco))
      }
      for (const fixo of [1, 12345, 20000, 999999]) {
        expect(precoComCupom(preco, 'fixo', fixo))
          .toBe(preco - calcularDesconto('fixo', fixo, preco))
      }
    }
  })
})
