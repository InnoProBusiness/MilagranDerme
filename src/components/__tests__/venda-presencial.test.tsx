import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  VendaPresencial,
  interpretarResposta,
  tetoDoBalcao,
} from '@/components/venda-presencial'
import { QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import type { Kit } from '@/repositories/produtos'
import { deInteiro } from '@/lib/money'

/**
 * O BALCAO DO EVENTO DE 25/08 (§10), pelo lado da tela.
 *
 * O que este arquivo existe para provar, em uma frase: NENHUM estado desta
 * tela deixa duvida sobre se a venda foi registrada e se o kit pode ser
 * entregue — e nenhum toque a mais tira um segundo kit da caixa.
 *
 * As duas leituras erradas que ele barra custam dinheiro em direcoes opostas:
 *   - ler so `response.ok` mostraria "venda aprovada" para um cartao recusado,
 *     e o comprador sairia pela porta com o kit sem ter pago;
 *   - ler todo erro como "nao aconteceu nada" faria o vendedor refazer uma
 *     venda que JA existe, gravando um segundo pedido e uma segunda baixa por
 *     um kit so.
 *
 * OS CORPOS DE RESPOSTA SAO COPIADOS DE src/app/api/vendas-presenciais/route.ts,
 * campo por campo. Um fixture "parecido" nao provaria nada: o contrato inteiro
 * desta tela e o campo `vendaRegistrada` viajar junto com os erros posteriores
 * ao COMMIT, e um fixture que esquecesse esse campo passaria a testar uma API
 * que nao existe.
 */

// deInteiro(), nunca `100000 as never`. O `as never` desligaria o construtor de
// Centavos e com ele a validacao de runtime — um fixture com 19.9 renderizaria
// R$ 0,20 em vez de estourar, que e um erro de 100x no valor que o vendedor le
// em voz alta para o comprador.
const KIT: Kit = {
  id: 'k1', slug: 'kit-milagran', nome: 'Kit Milagran',
  descricao: 'Kit de limpeza de pele instantanea.',
  precoCentavos: deInteiro(100000), unidades: 1, sku: 'MG-KIT-001',
  anvisaRegistro: null, ativo: true, ordem: 1,
  // O balcao nao cota frete nenhum (venda presencial nao tem entrega), mas o
  // fixture e tipado como `Kit` de proposito e por isso precisa da forma
  // inteira — inclusive peso e dimensoes, que existem para a cotacao online.
  pesoGramas: 760, alturaCm: 6, larguraCm: 18, comprimentoCm: 23,
}

const VENDEDOR = { nome: 'Ana Souza', papel: 'vendedor' } as const
// O tamanho do lote e o do evento (50 kits, §2/§4 —
// migrations/1755300700000_seed_estoque.sql), para os testes exercitarem os
// mesmos numeros do dia 25/08.
const LOTE = { disponivel: 50, total: 50 }

const TOKEN = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'

/** 201 de cartao aprovado: o unico desfecho que autoriza entregar o kit. */
const APROVADA = {
  vendaRegistrada: true,
  numero: 1042,
  token: TOKEN,
  pagamento: { metodo: 'cartao', status: 'aprovado', pedidoPago: true },
}

/** 201 de Pix: nasce PENDENTE. O webhook confirma depois — a tela, nunca. */
const PIX_PENDENTE = {
  vendaRegistrada: true,
  numero: 1043,
  token: TOKEN,
  pagamento: {
    metodo: 'pix',
    status: 'pendente',
    pixCopiaECola: '00020126580014br.gov.bcb.pix...milagran',
    pixQrBase64: 'iVBORw0KGgo=',
    expiraEm: '2026-08-25T23:59:59.000-03:00',
  },
}

/** 402: A VENDA EXISTE e o pagamento nao aconteceu. O caso que da nome ao arquivo. */
const PAGAMENTO_RECUSADO = {
  error: 'pagamento_recusado',
  vendaRegistrada: true,
  numero: 1044,
  token: TOKEN,
  pagamento: { metodo: 'cartao', status: 'recusado' },
  mensagem: 'O cartão não tem limite disponível para este valor. Tente outro cartão ou pague com Pix.',
}

/** 502: o Mercado Pago nao respondeu DEPOIS de a venda ja estar commitada. */
const FALHA_NO_PROVEDOR = {
  error: 'falha_no_provedor',
  vendaRegistrada: true,
  numero: 1045,
  token: TOKEN,
  mensagem: 'A venda foi registrada, mas a cobrança não foi criada. NÃO entregue o kit: tente cobrar de novo por este mesmo pedido.',
}

/** 409 antes do COMMIT: nada foi gravado e nenhum kit saiu da caixa. */
const ESTOQUE_ESGOTADO = {
  error: 'estoque_esgotado',
  mensagem: 'Restam apenas 2 kit(s) na caixa do evento e esta venda pedia 3. Ajuste a quantidade.',
  disponivel: 2,
}

const ESTOQUE_NAO_CONFIGURADO = {
  error: 'estoque_nao_configurado',
  mensagem: 'Este kit não está configurado para venda no evento. Chame o administrador antes de entregar o produto.',
}

type RespostaFalsa = { ok: boolean; status: number; json: () => Promise<unknown> }

function resposta(status: number, corpo: unknown): RespostaFalsa {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo }
}

/**
 * `fetch` que responde SEMPRE a mesma coisa e recusa qualquer URL que nao seja
 * a do balcao: uma chamada de rede que ninguem previu tem que aparecer como
 * teste vermelho, nao como resposta plausivel.
 */
function criarFetchFalso(r: RespostaFalsa) {
  return vi.fn(async (entrada: string, init?: RequestInit): Promise<RespostaFalsa> => {
    void init
    if (entrada !== '/api/vendas-presenciais') {
      throw new Error(`URL inesperada no teste: ${entrada}`)
    }
    return r
  })
}

type FetchFalso = ReturnType<typeof criarFetchFalso>

function corpoEnviado(fetchMock: FetchFalso): Record<string, unknown> {
  const ultima = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  if (!ultima) throw new Error('Nenhuma chamada para /api/vendas-presenciais')
  return JSON.parse(String(ultima[1]?.body)) as Record<string, unknown>
}

/**
 * Promessa que SO resolve quando o teste mandar. E o que permite exercitar o
 * intervalo em que a requisicao esta em voo — exatamente onde o segundo toque
 * do vendedor cai.
 *
 * `liberar` nasce como no-op em vez de `null` para o TypeScript nao estreitar o
 * tipo para `never` depois de um `!`; o executor do Promise roda de forma
 * sincrona, entao a funcao de verdade ja esta no lugar quando isto retorna.
 */
function criarPendente() {
  let resolver: (r: RespostaFalsa) => void = () => {}
  const promessa = new Promise<RespostaFalsa>((res) => { resolver = res })
  return { promessa, liberar: (r: RespostaFalsa) => resolver(r) }
}

async function preencherComprador() {
  await userEvent.type(screen.getByLabelText(/nome completo/i), 'Maria Aparecida')
  await userEvent.type(screen.getByLabelText(/e-mail/i), 'maria.balcao@exemplo.com')
  await userEvent.type(screen.getByLabelText(/cpf/i), '12345678901')
  await userEvent.type(screen.getByLabelText(/whatsapp/i), '11988887777')
}

function botaoConfirmar() {
  return screen.getByRole('button', { name: /confirmar venda/i })
}

function desfecho() {
  return screen.getByTestId('desfecho')
}

/**
 * Os titulos sao escritos em caixa normal no JSX e virados para caixa alta pelo
 * CSS (.venda__aprovada-titulo, .venda__erro-titulo). Isso e deliberado: quem
 * enxerga le "VENDA APROVADA" a metros de distancia e quem usa leitor de tela
 * ouve "Venda aprovada" em vez de receber a palavra soletrada letra a letra.
 * Por isso toda assercao aqui e case-insensitive — ela verifica a INFORMACAO,
 * nao a caixa das letras, que e assunto da folha de estilo.
 */
const APROVACAO = /venda aprovada/i
const NAO_ENTREGUE = /não entregue o kit/i

describe('VendaPresencial', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ---------- o caminho feliz ----------

  it('sucesso mostra VENDA APROVADA, libera a entrega e atualiza o contador', async () => {
    vi.stubGlobal('fetch', criarFetchFalso(resposta(201, APROVADA)))
    render(<VendaPresencial vendedor={VENDEDOR} kit={KIT} saldoInicial={LOTE} />)

    expect(screen.getByTestId('kits-restantes')).toHaveTextContent('50')

    await preencherComprador()
    await userEvent.click(botaoConfirmar())

    const bloco = await screen.findByTestId('desfecho')
    expect(bloco).toHaveTextContent(APROVACAO)
    // A frase unica que o vendedor le: a venda existe E o kit pode sair.
    expect(bloco).toHaveTextContent(/está registrada e paga/i)
    expect(bloco).toHaveTextContent(/pode entregar o kit/i)
    expect(bloco).toHaveTextContent('1042')

    // O CONTADOR CAIU UMA UNIDADE, nos dois lugares em que ele aparece — o do
    // topo (para a proxima venda) e o do desfecho (para o vendedor saber, no
    // mesmo olhar, se ainda ha kit para o proximo da fila).
    expect(screen.getByTestId('kits-restantes')).toHaveTextContent('49')
    expect(screen.getByTestId('kits-restantes-desfecho')).toHaveTextContent('49')
  })

  it('DINHEIRO: o corpo do POST nao leva nenhum valor monetario', async () => {
    const fetchMock = criarFetchFalso(resposta(201, APROVADA))
    vi.stubGlobal('fetch', fetchMock)
    render(<VendaPresencial vendedor={VENDEDOR} kit={KIT} saldoInicial={LOTE} />)

    await preencherComprador()
    await userEvent.click(botaoConfirmar())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const corpo = corpoEnviado(fetchMock)

    // O corpo INTEIRO, e nao so a ausencia de campos proibidos: o schema da
    // rota e `.strict()` e o preco sai do catalogo la dentro. Um `total` aqui
    // seria 422 — mas a garantia de verdade e ele nunca ser montado.
    expect(corpo).toEqual({
      kitSlug: 'kit-milagran',
      quantidade: 1,
      metodo: 'pix',
      nome: 'Maria Aparecida',
      email: 'maria.balcao@exemplo.com',
      cpf: '12345678901',
      whatsapp: '11988887777',
    })

    // Segunda camada, no molde de checkout-wizard.test.tsx: qualquer NOME que
    // cheire a dinheiro, mesmo um que ninguem pensou em listar.
    for (const chave of Object.keys(corpo)) {
      expect(chave).not.toMatch(/pre[cç]o|valor|total|subtotal|desconto|frete|centavos/i)
    }
    // Terceira camada, a que pega o caso mais perigoso: o valor certo enviado
    // sob um nome inocente.
    const numeros = Object.values(corpo).filter((v): v is number => typeof v === 'number')
    for (const n of numeros) {
      expect([100000, 200000, 300000]).not.toContain(n)
    }
  })

  it('DINHEIRO: o total acompanha a quantidade e nao inclui frete nenhum', async () => {
    vi.stubGlobal('fetch', criarFetchFalso(resposta(201, APROVADA)))
    render(<VendaPresencial vendedor={VENDEDOR} kit={KIT} saldoInicial={LOTE} />)

    expect(screen.getByTestId('valor-unitario')).toHaveTextContent('Valor unitário: R$ 1.000,00')
    expect(screen.getByTestId('total')).toHaveTextContent('Total a cobrar: R$ 1.000,00')

    const aumentar = screen.getByRole('button', { name: /aumentar/i })
    await userEvent.click(aumentar)
    await userEvent.click(aumentar)

    expect(screen.getByTestId('quantidade')).toHaveTextContent('3')
    expect(screen.getByTestId('total')).toHaveTextContent('Total a cobrar: R$ 3.000,00')
    // Venda presencial NAO TEM FRETE (§2: o kit sai na mao do comprador), e a
    // tela nao imprime linha de frete nenhuma — nem "R$ 0,00", que anunciaria
    // um frete gratis que nao existe como categoria aqui.
    expect(document.body.textContent ?? '').not.toContain('R$ 0,00')
    expect(document.body.textContent ?? '').not.toMatch(/frete/i)
  })

  // ---------- 402: A VENDA EXISTE E O KIT NAO SAI ----------

  /**
   * O TESTE MAIS IMPORTANTE DO ARQUIVO.
   *
   * O corpo carrega `vendaRegistrada: true` COM status 402 — a unidade ja saiu
   * da caixa e o cartao foi recusado. Um front que olhasse `response.ok`
   * mostraria a tela verde de aprovacao aqui; um front que tratasse 402 como
   * "nao aconteceu nada" faria o vendedor refazer a venda e tirar um segundo
   * kit da caixa. As duas coisas sao verificadas abaixo.
   */
  it('402 com vendaRegistrada NAO mostra VENDA APROVADA e manda nao entregar o kit', async () => {
    vi.stubGlobal('fetch', criarFetchFalso(resposta(402, PAGAMENTO_RECUSADO)))
    render(<VendaPresencial vendedor={VENDEDOR} kit={KIT} saldoInicial={LOTE} />)

    await preencherComprador()
    await userEvent.click(botaoConfirmar())

    const bloco = await screen.findByTestId('desfecho')
    expect(bloco).not.toHaveTextContent(APROVACAO)
    expect(document.body.textContent ?? '').not.toMatch(APROVACAO)

    expect(bloco).toHaveTextContent(NAO_ENTREGUE)
    // A tela diz que a venda ESTA registrada — e diz o numero dela, que e o que
    // o vendedor precisa para cobrar de novo o MESMO pedido.
    expect(bloco).toHaveTextContent(/está registrada/i)
    expect(bloco).toHaveTextContent('1044')
    // A mensagem curada pelo servidor sobre o motivo da recusa, sem a tela
    // reescrever nada por cima.
    expect(bloco).toHaveTextContent(/não tem limite disponível/i)

    // A UNIDADE SAIU DA CAIXA MESMO SEM PAGAMENTO: a rota baixa o estoque na
    // criacao do pedido, dentro da mesma transacao (§10). Um contador que so
    // caisse no sucesso prometeria ao proximo da fila um kit ja reservado.
    expect(screen.getByTestId('kits-restantes')).toHaveTextContent('49')

    // E NAO HA COMO REENVIAR ESTA VENDA: o formulario sai de cena e o unico
    // caminho e comecar outra. O link do pedido e por onde se cobra de novo.
    expect(screen.queryByRole('button', { name: /confirmar venda/i })).toBeNull()
    expect(screen.getByRole('button', { name: /nova venda/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /página do pedido/i }))
      .toHaveAttribute('href', `/pedido/${TOKEN}`)
  })

  it('502 do provedor tambem avisa que a venda esta registrada e o kit nao sai', async () => {
    vi.stubGlobal('fetch', criarFetchFalso(resposta(502, FALHA_NO_PROVEDOR)))
    render(<VendaPresencial vendedor={VENDEDOR} kit={KIT} saldoInicial={LOTE} />)

    await preencherComprador()
    await userEvent.click(botaoConfirmar())

    const bloco = await screen.findByTestId('desfecho')
    expect(bloco).not.toHaveTextContent(APROVACAO)
    expect(bloco).toHaveTextContent(NAO_ENTREGUE)
    expect(bloco).toHaveTextContent(/está registrada/i)
    expect(bloco).toHaveTextContent('1045')
    expect(screen.getByTestId('kits-restantes')).toHaveTextContent('49')
    expect(screen.queryByRole('button', { name: /confirmar venda/i })).toBeNull()
  })

  // ---------- Pix pendente: registrada, mas ninguem pagou ainda ----------

  it('201 de Pix pendente mostra o QR e NAO anuncia aprovacao', async () => {
    vi.stubGlobal('fetch', criarFetchFalso(resposta(201, PIX_PENDENTE)))
    render(<VendaPresencial vendedor={VENDEDOR} kit={KIT} saldoInicial={LOTE} />)

    await preencherComprador()
    await userEvent.click(botaoConfirmar())

    const bloco = await screen.findByTestId('desfecho')
    // Pix nasce pendente e quem confirma e o webhook. Um 201 lido como sucesso
    // liberaria o kit antes de o dinheiro cair.
    expect(bloco).not.toHaveTextContent(APROVACAO)
    expect(bloco).toHaveTextContent(NAO_ENTREGUE)
    expect(bloco).toHaveTextContent(/ainda NÃO foi confirmado/i)

    expect(screen.getByAltText(/QR code do Pix/i)).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgo=',
    )
    expect(screen.getByLabelText(/copia e cola/i)).toHaveValue(PIX_PENDENTE.pagamento.pixCopiaECola)
    // A unidade saiu da caixa no registro, nao no pagamento.
    expect(screen.getByTestId('kits-restantes')).toHaveTextContent('49')
  })

  // ---------- 409: nada foi gravado ----------

  it('409 estoque_esgotado tem mensagem propria e corrige o contador pelo servidor', async () => {
    vi.stubGlobal('fetch', criarFetchFalso(resposta(409, ESTOQUE_ESGOTADO)))
    render(<VendaPresencial vendedor={VENDEDOR} kit={KIT} saldoInicial={LOTE} />)

    await preencherComprador()
    const aumentar = screen.getByRole('button', { name: /aumentar/i })
    await userEvent.click(aumentar)
    await userEvent.click(aumentar)
    await userEvent.click(botaoConfirmar())

    const bloco = await screen.findByTestId('desfecho')
    expect(bloco).not.toHaveTextContent(APROVACAO)
    // A frase da tela: a venda NAO existe e nenhum kit saiu.
    expect(bloco).toHaveTextContent(/A venda NÃO foi registrada/i)
    expect(bloco).toHaveTextContent(/nenhum kit saiu da caixa/i)
    // E a mensagem PROPRIA do servidor, que aqui diz o que fazer a seguir
    // (ajustar a quantidade) — informacao que a tela nao tem como produzir.
    expect(bloco).toHaveTextContent(/Restam apenas 2 kit\(s\) na caixa/i)

    // O SALDO DO SERVIDOR MANDA: 50 era o retrato do carregamento da pagina e
    // nao viu as vendas dos outros aparelhos do evento; 2 foi lido dentro da
    // transacao que recusou esta venda.
    expect(screen.getByTestId('kits-restantes')).toHaveTextContent('2')

    // Recusa ANTES do COMMIT deixa o formulario em pe: corrigir a quantidade e
    // tentar de novo e seguro, porque nada foi gravado.
    expect(botaoConfirmar()).toBeInTheDocument()

    // E o stepper ja acompanha o teto novo: os 3 pedidos nao cabem mais na
    // caixa de 2. O proximo toque em "-" parte do que esta NA TELA, e nao do
    // numero bruto que o vendedor tinha digitado antes da correcao — senao o
    // primeiro toque nao mudaria nada, com a fila esperando.
    expect(screen.getByTestId('quantidade')).toHaveTextContent('2')
    await userEvent.click(screen.getByRole('button', { name: /diminuir/i }))
    expect(screen.getByTestId('quantidade')).toHaveTextContent('1')
  })

  it('409 estoque_nao_configurado tem mensagem diferente da de estoque esgotado', async () => {
    vi.stubGlobal('fetch', criarFetchFalso(resposta(409, ESTOQUE_NAO_CONFIGURADO)))
    render(<VendaPresencial vendedor={VENDEDOR} kit={KIT} saldoInicial={LOTE} />)

    await preencherComprador()
    await userEvent.click(botaoConfirmar())

    const bloco = await screen.findByTestId('desfecho')
    expect(bloco).toHaveTextContent(/A venda NÃO foi registrada/i)
    expect(bloco).toHaveTextContent(/não está configurado para venda no evento/i)
    // O conserto e OUTRO — chamar o administrador, e nao vender menos kits.
    // Achatar os dois 409 faria o vendedor tentar a vida reduzindo a
    // quantidade para sempre.
    expect(bloco).toHaveTextContent(/não tente reduzir a quantidade/i)
    expect(bloco).not.toHaveTextContent(/Ajuste a quantidade/i)
    // Nada saiu da caixa: o contador nao se mexe.
    expect(screen.getByTestId('kits-restantes')).toHaveTextContent('50')
  })

  // ---------- o toque duplo ----------

  it('duplo clique no "Confirmar venda" envia UMA requisicao so', async () => {
    const pendente = criarPendente()
    const fetchMock = vi.fn(async (entrada: string) => {
      if (entrada !== '/api/vendas-presenciais') throw new Error(`URL inesperada: ${entrada}`)
      return pendente.promessa
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VendaPresencial vendedor={VENDEDOR} kit={KIT} saldoInicial={LOTE} />)
    await preencherComprador()

    const botao = botaoConfirmar()
    await userEvent.click(botao)
    // O segundo toque cai com a primeira requisicao ainda em voo — que e
    // exatamente o que acontece num celular, em pe, com fila. Duas
    // requisicoes aqui seriam DOIS pedidos e DUAS baixas de estoque por um kit
    // so.
    await userEvent.click(botao)
    await userEvent.click(botao)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(botao).toBeDisabled()

    pendente.liberar(resposta(201, APROVADA))
    await waitFor(() => expect(desfecho()).toHaveTextContent(APROVACAO))
    // Uma unica venda, um unico kit fora da caixa.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('kits-restantes')).toHaveTextContent('49')
  })

  // ---------- o estado que nenhuma tela gosta de ter ----------

  /**
   * A CONEXAO CAIU E NAO SABEMOS DE NADA. A requisicao pode ter chegado,
   * commitado a venda e baixado a unidade antes de o WiFi do evento cair. O
   * texto natural aqui ("falha de conexao, tente de novo") mandaria o vendedor
   * refazer uma venda que talvez ja exista — e por isso ele nao existe nesta
   * tela.
   */
  it('falha de rede nao afirma nada: manda conferir antes de entregar ou refazer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rede caiu') }))
    render(<VendaPresencial vendedor={VENDEDOR} kit={KIT} saldoInicial={LOTE} />)

    await preencherComprador()
    await userEvent.click(botaoConfirmar())

    const bloco = await screen.findByTestId('desfecho')
    expect(bloco).not.toHaveTextContent(APROVACAO)
    expect(bloco).toHaveTextContent(/NÃO é possível saber se a venda foi registrada/i)
    expect(bloco).toHaveTextContent(NAO_ENTREGUE)
    expect(bloco).toHaveTextContent(/NÃO refaça esta venda/i)
    // A tela NAO diz "a venda nao foi registrada" — porque nao sabe.
    expect(bloco).not.toHaveTextContent(/A venda NÃO foi registrada/i)

    // Reenviar seria a pior saida possivel, entao o formulario sai de cena.
    expect(screen.queryByRole('button', { name: /confirmar venda/i })).toBeNull()
    // E o contador nao e mexido: nao ha o que afirmar sobre ele.
    expect(screen.getByTestId('kits-restantes')).toHaveTextContent('50')
  })

  // ---------- estado vazio honesto ----------

  it('sem lote presencial nao mostra contador nenhum e avisa o vendedor', () => {
    vi.stubGlobal('fetch', criarFetchFalso(resposta(201, APROVADA)))
    render(<VendaPresencial vendedor={VENDEDOR} kit={KIT} saldoInicial={null} />)

    // Nem "0": um kit que nunca teve caixa no evento nao pode anunciar
    // esgotamento que nunca aconteceu.
    expect(screen.queryByTestId('kits-restantes')).toBeNull()
    expect(screen.getByText(/não tem estoque presencial configurado/i)).toBeInTheDocument()
    // A venda continua tentavel: a autoridade sobre o estoque e a rota, e o
    // 409 dela e uma resposta melhor do que a tela adivinhando.
    expect(botaoConfirmar()).toBeInTheDocument()
  })

  it('so o admin ve o link do painel', () => {
    vi.stubGlobal('fetch', criarFetchFalso(resposta(201, APROVADA)))
    const { unmount } = render(
      <VendaPresencial vendedor={VENDEDOR} kit={KIT} saldoInicial={LOTE} />,
    )
    // Vendedor levaria 403 em /admin (COBERTURA, src/lib/guarda.ts): anunciar
    // uma porta que fecha na cara nao ajuda ninguem no meio da fila.
    expect(screen.queryByRole('link', { name: /painel administrativo/i })).toBeNull()
    unmount()

    render(
      <VendaPresencial
        vendedor={{ nome: 'Marcos', papel: 'admin' }}
        kit={KIT}
        saldoInicial={LOTE}
      />,
    )
    expect(screen.getByRole('link', { name: /painel administrativo/i })).toBeInTheDocument()
  })

  // ---------- o stepper contra o que ha na caixa ----------

  it('desabilita "Aumentar" no que resta na caixa, antes de QUANTIDADE_MAXIMA', async () => {
    const NA_CAIXA = 2
    // Premissa asseverada em vez de suposta: se QUANTIDADE_MAXIMA encolhesse
    // ate NA_CAIXA, o teste passaria sem provar nada sobre o segundo teto.
    expect(NA_CAIXA).toBeLessThan(QUANTIDADE_MAXIMA)

    vi.stubGlobal('fetch', criarFetchFalso(resposta(201, APROVADA)))
    render(
      <VendaPresencial
        vendedor={VENDEDOR}
        kit={KIT}
        saldoInicial={{ disponivel: NA_CAIXA, total: 50 }}
      />,
    )

    const aumentar = screen.getByRole('button', { name: /aumentar/i })
    for (let i = 0; i < NA_CAIXA + 3; i++) {
      await userEvent.click(aumentar)
    }

    expect(screen.getByTestId('quantidade')).toHaveTextContent(String(NA_CAIXA))
    expect(aumentar).toBeDisabled()
  })
})

/**
 * Os dois ajudantes puros, chamados direto — sem clique, sem DOM e sem rede.
 * Sao a regra que decide se um kit sai da caixa; o `disabled` de um botao pode
 * mudar amanha, a aritmetica e a leitura da resposta precisam continuar
 * cobertas.
 */
describe('tetoDoBalcao', () => {
  it('sem lote presencial vale o teto do banco', () => {
    expect(tetoDoBalcao(null)).toBe(QUANTIDADE_MAXIMA)
    // SUM() do Postgres chegando como NULL vira NaN no caminho ate aqui. Um
    // teto NaN desabilitaria o "+" para sempre, em silencio.
    expect(tetoDoBalcao(Number.NaN)).toBe(QUANTIDADE_MAXIMA)
  })

  it('manda a caixa quando ela e menor que o teto do banco', () => {
    expect(tetoDoBalcao(3)).toBe(3)
    expect(tetoDoBalcao(50)).toBe(QUANTIDADE_MAXIMA)
    // Fracionario nao existe em kit: 3.9 kits sao 3 kits.
    expect(tetoDoBalcao(3.9)).toBe(3)
  })

  /**
   * A DIFERENCA DELIBERADA PARA A VITRINE. La, `tetoDeQuantidade(0)` devolve
   * QUANTIDADE_MAXIMA porque o lote esgotado empurra a compra para o canal
   * online, que e pre-venda sem teto (§4). Aqui nao existe canal online: o
   * balcao so vende o que esta na caixa, e um stepper que fosse ate 20 com a
   * caixa vazia so montaria uma venda que o servidor vai recusar inteira.
   */
  it('caixa vazia trava em 1, ao contrario da vitrine', () => {
    expect(tetoDoBalcao(0)).toBe(1)
    // Saldo negativo existe de verdade (ajuste de inventario maior que o
    // saldo) e cai no mesmo lugar.
    expect(tetoDoBalcao(-3)).toBe(1)
  })
})

describe('interpretarResposta', () => {
  it('so libera a entrega com pagamento confirmado no corpo', () => {
    expect(interpretarResposta(201, APROVADA).entregar).toBe(true)
    expect(interpretarResposta(201, PIX_PENDENTE).entregar).toBe(false)
    expect(interpretarResposta(402, PAGAMENTO_RECUSADO).entregar).toBe(false)
    // ... e nos tres a venda EXISTE, com a unidade ja fora da caixa.
    expect(interpretarResposta(201, APROVADA).registrada).toBe(true)
    expect(interpretarResposta(201, PIX_PENDENTE).registrada).toBe(true)
    expect(interpretarResposta(402, PAGAMENTO_RECUSADO).registrada).toBe(true)
  })

  /**
   * A DIRECAO DA DUVIDA. Uma resposta que nao traga nem `vendaRegistrada` nem
   * um dos codigos de erro ANTERIORES ao COMMIT (um 502 do Traefik com corpo
   * HTML, um JSON que nao deu para ler) nao prova que a transacao nao
   * commitou. Tratar isso como "nao foi registrada" e o que faz o vendedor
   * refazer a venda e tirar duas unidades da caixa por um kit so.
   */
  it('resposta de forma desconhecida vira incerteza, nunca "nao registrada"', () => {
    for (const caso of [
      interpretarResposta(502, null),
      interpretarResposta(500, { erro: 'texto fora do contrato' }),
      // 2xx sem `vendaRegistrada` tambem: se o campo sumir do contrato, a tela
      // para em vez de anunciar aprovacao ou negar a venda.
      interpretarResposta(201, { numero: 7, token: TOKEN }),
    ]) {
      expect(caso.entregar).toBe(false)
      expect(caso.podeTentarDeNovo).toBe(false)
      expect(caso.frase).toMatch(/NÃO é possível saber/i)
    }
  })

  /**
   * DINHEIRO: os dois 500 pos-COMMIT pedem acoes OPOSTAS, e o codigo HTTP e o
   * mesmo nos dois. Quem separa e `cobrancaCriada`.
   *
   * Sem esta distincao a tela mandava "cobre de novo pelo MESMO pedido" tambem
   * quando a cobranca ja existia no Mercado Pago e podia ja estar capturada —
   * debitando o comprador duas vezes pelo mesmo kit, num balcao com fila, onde
   * ninguem confere extrato na hora.
   */
  it('500 com cobranca ja criada manda conferir, nunca cobrar de novo', () => {
    const d = interpretarResposta(500, {
      error: 'conciliacao_falhou',
      vendaRegistrada: true,
      cobrancaCriada: true,
      numero: 12,
      token: TOKEN,
    })

    expect(d.registrada).toBe(true)
    expect(d.entregar).toBe(false)
    expect(d.podeTentarDeNovo).toBe(false)
    expect(d.frase).toMatch(/NÃO cobre de novo/i)
    // A instrucao do OUTRO ramo, que aqui seria uma cobranca em duplicidade.
    // Mirar em /Cobre de novo/i nao serve: casa com o proprio "NÃO cobre de
    // novo" acima, entao passaria dizendo o contrario do que verifica.
    expect(d.frase).not.toMatch(/pelo MESMO pedido/i)
    // O link do pedido e a acao que sobra para o vendedor: sem numero e token
    // ele nao tem como conferir nada.
    expect(d.numero).toBe(12)
    expect(d.token).toBe(TOKEN)
  })

  it('500 sem cobranca criada continua mandando cobrar de novo pelo mesmo pedido', () => {
    const d = interpretarResposta(500, {
      error: 'nao_foi_possivel_cobrar',
      vendaRegistrada: true,
      numero: 13,
      token: TOKEN,
    })

    expect(d.registrada).toBe(true)
    expect(d.entregar).toBe(false)
    expect(d.frase).toMatch(/Cobre de novo pelo MESMO pedido/i)
  })

  it('erros anteriores ao COMMIT liberam nova tentativa do mesmo formulario', () => {
    const esgotado = interpretarResposta(409, ESTOQUE_ESGOTADO)
    expect(esgotado.registrada).toBe(false)
    expect(esgotado.podeTentarDeNovo).toBe(true)
    expect(esgotado.disponivelInformado).toBe(2)

    const semSessao = interpretarResposta(401, { error: 'nao_autenticado' })
    expect(semSessao.registrada).toBe(false)
    expect(semSessao.podeTentarDeNovo).toBe(true)
    expect(semSessao.frase).toMatch(/NÃO foi registrada/i)
  })

  /**
   * Sessao caida e o UNICO desfecho que pede reautenticacao — e por isso o
   * unico que mostra o link de login.
   *
   * A frase promete que os dados digitados continuam na tela. Sem o link, o
   * vendedor tinha que sair para /login pelo menu, o componente desmontava e
   * os dados sumiam exatamente ao seguir a instrucao. O link abre em aba nova
   * justamente para a promessa ser verdadeira.
   */
  it('so a sessao encerrada pede reautenticacao', () => {
    expect(interpretarResposta(401, { error: 'nao_autenticado' }).reautenticar).toBe(true)
    expect(interpretarResposta(403, { error: 'acesso_negado' }).reautenticar).toBe(true)

    for (const outro of [
      interpretarResposta(201, APROVADA),
      interpretarResposta(402, PAGAMENTO_RECUSADO),
      interpretarResposta(409, ESTOQUE_ESGOTADO),
      interpretarResposta(502, null),
    ]) {
      expect(outro.reautenticar).toBe(false)
    }
  })
})
