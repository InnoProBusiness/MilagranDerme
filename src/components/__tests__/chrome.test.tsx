import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

/**
 * O CABECALHO VIROU CLIENT COMPONENT em 20/08/2026 (§3/§4 pedem menu sanfona,
 * e menu que abre precisa de estado) e passou a ler `usePathname` para decidir
 * o que mostrar: a loja tem menu, o painel e o balcao nao.
 *
 * Fora do App Router `usePathname` devolve null e o componente ainda funciona
 * — mas um mock explicito e o que permite testar as DUAS decisoes (loja e
 * operacao) em vez de so a que o default entrega.
 */
const rota = vi.hoisted(() => ({ atual: '/' }))
vi.mock('next/navigation', () => ({ usePathname: () => rota.atual }))

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
  /**
   * A MARCA E A LOGO, e a logo e o unico conteudo do link desde 20/08/2026 (o
   * par de texto "Milagran / Derme" ao lado dela saiu junto com o termo).
   *
   * Por isso a busca e por NOME ACESSIVEL: ele agora vem inteiro do `alt` da
   * imagem. Se alguem devolver `alt=""` ali — o que era correto enquanto havia
   * texto ao lado —, este teste fica vermelho, e e a unica coisa que separa a
   * marca de virar um link que o leitor de tela anuncia como a URL crua.
   */
  it('leva ao topo da loja pela marca', () => {
    render(<Cabecalho />)
    expect(screen.getByRole('link', { name: /^milagran$/i })).toHaveAttribute('href', '/')
  })

  // O termo saiu da identidade em 20/08/2026: nao pode voltar por um alt, um
  // titulo ou um rotulo esquecido.
  it('nao usa mais o termo "Derme" em lugar nenhum do chrome', () => {
    const { container } = render(<><Cabecalho /><Rodape /></>)
    expect(container.textContent ?? '').not.toMatch(/derme/i)
    for (const img of container.querySelectorAll('img')) {
      expect(img.getAttribute('alt') ?? '').not.toMatch(/derme/i)
    }
  })

  it('abre com o atalho de pular para o conteudo, apontando para o alvo do layout', () => {
    render(<Cabecalho />)
    const atalho = screen.getByRole('link', { name: /pular para o conteúdo/i })
    expect(atalho).toHaveAttribute('href', '#conteudo')
    // Precisa ser o PRIMEIRO link do documento: um atalho que aparece depois
    // do cabecalho nao pula nada.
    expect(screen.getAllByRole('link')[0]).toBe(atalho)
  })

  /**
   * §24 INVERTEU METADE DESTA REGRA, e vale registrar o que mudou e o que
   * NAO mudou.
   *
   * Ate 20/08/2026 o cabecalho nao anunciava nenhuma tela de operacao —
   * login incluido — para nao convidar visitante a bater numa porta que
   * devolve 401. §24 pede um botao ACESSAR no header, apontando para a area
   * de acesso que ja existe: quem tem conta (representante, vendedor,
   * administracao) precisa achar a entrada sem decorar a URL.
   *
   * O QUE CONTINUA VALENDO: /venda e /admin seguem fora. Sao telas de
   * operacao com sessao propria e publico fechado; anuncia-las na loja nao
   * serve a ninguem.
   */
  it('anuncia o acesso de §24, mas nao o balcao nem o painel', () => {
    render(<Cabecalho />)
    const destinos = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(destinos).toContain('/entrar')
    expect(destinos).not.toContain('/venda')
    expect(destinos).not.toContain('/admin')
  })

  // §3 e §25: a barra leva os destinos primarios e os dois botoes; o menu
  // completo mora na gaveta do hamburger.
  it('traz o menu de §25 e os dois botoes de §3', () => {
    render(<Cabecalho />)

    const destinos = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    for (const esperado of ['/#a-milagran', '/#o-kit', '/#lancamento', '/#como-funciona', '/#contato']) {
      expect(destinos).toContain(esperado)
    }
    // A compra leva para o checkout embutido na home, nunca para uma tela nova.
    expect(destinos).toContain('/#comprar')
    // E o convite de representante continua alcancavel pelo menu (§23).
    expect(destinos).toContain('/seja-representante.html')
  })

  // As ancoras sao ABSOLUTAS porque este cabecalho aparece no checkout, no
  // painel e no balcao: `#o-kit` relativo la dentro rolaria a propria tela em
  // vez de voltar para a loja.
  it('as ancoras do menu sao absolutas, para funcionarem fora da home', () => {
    rota.atual = '/checkout'
    render(<Cabecalho />)

    const ancoras = screen.getAllByRole('link')
      .map((a) => a.getAttribute('href') ?? '')
      .filter((h) => h.includes('#') && h !== '#conteudo')
    expect(ancoras.length).toBeGreaterThan(0)
    for (const href of ancoras) expect(href.startsWith('/#')).toBe(true)
    rota.atual = '/'
  })

  /**
   * O painel e o balcao tem chrome proprio e publico proprio: quem esta ali
   * esta trabalhando, nao comprando. Um "COMPRAR" dourado por cima de uma
   * tabela de pedidos e ruido — mas a MARCA continua, e continua clicavel,
   * porque e a saida do operador de volta para a loja.
   */
  it('nas telas de operacao mostra so a marca', () => {
    rota.atual = '/admin/pedidos'
    render(<Cabecalho />)

    const destinos = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(destinos).toContain('/')
    expect(destinos).not.toContain('/#comprar')
    expect(destinos).not.toContain('/entrar')
    expect(screen.queryByRole('button', { name: /menu/i })).toBeNull()
    rota.atual = '/'
  })

  // §4: a gaveta existe no DOM fechada (para o conteudo estar no HTML servido)
  // e `inert` e quem tira os sete links do caminho do Tab. Sem ele, o teclado
  // passeia por links invisiveis antes de chegar ao conteudo.
  it('a gaveta comeca fechada e fora do alcance do teclado', () => {
    render(<Cabecalho />)

    expect(screen.getByTestId('gaveta')).toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: /abrir o menu/i }))
      .toHaveAttribute('aria-expanded', 'false')
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
