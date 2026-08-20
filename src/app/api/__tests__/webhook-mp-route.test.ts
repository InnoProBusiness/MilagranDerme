import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { createHmac, randomUUID } from 'node:crypto'
import { getDb, closeDb } from '@/lib/db'
import { POST } from '@/app/api/webhooks/mercadopago/route'
import { criarPedido } from '@/repositories/pedidos'
import { saldoDoRepresentante } from '@/repositories/comissoes'
import { deInteiro } from '@/lib/money'

// A UNICA costura mockada: a releitura do pagamento na API do Mercado Pago.
// Nao existe outra forma de exercitar o webhook sem uma conta real e um
// pagamento real. Tudo o mais — assinatura, deduplicacao por evento, lock,
// transicao de status, livro-razao — e o codigo de producao.
const provedor = vi.hoisted(() => ({
  resposta: null as null | Record<string, unknown>,
  erro: false,
  /**
   * QUAL DAS DUAS APIS o webhook foi reler. Nao e detalhe de implementacao: o
   * id ULID de uma order nao existe em `/v1/payments` e vice-versa, entao
   * bater na porta errada e um 404 garantido — que o handler traduz em 503 e o
   * Mercado Pago transforma em reentrega infinita.
   */
  lidoPor: [] as string[],
}))

vi.mock('@/lib/mercadopago', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/mercadopago')>()
  return {
    ...real,
    segredoDoWebhook: () => SEGREDO,
    buscarPagamentoMP: async (id: string) => {
      provedor.lidoPor.push('payments')
      if (provedor.erro) throw new real.ErroMercadoPago(0, 'sem_resposta', 'timeout')
      return { id, statusDetail: '', ...provedor.resposta }
    },
    buscarOrderMP: async (id: string) => {
      provedor.lidoPor.push('orders')
      if (provedor.erro) throw new real.ErroMercadoPago(0, 'sem_resposta', 'timeout')
      return { id, statusDetail: '', ...provedor.resposta }
    },
  }
})

// Conta os envios de confirmacao sem tocar na Resend. O e-mail e um efeito
// externo irreversivel: quantas vezes ele sai importa tanto quanto o saldo.
const emails = vi.hoisted(() => ({ enviados: [] as string[] }))

vi.mock('@/lib/email-pedido', () => ({
  enviarConfirmacaoDePedido: async (pedidoId: string) => {
    emails.enviados.push(pedidoId)
  },
}))

const SEGREDO = 'segredo-de-webhook-para-o-teste-de-rota'
const PRECO = 100000
const PERCENTUAL = 20

let idRep: string
let idKit: string
let idCliente: string
let idEndereco: string

function assinar(dataId: string, requestId: string, ts = String(Math.floor(Date.now() / 1000))) {
  const v1 = createHmac('sha256', SEGREDO)
    .update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`)
    .digest('hex')
  return `ts=${ts},v1=${v1}`
}

function requisicao(opcoes: {
  dataId: string
  requestId?: string
  tipo?: string
  assinatura?: string
  action?: string
}) {
  const requestId = opcoes.requestId ?? randomUUID()
  const url = `https://milagranoficial.com.br/api/webhooks/mercadopago?data.id=${opcoes.dataId}&type=${opcoes.tipo ?? 'payment'}`
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-request-id': requestId,
      'x-signature': opcoes.assinatura ?? assinar(opcoes.dataId, requestId),
    },
    body: JSON.stringify({
      type: opcoes.tipo ?? 'payment',
      action: opcoes.action ?? 'payment.updated',
      data: { id: opcoes.dataId },
    }),
  })
}

async function semear() {
  provedor.resposta = null
  provedor.erro = false
  provedor.lidoPor = []
  emails.enviados = []

  const db = getDb()
  const s = randomUUID().slice(0, 8)

  const rep = await db.insertInto('representantes').values({
    slug: `wh-${s}`, codigo: `WH${s.toUpperCase()}`, nome: 'Maria Webhook',
    email: `wh-${s}@exemplo.com`, percentual_comissao: PERCENTUAL,
  }).returning('id').executeTakeFirstOrThrow()
  idRep = rep.id

  const kit = await db.insertInto('kits').values({
    slug: `wh-kit-${s}`, nome: 'Kit Webhook', sku: `WH-${s}`,
    preco_centavos: PRECO, unidades: 1,
  }).returning('id').executeTakeFirstOrThrow()
  idKit = kit.id

  // Cliente e endereco passaram a ser OBRIGATORIOS para pedido do canal
  // online: a constraint pedido_online_tem_endereco
  // (migrations/1755300100000_pedidos_canal_logistica.sql) recusa a linha sem
  // endereco_id. Nao e burocracia de teste — e a regra de §3 do documento de
  // lancamento: pedido online e enviado pelos Correios, entao tem que existir
  // para onde despachar. Antes do Plano 4 este arquivo criava pedido sem
  // nenhum dos dois, e continuava valido.
  const cliente = await db.insertInto('clientes').values({
    nome: 'Comprador Webhook', email: `wh-cli-${s}@exemplo.com`,
    cpf: '39053344705', whatsapp: '62999990000',
  }).returning('id').executeTakeFirstOrThrow()
  idCliente = cliente.id

  const endereco = await db.insertInto('enderecos').values({
    cliente_id: cliente.id, cep: '74575070', rua: 'Rua do Webhook',
    numero: '100', bairro: 'Centro', cidade: 'Goiania', estado: 'GO',
  }).returning('id').executeTakeFirstOrThrow()
  idEndereco = endereco.id
}

async function novoPedido() {
  return criarPedido({
    // canal 'online' e explicito porque EntradaPedido passou a exigi-lo: o
    // eixo canal e independente de `origem` (que e ATRIBUICAO de comissao) —
    // ver o comentario de pedido_origem_coerente em
    // migrations/1754900300000_pedidos.sql.
    canal: 'online',
    tipoEntrega: 'envio',
    origem: 'link', representanteId: idRep, percentualComissao: PERCENTUAL,
    utmSource: null, utmMedium: null, utmCampaign: null,
    desconto: deInteiro(0), frete: deInteiro(0),
    itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO) }],
    clienteId: idCliente,
    enderecoId: idEndereco,
  })
}

async function statusDoPedido(id: string) {
  const p = await getDb().selectFrom('pedidos').select('status')
    .where('id', '=', id).executeTakeFirstOrThrow()
  return p.status
}

describe('webhook do Mercado Pago', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  // A BARREIRA QUE IMPEDE PAGAR PEDIDO DE GRACA. A rota nao tem autenticacao
  // e esta exposta na internet; sem a assinatura, este POST marcaria o pedido
  // como pago e creditaria comissao.
  it('recusa assinatura invalida sem tocar no pedido', async () => {
    const pedido = await novoPedido()
    provedor.resposta = { status: 'approved', referenciaExterna: pedido.id }

    const r = await POST(requisicao({
      dataId: '111', assinatura: 'ts=1,v1=deadbeef',
    }))

    expect(r.status).toBe(401)
    expect(await statusDoPedido(pedido.id)).toBe('pendente')
    const saldo = await saldoDoRepresentante(idRep)
    expect(saldo.totalCreditado).toBe(0)
  })

  it('assinatura valida marca o pedido como pago e credita a comissao', async () => {
    const pedido = await novoPedido()
    const idPagamento = String(Date.now())
    provedor.resposta = { status: 'approved', referenciaExterna: pedido.id }

    const r = await POST(requisicao({ dataId: idPagamento }))

    expect(r.status).toBe(200)
    expect(await statusDoPedido(pedido.id)).toBe('pago')
    const saldo = await saldoDoRepresentante(idRep)
    expect(saldo.totalCreditado).toBe(20000)
  })

  // O corpo diz "approved", a API diz "rejected". Manda a API — o corpo e um
  // aviso de que algo mudou, nao a verdade sobre o que mudou.
  it('ignora o status do corpo e usa o que a API responde', async () => {
    const pedido = await novoPedido()
    provedor.resposta = { status: 'rejected', referenciaExterna: pedido.id }

    await POST(requisicao({ dataId: String(Date.now() + 1) }))

    expect(await statusDoPedido(pedido.id)).toBe('pendente')
    expect((await saldoDoRepresentante(idRep)).totalCreditado).toBe(0)
  })

  it('reentrega da mesma notificacao nao credita de novo', async () => {
    const pedido = await novoPedido()
    const idPagamento = String(Date.now() + 2)
    const requestId = randomUUID()
    provedor.resposta = { status: 'approved', referenciaExterna: pedido.id }

    const primeira = await POST(requisicao({ dataId: idPagamento, requestId }))
    const segunda = await POST(requisicao({ dataId: idPagamento, requestId }))

    expect(primeira.status).toBe(200)
    expect(segunda.status).toBe(200)
    expect(await segunda.json()).toMatchObject({ duplicado: true })
    expect((await saldoDoRepresentante(idRep)).totalCreditado).toBe(20000)
  })

  // Entregas DIFERENTES sobre o mesmo pagamento (pendente e depois aprovado)
  // precisam ser processadas as duas — a deduplicacao e por entrega, nao por
  // pagamento. Mas so a que aprova credita.
  it('duas entregas distintas do mesmo pagamento creditam uma vez so', async () => {
    const pedido = await novoPedido()
    const idPagamento = String(Date.now() + 3)
    provedor.resposta = { status: 'approved', referenciaExterna: pedido.id }

    await POST(requisicao({ dataId: idPagamento, requestId: randomUUID() }))
    await POST(requisicao({ dataId: idPagamento, requestId: randomUUID() }))

    expect((await saldoDoRepresentante(idRep)).totalCreditado).toBe(20000)
  })

  // O e-mail e efeito externo irreversivel. Reenvio do webhook nao pode
  // virar um segundo "Pagamento confirmado" na caixa do comprador.
  it('envia a confirmacao uma vez so, mesmo com reentrega', async () => {
    const pedido = await novoPedido()
    const idPagamento = String(Date.now() + 20)
    provedor.resposta = { status: 'approved', referenciaExterna: pedido.id }

    await POST(requisicao({ dataId: idPagamento, requestId: randomUUID() }))
    await POST(requisicao({ dataId: idPagamento, requestId: randomUUID() }))

    expect(emails.enviados).toEqual([pedido.id])
  })

  it('pagamento recusado nao dispara e-mail de confirmacao', async () => {
    const pedido = await novoPedido()
    provedor.resposta = { status: 'rejected', referenciaExterna: pedido.id }

    await POST(requisicao({ dataId: String(Date.now() + 21) }))

    expect(emails.enviados).toEqual([])
  })

  it('notificacao que nao e de pagamento e ignorada com 200', async () => {
    const r = await POST(requisicao({ dataId: '999', tipo: 'merchant_order' }))
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ignorado: 'merchant_order' })
  })

  // 503 e deliberado: pede reenvio. Um 200 aqui perderia o pagamento em
  // silencio, porque o Mercado Pago para de reenviar depois do primeiro 2xx.
  it('falha ao reler o pagamento devolve 503 para o provedor reenviar', async () => {
    const pedido = await novoPedido()
    provedor.erro = true

    const r = await POST(requisicao({ dataId: String(Date.now() + 4) }))

    expect(r.status).toBe(503)
    expect(await statusDoPedido(pedido.id)).toBe('pendente')
  })

  it('estorno depois de pago reembolsa o pedido e reverte a comissao', async () => {
    const pedido = await novoPedido()
    provedor.resposta = { status: 'approved', referenciaExterna: pedido.id }
    await POST(requisicao({ dataId: String(Date.now() + 5) }))

    provedor.resposta = { status: 'refunded', referenciaExterna: pedido.id }
    await POST(requisicao({ dataId: String(Date.now() + 6) }))

    expect(await statusDoPedido(pedido.id)).toBe('reembolsado')
    const saldo = await saldoDoRepresentante(idRep)
    expect(saldo.disponivel + saldo.pendente).toBe(0)
  })

  // Sem linha em `pagamentos` (processo morto entre abrir e vincular), o
  // external_reference e a unica ancora que liga a cobranca ao pedido.
  it('concilia pelo external_reference quando nao ha pagamento local', async () => {
    const pedido = await novoPedido()
    provedor.resposta = { status: 'approved', referenciaExterna: pedido.id }

    await POST(requisicao({ dataId: String(Date.now() + 7) }))

    expect(await statusDoPedido(pedido.id)).toBe('pago')
  })

  it('pagamento sem pedido correspondente responde 200 sem quebrar', async () => {
    provedor.resposta = { status: 'approved', referenciaExterna: null }
    const r = await POST(requisicao({ dataId: String(Date.now() + 8) }))
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ semPedido: true })
  })

  /**
   * O TOPICO `order` — a saida de emergencia do Pix, testada ANTES de precisar
   * dela.
   *
   * Nenhuma rota cria order hoje: Pix e cartao saem os dois por
   * `/v1/payments`, e e o topico `payment` (testado acima) que roda em
   * producao. `criarOrderPixMP` existe para o dia em que o PolicyAgent voltar a
   * recusar `/v1/payments`, como recusou em 19/08/2026 — ver
   * src/lib/mercadopago.ts.
   *
   * POR QUE TESTAR UM CAMINHO QUE NAO RODA: porque o dia em que ele rodar sera
   * um dia de loja parada, e ninguem escreve teste com a loja parada. Adotar a
   * Orders muda TRES coisas nesta rota ao mesmo tempo — o topico da
   * notificacao, a API onde reler e o vocabulario de status — e errar qualquer
   * uma das tres tem o mesmo desfecho: o dinheiro entra e o pedido nunca vira
   * 'pago'.
   *
   * O QUE ESTES TESTES NAO PROVAM: que a notificacao de order CHEGA. Isso
   * depende do evento `order` estar marcado no painel do Mercado Pago, e nunca
   * foi observado.
   */
  describe('notificacao de order (Pix)', () => {
    const ORDER = 'ORD01M0DW0CJ1QGRJP9KM4MHHFM8S'

    it('order aprovada marca o pedido como pago e credita a comissao', async () => {
      const pedido = await novoPedido()
      provedor.resposta = {
        status: 'processed', statusDetail: 'accredited', referenciaExterna: pedido.id,
      }

      const r = await POST(requisicao({ dataId: ORDER, tipo: 'order' }))

      expect(r.status).toBe(200)
      expect(await statusDoPedido(pedido.id)).toBe('pago')
      expect((await saldoDoRepresentante(idRep)).totalCreditado).toBe(20000)
    })

    // A releitura tem que ir em /v1/orders. O ULID da order nao existe em
    // /v1/payments — medido em producao: `resource not found`.
    it('rele a order em /v1/orders, nunca em /v1/payments', async () => {
      const pedido = await novoPedido()
      provedor.resposta = {
        status: 'processed', statusDetail: 'accredited', referenciaExterna: pedido.id,
      }

      await POST(requisicao({ dataId: ORDER, tipo: 'order' }))

      expect(provedor.lidoPor).toEqual(['orders'])
    })

    // A assinatura e o unico portao desta rota, e ela nao pode ter ficado para
    // tras na migracao: um POST forjado com topico `order` pagaria pedido de
    // graca exatamente como um com topico `payment`.
    it('order com assinatura invalida e recusada sem tocar no pedido', async () => {
      const pedido = await novoPedido()
      provedor.resposta = {
        status: 'processed', statusDetail: 'accredited', referenciaExterna: pedido.id,
      }

      const r = await POST(requisicao({
        dataId: ORDER, tipo: 'order', assinatura: 'ts=1,v1=deadbeef',
      }))

      expect(r.status).toBe(401)
      expect(await statusDoPedido(pedido.id)).toBe('pendente')
      expect((await saldoDoRepresentante(idRep)).totalCreditado).toBe(0)
    })

    // O estado em que todo Pix nasce: QR na tela, dinheiro ainda nao. Nao
    // credita nada e nao manda e-mail.
    it('Pix aguardando transferencia nao credita nem manda e-mail', async () => {
      const pedido = await novoPedido()
      provedor.resposta = {
        status: 'action_required', statusDetail: 'waiting_transfer', referenciaExterna: pedido.id,
      }

      await POST(requisicao({ dataId: ORDER, tipo: 'order' }))

      expect(await statusDoPedido(pedido.id)).toBe('aguardando_pagamento')
      expect((await saldoDoRepresentante(idRep)).totalCreditado).toBe(0)
      expect(emails.enviados).toEqual([])
    })

    /**
     * O PIX QUE EXPIROU DEIXA O PEDIDO VENDAVEL. Se este teste virar
     * 'cancelado', a compradora que gerar o QR a noite e voltar no dia
     * seguinte encontra a loja recusando o proprio pedido dela: 'cancelado' e
     * terminal e /api/pagamentos so aceita 'pendente' ou
     * 'aguardando_pagamento'.
     */
    it('Pix expirado devolve o pedido para pendente', async () => {
      const pedido = await novoPedido()
      provedor.resposta = {
        status: 'action_required', statusDetail: 'waiting_transfer', referenciaExterna: pedido.id,
      }
      await POST(requisicao({ dataId: ORDER, tipo: 'order' }))

      provedor.resposta = {
        status: 'expired', statusDetail: 'expired', referenciaExterna: pedido.id,
      }
      await POST(requisicao({ dataId: ORDER, tipo: 'order' }))

      expect(await statusDoPedido(pedido.id)).toBe('pendente')
    })

    /**
     * A ARMADILHA DA REENTREGA INFINITA.
     *
     * Uma order Pix contem um pagamento com id ULID (`PAY01...`). Se o Mercado
     * Pago notificar esse pagamento no topico `payment`, a releitura em
     * `/v1/payments/{PAY01...}` responde `resource not found` — medido. Sem a
     * guarda, o handler devolveria 503 pedindo reenvio, e o provedor reenviaria
     * a MESMA notificacao por horas: uma fila de retentativas que nunca passa,
     * escondendo as notificacoes que importam.
     *
     * 200 e "decidimos conscientemente ignorar": quem confirma esse pagamento e
     * a notificacao da order, que chega em paralelo.
     */
    it('id ULID no topico payment e ignorado, e nao vira laco de 503', async () => {
      const r = await POST(requisicao({
        dataId: 'PAY01M0DW0CJA5GXQ3M22H5JB1N84', tipo: 'payment',
      }))

      expect(r.status).toBe(200)
      expect(provedor.lidoPor).toEqual([])
    })

    // O caminho do cartao nao pode ter sido quebrado pela guarda acima: id
    // numerico continua sendo lido em /v1/payments.
    it('id numerico no topico payment continua indo para /v1/payments', async () => {
      const pedido = await novoPedido()
      provedor.resposta = { status: 'approved', referenciaExterna: pedido.id }

      await POST(requisicao({ dataId: String(Date.now() + 30), tipo: 'payment' }))

      expect(provedor.lidoPor).toEqual(['payments'])
      expect(await statusDoPedido(pedido.id)).toBe('pago')
    })
  })
})
