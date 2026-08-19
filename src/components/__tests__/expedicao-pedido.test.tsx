import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExpedicaoPedido, statusOferecidos } from '@/components/expedicao-pedido'
import type { TipoEntrega } from '@/lib/pedido-status'
import { ROTULOS_STATUS } from '@/lib/pedido-status'
import type { PedidoStatus } from '@/repositories/pedidos'

// useRouter() exige um App Router montado, inexistente em jsdom puro. Mockar e
// o padrao recomendado pela propria Next.js para testar Client Component
// isolado — e `refresh` precisa ser observavel: e ele que faz a linha da tabela
// (renderizada no servidor) mostrar o status novo depois do PATCH.
const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}))

const PEDIDO_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
const URL_DO_PATCH = `/api/admin/pedidos/${PEDIDO_ID}`

type RespostaFalsa = { ok: boolean; status: number; json: () => Promise<unknown> }

function resposta(status: number, corpo: unknown): RespostaFalsa {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo }
}

/**
 * URL diferente da esperada LANCA em vez de devolver algo plausivel: uma
 * chamada de rede que ninguem previu (o painel batendo em /api/admin/vendas por
 * engano, por exemplo) tem que aparecer como teste vermelho.
 */
function criarFetchFalso(resultado: RespostaFalsa = resposta(200, { pedidoId: PEDIDO_ID })) {
  return vi.fn(async (entrada: string, init?: RequestInit): Promise<RespostaFalsa> => {
    void init
    if (entrada === URL_DO_PATCH) return resultado
    throw new Error(`URL inesperada no teste: ${entrada}`)
  })
}

type FetchFalso = ReturnType<typeof criarFetchFalso>

function corpoEnviado(fetchMock: FetchFalso): Record<string, unknown> {
  const ultima = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  if (!ultima) throw new Error('Nenhuma chamada a PATCH /api/admin/pedidos/[id]')
  return JSON.parse(String(ultima[1]?.body)) as Record<string, unknown>
}

function renderizar(
  status: PedidoStatus,
  rastreio: { codigo: string | null; transportadora: string | null } = { codigo: null, transportadora: null },
  tipoEntrega: TipoEntrega = 'envio',
) {
  render(
    <ExpedicaoPedido
      pedidoId={PEDIDO_ID}
      numero={1042}
      status={status}
      tipoEntrega={tipoEntrega}
      rastreioCodigo={rastreio.codigo}
      rastreioTransportadora={rastreio.transportadora}
    />,
  )
}

function botaoSalvar() {
  return screen.getByRole('button', { name: /^salvar$/i })
}

describe('statusOferecidos', () => {
  /**
   * DINHEIRO: os dois estados que mexem no livro-razao de comissao nao podem
   * ser oferecidos por esta tela em estado NENHUM. A rota ja recusa com 422
   * (TransicaoFinanceiraError), mas oferecer o botao e depois recusar o clique
   * ensina a operacao a ignorar erro vermelho no meio da fila do evento.
   *
   * A varredura e sobre TODOS os status do ENUM — a lista sai das chaves de
   * ROTULOS_STATUS, que e Record<PedidoStatus, ...> e por isso esta sempre
   * completa: um valor novo no ENUM entra neste teste sozinho.
   */
  it('DINHEIRO: nunca oferece "pago" nem "reembolsado", a partir de nenhum status', () => {
    const todos = Object.keys(ROTULOS_STATUS) as PedidoStatus[]

    for (const atual of todos) {
      const oferecidos = statusOferecidos(atual)
      expect(oferecidos, `a partir de ${atual}`).not.toContain('pago')
      expect(oferecidos, `a partir de ${atual}`).not.toContain('reembolsado')
    }
  })

  // O caminho normal da expedicao continua inteiro: separar, postar, acompanhar
  // e entregar. Sem esta assercao, um filtro exagerado que devolvesse lista
  // vazia para tudo passaria no teste acima.
  it('oferece o caminho da expedicao a partir de pago', () => {
    expect(statusOferecidos('pago')).toEqual(['em_preparacao', 'enviado', 'entregue'])
  })

  it('nao oferece nada a partir de entregue: so restaria reembolso', () => {
    expect(statusOferecidos('entregue')).toEqual([])
  })
})

describe('ExpedicaoPedido', () => {
  afterEach(() => {
    refresh.mockReset()
    vi.unstubAllGlobals()
  })

  it('DINHEIRO: o seletor nao lista reembolso nem pagamento', () => {
    vi.stubGlobal('fetch', criarFetchFalso())
    renderizar('pago')

    const seletor = screen.getByLabelText(/novo status do pedido/i)
    const rotulos = Array.from(seletor.querySelectorAll('option')).map((o) => o.textContent ?? '')

    expect(rotulos.join(' | ')).not.toMatch(/reembolsad/i)
    // "Pagamento confirmado" e o rotulo de 'pago' (ROTULOS_STATUS): ele so pode
    // aparecer na opcao "Manter …", nunca como destino.
    expect(rotulos.filter((r) => /pagamento confirmado/i.test(r))).toHaveLength(1)
    expect(rotulos[0]).toMatch(/^manter/i)
  })

  it('substitui o seletor por uma frase quando nao ha para onde mover', () => {
    vi.stubGlobal('fetch', criarFetchFalso())
    renderizar('entregue')

    expect(screen.queryByLabelText(/novo status do pedido/i)).toBeNull()
    expect(screen.getByText(/sem mudança de status disponível/i)).toBeInTheDocument()
  })

  /**
   * Os dois campos de rastreio andam JUNTOS: registrarRastreio grava as duas
   * colunas de uma vez, entao mandar so o codigo apagaria a transportadora
   * gravada — em silencio, num pedido ja a caminho. A rota devolve 422
   * `rastreio_incompleto`; a tela recusa antes, e o que este teste prova e que
   * ela nem chega a chamar a rede.
   */
  it('recusa codigo sem transportadora sem chamar a rota', async () => {
    const fetchMock = criarFetchFalso()
    vi.stubGlobal('fetch', fetchMock)
    renderizar('pago')

    await userEvent.type(screen.getByLabelText(/código de rastreio/i), 'AA123456789BR')
    await userEvent.click(botaoSalvar())

    expect(screen.getByTestId('mensagem-expedicao')).toHaveTextContent(
      /código de rastreio e a transportadora juntos/i,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('recusa o submit vazio sem chamar a rota', async () => {
    const fetchMock = criarFetchFalso()
    vi.stubGlobal('fetch', fetchMock)
    renderizar('pago')

    await userEvent.click(botaoSalvar())

    expect(screen.getByTestId('mensagem-expedicao')).toHaveTextContent(
      /escolha um novo status ou informe o código/i,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * O corpo e travado com `toEqual` (e nao `toMatchObject`) de proposito: o
   * schema da rota e `.strict()`, entao uma chave a mais nao e detalhe — e 422
   * em cima de um clique legitimo. E nenhuma das tres chaves aceitas e dinheiro:
   * valor de pedido e congelado pelo trigger de imutabilidade e nao existe
   * caminho no sistema que o reescreva.
   */
  it('envia status e rastreio no corpo exato do PATCH', async () => {
    const fetchMock = criarFetchFalso()
    vi.stubGlobal('fetch', fetchMock)
    renderizar('pago')

    await userEvent.selectOptions(
      screen.getByLabelText(/novo status do pedido/i),
      'enviado',
    )
    await userEvent.type(screen.getByLabelText(/código de rastreio/i), 'AA123456789BR')
    await userEvent.type(screen.getByLabelText(/transportadora/i), 'Correios')
    await userEvent.click(botaoSalvar())

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PATCH')
    expect(corpoEnviado(fetchMock)).toEqual({
      status: 'enviado',
      rastreioCodigo: 'AA123456789BR',
      rastreioTransportadora: 'Correios',
    })

    // Sem o refresh, a coluna "Status" da linha continuaria mostrando o valor
    // anterior ate alguem recarregar a mao — e a proxima pessoa a olhar a fila
    // postaria de novo um pedido ja postado.
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('mensagem-expedicao')).toHaveTextContent(/atualizado/i)
  })

  // So o status: o rastreio fica de fora do corpo em vez de ir como string
  // vazia. Campo ausente e "nao mexa nisso"; string vazia seria recusada pelo
  // `min(1)` do schema e, se passasse, apagaria o codigo de um pedido a caminho.
  it('envia so o status quando o rastreio nao foi preenchido', async () => {
    const fetchMock = criarFetchFalso()
    vi.stubGlobal('fetch', fetchMock)
    renderizar('pago')

    await userEvent.selectOptions(
      screen.getByLabelText(/novo status do pedido/i),
      'em_preparacao',
    )
    await userEvent.click(botaoSalvar())

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(corpoEnviado(fetchMock)).toEqual({ status: 'em_preparacao' })
  })

  /**
   * A mensagem curada da rota chega inteira a tela. E o caso de
   * TransicaoFinanceiraError e o de TransicaoInvalidaError: as duas trazem uma
   * frase em portugues que diz o que fazer no lugar, e reescreve-la aqui criaria
   * uma segunda versao do texto, que divergiria da primeira.
   */
  it('mostra a mensagem que a rota devolveu quando ela recusa', async () => {
    const fetchMock = criarFetchFalso(resposta(409, {
      error: 'transicao_invalida',
      mensagem: 'O pedido não está mais no estado que a tela mostrava.',
    }))
    vi.stubGlobal('fetch', fetchMock)
    renderizar('pago')

    await userEvent.selectOptions(screen.getByLabelText(/novo status do pedido/i), 'enviado')
    await userEvent.click(botaoSalvar())

    await waitFor(() => {
      expect(screen.getByTestId('mensagem-expedicao')).toHaveTextContent(
        /não está mais no estado que a tela mostrava/i,
      )
    })
    // Nada mudou no servidor: recarregar a tabela mostraria o mesmo estado e so
    // esconderia o erro que o administrador precisa ler.
    expect(refresh).not.toHaveBeenCalled()
  })

  // Falha de rede nao pode virar "salvou": o PATCH pode ter chegado. A frase
  // manda conferir, que e a unica instrucao verdadeira nesse estado.
  it('manda conferir quando a conexao falha', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sem rede') }))
    renderizar('pago')

    await userEvent.selectOptions(screen.getByLabelText(/novo status do pedido/i), 'enviado')
    await userEvent.click(botaoSalvar())

    await waitFor(() => {
      expect(screen.getByTestId('mensagem-expedicao')).toHaveTextContent(
        /atualize a página para conferir/i,
      )
    })
    expect(refresh).not.toHaveBeenCalled()
  })
})

/**
 * A LINHA DE RETIRADA NA FILA DO PAINEL (19/08/2026). Sem estes casos, a tela
 * nunca era renderizada como retirada em teste nenhum — e as duas coisas que a
 * distinguem sao justamente ausencias, o tipo de defeito que passa despercebido.
 */
describe('ExpedicaoPedido: retirada no local', () => {
  it('nao oferece nenhum status de postagem', () => {
    renderizar('pago', { codigo: null, transportadora: null }, 'retirada')

    const alvos = statusOferecidos('pago', 'retirada')
    expect(alvos).not.toContain('em_preparacao')
    expect(alvos).not.toContain('enviado')
    expect(alvos).not.toContain('em_transito')

    // E a tela concorda com a funcao: nenhuma <option> de postagem no <select>.
    for (const proibido of [/em prepara/i, /^enviado$/i, /em tr[aâ]nsito/i]) {
      expect(screen.queryByRole('option', { name: proibido })).toBeNull()
    }
  })

  /**
   * O DESFECHO TEM QUE EXISTIR. Um filtro bem-intencionado demais que tirasse
   * 'entregue' junto deixaria todo pedido de retirada preso em 'pago', sem
   * nenhum botao capaz de conclui-lo — e o teste acima, sozinho, continuaria
   * verde.
   */
  it('oferece "Entregue", que e como a retirada termina', () => {
    renderizar('pago', { codigo: null, transportadora: null }, 'retirada')
    expect(screen.getByRole('option', { name: /entregue/i })).toBeInTheDocument()
  })

  // Somem, e nao ficam cinzas: campo desabilitado ainda pergunta algo, e nao ha
  // nada a perguntar sobre a postagem de um kit que ninguem vai postar.
  it('nao pede codigo de rastreio nem transportadora', () => {
    renderizar('pago', { codigo: null, transportadora: null }, 'retirada')

    expect(screen.queryByLabelText(/c[oó]digo de rastreio/i)).toBeNull()
    expect(screen.queryByLabelText(/transportadora/i)).toBeNull()
  })

  it('a fila de envio continua pedindo os dois', () => {
    renderizar('pago')
    expect(screen.getByLabelText(/c[oó]digo de rastreio/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/transportadora/i)).toBeInTheDocument()
  })
})
