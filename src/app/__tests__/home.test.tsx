import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

/**
 * A home e um Server Component `async` que le banco. Aqui ele e exercitado
 * como funcao: `render(await PaginaInicial())` — a arvore que ele devolve e
 * JSX comum, e os dois repositorios que ele consulta entram mockados.
 *
 * O MOCK DOS REPOSITORIOS NAO E COMODIDADE, e o que torna este teste possivel:
 * `@/repositories/estoque` importa `src/lib/db.ts`, que abre o driver `pg`. Sem
 * o mock, o arquivo inteiro exigiria Postgres vivo so para conferir texto de
 * tela. A regra de negocio de estoque tem teste proprio, contra o banco de
 * verdade, em src/repositories/__tests__/estoque.test.ts.
 *
 * `src/lib/escassez.ts`, `src/lib/tempo.ts` e `src/lib/money.ts` continuam
 * REAIS: a frase de escassez, a data do lancamento e o formato do dinheiro sao
 * exatamente o que esta tela promete ao comprador, e mocka-los transformaria o
 * teste num espelho da propria implementacao.
 *
 * Pastas `__tests__` dentro de src/app nao viram rota: o App Router so cria
 * segmento a partir de page/route/layout. Mesmo arranjo ja usado em
 * src/app/api/__tests__.
 */
vi.mock('@/repositories/produtos', () => ({ listarKitsAtivos: vi.fn() }))
vi.mock('@/repositories/estoque', () => ({ saldoDoEstoque: vi.fn() }))

import PaginaInicial from '@/app/page'
import { listarKitsAtivos, type Kit } from '@/repositories/produtos'
import { saldoDoEstoque, type SaldoEstoque } from '@/repositories/estoque'
import { AVISO_PRE_VENDA } from '@/lib/tempo'
import { deInteiro } from '@/lib/money'

// deInteiro(), nunca `24900 as never`: o mesmo raciocinio do fixture de
// vitrine.test.tsx — desligar o construtor de Centavos desligaria a validacao
// que faz "R$ 249,00" ser o valor certo e nao um erro de 100x.
const KIT: Kit = {
  id: 'k1',
  slug: 'kit-milagran',
  nome: 'Kit Milagran',
  descricao: 'Kit de limpeza de pele instantânea.',
  precoCentavos: deInteiro(24900),
  unidades: 1,
  sku: 'MG-KIT-001',
  anvisaRegistro: null,
  ativo: true,
  ordem: 1,
  pesoGramas: 500,
  alturaCm: 12,
  larguraCm: 16,
  comprimentoCm: 20,
}

function saldoPresencial(disponivel: number, total = 50): SaldoEstoque {
  return {
    estoqueId: 'e1',
    kitId: KIT.id,
    canal: 'presencial',
    ilimitado: false,
    total,
    vendido: total - disponivel,
    disponivel,
  }
}

// O relogio e congelado em TODO teste: a pagina muda de tempo verbal em
// 25/08/2026 (§3), e um teste que dependesse da data do runner passaria hoje e
// quebraria sozinho no dia do evento. Mesma tecnica de src/lib/__tests__/tempo.test.ts.
const ANTES_DO_LANCAMENTO = new Date('2026-08-20T12:00:00Z')
const DEPOIS_DO_LANCAMENTO = new Date('2026-08-26T12:00:00Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(ANTES_DO_LANCAMENTO)
  vi.mocked(listarKitsAtivos).mockResolvedValue([KIT])
  vi.mocked(saldoDoEstoque).mockResolvedValue(saldoPresencial(42))
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function renderizarHome() {
  render(await PaginaInicial())
}

describe('Home da loja de lancamento', () => {
  it('abre com a manchete e o subtitulo de §6', async () => {
    await renderizarHome()

    expect(screen.getByRole('heading', {
      level: 1,
      name: 'A MILAGRAN ESTÁ OFICIALMENTE NO MERCADO.',
    })).toBeInTheDocument()
    expect(screen.getByText('Uma nova experiência em limpeza de pele chegou.'))
      .toBeInTheDocument()
  })

  // §18 e uma ORDEM, nao uma lista de assuntos: preco antes de produto responde
  // o que ninguem perguntou ainda. Travar a sequencia dos <h2> e a forma barata
  // de o requisito sobreviver ao proximo redesenho.
  it('conta a jornada de §18 na ordem: o que e, kit, preco, pagar, receber, comprar', async () => {
    await renderizarHome()

    const titulos = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(titulos).toEqual([
      'O que é a Milagran',
      'O que vem no kit',
      'Quanto custa',
      'Como pagar',
      'Como receber',
      'Comprar o kit',
    ])
  })

  it('DINHEIRO: mostra o preco do kit formatado em reais', async () => {
    await renderizarHome()

    expect(screen.getByTestId('preco')).toHaveTextContent('R$ 249,00')
    // §9: o valor unitario tem linha propria na jornada, com rotulo, para quem
    // vai comprar mais de um conseguir conferir a conta.
    expect(screen.getByTestId('valor-unitario')).toHaveTextContent('R$ 249,00')
  })

  // A home nao conhece o CEP de ninguem, entao o unico valor de frete que ela
  // poderia imprimir seria zero — a promessa de frete gratis que
  // src/components/linha-frete.tsx existe para impedir.
  it('DINHEIRO: nao imprime R$ 0,00 em lugar nenhum', async () => {
    await renderizarHome()

    expect(document.body).not.toHaveTextContent('R$ 0,00')
  })

  it('traz os dois caminhos de §7/§8 com as frases do documento', async () => {
    await renderizarHome()

    expect(screen.getByText('Comprou → Pagou → Levou na hora.')).toBeInTheDocument()
    expect(screen.getByText('Comprou → Pagou → Recebe pelos Correios.')).toBeInTheDocument()
  })

  // Busca DENTRO da secao "Como pagar": PIX e cartao sao citados tambem nos
  // dois cartoes de entrega e na chamada final, e uma consulta a pagina inteira
  // acharia varios nos. De quebra, `getByRole('region', {name})` so acha a
  // secao se o <h2> continuar sendo o nome acessivel dela.
  it('anuncia as duas formas de pagamento de §7', async () => {
    await renderizarHome()

    const secao = within(screen.getByRole('region', { name: 'Como pagar' }))
    expect(secao.getByText(/Cartão de crédito/)).toBeInTheDocument()
    expect(secao.getByText(/PIX/)).toBeInTheDocument()
  })

  it('mostra o contador ao vivo com o saldo lido no servidor', async () => {
    await renderizarHome()

    expect(screen.getByTestId('contador-estoque'))
      .toHaveTextContent('Apenas 50 kits disponíveis para levar na hora.')
    expect(screen.getByTestId('kits-disponiveis')).toHaveTextContent('42')
  })

  it('avisa quando o lote esta acabando, com o texto de src/lib/escassez.ts', async () => {
    vi.mocked(saldoDoEstoque).mockResolvedValue(saldoPresencial(3))
    await renderizarHome()

    expect(screen.getByTestId('contador-estoque'))
      .toHaveTextContent('Últimos 3 kits disponíveis para compra presencial.')
  })

  describe('CTA (§6, §5/§11)', () => {
    it('e "GARANTIR MEU KIT" enquanto ha kit para levar na hora', async () => {
      await renderizarHome()

      const cta = screen.getByTestId('cta-principal')
      expect(cta).toHaveTextContent('GARANTIR MEU KIT')
      expect(cta).toHaveAttribute('href', '/comprar')
      expect(screen.getByTestId('cta-final')).toHaveTextContent('GARANTIR MEU KIT')
    })

    it('vira "COMPRAR ONLINE" quando o presencial esgota', async () => {
      vi.mocked(saldoDoEstoque).mockResolvedValue(saldoPresencial(0))
      await renderizarHome()

      expect(screen.getByTestId('cta-principal')).toHaveTextContent('COMPRAR ONLINE')
      expect(screen.getByTestId('cta-final')).toHaveTextContent('COMPRAR ONLINE')
      // O destino NAO muda: o canal online nao esgota (§4), entao os dois
      // rotulos levam a uma compra que existe.
      expect(screen.getByTestId('cta-principal')).toHaveAttribute('href', '/comprar')
      expect(screen.getByTestId('contador-estoque'))
        .toHaveTextContent('Os 50 kits disponíveis para compra presencial foram esgotados.')
    })

    // Saldo negativo e estado legitimo (ajuste de inventario maior que o saldo).
    // Ele e esgotado para quem compra, e o numero cru nao vaza para a tela.
    it('trata saldo negativo como esgotado, sem publicar o numero negativo', async () => {
      vi.mocked(saldoDoEstoque).mockResolvedValue(saldoPresencial(-3))
      await renderizarHome()

      expect(screen.getByTestId('cta-principal')).toHaveTextContent('COMPRAR ONLINE')
      expect(document.body).not.toHaveTextContent('-3')
    })
  })

  describe('tempo verbal (§3)', () => {
    it('antes de 25/08 fala no futuro e usa a constante AVISO_PRE_VENDA', async () => {
      await renderizarHome()

      const prazo = screen.getByTestId('prazo-online')
      expect(prazo).toHaveTextContent('No dia 25 de agosto os pedidos serão liberados')
      expect(prazo).toHaveTextContent(AVISO_PRE_VENDA)
    })

    it('depois de 25/08 fala no presente e larga o aviso de pre-venda', async () => {
      vi.setSystemTime(DEPOIS_DO_LANCAMENTO)
      await renderizarHome()

      const prazo = screen.getByTestId('prazo-online')
      expect(prazo).not.toHaveTextContent(AVISO_PRE_VENDA)
      expect(prazo).toHaveTextContent('já são enviados')
    })
  })

  describe('estado vazio honesto', () => {
    it('catalogo vazio: pagina de pe, sem preco e sem botao para lugar nenhum', async () => {
      vi.mocked(listarKitsAtivos).mockResolvedValue([])
      await renderizarHome()

      // A pagina continua dizendo de quem ela e...
      expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
      // ...e diz a verdade sobre o que nao ha.
      expect(screen.getByTestId('sem-kit')).toHaveTextContent(/Nenhum kit está disponível/)
      expect(screen.queryByTestId('preco')).toBeNull()
      expect(screen.queryByTestId('cta-principal')).toBeNull()
      expect(screen.queryByTestId('cta-final')).toBeNull()
      // Sem kit nao ha o que perguntar ao estoque.
      expect(saldoDoEstoque).not.toHaveBeenCalled()
    })

    it('kit sem lote presencial: nenhum contador, nenhum numero inventado', async () => {
      // `null` = o kit nao tem linha de estoque presencial (nao entra no
      // evento). Nao e esgotado: e ausencia de lote.
      vi.mocked(saldoDoEstoque).mockResolvedValue(null)
      await renderizarHome()

      expect(screen.queryByTestId('contador-estoque')).toBeNull()
      expect(screen.getByTestId('cta-principal')).toHaveTextContent('GARANTIR MEU KIT')
      expect(document.body).not.toHaveTextContent('foram esgotados')
    })
  })

  describe('registro ANVISA (divida deliberada)', () => {
    it('diz "em breve" enquanto o registro nao existe', async () => {
      await renderizarHome()

      expect(screen.getByTestId('anvisa')).toHaveTextContent(/em breve/i)
    })

    it('mostra o numero assim que ele existir', async () => {
      vi.mocked(listarKitsAtivos)
        .mockResolvedValue([{ ...KIT, anvisaRegistro: '25351.000123/2026-01' }])
      await renderizarHome()

      expect(screen.getByTestId('anvisa')).toHaveTextContent('25351.000123/2026-01')
    })
  })

  // A LP estatica revela conteudo por IntersectionObserver (public/script.js).
  // Aquele script nao existe no App Router: um `.reveal` aqui deixaria a secao
  // em opacity:0 para sempre, com o HTML impecavel no DevTools.
  it('nao usa a classe .reveal, que depende de um script que esta pagina nao carrega', async () => {
    const { container } = render(await PaginaInicial())

    expect(container.querySelectorAll('.reveal')).toHaveLength(0)
  })
})
