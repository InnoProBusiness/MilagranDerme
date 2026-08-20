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

/**
 * O QUE DIZER quando o Mercado Pago nao cria a cobranca — e se faz sentido
 * mandar tentar de novo.
 *
 * FUNCAO PROPRIA, e nao um `if` dentro da rota, pelo mesmo motivo de
 * `mapearStatusMP` (src/lib/pedido-status.ts): e uma regra com casos, ela
 * decide o que a compradora le num momento em que ja tem o cartao na mao, e
 * precisa de teste sem banco nem rede.
 *
 * A DISTINCAO QUE ELA EXISTE PARA FAZER, aprendida em producao em 19/08/2026:
 *
 *   - NAO HOUVE RESPOSTA (status 0: timeout, DNS, rede) ou o provedor teve um
 *     problema DELE (5xx). Isso passa sozinho, e "tente de novo em instantes" e
 *     o conselho certo.
 *   - O PROVEDOR RESPONDEU E RECUSOU (4xx). Isso NAO passa sozinho. Naquele dia
 *     a conta do Mercado Pago ficou com `address_pending` e toda cobranca —
 *     Pix, boleto e cartao — voltou 403 `PA_UNAUTHORIZED_RESULT_FROM_POLICIES`.
 *     A tela mandava a compradora tentar de novo em instantes, para sempre, e a
 *     operacao lia "instabilidade do provedor" no lugar de "va corrigir a
 *     conta".
 *
 * O TEXTO DO PROVEDOR NUNCA VAI PARA A TELA. Ele carrega vocabulario interno e,
 * em varios erros, ecoa o payload enviado — que tem CPF e e-mail de quem esta
 * comprando. Vai para `paraOLog`, e so.
 */
export type FalhaDoProvedor = {
  podeTentarDeNovo: boolean
  /** Frase escrita por nos, para a compradora ler. */
  mensagem: string
  /** Linha para o console do servidor: status e codigo do provedor. */
  paraOLog: string
}

export function falhaDoProvedor(e: ErroMercadoPago): FalhaDoProvedor {
  // 0 = nao houve resposta (ver `chamar`). Abaixo de 500 e acima de 0 e recusa.
  const semResposta = e.status === 0
  const problemaDoProvedor = e.status >= 500
  const podeTentarDeNovo = semResposta || problemaDoProvedor

  return {
    podeTentarDeNovo,
    mensagem: podeTentarDeNovo
      ? 'O provedor de pagamento não respondeu. Tente de novo em instantes.'
      // SEM "tente de novo" e sem "aguarde": a recusa e permanente ate alguem
      // mexer na conta do Mercado Pago, e prometer o contrario faz a compradora
      // insistir num botao morto. A frase assume o problema como NOSSO — porque
      // e — e da uma saida que existe de verdade.
      : 'Não conseguimos gerar a cobrança deste pedido. O problema é do nosso lado '
        + 'e já fomos avisados. Seu pedido está guardado: chame a gente no WhatsApp '
        + 'para concluir a compra.',
    paraOLog: `mercadopago ${e.status} ${e.codigo}: ${e.message}`,
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
    transaction_amount: Number(emReais(e.valor)),
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

// ---------------------------------------------------------------------------
// ORDERS API — a saida de emergencia do Pix. NAO ESTA NO CAMINHO CRITICO.
//
// LEIA ISTO ANTES DE USAR: nenhuma rota chama `criarOrderPixMP` hoje. Pix e
// cartao saem os dois por `criarPagamentoMP`. O codigo abaixo existe pronto e
// testado para o dia em que `/v1/payments` voltar a ser recusado — e a historia
// de por que ele foi escrito e o que precisa ser feito antes de liga-lo importa
// mais do que o codigo em si.
//
// 19/08/2026 — O BLOQUEIO. A conta (`milagranoficial@gmail.com`, CNPJ
// 68.232.977/0001-78) ficou com o endereco cadastral vazio:
// `GET /users/me` devolvia status.billing.allow === false com o codigo
// `address_pending`. O PolicyAgent passou a recusar TODA criacao de cobranca em
// `/v1/payments` — Pix, boleto e cartao — com 403
// `PA_UNAUTHORIZED_RESULT_FROM_POLICIES`. Nao era o nosso codigo: curl direto na
// API falhava igual. `POST /v1/orders` nao passava pelo mesmo bloqueio, e foi
// por ai que a saida foi construida
// (docs/2026-08-19-migrar-pix-para-orders.md).
//
// 20/08/2026 — O BLOQUEIO CAIU, tambem medido contra a producao: Pix em
// `/v1/payments` voltou a devolver 201 com QR utilizavel, e uma sonda de cartao
// com token invalido voltou 400 falando do TOKEN, e nao 403 da politica.
// `status.billing.allow` continua `false`: o flag e cosmetico, quem decide e a
// API respondendo. Ver `scripts/diagnostico-mercadopago.mjs`, que remede tudo
// isto em um comando.
//
// POR QUE O PIX NAO MUDOU DE PORTA, entao. `/v1/payments` e o unico caminho com
// ENTREGA DE WEBHOOK COMPROVADA nesta conta: em 20/08/2026 tres notificacoes
// reais chegaram, passaram na assinatura HMAC e foram relidas pela API.
//
// E O TOPICO `order` NAO CHEGA — isto foi MEDIDO, nao suposto. Com este codigo
// ja em producao (que aceita o topico e gravaria a linha em `webhook_eventos`),
// uma order real foi criada em 20/08/2026 e NENHUMA notificacao apareceu, nem
// depois de dois minutos e meio; a notificacao de `payment` da mesma rodada
// chegou em menos de um segundo. O evento `order` nao esta marcado no painel.
//
// LEIA ISSO COMO O QUE E: se a migracao tivesse sido feita, cada Pix teria sido
// criado e NUNCA confirmado. A compradora pagaria, o dinheiro entraria, e o
// pedido ficaria em 'aguardando_pagamento' para sempre — sem erro em log
// nenhum.
//
// O QUE FAZER ANTES DE LIGAR ISTO, se o bloqueio voltar:
//   1. Marcar o evento `order` no painel do Mercado Pago (Suas integracoes ->
//      a aplicacao -> Webhooks). MEDIDO EM 20/08/2026: hoje ele NAO esta
//      marcado, e sem ele NENHUMA notificacao de Pix chega. Este passo nao e
//      burocracia — e a diferenca entre vender e so parecer que vende.
//      Depois de marcar, confirme criando uma order e olhando
//      `SELECT * FROM webhook_eventos WHERE tipo = 'order'`.
//   2. Trocar `criarPagamentoMP` por `criarOrderPixMP` no ramo do Pix de
//      src/app/api/pagamentos/route.ts E de src/app/api/vendas-presenciais/route.ts,
//      trocando `mapearStatusMP` por `mapearStatusOrder` junto, nos dois.
//   3. Pagar um Pix de verdade e confirmar que o pedido vira 'pago'.
//      `node scripts/diagnostico-mercadopago.mjs --criar --aguardar` cria a
//      cobranca e imprime cada transicao de status.
//
// O CARTAO NUNCA TEVE ESTA SAIDA: em `/v1/orders` ele devolveu
// `400 invalid_transaction_amount` em todo valor testado (R$ 1,00, R$ 10,00 e
// R$ 814,94). Migra-lo trocaria uma recusa por outra.
//
// E NADA DISTO SUBSTITUI CORRIGIR A CONTA. O endereco se preenche em
// *Seu perfil -> Informacoes do seu perfil*, e NAO na agenda de entrega
// ("Enderecos salvos na sua conta"), que e outra tela e nao muda
// `address_pending`.
// ---------------------------------------------------------------------------

export type EntradaOrderPixMP = {
  valor: Centavos
  /** id do pedido — ancora de reconciliacao quando a linha local se perde. */
  referenciaExterna: string
  pagador: PagadorMP
}

/**
 * Cria a cobranca Pix pela Orders API.
 *
 * O QUE E DIFERENTE de `criarPagamentoMP`, tudo medido contra a producao:
 *
 *   - `total_amount` e `amount` vao como STRING decimal ("814.94"). Numero JSON
 *     e recusado. Ver `emReais`.
 *   - `notification_url` NAO E ACEITO no corpo: devolve
 *     `400 unsupported_properties — additionalProperties '$.notification_url'
 *     not allowed`. As notificacoes de order vao para a URL configurada no
 *     painel do Mercado Pago, que ja aponta para /api/webhooks/mercadopago com
 *     o segredo de assinatura. Por isso `urlDeNotificacao()` nao aparece aqui —
 *     a ausencia e deliberada, nao esquecimento.
 *   - O `payer` leva SO O E-MAIL. Nao e economia: o exemplo oficial de Pix da
 *     Orders API tambem manda so o e-mail, e foi o corpo exato que devolveu 201
 *     em producao. `first_name`/`last_name`/`identification` NAO foram provados
 *     nesta API, e campo nao aceito aqui nao e ignorado — vira 400
 *     `unsupported_properties` e derruba a cobranca inteira. O CPF continua
 *     chegando ao provedor pelo caminho do cartao, e continua fora do navegador
 *     nos dois.
 *
 * `chaveIdempotencia` e o id da linha em `pagamentos`, gerado ANTES desta
 * chamada, pelo mesmo motivo de `criarPagamentoMP`: sem ele a retentativa de
 * uma requisicao que expirou sem resposta cobraria duas vezes.
 */
export async function criarOrderPixMP(
  e: EntradaOrderPixMP,
  chaveIdempotencia: string,
): Promise<RespostaPagamentoMP> {
  const valor = emReais(e.valor)

  const corpo = {
    type: 'online',
    processing_mode: 'automatic',
    total_amount: valor,
    external_reference: e.referenciaExterna,
    payer: { email: e.pagador.email },
    transactions: {
      payments: [{
        amount: valor,
        payment_method: { id: 'pix', type: 'bank_transfer' },
      }],
    },
  }

  const dados = await chamar('/v1/orders', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': chaveIdempotencia },
    body: JSON.stringify(corpo),
  })

  return normalizarOrder(dados)
}

/**
 * Le uma order pelo id (o ULID `ORD01...` que gravamos em
 * `pagamentos.provedor_id`).
 *
 * NAO DA PARA USAR `buscarPagamentoMP` NO LUGAR. Medido: o id do pagamento que
 * vem dentro da order (`PAY01...`) NAO existe em `/v1/payments/{id}` — a API
 * responde `resource not found`. Os dois mundos tem numeracoes separadas, e o
 * unico id que abre uma cobranca criada por `criarOrderPixMP` e o da order.
 *
 * O webhook passa por aqui pelo mesmo motivo que passa por `buscarPagamentoMP`:
 * a assinatura prova QUEM enviou a notificacao, nao que o `status` do corpo
 * reflita o estado atual da cobranca. Reler autenticado e o que torna
 * "pedido pago" um fato verificado.
 */
export async function buscarOrderMP(id: string): Promise<RespostaPagamentoMP> {
  return normalizarOrder(await chamar(`/v1/orders/${encodeURIComponent(id)}`, { method: 'GET' }))
}

/**
 * Achata a resposta da Orders API na MESMA forma que `normalizar` produz para
 * `/v1/payments`.
 *
 * A FORMA UNICA E O PONTO: a rota de pagamento, o webhook e a tela nao
 * precisam saber por qual das duas APIs a cobranca nasceu. O que muda entre as
 * duas — e o que este arquivo isola — e onde cada campo mora:
 *
 *   /v1/payments : point_of_interaction.transaction_data.qr_code
 *   /v1/orders   : transactions.payments[0].payment_method.qr_code
 *
 * `id` e o da ORDER, e nao o do pagamento de dentro dela, porque e ele que o
 * webhook recebe em `data.id` e e ele que abre `GET /v1/orders/{id}`. Gravar o
 * `PAY01...` em `pagamentos.provedor_id` deixaria a linha local impossivel de
 * casar com a notificacao.
 *
 * O `status` lido e o da ORDER (raiz), nao o do pagamento aninhado. Nas nossas
 * cobrancas ha exatamente um pagamento por order, entao os dois andam juntos;
 * a raiz e a que o Mercado Pago documenta como o estado da order e a que
 * `mapearStatusOrder` (src/lib/pedido-status.ts) fala.
 */
function normalizarOrder(d: Record<string, unknown>): RespostaPagamentoMP {
  const transacoes = (d.transactions ?? {}) as Record<string, unknown>
  const pagamentos = Array.isArray(transacoes.payments) ? transacoes.payments : []
  const pagamento = (pagamentos[0] ?? {}) as Record<string, unknown>
  const metodo = (pagamento.payment_method ?? {}) as Record<string, unknown>

  return {
    id: String(d.id),
    status: String(d.status ?? ''),
    statusDetail: String(d.status_detail ?? ''),
    referenciaExterna: typeof d.external_reference === 'string' ? d.external_reference : null,
    pixCopiaECola: typeof metodo.qr_code === 'string' ? metodo.qr_code : undefined,
    pixQrBase64: typeof metodo.qr_code_base64 === 'string' ? metodo.qr_code_base64 : undefined,
    // A validade do Pix vive no PAGAMENTO, nao na order.
    expiraEm: typeof pagamento.date_of_expiration === 'string'
      ? pagamento.date_of_expiration
      : undefined,
  }
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
    const { codigo, mensagem } = erroDoProvedor(dados)
    throw new ErroMercadoPago(resposta.status, codigo, mensagem)
  }

  return dados
}

/**
 * DE ONDE SAI O CODIGO E A MENSAGEM DE UM ERRO DO MERCADO PAGO — que sao a
 * unica coisa do corpo de erro autorizada a existir fora daqui.
 *
 * O CORPO COMPLETO NAO ENTRA NA EXCECAO. Ele ecoa o payload enviado, que
 * carrega e-mail e CPF de quem esta comprando, e acabaria no log agregado do
 * container inteiro.
 *
 * SAO TRES FORMATOS, e a loja fala com os tres:
 *
 *   1. `{"message": "...", "error": "..."}`  — /v1/payments, caso comum.
 *   2. `{"message": "...", "code": "..."}`   — /v1/payments, PolicyAgent. Foi
 *      a recusa que derrubou a loja em 19/08/2026:
 *      {"code":"PA_UNAUTHORIZED_RESULT_FROM_POLICIES", ...}, SEM `error`
 *      nenhum. Enquanto so `error` era lido, o log dizia 'desconhecido' e a
 *      causa real (conta com endereco pendente) nao aparecia em lugar nenhum.
 *   3. `{"errors": [{"code": "...", "message": "..."}]}` — /v1/orders. Aqui
 *      nao ha `message` NA RAIZ: lendo so a raiz, todo erro da Orders vira
 *      'erro sem mensagem', e o log perde justamente o texto que diz o que
 *      esta errado no payload (foi assim que apareceu
 *      `unsupported_properties: additionalProperties '$.notification_url' not
 *      allowed`).
 *
 * `code` da Orders ja chegou como numero em alguns erros; por isso a
 * normalizacao aceita number. Um log que diz 'desconhecido' por causa de tipo
 * e exatamente o defeito que esta funcao existe para nao repetir.
 */
function erroDoProvedor(d: Record<string, unknown>): { codigo: string; mensagem: string } {
  const listados = Array.isArray(d.errors) ? d.errors : []
  const primeiro = (listados[0] ?? {}) as Record<string, unknown>

  return {
    mensagem: textoDoErro(d.message) ?? textoDoErro(primeiro.message) ?? 'erro sem mensagem',
    codigo: textoDoErro(d.error) ?? textoDoErro(d.code) ?? textoDoErro(primeiro.code) ?? 'desconhecido',
  }
}

function textoDoErro(v: unknown): string | undefined {
  if (typeof v === 'string' && v !== '') return v
  if (typeof v === 'number') return String(v)
  return undefined
}

/**
 * Centavos -> a STRING decimal que o Mercado Pago espera ("814.94").
 *
 * A UNICA FRONTEIRA DO SISTEMA onde dinheiro deixa de ser inteiro. Existe uma
 * funcao so, e nao uma conversao repetida em cada corpo de requisicao, porque
 * as duas APIs querem TIPOS diferentes do mesmo numero: /v1/payments quer
 * `transaction_amount` como NUMERO JSON e /v1/orders quer `total_amount` e
 * `amount` como STRING (medido: numero em /v1/orders e recusado). Se a
 * conversao morasse em dois lugares, um deles arredondaria diferente do outro
 * no dia em que alguem mexesse, e a diferenca apareceria como centavo faltando
 * na cobranca — nunca como erro.
 */
function emReais(v: Centavos): string {
  return (v / 100).toFixed(2)
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
