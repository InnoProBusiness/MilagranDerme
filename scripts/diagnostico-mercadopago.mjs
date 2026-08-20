#!/usr/bin/env node
/**
 * DIAGNOSTICO DA COBRANCA EM PRODUCAO — mede, nao adivinha.
 *
 * Este script existe porque a migracao do Pix para a Orders API
 * (docs/2026-08-19-migrar-pix-para-orders.md) tem UM ponto que so producao
 * responde: qual status uma order assume quando o Pix e REALMENTE PAGO. Em
 * 19/08/2026 nao deu para pagar um Pix de verdade, e o documento saiu com esse
 * buraco escrito em letras grandes. `--aguardar` fecha o buraco: ele fica
 * relendo a order e imprime cada transicao de status conforme ela acontece.
 *
 * O QUE ELE FAZ, na ordem:
 *
 *   1. conta     — GET /users/me. Diz se o endereco da conta ainda esta
 *                  pendente, que e a causa raiz de tudo isto.
 *   2. bloqueio  — POST /v1/payments com Pix. ESPERA falhar com 403 do
 *                  PolicyAgent. Se um dia passar, a conta foi corrigida e o
 *                  desvio para a Orders deixou de ser necessario.
 *   3. order     — POST /v1/orders com Pix. Cria uma cobranca DE VERDADE.
 *   4. releitura — GET /v1/orders/{id}. Prova que o webhook consegue reler.
 *   5. aguardar  — opcional: relê ate o Pix ser pago ou expirar.
 *
 * COBRANCA DE VERDADE, DINHEIRO DE VERDADE. O passo 3 so roda com `--criar`, e
 * o valor padrao e UM CENTAVO. O passo 2 nao cria nada enquanto a conta estiver
 * bloqueada — mas se ela for corrigida, ele passa a criar; por isso ele tambem
 * usa o valor de `--valor`.
 *
 * USO:
 *   export MERCADOPAGO_ACCESS_TOKEN=APP_USR-...
 *   node scripts/diagnostico-mercadopago.mjs                  # so diagnostica
 *   node scripts/diagnostico-mercadopago.mjs --criar          # cria Pix de R$ 0,01
 *   node scripts/diagnostico-mercadopago.mjs --criar --aguardar
 *   node scripts/diagnostico-mercadopago.mjs --order ORD01... --aguardar
 *
 * OPCOES:
 *   --criar              cria a cobranca Pix de teste (passo 3)
 *   --valor <reais>      valor da cobranca de teste. Padrao: 0.01
 *   --ref <texto>        external_reference. Padrao: diagnostico-<timestamp>
 *   --email <e-mail>     payer.email. Padrao: diagnostico@milagranoficial.com.br
 *   --order <ORD01...>   pula a criacao e observa uma order existente
 *   --aguardar           relê a order ate mudar de estado, expirar ou dar timeout
 *   --minutos <n>        teto de espera do --aguardar. Padrao: 30
 *
 * O TOKEN NUNCA E IMPRESSO. Só o prefixo (APP_USR / TEST), que e o que decide
 * se a cobranca e real.
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as dormir } from 'node:timers/promises'

const BASE = 'https://api.mercadopago.com'
const INTERVALO_MS = 5000

// ---------------------------------------------------------------------------

function lerArgumentos(argv) {
  const o = {
    criar: false, aguardar: false, valor: '0.01', minutos: 30,
    ref: null, email: 'diagnostico@milagranoficial.com.br', order: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--criar') o.criar = true
    else if (a === '--aguardar') o.aguardar = true
    else if (a === '--valor') o.valor = argv[++i]
    else if (a === '--minutos') o.minutos = Number(argv[++i])
    else if (a === '--ref') o.ref = argv[++i]
    else if (a === '--email') o.email = argv[++i]
    else if (a === '--order') o.order = argv[++i]
    else if (a === '--help' || a === '-h') { imprimirAjuda(); process.exit(0) }
    else { erro(`opcao desconhecida: ${a}`); process.exit(2) }
  }
  return o
}

function imprimirAjuda() {
  console.log(`
node scripts/diagnostico-mercadopago.mjs [opcoes]

  --criar              cria uma cobranca Pix DE VERDADE (padrao: R$ 0,01)
  --valor <reais>      valor da cobranca. Padrao: 0.01
  --ref <texto>        external_reference
  --email <e-mail>     payer.email
  --order <ORD01...>   observa uma order existente em vez de criar
  --aguardar           relê a order ate ela mudar de estado
  --minutos <n>        teto de espera. Padrao: 30

Precisa de MERCADOPAGO_ACCESS_TOKEN no ambiente.
`)
}

const titulo = (t) => console.log(`\n\x1b[1m${t}\x1b[0m\n${'─'.repeat(t.length)}`)
const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`)
const falha = (m) => console.log(`  \x1b[31m✘\x1b[0m ${m}`)
const nota = (m) => console.log(`  \x1b[2m·\x1b[0m ${m}`)
const erro = (m) => console.error(`\x1b[31m${m}\x1b[0m`)

function token() {
  const t = process.env.MERCADOPAGO_ACCESS_TOKEN
  if (!t) {
    erro('MERCADOPAGO_ACCESS_TOKEN nao esta no ambiente.')
    erro('Na VPS: export MERCADOPAGO_ACCESS_TOKEN=$(cat /root/.milagran-mp-access-token)')
    process.exit(2)
  }
  return t
}

/**
 * Uma chamada crua a API. Devolve status e corpo SEM lancar: um 403 aqui e
 * resultado esperado do diagnostico, nao acidente.
 */
async function chamar(caminho, init = {}) {
  const r = await fetch(`${BASE}${caminho}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      ...(init.idempotencia ? { 'X-Idempotency-Key': init.idempotencia } : {}),
    },
    body: init.body,
    signal: AbortSignal.timeout(20_000),
  })
  const texto = await r.text()
  let corpo = {}
  try { corpo = texto ? JSON.parse(texto) : {} } catch { corpo = { _bruto: texto.slice(0, 400) } }
  return { status: r.status, corpo }
}

/** Codigo + mensagem, nos TRES formatos de erro que o Mercado Pago usa. */
function resumoDoErro(c) {
  const primeiro = Array.isArray(c.errors) ? (c.errors[0] ?? {}) : {}
  const codigo = c.error ?? c.code ?? primeiro.code ?? 'sem_codigo'
  const mensagem = c.message ?? primeiro.message ?? '(sem mensagem)'
  return `${codigo} — ${mensagem}`
}

// --- 1. a conta ------------------------------------------------------------

async function verificarConta() {
  titulo('1. A conta')

  const t = process.env.MERCADOPAGO_ACCESS_TOKEN ?? ''
  const ambiente = t.startsWith('APP_USR') ? 'PRODUCAO (cobra de verdade)'
    : t.startsWith('TEST') ? 'SANDBOX' : 'DESCONHECIDO'
  nota(`token: ${ambiente}`)

  const { status, corpo } = await chamar('/users/me')
  if (status !== 200) {
    falha(`GET /users/me devolveu ${status}: ${resumoDoErro(corpo)}`)
    return { bloqueada: null }
  }

  nota(`user id ${corpo.id} · ${corpo.email ?? '(sem e-mail)'}`)

  const billing = corpo.status?.billing ?? {}
  const endereco = corpo.address ?? {}
  const temEndereco = Boolean(endereco.zip_code || endereco.city || endereco.address)

  if (billing.allow === true) {
    ok('status.billing.allow = true — a conta pode cobrar')
    ok('SE O PASSO 2 PASSAR, o desvio para a Orders API nao e mais necessario:')
    nota('  o cartao volta a funcionar sozinho, sem tocar em codigo.')
  } else {
    falha(`status.billing.allow = false · codigos: ${JSON.stringify(billing.codes ?? [])}`)
    nota(`endereco cadastral: ${temEndereco ? JSON.stringify(endereco) : 'VAZIO'}`)
    nota('Corrigir em: Seu perfil → Informacoes do seu perfil (Dados do negocio).')
    nota('NAO e a tela "Enderecos salvos na sua conta" — aquela e a agenda de entrega.')
  }

  return { bloqueada: billing.allow !== true }
}

// --- 2. o bloqueio ---------------------------------------------------------

/**
 * O CARTÃO VENDE HOJE? — sem cartão, sem cobrança, sem efeito nenhum.
 *
 * Não dá para tokenizar um cartão fora do navegador, e não é preciso: a
 * pergunta não é "este cartão passa", é **quem recusa**. Manda-se um token
 * deliberadamente inválido e lê-se de quem vem o "não":
 *
 *   403 `PA_UNAUTHORIZED_RESULT_FROM_POLICIES` → o PolicyAgent recusou ANTES de
 *     olhar o cartão. A conta está bloqueada e o cartão não vende de jeito
 *     nenhum, com token válido ou não.
 *   400 falando do TOKEN → o PolicyAgent deixou passar. A recusa agora é só do
 *     token falso, e um cartão de verdade seguiria adiante.
 *
 * NENHUM DOS DOIS CRIA COBRANÇA. É por isso que esta sonda roda sempre, e a do
 * Pix (abaixo) só com `--criar`.
 */
async function sondarCartao(valor) {
  titulo('2. /v1/payments — o cartao vende hoje?')

  const { status, corpo } = await chamar('/v1/payments', {
    method: 'POST',
    idempotencia: randomUUID(),
    body: JSON.stringify({
      transaction_amount: Number(valor),
      description: 'sonda de politica — nao cria cobranca',
      payment_method_id: 'visa',
      installments: 1,
      token: 'token-invalido-de-proposito',
      payer: {
        email: 'diagnostico@milagranoficial.com.br',
        identification: { type: 'CPF', number: '39053344705' },
      },
    }),
  })

  const resumo = resumoDoErro(corpo)
  const codigo = corpo.code ?? corpo.error ?? ''

  if (status === 403 && String(codigo).startsWith('PA_')) {
    falha(`403 do PolicyAgent — ${resumo}`)
    nota('A CONTA ESTA BLOQUEADA. O cartao nao vende, com token valido ou nao.')
    return { liberado: false }
  }

  if (status === 400 || status === 422) {
    ok(`${status} — ${resumo}`)
    nota('A recusa e do TOKEN FALSO, nao da politica: o PolicyAgent deixou passar.')
    nota('Ou seja: um cartao de verdade seguiria adiante daqui.')
    return { liberado: true }
  }

  if (status === 201 || status === 200) {
    falha(`${status} — a sonda criou uma cobranca (${corpo.id}). Cancele no painel.`)
    return { liberado: true }
  }

  nota(`${status} — ${resumo} (resultado ambiguo)`)
  return { liberado: null }
}

async function verificarBloqueioDePayments(valor) {
  titulo('2b. /v1/payments — Pix pelo caminho antigo')
  nota('esta sonda PODE criar uma cobranca real, por isso so roda com --criar.')

  const { status, corpo } = await chamar('/v1/payments', {
    method: 'POST',
    idempotencia: randomUUID(),
    body: JSON.stringify({
      transaction_amount: Number(valor),
      description: 'diagnostico Milagran',
      payment_method_id: 'pix',
      payer: {
        email: 'diagnostico@milagranoficial.com.br',
        identification: { type: 'CPF', number: '39053344705' },
      },
    }),
  })

  if (status === 403) {
    ok(`403 como esperado — ${resumoDoErro(corpo)}`)
    nota('E a recusa do PolicyAgent. Confirma o diagnostico: o problema e a conta.')
    return { bloqueado: true }
  }

  if (status === 201 || status === 200) {
    ok(`${status} — Pix em /v1/payments VOLTOU A FUNCIONAR (pagamento ${corpo.id})`)
    nota(`status: ${corpo.status} / ${corpo.status_detail}`)
    const qr = corpo.point_of_interaction?.transaction_data?.qr_code
    nota(qr ? 'veio com QR code — e uma cobranca Pix utilizavel' : 'SEM QR code na resposta')
    nota('ATENCAO: esta chamada CRIOU uma cobranca real, pendente. Ela expira sozinha.')
    return { bloqueado: false }
  }

  falha(`${status} — ${resumoDoErro(corpo)}`)
  return { bloqueado: null }
}

// --- 3. a criacao via Orders ----------------------------------------------

async function criarOrderPix(o) {
  titulo('3. /v1/orders — o caminho novo do Pix')

  const ref = o.ref ?? `diagnostico-${Date.now()}`
  const valor = Number(o.valor).toFixed(2)

  nota(`criando cobranca REAL de R$ ${valor} (ref ${ref})`)

  const { status, corpo } = await chamar('/v1/orders', {
    method: 'POST',
    idempotencia: randomUUID(),
    body: JSON.stringify({
      type: 'online',
      processing_mode: 'automatic',
      total_amount: valor,
      external_reference: ref,
      payer: { email: o.email },
      transactions: {
        payments: [{ amount: valor, payment_method: { id: 'pix', type: 'bank_transfer' } }],
      },
    }),
  })

  if (status !== 201 && status !== 200) {
    falha(`${status} — ${resumoDoErro(corpo)}`)
    return null
  }

  const pagamento = corpo.transactions?.payments?.[0] ?? {}
  const metodo = pagamento.payment_method ?? {}

  ok(`${status} — order ${corpo.id}`)
  nota(`status: ${corpo.status} / ${corpo.status_detail}`)
  nota(`pagamento interno: ${pagamento.id} (ULID — NAO existe em /v1/payments)`)
  nota(`expira em: ${pagamento.date_of_expiration ?? '(nao informado)'}`)

  if (metodo.qr_code) {
    ok('QR code recebido. Copia e cola abaixo:')
    console.log(`\n${metodo.qr_code}\n`)
  } else {
    falha('SEM qr_code na resposta — a tela de checkout ficaria sem Pix.')
    nota(`chaves de payment_method: ${Object.keys(metodo).join(', ') || '(vazio)'}`)
  }

  if (!metodo.qr_code_base64) falha('SEM qr_code_base64 — a imagem do QR nao apareceria.')
  else ok('qr_code_base64 recebido (imagem do QR).')

  if (corpo.external_reference !== ref) {
    falha(`external_reference voltou "${corpo.external_reference}", esperado "${ref}"`)
    nota('E a ancora de reconciliacao do webhook. Sem ela o pedido fica orfao.')
  } else {
    ok('external_reference preservado — o webhook consegue achar o pedido.')
  }

  return corpo.id
}

// --- 4. a releitura --------------------------------------------------------

async function relerOrder(id, silencioso = false) {
  const { status, corpo } = await chamar(`/v1/orders/${encodeURIComponent(id)}`)
  if (status !== 200) {
    if (!silencioso) falha(`GET /v1/orders/${id} devolveu ${status} — ${resumoDoErro(corpo)}`)
    return null
  }
  return corpo
}

async function verificarReleitura(id) {
  titulo('4. Releitura — o que o webhook faz')

  const corpo = await relerOrder(id)
  if (!corpo) {
    falha('O WEBHOOK NAO CONSEGUIRIA CONFIRMAR ESTE PAGAMENTO.')
    return null
  }

  ok(`GET /v1/orders/${id} → ${corpo.status} / ${corpo.status_detail}`)

  // O contra-teste que o documento registrou: o id do pagamento de dentro da
  // order NAO abre em /v1/payments. Se um dia abrir, o webhook pode simplificar.
  const idPagamento = corpo.transactions?.payments?.[0]?.id
  if (idPagamento) {
    const r = await chamar(`/v1/payments/${encodeURIComponent(idPagamento)}`)
    if (r.status === 200) {
      nota(`NOVIDADE: /v1/payments/${idPagamento} respondeu 200 (antes era 404).`)
    } else {
      ok(`/v1/payments/${idPagamento} → ${r.status}, como esperado.`)
      nota('Confirma que so o id da ORDER serve para reler. E o que gravamos.')
    }
  }

  return corpo
}

// --- 5. a espera -----------------------------------------------------------

/**
 * O PASSO QUE FECHA O BURACO DA DOCUMENTACAO. Fica relendo a order e imprime
 * CADA transicao de status. Pague o Pix com o QR do passo 3 e o vocabulario
 * real do pagamento aprovado aparece aqui — nao na documentacao, nao num
 * palpite.
 */
async function aguardar(id, minutos) {
  titulo('5. Aguardando o pagamento')
  nota(`pague o Pix acima. Relendo a cada ${INTERVALO_MS / 1000}s, por ate ${minutos} min.`)
  nota('Ctrl+C para parar.')

  const limite = Date.now() + minutos * 60_000
  let anterior = null

  while (Date.now() < limite) {
    const corpo = await relerOrder(id, true)
    if (corpo) {
      const atual = `${corpo.status} / ${corpo.status_detail}`
      if (atual !== anterior) {
        const hora = new Date().toISOString().slice(11, 19)
        console.log(`  [${hora}] ${atual}`)
        anterior = atual

        if (corpo.status === 'processed') {
          ok('PAGO. Este e o par que mapearStatusOrder precisa ler como "aprovado":')
          console.log(`\n      status = "${corpo.status}"  ·  status_detail = "${corpo.status_detail}"\n`)
          nota('Confira em src/lib/pedido-status.ts que este par devolve \'aprovado\'.')
          return corpo
        }
        if (['expired', 'canceled', 'cancelled', 'failed', 'refunded'].includes(corpo.status)) {
          falha(`a cobranca terminou sem pagamento: ${atual}`)
          return corpo
        }
      }
    }
    await dormir(INTERVALO_MS)
  }

  falha(`tempo esgotado (${minutos} min). Ultimo estado: ${anterior ?? 'desconhecido'}`)
  return null
}

// ---------------------------------------------------------------------------

async function principal() {
  const o = lerArgumentos(process.argv.slice(2))
  token()

  console.log('\x1b[1mDiagnostico Mercado Pago — Milagran\x1b[0m')

  const conta = await verificarConta()
  const cartao = await sondarCartao(o.valor)
  if (o.criar) await verificarBloqueioDePayments(o.valor)

  let id = o.order
  if (!id && o.criar) id = await criarOrderPix(o)
  else if (!id) {
    titulo('3. /v1/orders — o caminho novo do Pix')
    nota('pulado. Rode com --criar para criar uma cobranca Pix de verdade.')
  }

  if (id) {
    await verificarReleitura(id)
    if (o.aguardar) await aguardar(id, o.minutos)
  }

  titulo('Resumo')

  // O QUE MANDA E A SONDA, NAO O PAINEL. `status.billing.allow` pode continuar
  // false com o PolicyAgent ja liberado — foi exatamente o que apareceu em
  // 20/08/2026. Quem decide se a loja vende e a API respondendo, nao o flag.
  nota(`endereco da conta: ${conta.bloqueada === false ? 'OK' : 'PENDENTE (address_pending)'}`)

  if (cartao.liberado === true) {
    ok('CARTAO: o PolicyAgent nao bloqueia mais. /v1/payments aceita cobranca.')
  } else if (cartao.liberado === false) {
    falha('CARTAO: bloqueado pelo PolicyAgent. A loja vende so por Pix.')
  } else {
    nota('CARTAO: resultado ambiguo — leia o passo 2 acima.')
  }

  if (id) nota(`order deste diagnostico: ${id}`)
  console.log('')
}

principal().catch((e) => {
  erro(`\nfalhou: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
