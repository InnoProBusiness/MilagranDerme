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

/**
 * A home passou a montar o CHECKOUT INTEIRO na secao "06 — A compra" (o mesmo
 * padrao da LP de recrutamento, que traz o formulario embutido em vez de um
 * link). `CheckoutWizard` e Client Component e chama `useRouter`, que fora do
 * App Router lanca "invariant expected app router to be mounted".
 *
 * O mock e o mesmo de src/components/__tests__/checkout-wizard.test.tsx — e la
 * que o comportamento do checkout e testado de verdade, com fetch falso e as
 * quatro etapas. Aqui interessa apenas que ele ESTA na pagina, no lugar certo
 * da jornada de §18.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import PaginaInicial from '@/app/page'
import { listarKitsAtivos, type Kit } from '@/repositories/produtos'
import { saldoDoEstoque, type SaldoEstoque } from '@/repositories/estoque'
import { AVISO_PRE_VENDA } from '@/lib/tempo'
import { deInteiro } from '@/lib/money'
import { ENDERECO_RETIRADA, PRAZO_RETIRADA_DIAS } from '@/lib/retirada'

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
  anvisaDispensado: false,
  ativo: true,
  ordem: 1,
  pesoGramas: 760,
  alturaCm: 6,
  larguraCm: 18,
  comprimentoCm: 23,
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

/**
 * `searchParams` e Promise porque e assim que o Next 16 entrega — a home o
 * recebe para ler `?cupom=CODIGO` dos links de campanha. O default vazio
 * mantem todos os testes anteriores descrevendo a home normal, sem cupom.
 */
async function renderizarHome(searchParams: { cupom?: string | string[] } = {}) {
  render(await PaginaInicial({ searchParams: Promise.resolve(searchParams) }))
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
    //
    // `getAllByTestId`, e nao `getByTestId`: desde que o checkout passou a ser
    // montado na propria home, "Valor unitário" aparece DUAS vezes — na secao
    // de preco e dentro do passo 1 do checkout. As duas sao legitimas e leem o
    // mesmo `kit.precoCentavos` pela mesma funcao de formatacao, entao o que
    // importa e que NENHUMA delas divirja.
    const unitarios = screen.getAllByTestId('valor-unitario')
    expect(unitarios.length).toBeGreaterThan(0)
    for (const linha of unitarios) expect(linha).toHaveTextContent('R$ 249,00')
  })

  // A home nao conhece o CEP de ninguem, entao o unico valor de frete que ela
  // poderia imprimir seria zero — a promessa de frete gratis que
  // src/components/linha-frete.tsx existe para impedir.
  it('DINHEIRO: nao imprime R$ 0,00 em lugar nenhum', async () => {
    await renderizarHome()

    expect(document.body).not.toHaveTextContent('R$ 0,00')
  })

  // A frase do cartao online mudou em 19/08/2026, com a retirada no local:
  // "Recebe pelos Correios" deixou de descrever a compra online inteira. Este
  // cartao ENUMERA as formas de receber o kit, e um titulo que promete
  // transportadora manda para o frete quem mora em Goiania e nao precisa dele.
  it('traz os dois caminhos de §7/§8 com as frases do documento', async () => {
    await renderizarHome()

    expect(screen.getByText('Comprou → Pagou → Levou na hora.')).toBeInTheDocument()
    expect(screen.getByText('Comprou → Pagou → Recebe em casa ou retira aqui.')).toBeInTheDocument()
  })

  /**
   * A HOME NAO PODE ESCONDER A RETIRADA. Ela e a unica superficie que enumera
   * as formas de entrega antes de a pessoa entrar no checkout: se so falar em
   * Correios, quem mora em Goiania conclui que vai pagar frete e desiste antes
   * de chegar na tela onde a alternativa aparece.
   */
  it('anuncia a retirada no local, com cidade e prazo', async () => {
    await renderizarHome()

    const texto = document.body.textContent ?? ''
    expect(texto).toContain(ENDERECO_RETIRADA.cidade)
    expect(texto).toMatch(new RegExp(`retirada no local.*${PRAZO_RETIRADA_DIAS} dias`, 'i'))
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

    // Os dois leem o MESMO saldo. Ate 17/08/2026 esta asserção esperava "42"
    // no numero e "Apenas 50 kits" na frase — a contradicao que a home exibia
    // lado a lado. Ver a nota no cabecalho de src/lib/escassez.ts.
    expect(screen.getByTestId('contador-estoque'))
      .toHaveTextContent('Apenas 42 kits disponíveis para levar na hora.')
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
      // ANCORA, e nao mais /comprar: a compra acontece nesta pagina, no fim
      // dela. O botao do hero desce ate o checkout em vez de trocar de tela.
      expect(cta).toHaveAttribute('href', '#comprar')
    })

    it('vira "COMPRAR ONLINE" quando o presencial esgota', async () => {
      vi.mocked(saldoDoEstoque).mockResolvedValue(saldoPresencial(0))
      await renderizarHome()

      expect(screen.getByTestId('cta-principal')).toHaveTextContent('COMPRAR ONLINE')
      // O destino NAO muda com o esgotamento: o canal online nao tem teto
      // (§4), entao os dois rotulos levam a uma compra que existe.
      expect(screen.getByTestId('cta-principal')).toHaveAttribute('href', '#comprar')
      expect(screen.getByTestId('contador-estoque'))
        .toHaveTextContent('Os 50 kits disponíveis para compra presencial foram esgotados.')
    })

    /**
     * O FIM DA PAGINA NAO E MAIS UM BOTAO, E O CHECKOUT.
     *
     * Ate 17/08/2026 a secao "06 — A compra" trazia um segundo botao
     * (`cta-final`) que levava para /comprar. Ele deixou de existir: quem leu
     * os seis blocos de argumento agora escolhe a quantidade e finaliza ali
     * mesmo, como a LP de recrutamento faz com o formulario de candidatura.
     *
     * Este teste trava o padrao. Se alguem trocar o checkout embutido por um
     * link de novo, ele fica vermelho.
     */
    it('a secao de compra traz o checkout embutido, nao um link para outra tela', async () => {
      await renderizarHome()

      const secao = document.querySelector('#comprar')
      expect(secao).not.toBeNull()

      // O passo 1 do checkout: seletor de quantidade e subtotal, dentro da
      // propria secao.
      const dentro = within(secao as HTMLElement)
      expect(dentro.getByTestId('quantidade')).toBeInTheDocument()
      expect(dentro.getByRole('button', { name: /aumentar quantidade/i })).toBeInTheDocument()
      expect(dentro.getByRole('button', { name: /^continuar$/i })).toBeInTheDocument()

      // E nenhum link de saida sobrou ali.
      expect(dentro.queryByTestId('cta-final')).toBeNull()
      expect(secao!.querySelector('a[href="/comprar"]')).toBeNull()
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

  /**
   * Deixou de ser "divida deliberada" em 18/08/2026: o cliente declarou o
   * enquadramento na Lei 15.154/2025 e o kit do lancamento passou a carregar
   * a dispensa gravada por migration. Os tres estados agora convivem — "em
   * breve" segue sendo o default honesto de um kit futuro sem declaracao.
   * A copy vem de src/lib/anvisa.ts, a MESMA fonte da vitrine.
   */
  describe('situacao ANVISA', () => {
    it('diz "em breve" enquanto nao ha registro nem dispensa', async () => {
      await renderizarHome()

      const anvisa = screen.getByTestId('anvisa')
      expect(anvisa).toHaveTextContent(/em breve/i)
      // Pendencia de verdade merece moldura de atencao.
      expect(anvisa.className).toContain('aviso--atencao')
    })

    it('kit dispensado mostra a Lei 15.154/2025, sem moldura de alerta', async () => {
      vi.mocked(listarKitsAtivos)
        .mockResolvedValue([{ ...KIT, anvisaDispensado: true }])
      await renderizarHome()

      const anvisa = screen.getByTestId('anvisa')
      expect(anvisa).toHaveTextContent('Lei nº 15.154/2025')
      expect(anvisa).not.toHaveTextContent(/em breve/i)
      // Situacao RESOLVIDA nao se veste de alerta: o comprador leria
      // problema onde nao ha.
      expect(anvisa.className).not.toContain('aviso--atencao')
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
    const { container } = render(await PaginaInicial({ searchParams: Promise.resolve({}) }))

    expect(container.querySelectorAll('.reveal')).toHaveLength(0)
  })
})
