import { z } from 'zod'
import { getDb } from '@/lib/db'
import {
  abrirPagamento, vincularAoProvedor, buscarPedidoParaPagamento,
} from '@/repositories/pagamentos'
import { conciliarPagamento } from '@/repositories/conciliacao'
import { criarPagamentoMP, ErroMercadoPago, falhaDoProvedor } from '@/lib/mercadopago'
import { mapearStatusMP } from '@/lib/pedido-status'
import { mensagemDoPagamento } from '@/lib/pagamento-mensagens'
import { enviarConfirmacaoDePedido } from '@/lib/email-pedido'
import {
  criarLimitadorPorIp, ipDoPedido,
  JANELA_RATE_LIMIT_MS, MAX_PEDIDOS_POR_JANELA,
} from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const excedeuRateLimit = criarLimitadorPorIp({
  janelaMs: JANELA_RATE_LIMIT_MS,
  maxPorJanela: MAX_PEDIDOS_POR_JANELA,
})

const Corpo = z.discriminatedUnion('metodo', [
  z.object({
    metodo: z.literal('pix'),
    pedidoToken: z.string().uuid(),
  }).strict(),
  z.object({
    metodo: z.literal('cartao'),
    pedidoToken: z.string().uuid(),
    // Token gerado NO NAVEGADOR pelo Payment Brick. O numero do cartao nunca
    // passa por este servidor — e o que mantem a aplicacao fora do escopo de
    // PCI e atende a secao 15 da spec ("dados sensiveis do cartao nao devem
    // ser armazenados pela aplicacao").
    token: z.string().min(1),
    parcelas: z.number().int().min(1).max(12),
    metodoPagamentoId: z.string().min(1),
    emissorId: z.string().min(1).optional(),
  }).strict(),
])

/**
 * Separa "Maria Aparecida da Silva" em first_name/last_name para o campo
 * `payer` do Mercado Pago. Nome sem sobrenome repete o proprio nome: o
 * provedor recusa last_name vazio.
 */
function separarNome(completo: string): { nome: string; sobrenome: string } {
  const partes = completo.trim().split(/\s+/)
  if (partes.length === 1) return { nome: partes[0], sobrenome: partes[0] }
  return { nome: partes[0], sobrenome: partes.slice(1).join(' ') }
}

export async function POST(req: Request) {
  if (excedeuRateLimit(ipDoPedido(req.headers))) {
    return Response.json({ error: 'rate_limited' }, { status: 429 })
  }

  const parsed = Corpo.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'dados_invalidos' }, { status: 422 })
  }
  const d = parsed.data

  const pedido = await buscarPedidoParaPagamento(d.pedidoToken)
  if (!pedido) return Response.json({ error: 'pedido_nao_encontrado' }, { status: 404 })

  // Pedido ja pago nao abre cobranca nova. Sem esta guarda, recarregar a tela
  // de pagamento de um pedido concluido cobraria de novo.
  if (pedido.status !== 'pendente' && pedido.status !== 'aguardando_pagamento') {
    return Response.json(
      { error: 'pedido_nao_aceita_pagamento', status: pedido.status },
      { status: 409 },
    )
  }

  const { nome, sobrenome } = separarNome(pedido.clienteNome)

  // ORDEM DELIBERADA: a linha local nasce ANTES da chamada ao provedor, e a
  // chamada ao provedor acontece FORA de qualquer transacao.
  //
  // O id gerado aqui e a chave de idempotencia enviada ao Mercado Pago: sem
  // uma linha previa nao existiria identificador estavel para reenviar a
  // mesma requisicao sem cobrar duas vezes.
  //
  // E a chamada de rede nao pode ficar dentro de uma transacao aberta: 15
  // segundos de timeout segurando conexao do pool (que tem 5) e locks e o
  // caminho curto para travar o checkout inteiro sob carga.
  const local = await abrirPagamento({
    pedidoId: pedido.id,
    metodo: d.metodo,
    valor: pedido.totalCentavos,
    parcelas: d.metodo === 'cartao' ? d.parcelas : 1,
  })

  let resposta
  try {
    resposta = await criarPagamentoMP(
      d.metodo === 'pix'
        ? {
            metodo: 'pix',
            valor: pedido.totalCentavos,
            descricao: `Pedido #${pedido.numero} — Milagran`,
            referenciaExterna: pedido.id,
            pagador: { email: pedido.clienteEmail, nome, sobrenome, cpf: pedido.clienteCpf },
          }
        : {
            metodo: 'cartao',
            valor: pedido.totalCentavos,
            descricao: `Pedido #${pedido.numero} — Milagran`,
            referenciaExterna: pedido.id,
            pagador: { email: pedido.clienteEmail, nome, sobrenome, cpf: pedido.clienteCpf },
            token: d.token,
            parcelas: d.parcelas,
            metodoPagamentoId: d.metodoPagamentoId,
            emissorId: d.emissorId,
          },
      local.id,
    )
  } catch (e) {
    if (e instanceof ErroMercadoPago) {
      // A regra de "o que dizer" mora em falhaDoProvedor (src/lib/mercadopago.ts),
      // com teste proprio: ela separa "o provedor nao respondeu" — que passa
      // sozinho — de "o provedor recusou", que nao passa. A mensagem do
      // provedor vai so para o log, porque carrega vocabulario interno e, em
      // alguns erros, ecoa o payload enviado, com CPF e e-mail do comprador.
      const falha = falhaDoProvedor(e)
      console.error('[pagamentos]', falha.paraOLog)

      // DOIS CODIGOS DE ERRO, e nao um: a tela ja mostra a mensagem certa, mas
      // quem consome esta rota (hoje src/components/pagamento.tsx, amanha
      // qualquer outra coisa) precisa poder distinguir "tente de novo" de "nao
      // adianta tentar" sem ler a frase em portugues.
      return Response.json({
        error: falha.podeTentarDeNovo ? 'falha_no_provedor' : 'cobranca_recusada',
        mensagem: falha.mensagem,
      }, { status: 502 })
    }
    console.error('[pagamentos] falha inesperada:', e instanceof Error ? e.message : 'erro')
    return Response.json({ error: 'nao_foi_possivel_cobrar' }, { status: 500 })
  }

  const status = mapearStatusMP(resposta.status)
  if (status === null) {
    // Status que nao sabemos ler: a cobranca EXISTE no provedor, entao a
    // linha local precisa apontar para ela de qualquer jeito. O webhook
    // reconcilia quando o status virar algo conhecido.
    console.error('[pagamentos] status desconhecido do provedor:', resposta.status)
    await vincularAoProvedor(local.id, resposta.id, 'pendente')
    return Response.json({ metodo: d.metodo, status: 'pendente' }, { status: 202 })
  }

  const conciliado = await getDb().transaction().execute(async (trx) => {
    await vincularAoProvedor(local.id, resposta.id, status, trx)
    // MESMA funcao que o webhook chama. Um cartao aprovado na hora credita
    // comissao por este caminho; se o webhook do mesmo pagamento chegar logo
    // depois, `conciliarPagamento` devolve no-op. Duplicar a regra aqui seria
    // a forma mais direta de creditar duas vezes.
    return conciliarPagamento(pedido.id, status, trx)
  })

  // Cartao aprovado na hora tambem gera confirmacao — e o mesmo evento de
  // negocio que o webhook trata, so que sincrono. Depois do COMMIT pela mesma
  // razao de la: e-mail enviado nao volta atras, rollback volta.
  if (conciliado.mudou && conciliado.para === 'pago') {
    await enviarConfirmacaoDePedido(pedido.id)
  }

  if (d.metodo === 'pix') {
    return Response.json({
      metodo: 'pix',
      status,
      pixCopiaECola: resposta.pixCopiaECola,
      pixQrBase64: resposta.pixQrBase64,
      expiraEm: resposta.expiraEm,
    }, { status: 201 })
  }

  if (status === 'recusado') {
    return Response.json({
      metodo: 'cartao',
      status,
      mensagem: mensagemDoPagamento(resposta.statusDetail),
    }, { status: 402 })
  }

  return Response.json({
    metodo: 'cartao',
    status,
    pedidoPago: conciliado.para === 'pago',
  }, { status: 201 })
}

export async function GET() {
  return Response.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'POST' },
  })
}
