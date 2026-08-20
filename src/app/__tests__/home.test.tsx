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
  /**
   * A MANCHETE MUDA DE TEMPO VERBAL, e as duas versoes sao copy aprovada: §6
   * escreve "CHEGOU" e §7 oferece "ESTA CHEGANDO" como alternativa. Publicar
   * "chegou" antes de 25/08 seria afirmar um fato que ainda nao aconteceu na
   * mesma pagina que avisa, logo abaixo, que os pedidos so saem no lancamento.
   */
  it('antes do lançamento abre com a manchete no futuro (§7)', async () => {
    await renderizarHome()

    expect(screen.getByRole('heading', {
      level: 1,
      name: 'UMA NOVA FORMA DE CUIDAR DA PELE ESTÁ CHEGANDO.',
    })).toBeInTheDocument()
    expect(screen.getByText(/15 anos de história deram origem/)).toBeInTheDocument()
  })

  it('depois do lançamento a manchete passa para o presente (§6)', async () => {
    vi.setSystemTime(DEPOIS_DO_LANCAMENTO)
    await renderizarHome()

    expect(screen.getByRole('heading', {
      level: 1,
      name: 'A NOVA EXPERIÊNCIA EM LIMPEZA DE PELE CHEGOU.',
    })).toBeInTheDocument()
    expect(screen.getByText(/Conheça a Milagran, uma nova proposta/)).toBeInTheDocument()
  })

  /**
   * §36 E UMA ORDEM, nao uma lista de assuntos — e a ordem mudou em
   * 20/08/2026.
   *
   * A sequencia antiga (§18 do documento de 16/08) respondia perguntas: o que
   * e -> kit -> preco -> pagar -> receber -> comprar. A nova constroi desejo
   * antes de responder: marca -> historia -> pertencimento -> produto ->
   * procedimento -> prova -> data -> escassez -> compra -> representantes.
   * Sao dois funis diferentes, e embaralhar o novo devolve a pagina ao
   * anterior sem ninguem perceber.
   */
  it('conta a jornada de §36 na ordem, da identidade ate a compra', async () => {
    await renderizarHome()

    const titulos = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(titulos).toEqual([
      'Não é apenas uma limpeza de pele.',
      '15 anos de história. Um propósito que agora ganha vida.',
      'Uma nova oportunidade para quem vive da beleza.',
      'Conheça o Kit Milagran.',
      'Como funciona.',
      'Não é só sobre o produto. É sobre a experiência.',
      '25 de agosto. O dia em que a Milagran chega ao mercado.',
      'Apenas 50 kits disponíveis no evento.',
      'Uma nova experiência começa agora.',
      'Quer levar a Milagran com você?',
    ])
  })

  /**
   * §8: O PRECO NAO APARECE ANTES DO CHECKOUT.
   *
   * Ate 20/08/2026 esta home mostrava o valor DUAS vezes — no hero e numa
   * secao inteira "Quanto custa". A regra nova e curiosidade -> desejo ->
   * percepcao de valor -> decisao -> checkout, e o numero so entra quando a
   * compradora ja esta avancando para pagar.
   *
   * O QUE ESTE TESTE NAO PROIBE: o preco DENTRO do checkout embutido. Aquele
   * bloco E o checkout de §20 — e o unico lugar da pagina autorizado a
   * imprimir o valor. Por isso a assercao nao e "nao existe R$ 249,00 na
   * pagina", que seria falsa e forcaria alguem a afrouxa-la; e "todo R$ 249,00
   * que existir esta dentro de #comprar".
   */
  it('DINHEIRO: o preço não aparece fora do checkout (§8)', async () => {
    await renderizarHome()

    // O bloco de preco do hero e a secao "Quanto custa" deixaram de existir.
    expect(screen.queryByTestId('preco')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Quanto custa' })).toBeNull()

    const compra = document.querySelector('#comprar') as HTMLElement
    expect(compra).not.toBeNull()

    // Todo valor impresso mora dentro da secao de compra.
    const unitarios = screen.getAllByTestId('valor-unitario')
    expect(unitarios.length).toBeGreaterThan(0)
    for (const linha of unitarios) {
      expect(linha).toHaveTextContent('R$ 249,00')
      expect(compra.contains(linha)).toBe(true)
    }
  })

  // A home nao conhece o CEP de ninguem, entao o unico valor de frete que ela
  // poderia imprimir seria zero — a promessa de frete gratis que
  // src/components/linha-frete.tsx existe para impedir.
  it('DINHEIRO: nao imprime R$ 0,00 em lugar nenhum', async () => {
    await renderizarHome()

    expect(document.body).not.toHaveTextContent('R$ 0,00')
  })

  // §17, palavra por palavra: o que a compradora presente no evento leva na
  // hora. As tres palavras sao uma frase so — se virarem lista, o leitor de
  // tela anuncia "lista de 3 itens" para o que e uma sentenca.
  it('traz o lema do evento de §17', async () => {
    await renderizarHome()

    const lema = screen.getByTestId('lema-presencial')
    expect(lema).toHaveTextContent('Comprou.')
    expect(lema).toHaveTextContent('Pagou.')
    expect(lema).toHaveTextContent('Levou.')
  })

  /**
   * §17: depois dos 50 presenciais a compra CONTINUA, pelos Correios. A frase
   * muda de tempo verbal conforme o lote — prometer "continuará disponível"
   * depois de esgotado deixaria a compradora achando que ainda ha kit no
   * balcao.
   */
  it('explica o que acontece depois que os kits do evento acabam', async () => {
    await renderizarHome()
    expect(document.body).toHaveTextContent(/continuará disponível pelo site/)

    vi.mocked(saldoDoEstoque).mockResolvedValue(saldoPresencial(0))
    document.body.innerHTML = ''
    await renderizarHome()
    expect(document.body).toHaveTextContent(/continua disponível pelo site/)
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

  // §20: as duas formas de pagamento continuam anunciadas — agora dentro da
  // secao de compra, e nao numa secao propria. `getByRole('region', {name})`
  // so acha a secao se o <h2> continuar sendo o nome acessivel dela.
  it('anuncia as duas formas de pagamento de §20', async () => {
    await renderizarHome()

    // Case-insensitive de proposito: a chamada da secao escreve "cartão de
    // crédito" no meio da frase e os chips do checkout escrevem "Cartão de
    // crédito" capitalizado. As duas dizem a mesma coisa, e travar a caixa
    // aqui quebraria o teste na primeira vez que alguem reescrevesse a frase.
    const secao = screen.getByRole('region', { name: 'Uma nova experiência começa agora.' })
    expect(secao.textContent).toMatch(/cartão de crédito/i)
    expect(secao.textContent).toMatch(/pix/i)
  })

  /**
   * §14 pede para EVITAR afirmacao medica ou resultado nao documentado, e a
   * secao do procedimento e o lugar mais facil de escorregar para "trata",
   * "elimina", "regenera". Este teste trava a contencao: se alguem enriquecer
   * a copy dos quatro passos com promessa clinica, ele fica vermelho.
   */
  it('§14: a descrição do procedimento não faz afirmação médica', async () => {
    await renderizarHome()

    const secao = screen.getByRole('region', { name: 'Como funciona.' })
    const texto = secao.textContent ?? ''
    for (const proibida of [/\btrata\b/i, /\bcura\b/i, /\belimina\b/i, /\bregenera\b/i, /\bacne\b/i]) {
      expect(texto).not.toMatch(proibida)
    }
    // E os quatro passos de §14 continuam la, na ordem.
    expect(secao.textContent).toMatch(/Preparação[\s\S]*Aplicação[\s\S]*Extração[\s\S]*Finalização/)
  })

  /**
   * §23: a funcionalidade de representante CONTINUA, mas deixou de ser a CTA
   * principal. As duas metades importam: sumir com o convite quebraria o
   * recrutamento; promove-lo a botao solido roubaria a atencao da compra, que
   * e o objetivo do lancamento (§39).
   */
  it('§23: mantém o convite de representante, e discreto', async () => {
    await renderizarHome()

    const link = screen.getByRole('link', { name: /quero representar a milagran/i })
    expect(link).toHaveAttribute('href', '/seja-representante.html')
    // Fantasma, nunca solido: um botao dourado aqui competiria com o checkout.
    expect(link.className).toContain('btn--ghost')
    expect(link.className).not.toContain('btn--solid')
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

  describe('CTA (§6, §9, §19)', () => {
    /**
     * §6 e §9: o hero tem DUAS CTAs com pesos diferentes, e a principal NAO e
     * a de compra.
     *
     * §39 manda a pagina nao entregar tudo no primeiro bloco. Quem chega sem
     * conhecer a marca precisa de um convite a conhecer; o botao de comprar
     * fica ao lado, fantasma, para quem ja decidiu. Inverter os dois devolve
     * a pagina ao funil antigo.
     */
    it('o hero convida a conhecer, com a compra ao lado', async () => {
      await renderizarHome()

      const principal = screen.getByTestId('cta-principal')
      expect(principal).toHaveTextContent('Quero conhecer a Milagran')
      expect(principal).toHaveAttribute('href', '#a-milagran')
      expect(principal.className).toContain('btn--solid')

      const secundaria = screen.getByTestId('cta-secundaria')
      expect(secundaria).toHaveTextContent('Garantir meu kit')
      // ANCORA, e nao /comprar: a compra acontece nesta pagina, no fim dela.
      expect(secundaria).toHaveAttribute('href', '#comprar')
    })

    /**
     * §19: a troca de rotulo desceu do hero para junto do CONTADOR.
     *
     * Ate 20/08/2026 ela vivia no botao do topo. O botao do topo e lido por
     * quem ainda nao sabe que existe um lote presencial, e "COMPRAR ONLINE"
     * ali responderia uma pergunta que ninguem fez. Ao lado do numero que a
     * justifica, a mesma palavra passa a fazer sentido.
     */
    it('a CTA da escassez é "GARANTIR MEU KIT" enquanto há kit no evento', async () => {
      await renderizarHome()

      const cta = screen.getByTestId('cta-escassez')
      expect(cta).toHaveTextContent('GARANTIR MEU KIT')
      expect(cta).toHaveAttribute('href', '#comprar')
    })

    it('vira "COMPRAR ONLINE" quando o presencial esgota', async () => {
      vi.mocked(saldoDoEstoque).mockResolvedValue(saldoPresencial(0))
      await renderizarHome()

      expect(screen.getByTestId('cta-escassez')).toHaveTextContent('COMPRAR ONLINE')
      // O destino NAO muda com o esgotamento: o canal online nao tem teto,
      // entao os dois rotulos levam a uma compra que existe.
      expect(screen.getByTestId('cta-escassez')).toHaveAttribute('href', '#comprar')
      expect(screen.getByTestId('contador-estoque'))
        .toHaveTextContent('Os 50 kits disponíveis para compra presencial foram esgotados.')
      // O hero NAO muda: ele continua convidando a conhecer a marca.
      expect(screen.getByTestId('cta-principal')).toHaveTextContent('Quero conhecer a Milagran')
    })

    /**
     * §32: a barra fixa do celular carrega a MESMA palavra da CTA de escassez.
     * Duas superficies falando do mesmo lote com rotulos diferentes e a
     * divergencia que src/lib/escassez.ts existe para impedir.
     */
    it('a barra fixa do celular acompanha o rótulo da escassez', async () => {
      await renderizarHome()
      expect(screen.getByTestId('barra-compra-mobile')).toHaveTextContent('GARANTIR MEU KIT')

      vi.mocked(saldoDoEstoque).mockResolvedValue(saldoPresencial(0))
      document.body.innerHTML = ''
      await renderizarHome()
      expect(screen.getByTestId('barra-compra-mobile')).toHaveTextContent('COMPRAR ONLINE')
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

      expect(screen.getByTestId('cta-escassez')).toHaveTextContent('COMPRAR ONLINE')
      expect(document.body).not.toHaveTextContent('-3')
    })
  })

  describe('tempo verbal (§21)', () => {
    // §21, palavra por palavra: "GARANTA SEU KIT ANTES DO LANÇAMENTO", com o
    // prazo dito claramente. A frase do prazo NAO e reescrita aqui — e a
    // constante AVISO_PRE_VENDA, a mesma que o checkout mostra.
    it('antes de 25/08 fala no futuro e usa a constante AVISO_PRE_VENDA', async () => {
      await renderizarHome()

      const prazo = screen.getByTestId('prazo-online')
      expect(prazo).toHaveTextContent('Garanta seu kit antes do lançamento')
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
      // NENHUMA CTA: as duas do hero sao ancoras para secoes que este estado
      // nao renderiza. Botao que rola para lugar nenhum e pior que botao
      // nenhum — a visitante conclui que o site quebrou em vez de ler o aviso.
      expect(screen.queryByTestId('cta-principal')).toBeNull()
      expect(screen.queryByTestId('cta-secundaria')).toBeNull()
      expect(screen.queryByTestId('cta-escassez')).toBeNull()
      expect(screen.queryByTestId('barra-compra-mobile')).toBeNull()
      // Sem kit nao ha o que perguntar ao estoque.
      expect(saldoDoEstoque).not.toHaveBeenCalled()
    })

    it('kit sem lote presencial: nenhum contador, nenhum numero inventado', async () => {
      // `null` = o kit nao tem linha de estoque presencial (nao entra no
      // evento). Nao e esgotado: e ausencia de lote.
      vi.mocked(saldoDoEstoque).mockResolvedValue(null)
      await renderizarHome()

      expect(screen.queryByTestId('contador-estoque')).toBeNull()
      expect(screen.getByTestId('cta-escassez')).toHaveTextContent('GARANTIR MEU KIT')
      expect(document.body).not.toHaveTextContent('foram esgotados')
      // Sem lote, o titulo nao inventa um numero de kits.
      expect(screen.getByRole('heading', { name: 'Kits disponíveis no evento.' }))
        .toBeInTheDocument()
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

  /**
   * AS FOTOS OFICIAIS AINDA NAO CHEGARAM (§5, §13, §15 do briefing de
   * 20/08/2026), e a pagina precisa ser publicavel assim mesmo — o lancamento
   * e em 25/08.
   *
   * O QUE ESTE BLOCO TRAVA nao e "a foto esta faltando", que e um estado
   * temporario: e que a AUSENCIA nao produz imagem quebrada nem promessa vazia.
   * Quando os arquivos entrarem em src/lib/fotos.ts, o primeiro teste passa a
   * encontrar <img> e o segundo continua valendo igual.
   */
  describe('fotos oficiais (§5, §13, §15)', () => {
    /**
     * ESTE TESTE MUDOU DE PERGUNTA quando as fotos chegaram, em 20/08/2026.
     *
     * Enquanto nao havia nenhuma, ele provava que a AUSENCIA nao virava imagem
     * quebrada — e contava molduras ornamentais. Com o hero e os quatro
     * produtos entregues, nao sobrou nenhuma moldura nesta pagina, e insistir
     * em contar molduras aqui so daria duas saidas ruins: afrouxar a assercao
     * ate ela nao provar nada, ou reintroduzir um buraco na pagina para o teste
     * ter o que medir.
     *
     * A garantia da ausencia nao sumiu: ela mudou de endereco, para
     * src/components/__tests__/foto-da-marca.test.tsx, onde e exercitada
     * diretamente e continua valendo mesmo com a loja inteira fotografada.
     * Aqui ficou a pergunta que so a PAGINA responde: as fotos declaradas
     * chegam mesmo a tela, com texto alternativo.
     */
    it('cada foto declarada vira uma <img> real, com alt', async () => {
      await renderizarHome()

      const imagens = [...document.querySelectorAll('img')]
      expect(imagens.length).toBeGreaterThanOrEqual(5) // hero + os quatro produtos

      for (const img of imagens) {
        // Nenhum <img> apontando para lugar nenhum.
        expect(img.getAttribute('src')).toBeTruthy()
        // E nenhuma foto muda em silencio para quem nao a ve. `alt=""` aqui
        // seria legitimo so para imagem DECORATIVA, e nenhuma destas e.
        expect(img.getAttribute('alt')).toBeTruthy()
      }

      // O hero carrega adiantado; o resto espera a rolagem (§33).
      const heroImg = document.querySelector('.hero__foto') as HTMLImageElement
      expect(heroImg).not.toBeNull()
      expect(heroImg.getAttribute('loading')).toBe('eager')
      expect(heroImg.getAttribute('fetchpriority')).toBe('high')
      for (const card of document.querySelectorAll('.kit-card__foto')) {
        expect(card.getAttribute('loading')).toBe('lazy')
      }
    })

    it('sem fotos dos testes, a seção de experiência não mostra galeria vazia', async () => {
      await renderizarHome()

      // A secao existe e o texto de §15 esta la...
      expect(screen.getByRole('heading', {
        name: 'Não é só sobre o produto. É sobre a experiência.',
      })).toBeInTheDocument()
      // ...e nao ha uma fileira de molduras vazias anunciando o que falta.
      expect(screen.queryByTestId('galeria-experiencia')).toBeNull()
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
