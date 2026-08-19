import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LinhaFrete, TEXTO_FRETE_A_COTAR } from '@/components/linha-frete'
import { deInteiro } from '@/lib/money'

/**
 * O componente que existe para UMA garantia: nunca imprimir "R$ 0,00" quando
 * nao ha valor. Ele e o mesmo no nas quatro telas que falam de frete do mesmo
 * pedido (vitrine, passos 1 e 4 do checkout, confirmacao), entao um erro aqui
 * aparece nas quatro de uma vez — e por isso a garantia e testada direto no
 * componente, alem de nas telas.
 *
 * A DISTINCAO QUE ESTE ARQUIVO TRAVA: `null` ("ainda nao cotado", a vitrine
 * nao conhece o CEP) e zero ("nao ha frete a somar", venda presencial do
 * evento, §10) sao estados DIFERENTES e precisam continuar imprimindo coisas
 * diferentes. Colapsar os dois em um so foi exatamente o que a divida antiga
 * deste componente evitava por nao ter valor nenhum.
 */
describe('LinhaFrete', () => {
  it('DINHEIRO: sem valor, diz que sera calculado — nunca R$ 0,00', () => {
    render(<LinhaFrete retirada={false} valor={null} />)
    const frete = screen.getByTestId('frete')
    expect(frete).toHaveTextContent(TEXTO_FRETE_A_COTAR)
    expect(frete).not.toHaveTextContent('R$')
  })

  it('DINHEIRO: prazo sozinho nao vira valor — sem cotacao continua "a cotar"', () => {
    render(<LinhaFrete retirada={false} valor={null} prazoDias={5} />)
    const frete = screen.getByTestId('frete')
    expect(frete).toHaveTextContent(TEXTO_FRETE_A_COTAR)
    expect(frete).not.toHaveTextContent('R$ 0,00')
    expect(frete).not.toHaveTextContent(/dias úteis/)
  })

  it('DINHEIRO: zero e um valor legitimo (venda presencial nao tem frete)', () => {
    // O unico caminho em que "R$ 0,00" e verdade: o comprador leva o kit na
    // mao no evento (§10). Ele so aparece porque alguem PASSOU zero, nunca por
    // omissao — que e a diferenca inteira entre este componente e a flag que
    // ele substituiu.
    render(<LinhaFrete retirada={false} valor={deInteiro(0)} />)
    expect(screen.getByTestId('frete')).toHaveTextContent('Frete: R$ 0,00')
  })

  it('mostra o valor cotado formatado por formatarBRL', () => {
    render(<LinhaFrete retirada={false} valor={deInteiro(2490)} />)
    expect(screen.getByTestId('frete')).toHaveTextContent('Frete: R$ 24,90')
  })

  it('acrescenta o prazo estimado quando o provedor devolve um', () => {
    render(<LinhaFrete retirada={false} valor={deInteiro(2490)} prazoDias={5} />)
    expect(screen.getByTestId('frete'))
      .toHaveTextContent('Frete: R$ 24,90 (prazo estimado: 5 dias úteis)')
  })

  it('concorda com o singular no prazo de um dia', () => {
    render(<LinhaFrete retirada={false} valor={deInteiro(2490)} prazoDias={1} />)
    expect(screen.getByTestId('frete')).toHaveTextContent('prazo estimado: 1 dia útil')
  })

  /**
   * Prazo ausente, zero, negativo ou fracionario nao vira texto: "prazo
   * estimado: 0 dias úteis" soaria como entrega no mesmo dia, que e uma
   * promessa que ninguem fez. O valor continua aparecendo — o que falta e o
   * prazo, nao a cotacao.
   */
  it('omite o prazo quando o numero nao descreve um prazo de verdade', () => {
    for (const prazo of [undefined, null, 0, -2, 0.4]) {
      const { unmount } = render(<LinhaFrete retirada={false} valor={deInteiro(2490)} prazoDias={prazo} />)
      const frete = screen.getByTestId('frete')
      expect(frete).toHaveTextContent('Frete: R$ 24,90')
      expect(frete).not.toHaveTextContent(/prazo estimado/)
      unmount()
    }
  })

  it('trunca prazo fracionario em vez de imprimir "3,7 dias"', () => {
    render(<LinhaFrete retirada={false} valor={deInteiro(2490)} prazoDias={3.7} />)
    expect(screen.getByTestId('frete')).toHaveTextContent('prazo estimado: 3 dias úteis')
  })
})
