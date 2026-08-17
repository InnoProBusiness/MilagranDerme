import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ContadorEstoque, lerSaldo } from '@/components/contador-estoque'

/**
 * O contador e o unico componente do projeto que fala com a rede sozinho, e o
 * que ele mostra decide o que o comprador acha que pode fazer: 'esgotado' e o
 * nivel que troca a CTA da home por "COMPRAR ONLINE". Por isso os testes daqui
 * nao sao sobre pintura — sao sobre as tres formas de o polling mentir:
 * responder fora de ordem, cair de rede e continuar batendo depois que a tela
 * saiu.
 *
 * Intervalos curtos (10-15ms) em vez de timer falso: o componente combina
 * `setInterval` com `await fetch`, e adiantar o relogio nao adianta as
 * promessas — o teste com timer falso precisaria de um `advanceTimers` para
 * cada microtask e travaria na primeira mudanca de implementacao. Com
 * intervalo curto e `waitFor`, o que se afirma e o comportamento observavel.
 */

type RespostaFalsa = { ok: boolean; json: () => Promise<unknown> }

/** O corpo REAL de GET /api/estoque (src/app/api/estoque/route.ts). */
function corpoDaRota(disponivel: number, total = 50): unknown {
  return {
    kitSlug: 'kit-milagran',
    presencial: { disponivel, total, esgotado: disponivel <= 0 },
    // O componente IGNORA este campo de proposito e recalcula a frase com
    // src/lib/escassez.ts. O fixture manda texto errado justamente para que o
    // teste quebre se alguem passar a confiar na string que veio da rede.
    aviso: { nivel: 'normal', mensagem: 'TEXTO QUE NAO PODE APARECER NA TELA' },
    online: { ilimitado: true },
  }
}

function respostaOk(disponivel: number, total = 50): RespostaFalsa {
  return { ok: true, json: async () => corpoDaRota(disponivel, total) }
}

function instalarFetch(impl: (url: string) => Promise<RespostaFalsa>) {
  const espia = vi.fn(impl)
  vi.stubGlobal('fetch', espia)
  return espia
}

/** Promessa que o teste solta na hora que quiser, para encenar atraso de rede. */
function promessaControlada() {
  let soltar: () => void = () => {}
  const promessa = new Promise<void>((resolve) => { soltar = resolve })
  return { promessa, soltar: () => soltar() }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ContadorEstoque', () => {
  it('mostra o saldo que veio do servidor antes de qualquer consulta de rede', () => {
    const espia = instalarFetch(async () => respostaOk(42))

    render(<ContadorEstoque inicial={{ disponivel: 42, total: 50 }} />)

    expect(screen.getByTestId('kits-disponiveis')).toHaveTextContent('42')
    expect(screen.getByTestId('contador-estoque'))
      .toHaveTextContent('Apenas 50 kits disponíveis para levar na hora.')
    // A primeira pintura NAO depende de rede: quem chega pelo QR Code do evento
    // ve o numero certo no primeiro frame, nao 15 segundos depois.
    expect(espia).not.toHaveBeenCalled()
  })

  it('atualiza o numero quando o polling responde', async () => {
    instalarFetch(async () => respostaOk(8))

    render(<ContadorEstoque inicial={{ disponivel: 42, total: 50 }} intervaloMs={15} />)

    expect(await screen.findByText('Restam apenas 8 kits disponíveis para levar hoje.'))
      .toBeInTheDocument()
    expect(screen.getByTestId('kits-disponiveis')).toHaveTextContent('8')
  })

  it('escreve a frase com src/lib/escassez.ts, nunca com o texto que veio da rede', async () => {
    instalarFetch(async () => respostaOk(3))

    render(<ContadorEstoque inicial={{ disponivel: 42, total: 50 }} intervaloMs={10} />)

    expect(await screen.findByText('Últimos 3 kits disponíveis para compra presencial.'))
      .toBeInTheDocument()
    expect(screen.getByTestId('contador-estoque'))
      .not.toHaveTextContent('TEXTO QUE NAO PODE APARECER NA TELA')
  })

  // O teste mais importante do arquivo. "0 kits" por causa de WiFi ruim nao e
  // um numero errado: e a loja anunciando esgotado sem estar, e mandando para a
  // compra online quem esta a tres metros do balcao.
  it('falha de rede NAO zera o contador: mantem o ultimo valor bom e segue tentando', async () => {
    const espia = instalarFetch(async () => { throw new Error('rede_indisponivel') })

    render(<ContadorEstoque inicial={{ disponivel: 7, total: 50 }} intervaloMs={10} />)

    // "segue tentando": nao ha desistencia depois da primeira falha.
    await waitFor(() => expect(espia.mock.calls.length).toBeGreaterThanOrEqual(3))

    const bloco = screen.getByTestId('contador-estoque')
    expect(screen.getByTestId('kits-disponiveis')).toHaveTextContent('7')
    expect(bloco).toHaveTextContent('Restam apenas 7 kits disponíveis para levar hoje.')
    expect(bloco.className).not.toContain('escassez--esgotado')
  })

  // Resposta HTTP que nao e 2xx cai na mesma regra: a rota respondeu, mas nao
  // com um numero. Nada muda na tela.
  it('resposta com erro HTTP nao muda o numero na tela', async () => {
    const espia = instalarFetch(async () => ({ ok: false, json: async () => ({ error: 'kit_nao_encontrado' }) }))

    render(<ContadorEstoque inicial={{ disponivel: 12, total: 50 }} intervaloMs={10} />)
    await waitFor(() => expect(espia.mock.calls.length).toBeGreaterThanOrEqual(2))

    expect(screen.getByTestId('kits-disponiveis')).toHaveTextContent('12')
  })

  it('resposta atrasada nao sobrescreve uma mais recente', async () => {
    const atraso = promessaControlada()
    let chamadas = 0
    const espia = instalarFetch(async () => {
      chamadas += 1
      // 1a consulta: fica presa (o WiFi lotado do evento) e so volta quando o
      // teste soltar — com um saldo VELHO, de antes da venda.
      if (chamadas === 1) {
        await atraso.promessa
        return respostaOk(40)
      }
      // 2a consulta: volta na frente, com o saldo novo.
      if (chamadas === 2) return respostaOk(8)
      // Da terceira em diante nada resolve: o teste quer olhar so o duelo
      // entre a primeira e a segunda.
      return new Promise<RespostaFalsa>(() => {})
    })

    render(<ContadorEstoque inicial={{ disponivel: 50, total: 50 }} intervaloMs={10} />)

    expect(await screen.findByText('Restam apenas 8 kits disponíveis para levar hoje.'))
      .toBeInTheDocument()

    atraso.soltar()
    // Espera um tique inteiro depois de soltar a atrasada: sem isso o teste
    // passaria mesmo com a guarda de ordem removida, porque olharia a tela
    // antes de a resposta velha chegar.
    await waitFor(() => expect(espia.mock.calls.length).toBeGreaterThanOrEqual(4))

    expect(screen.getByTestId('kits-disponiveis')).toHaveTextContent('8')
    expect(screen.getByTestId('contador-estoque'))
      .toHaveTextContent('Restam apenas 8 kits disponíveis para levar hoje.')
  })

  it('para de consultar depois do unmount', async () => {
    const espia = instalarFetch(async () => respostaOk(30))

    const { unmount } = render(
      <ContadorEstoque inicial={{ disponivel: 50, total: 50 }} intervaloMs={10} />,
    )
    await waitFor(() => expect(espia.mock.calls.length).toBeGreaterThanOrEqual(2))

    unmount()
    const consultasAteAqui = espia.mock.calls.length
    await new Promise((resolve) => { setTimeout(resolve, 60) })

    expect(espia.mock.calls.length).toBe(consultasAteAqui)
  })

  // O painel administrativo (§17) reusa este componente com atualizacao propria;
  // intervalo zero e como ele desliga o polling sem precisar de outro componente.
  it('intervalo zero desliga o polling e deixa o bloco estatico', async () => {
    const espia = instalarFetch(async () => respostaOk(1))

    render(<ContadorEstoque inicial={{ disponivel: 50, total: 50 }} intervaloMs={0} />)
    await new Promise((resolve) => { setTimeout(resolve, 40) })

    expect(espia).not.toHaveBeenCalled()
    expect(screen.getByTestId('kits-disponiveis')).toHaveTextContent('50')
  })

  it('consulta o kit que recebeu por prop, e nao o default da rota', async () => {
    const espia = instalarFetch(async () => respostaOk(9))

    render(
      <ContadorEstoque
        inicial={{ disponivel: 50, total: 50 }}
        kitSlug="kit-milagran"
        intervaloMs={10}
      />,
    )
    await waitFor(() => expect(espia).toHaveBeenCalled())

    expect(espia.mock.calls[0][0]).toBe('/api/estoque?kit=kit-milagran')
  })

  it('sem kitSlug consulta a rota sem parametro', async () => {
    const espia = instalarFetch(async () => respostaOk(9))

    render(<ContadorEstoque inicial={{ disponivel: 50, total: 50 }} intervaloMs={10} />)
    await waitFor(() => expect(espia).toHaveBeenCalled())

    expect(espia.mock.calls[0][0]).toBe('/api/estoque')
  })

  it('esgotado troca o numero pelo selo e continua anunciando a frase inteira', () => {
    instalarFetch(async () => respostaOk(0))

    render(<ContadorEstoque inicial={{ disponivel: 0, total: 50 }} />)

    const bloco = screen.getByTestId('contador-estoque')
    expect(bloco.className).toContain('escassez--esgotado')
    // Numero grande sai de cena: no esgotado ele seria um "0" gigante sem
    // significado proprio.
    expect(screen.queryByTestId('kits-disponiveis')).toBeNull()
    expect(bloco).toHaveTextContent('Os 50 kits disponíveis para compra presencial foram esgotados.')
  })

  it('anuncia mudanca de forma nao intrusiva (role=status) e marca a consulta em voo', async () => {
    const atraso = promessaControlada()
    instalarFetch(async () => {
      await atraso.promessa
      return respostaOk(5)
    })

    render(<ContadorEstoque inicial={{ disponivel: 50, total: 50 }} intervaloMs={10} />)
    const bloco = screen.getByRole('status')

    expect(bloco).toHaveAttribute('aria-busy', 'false')
    await waitFor(() => expect(bloco).toHaveAttribute('aria-busy', 'true'))

    atraso.soltar()
    await waitFor(() => expect(bloco).toHaveAttribute('aria-busy', 'false'))
    expect(bloco).toHaveTextContent('Últimos 5 kits disponíveis para compra presencial.')
  })
})

describe('lerSaldo', () => {
  it('devolve null para tudo que nao e um saldo utilizavel', () => {
    expect(lerSaldo(null)).toBeNull()
    expect(lerSaldo('resposta de proxy em HTML')).toBeNull()
    expect(lerSaldo({})).toBeNull()
    // Resposta LEGITIMA da rota: kit que nao entra no evento. Sem lote, sem
    // contador — e nunca zero, que anunciaria o fim de um lote que nao existiu.
    expect(lerSaldo({ presencial: null })).toBeNull()
    expect(lerSaldo({ presencial: { total: 50 } })).toBeNull()
    expect(lerSaldo({ presencial: { disponivel: 3 } })).toBeNull()
    expect(lerSaldo({ presencial: { disponivel: '3', total: 50 } })).toBeNull()
    expect(lerSaldo({ presencial: { disponivel: Number.NaN, total: 50 } })).toBeNull()
  })

  it('le o saldo quando ele esta la', () => {
    expect(lerSaldo(corpoDaRota(8))).toEqual({ disponivel: 8, total: 50 })
  })

  it('clampa saldo negativo em zero: "-3 kits" nao e verdade sobre a caixa do evento', () => {
    expect(lerSaldo({ presencial: { disponivel: -3, total: 50 } }))
      .toEqual({ disponivel: 0, total: 50 })
  })

  it('trunca fracionario: nao existe 5,9 kit', () => {
    expect(lerSaldo({ presencial: { disponivel: 5.9, total: 50.4 } }))
      .toEqual({ disponivel: 5, total: 50 })
  })
})
