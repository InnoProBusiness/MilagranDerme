import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Vitrine, diminuirQuantidade, aumentarQuantidade } from '@/components/vitrine'
import { QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { deInteiro } from '@/lib/money'

// deInteiro(), nunca `100000 as never`. Este preco alimenta as assercoes de
// dinheiro abaixo (R$ 1.000,00 unitario, R$ 3.000,00 no subtotal e no
// total): `as never` desliga o construtor de Centavos e com ele toda a
// validacao de runtime, entao um fixture com 19.9 renderizaria R$ 0,20 em
// vez de estourar — um erro de 100x que o tipo existe justamente para pegar.
const KITS = [{
  id: 'k1', slug: 'kit-milagran', nome: 'Kit Milagran',
  descricao: 'Kit de limpeza de pele instantanea.',
  precoCentavos: deInteiro(100000), unidades: 1, sku: 'MG-KIT-001',
  anvisaRegistro: null, ativo: true, ordem: 1,
}]

describe('Vitrine', () => {
  it('mostra o preco formatado em reais', () => {
    render(<Vitrine kits={KITS} representante={null} />)
    expect(screen.getByText('R$ 1.000,00')).toBeDefined()
  })

  it('recalcula subtotal e total ao aumentar a quantidade', async () => {
    render(<Vitrine kits={KITS} representante={null} />)
    const aumentar = screen.getByRole('button', { name: /aumentar/i })
    await userEvent.click(aumentar)
    await userEvent.click(aumentar)
    expect(screen.getByTestId('subtotal')).toHaveTextContent('R$ 3.000,00')
    expect(screen.getByTestId('total')).toHaveTextContent('R$ 3.000,00')
  })

  it('mantem subtotal, frete e total consistentes na quantidade 3', async () => {
    render(<Vitrine kits={KITS} representante={null} />)
    const aumentar = screen.getByRole('button', { name: /aumentar/i })
    await userEvent.click(aumentar)
    await userEvent.click(aumentar)
    expect(screen.getByTestId('quantidade')).toHaveTextContent('3')
    expect(screen.getByTestId('subtotal')).toHaveTextContent('R$ 3.000,00')
    expect(screen.getByTestId('frete')).toHaveTextContent(/a definir/i)
    expect(screen.getByTestId('total')).toHaveTextContent('R$ 3.000,00')
  })

  // Guarda o QUE O USUARIO VE: o botao "Diminuir" fica desabilitado exatamente
  // na quantidade minima e volta a habilitar assim que ela sobe. Isto e o que
  // realmente impede o clique de derrubar a quantidade abaixo de 1 na UI —
  // por isso e testado diretamente, em vez de inferido a partir do valor
  // mostrado (um clique num botao disabled nao dispara o handler, entao
  // checar so o texto da quantidade depois de um clique nao prova nada sobre
  // este botao especificamente).
  it('desabilita "Diminuir" na quantidade minima e habilita apos incrementar', async () => {
    render(<Vitrine kits={KITS} representante={null} />)
    const diminuir = screen.getByRole('button', { name: /diminuir/i })
    expect(diminuir).toBeDisabled()
    expect(screen.getByTestId('quantidade')).toHaveTextContent('1')

    await userEvent.click(screen.getByRole('button', { name: /aumentar/i }))
    expect(diminuir).not.toBeDisabled()
  })

  // Mesma logica para o teto, alcancado programaticamente a partir da
  // constante (nao um "19" magico escrito a mao no teste).
  it('desabilita "Aumentar" ao atingir QUANTIDADE_MAXIMA', async () => {
    render(<Vitrine kits={KITS} representante={null} />)
    const aumentar = screen.getByRole('button', { name: /aumentar/i })
    for (let i = 1; i < QUANTIDADE_MAXIMA; i++) {
      await userEvent.click(aumentar)
    }
    expect(screen.getByTestId('quantidade')).toHaveTextContent(String(QUANTIDADE_MAXIMA))
    expect(aumentar).toBeDisabled()
  })

  // O `disabled` do botao e a defesa que o usuario ve, mas o clamp
  // aritmetico por baixo dele (Math.max/Math.min) e a segunda linha de
  // defesa e precisa de um teste proprio que quebre se ela for removida —
  // chamando a funcao pura direto, sem passar por nenhum clique ou pelo
  // atributo disabled.
  it('diminuirQuantidade nunca desce abaixo de 1 (clamp puro, sem clique)', () => {
    expect(diminuirQuantidade(1)).toBe(1)
    expect(diminuirQuantidade(2)).toBe(1)
    expect(diminuirQuantidade(5)).toBe(4)
  })

  it('aumentarQuantidade nunca passa de QUANTIDADE_MAXIMA (clamp puro, sem clique)', () => {
    expect(aumentarQuantidade(QUANTIDADE_MAXIMA)).toBe(QUANTIDADE_MAXIMA)
    expect(aumentarQuantidade(QUANTIDADE_MAXIMA - 1)).toBe(QUANTIDADE_MAXIMA)
    expect(aumentarQuantidade(1)).toBe(2)
  })

  it('mostra "a definir" no frete, nunca R$ 0,00', () => {
    render(<Vitrine kits={KITS} representante={null} />)
    const frete = screen.getByTestId('frete')
    expect(frete).toHaveTextContent(/a definir/i)
    expect(frete).not.toHaveTextContent('R$ 0,00')
  })

  it('avisa que o registro ANVISA esta em breve quando nao ha numero', () => {
    render(<Vitrine kits={KITS} representante={null} />)
    expect(screen.getByTestId('anvisa')).toHaveTextContent(/em breve/i)
  })

  it('mostra o numero ANVISA quando ele existe', () => {
    render(<Vitrine kits={[{ ...KITS[0]!, anvisaRegistro: '25351.000123/2026-01' }]} representante={null} />)
    expect(screen.getByTestId('anvisa')).toHaveTextContent('25351.000123/2026-01')
  })

  it('identifica o representante quando a vitrine e dele', () => {
    render(<Vitrine kits={KITS} representante={{ nome: 'Maria', slug: 'maria' }} />)
    expect(screen.getByText(/Maria/)).toBeDefined()
  })

  it('mostra mensagem honesta quando nao ha kit disponivel', () => {
    render(<Vitrine kits={[]} representante={null} />)
    expect(screen.getByText('Nenhum kit disponivel no momento.')).toBeDefined()
  })
})
