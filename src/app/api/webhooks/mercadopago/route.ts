import { getDb } from '@/lib/db'
import { verificarAssinaturaMP } from '@/lib/webhook-mp'
import { buscarPagamentoMP, segredoDoWebhook, ErroMercadoPago } from '@/lib/mercadopago'
import { mapearStatusMP } from '@/lib/pedido-status'
import { atualizarStatusPorProvedorId } from '@/repositories/pagamentos'
import { conciliarPagamento } from '@/repositories/conciliacao'
import { enviarConfirmacaoDePedido } from '@/lib/email-pedido'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Webhook do Mercado Pago.
 *
 * SEMANTICA DE RESPOSTA — o Mercado Pago reenvia a notificacao ate receber
 * 2xx e depois desiste. Entao:
 *   200 = "tratamos, ou decidimos conscientemente ignorar". Nao reenviar.
 *   401 = assinatura invalida. Nao e nosso trafego.
 *   5xx = falha transitoria nossa. POR FAVOR reenvie.
 * Devolver 200 para uma falha real perde o pagamento em silencio; devolver
 * 5xx para algo que ja tratamos gera reentrega em laco.
 *
 * TRES BARREIRAS, nesta ordem:
 *   1. Assinatura HMAC. Sem ela, um POST forjado marca pedido como pago.
 *   2. webhook_evento_unico: a mesma entrega (x-request-id) so processa uma vez.
 *   3. conciliarPagamento com FOR UPDATE + comissao_um_credito_por_pedido.
 */
export async function POST(req: Request) {
  const url = new URL(req.url)

  let corpo: Record<string, unknown> = {}
  try {
    corpo = (await req.json()) as Record<string, unknown>
  } catch {
    // Corpo vazio ou malformado nao e motivo para reenvio: a notificacao
    // util vem na query string. Seguimos com o que der.
  }

  // O Mercado Pago manda os mesmos dados na query e no corpo, e nem sempre
  // nos dois. A query e a fonte que a documentacao usa para montar o
  // manifesto assinado, entao ela vem primeiro.
  const dadosDoCorpo = (corpo.data ?? {}) as Record<string, unknown>
  const dataId = url.searchParams.get('data.id')
    ?? (dadosDoCorpo.id != null ? String(dadosDoCorpo.id) : null)
  const tipo = url.searchParams.get('type')
    ?? (typeof corpo.type === 'string' ? corpo.type : null)
  const requestId = req.headers.get('x-request-id')

  let segredo: string
  try {
    segredo = segredoDoWebhook()
  } catch {
    // Sem segredo configurado NAO ha como distinguir notificacao legitima de
    // POST forjado. Recusar e a unica opcao segura: aceitar "porque a env
    // ainda nao foi preenchida" transforma um erro de configuracao em porta
    // aberta para marcar pedido como pago.
    //
    // O DIAGNOSTICO AO LADO DA RECUSA responde, sem abrir nada, a pergunta que
    // aparece quando o painel do provedor nao mostra onde gerar o segredo: as
    // notificacoes chegam ASSINADAS? Se `assinatura=sim`, o Mercado Pago ja
    // esta assinando e falta so o segredo do nosso lado. Se `assinatura=nao`,
    // nenhum segredo faria a verificacao passar e a conversa e outra.
    //
    // So a PRESENCA dos cabecalhos vai para o log, nunca o valor: a assinatura
    // e material criptografico e o log do container e agregado.
    console.error(
      '[webhook-mp] MERCADOPAGO_WEBHOOK_SECRET nao configurada — recusando'
      + ` (assinatura=${req.headers.get('x-signature') ? 'sim' : 'nao'}`
      + `, request-id=${requestId ? 'sim' : 'nao'}`
      + `, tipo=${tipo ?? '-'})`,
    )
    return Response.json({ error: 'nao_configurado' }, { status: 503 })
  }

  const assinaturaOk = verificarAssinaturaMP({
    assinatura: req.headers.get('x-signature'),
    requestId,
    dataId,
    segredo,
  })

  if (!assinaturaOk) {
    console.warn('[webhook-mp] assinatura invalida, data.id=', dataId)
    return Response.json({ error: 'assinatura_invalida' }, { status: 401 })
  }

  // Notificacao de outro assunto (merchant_order, plano, assinatura). Nada a
  // fazer, e nada a reenviar.
  if (tipo !== 'payment' || !dataId) {
    return Response.json({ ok: true, ignorado: tipo ?? 'sem_tipo' }, { status: 200 })
  }

  // BARREIRA 2. Sem x-request-id nao ha chave de entrega; usar o id do
  // pagamento no lugar tornaria a SEGUNDA notificacao do mesmo pagamento
  // (pendente -> aprovado) um duplicado, e o pedido nunca sairia de
  // aguardando_pagamento. Por isso o fallback carrega o status junto.
  const chaveDeEntrega = requestId ?? `${dataId}:${String(corpo.action ?? 'sem_acao')}`

  const registrado = await getDb()
    .insertInto('webhook_eventos')
    .values({
      evento_id: chaveDeEntrega,
      tipo,
      recurso_id: dataId,
      payload: JSON.stringify(corpo),
    })
    .onConflict((oc) => oc.columns(['provedor', 'evento_id']).doNothing())
    .returning('id')
    .executeTakeFirst()

  if (!registrado) {
    return Response.json({ ok: true, duplicado: true }, { status: 200 })
  }

  // A VERDADE VEM DA API, NUNCA DO CORPO. A assinatura prova quem enviou;
  // ela nao prova que o `status` do payload reflete o estado atual da
  // cobranca. Reler autenticado com o access token e o que transforma
  // "pedido pago" em fato verificado.
  let pagamento
  try {
    pagamento = await buscarPagamentoMP(dataId)
  } catch (e) {
    const detalhe = e instanceof ErroMercadoPago ? e.message : 'erro desconhecido'
    console.error('[webhook-mp] falha ao reler o pagamento:', detalhe)
    // 5xx de proposito: pedir reenvio. O evento fica gravado com
    // processado_em NULL, que e a fila do que chegou e nao foi tratado.
    return Response.json({ error: 'releitura_falhou' }, { status: 503 })
  }

  const status = mapearStatusMP(pagamento.status)
  if (status === null) {
    console.error('[webhook-mp] status desconhecido:', pagamento.status)
    // 200: reenviar nao ajuda, o status continuaria desconhecido. Fica na
    // fila de processado_em NULL para inspecao humana.
    return Response.json({ ok: true, statusDesconhecido: pagamento.status }, { status: 200 })
  }

  try {
    const resultado = await getDb().transaction().execute(async (trx) => {
      const local = await atualizarStatusPorProvedorId(pagamento.id, status, trx)

      // external_reference e o id do pedido, gravado por nos na criacao. E a
      // ancora quando a linha local nao existe — o processo pode ter morrido
      // entre abrirPagamento e vincularAoProvedor, e a cobranca real existe
      // do mesmo jeito. Sem este fallback o pagamento ficaria orfao e o
      // pedido nunca sairia de pendente.
      const pedidoId = local?.pedidoId ?? pagamento.referenciaExterna
      if (!pedidoId) return null

      const conciliado = await conciliarPagamento(pedidoId, status, trx)

      await trx
        .updateTable('webhook_eventos')
        .set({ processado_em: new Date() })
        .where('id', '=', registrado.id)
        .execute()

      return { ...conciliado, pedidoId }
    })

    if (resultado === null) {
      console.error('[webhook-mp] pagamento sem pedido correspondente:', pagamento.id)
      return Response.json({ ok: true, semPedido: true }, { status: 200 })
    }

    // DEPOIS do COMMIT, e so na transicao para 'pago'. Dentro da transacao o
    // e-mail poderia sair e o banco desfazer tudo em seguida, deixando o
    // comprador com a confirmacao de um pagamento que nao existe. E `mudou`
    // garante envio unico: a reentrega da notificacao nao reenvia o e-mail.
    if (resultado.mudou && resultado.para === 'pago') {
      await enviarConfirmacaoDePedido(resultado.pedidoId)
    }

    return Response.json({ ok: true, mudou: resultado.mudou, status: resultado.para }, { status: 200 })
  } catch (e) {
    console.error('[webhook-mp] falha ao conciliar:', e instanceof Error ? e.message : 'erro')
    return Response.json({ error: 'conciliacao_falhou' }, { status: 503 })
  }
}

export async function GET() {
  return Response.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'POST' },
  })
}
