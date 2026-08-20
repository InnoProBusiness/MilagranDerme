import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  criarOrderPixMP, buscarOrderMP, criarPagamentoMP, ErroMercadoPago,
} from '@/lib/mercadopago'
import { deInteiro } from '@/lib/money'

/**
 * O CONTRATO DA ORDERS API — o corpo que sai daqui e o que a loja entende de
 * volta.
 *
 * POR QUE ESTE ARQUIVO EXISTE, sendo que nenhuma rota chama `criarOrderPixMP`.
 *
 * Em 19/08/2026 a conta do Mercado Pago ficou com `address_pending` e o
 * PolicyAgent passou a recusar TODA criacao de cobranca em `/v1/payments` —
 * Pix, boleto e cartao — com 403 `PA_UNAUTHORIZED_RESULT_FROM_POLICIES`. A
 * loja parou de cobrar. `POST /v1/orders` nao passava pelo mesmo bloqueio, e
 * foi por ai que a saida foi construida
 * (docs/2026-08-19-migrar-pix-para-orders.md).
 *
 * Em 20/08/2026 o bloqueio caiu e o Pix ficou onde estava — `/v1/payments` e o
 * unico caminho com entrega de webhook comprovada nesta conta. A saida
 * continua escrita, e continua TESTADA, porque o dia em que ela for necessaria
 * sera de novo um dia de loja parada, e ninguem escreve teste com a loja
 * parada.
 *
 * As diferencas entre as duas APIs sao TODAS silenciosas quando quebram:
 * mandar o valor como numero, mandar um campo a mais, ou ler o QR do lugar
 * errado nao produz erro de compilacao nenhum — produz uma tela de checkout sem
 * QR code, ou um 400 na frente da compradora. Cada `it` abaixo fixa uma dessas
 * diferencas, medidas contra a producao.
 *
 * A COSTURA MOCKADA E `fetch`, e so ela. Todo o resto — montagem do corpo,
 * leitura da resposta, traducao do erro — e o codigo de producao.
 */

const TOKEN = 'APP_USR-token-de-teste'

type Chamada = { url: string; init: RequestInit }

const chamadas: Chamada[] = []

function responder(status: number, corpo: unknown) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    chamadas.push({ url, init })
    return new Response(JSON.stringify(corpo), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function corpoEnviado(): Record<string, any> {
  return JSON.parse(String(chamadas[0].init.body))
}

/** A forma que a producao devolveu em 19/08/2026, reduzida ao que lemos. */
function respostaDeOrderPix(over: Record<string, unknown> = {}) {
  return {
    id: 'ORD01M0DW0CJ1QGRJP9KM4MHHFM8S',
    status: 'action_required',
    status_detail: 'waiting_transfer',
    external_reference: 'pedido-123',
    transactions: {
      payments: [{
        // O id do PAGAMENTO, que e diferente do id da ORDER e nao serve para
        // reler nada — ver o teste "grava o id da ORDER".
        id: 'PAY01M0DW0CJA5GXQ3M22H5JB1N84',
        amount: '814.94',
        status: 'action_required',
        status_detail: 'waiting_transfer',
        date_of_expiration: '2026-08-20T20:39:17.584+00:00',
        payment_method: {
          id: 'pix',
          type: 'bank_transfer',
          qr_code: '00020126580014br.gov.bcb.pix0136 92d60646-2c97-4cf6-a96c-391b8086fbdf',
          qr_code_base64: 'iVBORw0KGgo',
          ticket_url: 'https://www.mercadopago.com.br/payments/1/ticket',
        },
      }],
    },
    ...over,
  }
}

const ENTRADA = {
  valor: deInteiro(81494),
  referenciaExterna: 'pedido-123',
  pagador: {
    email: 'compradora@exemplo.com',
    nome: 'Maria',
    sobrenome: 'Aparecida da Silva',
    cpf: '39053344705',
  },
}

beforeEach(() => {
  chamadas.length = 0
  process.env.MERCADOPAGO_ACCESS_TOKEN = TOKEN
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('criarOrderPixMP: o corpo que sai', () => {
  it('bate em /v1/orders, e nao em /v1/payments', async () => {
    responder(201, respostaDeOrderPix())
    await criarOrderPixMP(ENTRADA, 'chave-idem-1')

    expect(chamadas[0].url).toBe('https://api.mercadopago.com/v1/orders')
    expect(chamadas[0].init.method).toBe('POST')
  })

  /**
   * O VALOR VAI COMO STRING. Medido: numero JSON e recusado pela Orders API.
   * Este e o erro mais facil de cometer copiando `criarPagamentoMP`, onde
   * `transaction_amount` e justamente um numero — e o sintoma seria a loja
   * inteira parando de gerar Pix.
   */
  it('total_amount e amount vao como STRING decimal, nao numero nem centavos', async () => {
    responder(201, respostaDeOrderPix())
    await criarOrderPixMP(ENTRADA, 'chave-idem-2')

    const corpo = corpoEnviado()
    expect(corpo.total_amount).toBe('814.94')
    expect(corpo.transactions.payments[0].amount).toBe('814.94')
    expect(typeof corpo.total_amount).toBe('string')
    // Nem 81494 (centavos) nem 814.94 (numero).
    expect(corpo.total_amount).not.toBe(81494)
    expect(corpo.total_amount).not.toBe(814.94)
  })

  /**
   * `notification_url` NO CORPO DERRUBA A COBRANCA. Medido:
   * `400 unsupported_properties — additionalProperties '$.notification_url' not
   * allowed`. A URL de notificacao da Orders vem do painel do Mercado Pago.
   *
   * Este teste protege contra o conserto "obvio" que alguem faria ao ver que a
   * order nao manda notification_url como o pagamento manda.
   */
  it('NAO manda notification_url — a Orders recusa o campo', async () => {
    responder(201, respostaDeOrderPix())
    await criarOrderPixMP(ENTRADA, 'chave-idem-3')

    expect(corpoEnviado()).not.toHaveProperty('notification_url')
  })

  /**
   * O `payer` leva SO O E-MAIL: e o corpo exato que devolveu 201 em producao e
   * o mesmo do exemplo oficial de Pix da Orders API. Acrescentar
   * first_name/last_name/identification aqui nao e "mais informacao" — e risco
   * de 400 `unsupported_properties` num campo nao provado, e a cobranca inteira
   * cai.
   */
  it('o payer leva so o e-mail', async () => {
    responder(201, respostaDeOrderPix())
    await criarOrderPixMP(ENTRADA, 'chave-idem-4')

    expect(corpoEnviado().payer).toEqual({ email: 'compradora@exemplo.com' })
  })

  // A chave de idempotencia e o id da linha em `pagamentos`, gerada ANTES da
  // chamada. Sem ela, a retentativa de uma requisicao que expirou sem resposta
  // cobraria a compradora duas vezes.
  it('manda X-Idempotency-Key com a chave recebida', async () => {
    responder(201, respostaDeOrderPix())
    await criarOrderPixMP(ENTRADA, 'chave-idem-5')

    const headers = chamadas[0].init.headers as Record<string, string>
    expect(headers['X-Idempotency-Key']).toBe('chave-idem-5')
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('external_reference carrega o id do pedido', async () => {
    responder(201, respostaDeOrderPix())
    await criarOrderPixMP(ENTRADA, 'chave-idem-6')

    expect(corpoEnviado().external_reference).toBe('pedido-123')
    expect(corpoEnviado().type).toBe('online')
    expect(corpoEnviado().processing_mode).toBe('automatic')
    expect(corpoEnviado().transactions.payments[0].payment_method)
      .toEqual({ id: 'pix', type: 'bank_transfer' })
  })
})

describe('criarOrderPixMP: a resposta que entra', () => {
  /**
   * O QR MUDOU DE LUGAR. Em `/v1/payments` ele vive em
   * point_of_interaction.transaction_data; na Orders, em
   * transactions.payments[0].payment_method. Ler do lugar antigo nao lanca
   * nada: devolve undefined, e a compradora ve a tela de Pix sem QR e sem
   * copia-e-cola.
   */
  it('acha o QR e o copia-e-cola dentro de transactions.payments[0]', async () => {
    responder(201, respostaDeOrderPix())
    const r = await criarOrderPixMP(ENTRADA, 'k')

    expect(r.pixCopiaECola).toContain('br.gov.bcb.pix')
    expect(r.pixQrBase64).toBe('iVBORw0KGgo')
    expect(r.expiraEm).toBe('2026-08-20T20:39:17.584+00:00')
  })

  /**
   * GRAVA O ID DA ORDER, NUNCA O DO PAGAMENTO DE DENTRO DELA. O `PAY01...` nao
   * existe em `/v1/payments/{id}` (medido: `resource not found`) e nao e o que
   * o webhook recebe em `data.id`. Gravar o id errado em
   * `pagamentos.provedor_id` deixaria a linha local impossivel de casar com a
   * notificacao — o dinheiro entra e o pedido nunca vira 'pago'.
   */
  it('o id normalizado e o da ORDER, nao o do pagamento aninhado', async () => {
    responder(201, respostaDeOrderPix())
    const r = await criarOrderPixMP(ENTRADA, 'k')

    expect(r.id).toBe('ORD01M0DW0CJ1QGRJP9KM4MHHFM8S')
    expect(r.id.startsWith('PAY')).toBe(false)
  })

  it('le status e status_detail da raiz da order', async () => {
    responder(201, respostaDeOrderPix())
    const r = await criarOrderPixMP(ENTRADA, 'k')

    expect(r.status).toBe('action_required')
    expect(r.statusDetail).toBe('waiting_transfer')
    expect(r.referenciaExterna).toBe('pedido-123')
  })

  // Uma order sem a lista de pagamentos (ou com ela vazia) nao pode derrubar a
  // rota com "cannot read property of undefined": o pedido existe do mesmo
  // jeito e o webhook ainda vai reconciliar.
  it('order sem lista de pagamentos nao quebra a leitura', async () => {
    responder(200, { id: 'ORD1', status: 'processed', status_detail: 'accredited' })
    const r = await buscarOrderMP('ORD1')

    expect(r.status).toBe('processed')
    expect(r.pixCopiaECola).toBeUndefined()
    expect(r.expiraEm).toBeUndefined()
  })
})

describe('buscarOrderMP', () => {
  it('le em /v1/orders/{id}', async () => {
    responder(200, respostaDeOrderPix({ status: 'processed', status_detail: 'accredited' }))
    const r = await buscarOrderMP('ORD01M0DW0CJ1QGRJP9KM4MHHFM8S')

    expect(chamadas[0].url)
      .toBe('https://api.mercadopago.com/v1/orders/ORD01M0DW0CJ1QGRJP9KM4MHHFM8S')
    expect(chamadas[0].init.method).toBe('GET')
    expect(r.status).toBe('processed')
    expect(r.statusDetail).toBe('accredited')
  })
})

/**
 * O LOG QUE DIZ O QUE ACONTECEU.
 *
 * `falhaDoProvedor` (testada em mercadopago-falha.test.ts) decide o que a
 * compradora le. Este bloco cuida do outro lado: o que a OPERACAO le. Um erro
 * que chega ao console como 'desconhecido: erro sem mensagem' custou uma
 * semana em 19/08/2026, porque a causa real (`address_pending`) nao aparecia em
 * lugar nenhum.
 */
describe('formatos de erro do Mercado Pago', () => {
  // O formato da Orders API: a mensagem NAO esta na raiz, esta dentro de
  // `errors[]`. Era exatamente aqui que o log virava 'erro sem mensagem'.
  it('erro da Orders (errors[]) chega com codigo E mensagem', async () => {
    responder(400, {
      errors: [{
        code: 'unsupported_properties',
        message: "additionalProperties '$.notification_url' not allowed",
      }],
    })

    const e = await criarOrderPixMP(ENTRADA, 'k').catch((x) => x)

    expect(e).toBeInstanceOf(ErroMercadoPago)
    expect((e as ErroMercadoPago).status).toBe(400)
    expect((e as ErroMercadoPago).codigo).toBe('unsupported_properties')
    expect((e as ErroMercadoPago).message).toContain('notification_url')
    expect((e as ErroMercadoPago).message).not.toContain('erro sem mensagem')
  })

  // Regressao: o formato de /v1/payments com `code` na raiz — a recusa do
  // PolicyAgent de 19/08/2026 — continua sendo lido igual.
  it('403 do PolicyAgent em /v1/payments continua nomeando a causa', async () => {
    responder(403, {
      code: 'PA_UNAUTHORIZED_RESULT_FROM_POLICIES',
      message: 'At least one policy returned UNAUTHORIZED.',
      blocked_by: 'PolicyAgent',
    })

    const e = await criarPagamentoMP({
      metodo: 'cartao', valor: deInteiro(100), descricao: 'x',
      referenciaExterna: 'p', pagador: ENTRADA.pagador,
      token: 'tok', parcelas: 1, metodoPagamentoId: 'visa',
    }, 'k').catch((x) => x)

    expect((e as ErroMercadoPago).codigo).toBe('PA_UNAUTHORIZED_RESULT_FROM_POLICIES')
    expect((e as ErroMercadoPago).status).toBe(403)
  })

  // O formato antigo com `error` na raiz tambem nao pode regredir.
  it('erro de /v1/payments com `error` na raiz continua lido', async () => {
    responder(404, { error: 'not_found', message: 'Payment not found' })

    const e = await criarOrderPixMP(ENTRADA, 'k').catch((x) => x)

    expect((e as ErroMercadoPago).codigo).toBe('not_found')
    expect((e as ErroMercadoPago).message).toContain('Payment not found')
  })

  // Corpo de erro que nao encaixa em nenhum dos formatos nao pode virar
  // excecao sem status: a rota precisa do numero para decidir se manda tentar
  // de novo.
  it('erro sem formato conhecido ainda carrega o status HTTP', async () => {
    responder(500, { qualquer: 'coisa' })

    const e = await criarOrderPixMP(ENTRADA, 'k').catch((x) => x)

    expect((e as ErroMercadoPago).status).toBe(500)
    expect((e as ErroMercadoPago).codigo).toBe('desconhecido')
  })
})
