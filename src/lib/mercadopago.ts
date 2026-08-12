import type { Centavos } from '@/lib/money'

const BASE = 'https://api.mercadopago.com'
const TIMEOUT_MS = 15_000

/**
 * Token de servidor. NUNCA vai para o navegador — e ele que autoriza criar
 * cobranca e consultar qualquer pagamento da conta.
 *
 * O prefixo determina o ambiente: TEST-... fala com o sandbox, APP_USR-...
 * cobra de verdade. Nao ha troca de host nem de flag; trocar a variavel troca
 * o ambiente inteiro. E por isso que a integracao pode ser construida e
 * testada antes de o CNPJ passar no KYC — so o valor da env muda depois.
 */
export function tokenDeAcesso(): string {
  const t = process.env.MERCADOPAGO_ACCESS_TOKEN
  if (!t) throw new Error('MERCADOPAGO_ACCESS_TOKEN nao configurada')
  return t
}

/** Chave publica, usada pelo Payment Brick no navegador para tokenizar cartao. */
export function chavePublica(): string {
  const k = process.env.MERCADOPAGO_PUBLIC_KEY
  if (!k) throw new Error('MERCADOPAGO_PUBLIC_KEY nao configurada')
  return k
}

export function segredoDoWebhook(): string {
  const s = process.env.MERCADOPAGO_WEBHOOK_SECRET
  if (!s) throw new Error('MERCADOPAGO_WEBHOOK_SECRET nao configurada')
  return s
}

/**
 * URL que o Mercado Pago chama quando o status do pagamento muda. Precisa ser
 * publica e HTTPS — o proprio Mercado Pago recusa http:// e localhost, entao
 * em desenvolvimento isto so funciona atras de um tunel.
 */
function urlDeNotificacao(): string {
  const base = process.env.APP_URL ?? 'https://milagranoficial.com.br'
  return `${base.replace(/\/$/, '')}/api/webhooks/mercadopago`
}

export class ErroMercadoPago extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensagem: string,
  ) {
    super(`mercadopago_${status}: ${mensagem}`)
    this.name = 'ErroMercadoPago'
  }
}

export type PagadorMP = {
  email: string
  nome: string
  sobrenome: string
  cpf: string
}

export type EntradaPagamentoMP = {
  valor: Centavos
  descricao: string
  /** id do pedido — ancora de reconciliacao quando a linha local se perde. */
  referenciaExterna: string
  pagador: PagadorMP
} & (
  | { metodo: 'pix' }
  | {
      metodo: 'cartao'
      /** Token gerado NO NAVEGADOR pelo Brick. O numero do cartao nunca chega aqui. */
      token: string
      parcelas: number
      /** 'visa', 'master', 'elo'... vem do Brick, nao e adivinhado. */
      metodoPagamentoId: string
      emissorId?: string
    }
)

export type RespostaPagamentoMP = {
  id: string
  status: string
  statusDetail: string
  /**
   * O id do pedido, gravado por nos na criacao. E a ancora de reconciliacao
   * do webhook: mesmo que a linha em `pagamentos` nao exista (processo morto
   * entre abrir e vincular), este campo diz a qual pedido a cobranca pertence.
   */
  referenciaExterna: string | null
  /** Copia-e-cola do Pix. Ausente em cartao. */
  pixCopiaECola?: string
  /** QR code em PNG base64, sem o prefixo data:. Ausente em cartao. */
  pixQrBase64?: string
  expiraEm?: string
}

/**
 * Cria a cobranca no Mercado Pago.
 *
 * `chaveIdempotencia` e o id da linha em `pagamentos`, gerado ANTES desta
 * chamada (ver abrirPagamento). Se a rede cair sem resposta e o comprador
 * clicar de novo, a retentativa com a mesma chave devolve a cobranca ja
 * criada em vez de cobrar duas vezes.
 *
 * `transaction_amount` vai em REAIS decimais, nao em centavos — a unica
 * fronteira do sistema onde dinheiro deixa de ser inteiro. A conversao mora
 * aqui e em nenhum outro lugar.
 */
export async function criarPagamentoMP(
  e: EntradaPagamentoMP,
  chaveIdempotencia: string,
): Promise<RespostaPagamentoMP> {
  const corpo: Record<string, unknown> = {
    transaction_amount: Number((e.valor / 100).toFixed(2)),
    description: e.descricao,
    external_reference: e.referenciaExterna,
    notification_url: urlDeNotificacao(),
    payer: {
      email: e.pagador.email,
      first_name: e.pagador.nome,
      last_name: e.pagador.sobrenome,
      identification: { type: 'CPF', number: e.pagador.cpf },
    },
  }

  if (e.metodo === 'pix') {
    corpo.payment_method_id = 'pix'
  } else {
    corpo.token = e.token
    corpo.installments = e.parcelas
    corpo.payment_method_id = e.metodoPagamentoId
    if (e.emissorId) corpo.issuer_id = e.emissorId
    // Captura automatica: autorizar sem capturar deixaria dinheiro reservado
    // mas nao recebido, e o mapeamento de status trata 'authorized' como
    // em_analise justamente para nao creditar comissao nesse estado.
    corpo.capture = true
  }

  const dados = await chamar('/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': chaveIdempotencia },
    body: JSON.stringify(corpo),
  })

  return normalizar(dados)
}

/**
 * Le um pagamento pelo id.
 *
 * O WEBHOOK SEMPRE PASSA POR AQUI. O corpo da notificacao do Mercado Pago e
 * um aviso de que algo mudou, nao a verdade sobre o que mudou: agir sobre o
 * status que veio no corpo significa confiar num payload que chega pela
 * internet publica. A assinatura prova quem enviou; ela nao prova que o
 * conteudo reflete o estado atual da cobranca. Reler pela API, autenticado
 * com o access token, e o que torna "pedido pago" um fato verificado.
 */
export async function buscarPagamentoMP(id: string): Promise<RespostaPagamentoMP> {
  return normalizar(await chamar(`/v1/payments/${encodeURIComponent(id)}`, { method: 'GET' }))
}

async function chamar(
  caminho: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
): Promise<Record<string, unknown>> {
  let resposta: Response
  try {
    resposta = await fetch(`${BASE}${caminho}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${tokenDeAcesso()}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      body: init.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (causa) {
    // Timeout e falha de DNS/rede chegam aqui. Status 0 sinaliza "nao houve
    // resposta" — diferente de uma recusa do provedor, e o chamador precisa
    // distinguir os dois para decidir se pode tentar de novo.
    throw new ErroMercadoPago(0, 'sem_resposta', causa instanceof Error ? causa.message : 'falha de rede')
  }

  const texto = await resposta.text()
  let dados: Record<string, unknown> = {}
  try {
    dados = texto ? (JSON.parse(texto) as Record<string, unknown>) : {}
  } catch {
    throw new ErroMercadoPago(resposta.status, 'resposta_invalida', 'corpo nao e JSON')
  }

  if (!resposta.ok) {
    // So `message` e `error` do provedor entram na excecao. O corpo completo
    // ecoa o payload enviado — que carrega e-mail e CPF do comprador — e
    // acabaria no log do servidor inteiro se fosse anexado aqui.
    const mensagem = typeof dados.message === 'string' ? dados.message : 'erro sem mensagem'
    const codigo = typeof dados.error === 'string' ? dados.error : 'desconhecido'
    throw new ErroMercadoPago(resposta.status, codigo, mensagem)
  }

  return dados
}

function normalizar(d: Record<string, unknown>): RespostaPagamentoMP {
  const interacao = (d.point_of_interaction ?? {}) as Record<string, unknown>
  const transacao = (interacao.transaction_data ?? {}) as Record<string, unknown>

  return {
    id: String(d.id),
    status: String(d.status ?? ''),
    statusDetail: String(d.status_detail ?? ''),
    referenciaExterna: typeof d.external_reference === 'string' ? d.external_reference : null,
    pixCopiaECola: typeof transacao.qr_code === 'string' ? transacao.qr_code : undefined,
    pixQrBase64: typeof transacao.qr_code_base64 === 'string' ? transacao.qr_code_base64 : undefined,
    expiraEm: typeof d.date_of_expiration === 'string' ? d.date_of_expiration : undefined,
  }
}
