import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Vitrine } from '@/components/vitrine'

const KITS = [{
  id: 'k1', slug: 'kit-milagran', nome: 'Kit Milagran',
  descricao: 'Kit de limpeza de pele instantanea.',
  precoCentavos: 100000 as never, unidades: 1, sku: 'MG-KIT-001',
  anvisaRegistro: null, ativo: true, ordem: 1,
}]

describe('Vitrine', () => {
  it('mostra o preco formatado em reais', () => {
    render(<Vitrine kits={KITS} representante={null} />)
    expect(screen.getByText('R$ 1.000,00')).toBeDefined()
  })

  it('recalcula o total ao aumentar a quantidade', async () => {
    render(<Vitrine kits={KITS} representante={null} />)
    await userEvent.click(screen.getByRole('button', { name: /aumentar/i }))
    await userEvent.click(screen.getByRole('button', { name: /aumentar/i }))
    expect(screen.getByTestId('total')).toHaveTextContent('R$ 3.000,00')
  })

  it('nao deixa a quantidade cair abaixo de 1', async () => {
    render(<Vitrine kits={KITS} representante={null} />)
    await userEvent.click(screen.getByRole('button', { name: /diminuir/i }))
    expect(screen.getByTestId('quantidade')).toHaveTextContent('1')
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
})
