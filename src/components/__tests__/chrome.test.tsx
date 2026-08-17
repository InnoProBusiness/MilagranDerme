import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Cabecalho } from '@/components/cabecalho'
import { Rodape } from '@/components/rodape'

/**
 * O chrome parece cosmetico e nao e: duas coisas testadas aqui tem
 * consequencia fora da tela.
 *
 * 1. O link de §14 e a UNICA porta para o formulario de representante depois
 *    que a loja tomou "/". Se ele sumir, a campanha em circulacao continua
 *    funcionando (a URL segue de pe), mas quem chega pela home nunca mais
 *    encontra o programa.
 * 2. Essa mesma URL, /seja-representante.html, e a que
 *    deploy/milagran-ci-deploy.sh usa em verificar_borda() para aprovar ou
 *    REVERTER o deploy inteiro. Um teste que trave o endereco por extenso e
 *    barato perto do sintoma de ele mudar (rollback silencioso a cada deploy).
 */
describe('Cabecalho', () => {
  it('leva ao topo da loja pela marca', () => {
    render(<Cabecalho />)
    expect(screen.getByRole('link', { name: /milagran derme/i })).toHaveAttribute('href', '/')
  })

  it('abre com o atalho de pular para o conteudo, apontando para o alvo do layout', () => {
    render(<Cabecalho />)
    const atalho = screen.getByRole('link', { name: /pular para o conteúdo/i })
    expect(atalho).toHaveAttribute('href', '#conteudo')
    // Precisa ser o PRIMEIRO link do documento: um atalho que aparece depois
    // do cabecalho nao pula nada.
    expect(screen.getAllByRole('link')[0]).toBe(atalho)
  })

  it('nao anuncia as telas de operacao (login, balcao, painel)', () => {
    render(<Cabecalho />)
    const destinos = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(destinos).not.toContain('/entrar')
    expect(destinos).not.toContain('/venda')
    expect(destinos).not.toContain('/admin')
  })
})

describe('Rodape', () => {
  it('mantem o convite de §14 apontando para /seja-representante.html', () => {
    render(<Rodape />)
    expect(screen.getByText('Quer representar a Milagran?')).toBeInTheDocument()
    const cta = screen.getByRole('link', { name: /conheça as oportunidades/i })
    expect(cta).toHaveAttribute('href', '/seja-representante.html')
  })

  // §14 diz que representante NAO e o foco da pagina de lancamento. "Discreto"
  // vira teste aqui porque e requisito, e a forma mais provavel de o requisito
  // se perder e alguem promover o link a botao dourado para "melhorar a
  // conversao" — competindo com a CTA de compra, que e a razao de a loja
  // existir.
  it('mantem o convite discreto: link de texto, nunca botao de destaque', () => {
    render(<Rodape />)
    const cta = screen.getByRole('link', { name: /conheça as oportunidades/i })
    expect(cta.className).toContain('rodape__cta')
    expect(cta.className).not.toContain('btn--solid')
  })

  // LGPD: a URL da politica de privacidade esta linkada no consentimento do
  // formulario de candidatura e nao pode desaparecer do rodape.
  it('LGPD: publica o link da politica de privacidade', () => {
    render(<Rodape />)
    expect(screen.getByRole('link', { name: /política de privacidade/i }))
      .toHaveAttribute('href', '/privacidade.html')
  })

  it('mostra os canais de contato reais da marca', () => {
    render(<Rodape />)
    expect(screen.getByRole('link', { name: /whatsapp/i }))
      .toHaveAttribute('href', 'https://wa.me/556291129089')
    expect(screen.getByRole('link', { name: /milagranoficial@gmail\.com/i }))
      .toHaveAttribute('href', 'mailto:milagranoficial@gmail.com')
  })
})
