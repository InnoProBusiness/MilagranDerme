import type { PedidoStatus, PagamentoStatus } from '@/lib/db-types'

/**
 * Traduz payment.status do Mercado Pago para o ENUM pagamento_status
 * (migrations/1755200000000_pagamentos.sql).
 *
 * ESTE E O UNICO LUGAR DO SISTEMA que conhece as strings do provedor. Nenhuma
 * rota, nenhum repositorio e nenhum componente compara com 'approved' — todos
 * falam o ENUM do banco. Trocar de gateway um dia significa reescrever esta
 * funcao, e nada mais.
 *
 * Devolve null para status desconhecido em vez de lancar: o webhook precisa
 * gravar o evento e responder 200 (senao o Mercado Pago reenvia em laco por
 * horas), mas nao pode agir sobre algo que nao entende. O evento fica com
 * processado_em NULL, que e exatamente a fila de "chegou e ninguem tratou".
 */
export function mapearStatusMP(status: string): PagamentoStatus | null {
  switch (status) {
    case 'approved':
      return 'aprovado'
    case 'rejected':
      return 'recusado'
    case 'cancelled':
      return 'cancelado'
    // Estorno e chargeback tem o mesmo efeito financeiro: o dinheiro voltou
    // para o comprador. A diferenca (quem iniciou) importa para disputa, nao
    // para o saldo do representante.
    case 'refunded':
    case 'charged_back':
      return 'estornado'
    case 'pending':
      return 'pendente'
    // 'authorized' e cartao autorizado mas NAO capturado — o dinheiro ainda
    // nao e nosso. Mapear para 'aprovado' aqui creditaria comissao sobre
    // valor que pode nunca ser capturado. Como criamos os pagamentos com
    // captura automatica, este estado nao deveria aparecer; se aparecer,
    // 'em_analise' e a leitura segura.
    case 'authorized':
    case 'in_process':
    // 'in_mediation' e disputa aberta com o dinheiro ainda retido. Resolve-se
    // depois como 'approved' de volta ou 'charged_back' — e o desfecho e quem
    // move o saldo. Segurar aqui evita estornar comissao de uma disputa que a
    // Milagran vai ganhar.
    case 'in_mediation':
      return 'em_analise'
    default:
      return null
  }
}

/**
 * Transicoes validas de pedido_status. Nao ha caminho de volta a partir de
 * 'cancelado' e 'reembolsado': sao terminais, e corrigir um deles significa
 * pedido novo, nunca reabrir o antigo (ver
 * docs/superpowers/plans/2026-08-11-pendencias-carregadas.md).
 *
 * 'pendente' -> 'pago' existe de proposito, alem do caminho normal via
 * 'aguardando_pagamento': se a rota de criacao de pagamento morrer entre
 * chamar o Mercado Pago e gravar o novo status, o pedido fica em 'pendente'
 * com um pagamento real em curso. O webhook e quem reconcilia — e ele nao
 * pode recusar a aprovacao so porque o passo intermediario se perdeu.
 */
const TRANSICOES: Record<PedidoStatus, readonly PedidoStatus[]> = {
  pendente: ['aguardando_pagamento', 'pago', 'cancelado'],
  aguardando_pagamento: ['pago', 'pendente', 'cancelado'],
  // Depois de pago, o dinheiro so sai por reembolso — nunca por
  // 'cancelado', que nao move o livro-razao de comissao da mesma forma.
  pago: ['em_preparacao', 'enviado', 'reembolsado'],
  em_preparacao: ['enviado', 'reembolsado'],
  enviado: ['entregue', 'reembolsado'],
  entregue: ['reembolsado'],
  cancelado: [],
  reembolsado: [],
}

export function transicaoPermitida(de: PedidoStatus, para: PedidoStatus): boolean {
  return TRANSICOES[de].includes(para)
}

/**
 * Para qual status o PEDIDO deve ir, dado o status do PAGAMENTO que acabou de
 * chegar e onde o pedido esta agora.
 *
 * Devolve null quando nao ha nada a fazer — e o caso mais comum em producao,
 * nao a excecao: o Mercado Pago reenvia a mesma notificacao ate receber 2xx,
 * entao o segundo "approved" de um pedido ja pago cai aqui e vira no-op. E
 * essa devolucao null, somada ao UNIQUE de comissao por pedido, que garante
 * que reenvio nao vira comissao em dobro.
 */
export function pedidoAposPagamento(
  statusPagamento: PagamentoStatus,
  statusAtual: PedidoStatus,
): PedidoStatus | null {
  const alvo = alvoDoPagamento(statusPagamento)
  if (alvo === null) return null
  if (alvo === statusAtual) return null
  return transicaoPermitida(statusAtual, alvo) ? alvo : null
}

function alvoDoPagamento(s: PagamentoStatus): PedidoStatus | null {
  switch (s) {
    case 'aprovado':
      return 'pago'
    case 'estornado':
      return 'reembolsado'
    case 'cancelado':
      return 'cancelado'
    // Cartao recusado NAO cancela o pedido: o comprador tipicamente tenta
    // outro cartao ou troca para Pix na mesma tela. Voltar para 'pendente'
    // deixa o pedido pronto para a proxima tentativa.
    case 'recusado':
      return 'pendente'
    case 'pendente':
    case 'em_analise':
      return 'aguardando_pagamento'
    default: {
      // Exaustividade verificada pelo compilador: um valor novo no ENUM
      // pagamento_status quebra o build aqui em vez de virar no-op silencioso
      // em producao.
      const _exaustivo: never = s
      return _exaustivo
    }
  }
}

/**
 * O pedido acabou de entrar em um estado que gera credito de comissao?
 * Unico gatilho: a entrada em 'pago'.
 */
export function geraCreditoDeComissao(de: PedidoStatus, para: PedidoStatus): boolean {
  return para === 'pago' && de !== 'pago'
}

/**
 * O pedido acabou de sair de um estado pago para um que desfaz a venda?
 * O credito precisa ser revertido no livro-razao.
 */
export function geraEstornoDeComissao(de: PedidoStatus, para: PedidoStatus): boolean {
  const estavaPago = de === 'pago' || de === 'em_preparacao' || de === 'enviado' || de === 'entregue'
  return estavaPago && (para === 'reembolsado' || para === 'cancelado')
}
