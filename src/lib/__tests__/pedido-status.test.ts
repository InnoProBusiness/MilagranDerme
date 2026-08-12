import { describe, it, expect } from 'vitest'
import {
  mapearStatusMP, transicaoPermitida, pedidoAposPagamento,
  geraCreditoDeComissao, geraEstornoDeComissao,
} from '@/lib/pedido-status'
import type { PedidoStatus } from '@/lib/db-types'

const TODOS_OS_STATUS: readonly PedidoStatus[] = [
  'pendente', 'aguardando_pagamento', 'pago', 'em_preparacao',
  'enviado', 'entregue', 'cancelado', 'reembolsado',
]

describe('traducao do status do Mercado Pago', () => {
  it('approved vira aprovado', () => {
    expect(mapearStatusMP('approved')).toBe('aprovado')
  })

  it('refunded e charged_back caem no mesmo estado: o dinheiro voltou', () => {
    expect(mapearStatusMP('refunded')).toBe('estornado')
    expect(mapearStatusMP('charged_back')).toBe('estornado')
  })

  // O erro que este teste existe para impedir: tratar cartao AUTORIZADO como
  // pago. Autorizado e limite reservado, nao dinheiro capturado — creditar
  // comissao ali paga o representante por uma venda que pode nunca liquidar.
  it('authorized NAO e aprovado: o dinheiro ainda nao foi capturado', () => {
    expect(mapearStatusMP('authorized')).toBe('em_analise')
  })

  it('disputa aberta segura o saldo em vez de estornar', () => {
    expect(mapearStatusMP('in_mediation')).toBe('em_analise')
  })

  it('status desconhecido devolve null em vez de lancar', () => {
    expect(mapearStatusMP('quantum_superposition')).toBeNull()
  })
})

describe('transicoes de status do pedido', () => {
  it('cancelado e reembolsado sao terminais', () => {
    for (const destino of TODOS_OS_STATUS) {
      expect(transicaoPermitida('cancelado', destino)).toBe(false)
      expect(transicaoPermitida('reembolsado', destino)).toBe(false)
    }
  })

  // Depois de o dinheiro entrar, "cancelar" nao e um caminho: o pedido tem
  // que ser reembolsado, que e o unico estado que reverte o livro-razao.
  it('pedido pago nao pode ser cancelado, so reembolsado', () => {
    expect(transicaoPermitida('pago', 'cancelado')).toBe(false)
    expect(transicaoPermitida('pago', 'reembolsado')).toBe(true)
  })

  it('nenhum status transiciona para si mesmo', () => {
    for (const s of TODOS_OS_STATUS) {
      expect(transicaoPermitida(s, s)).toBe(false)
    }
  })
})

describe('efeito do pagamento sobre o pedido', () => {
  it('aprovado leva o pedido de aguardando_pagamento para pago', () => {
    expect(pedidoAposPagamento('aprovado', 'aguardando_pagamento')).toBe('pago')
  })

  // O CASO QUE MAIS IMPORTA. O Mercado Pago reenvia a notificacao ate receber
  // 2xx. O segundo "approved" do mesmo pedido tem que ser inofensivo — se
  // virasse uma transicao, viraria tambem um segundo credito de comissao.
  it('aprovado repetido sobre pedido ja pago nao faz nada', () => {
    expect(pedidoAposPagamento('aprovado', 'pago')).toBeNull()
  })

  it('aprovado que chega depois do envio nao regride o pedido', () => {
    expect(pedidoAposPagamento('aprovado', 'enviado')).toBeNull()
  })

  // Se a rota de pagamento morrer entre chamar o gateway e gravar o status, o
  // pedido fica 'pendente' com cobranca real em curso. O webhook reconcilia.
  it('aprovado sobre pedido ainda pendente e aceito', () => {
    expect(pedidoAposPagamento('aprovado', 'pendente')).toBe('pago')
  })

  it('cartao recusado devolve o pedido para pendente, permitindo nova tentativa', () => {
    expect(pedidoAposPagamento('recusado', 'aguardando_pagamento')).toBe('pendente')
  })

  it('estorno reembolsa o pedido em qualquer estado ja pago', () => {
    expect(pedidoAposPagamento('estornado', 'pago')).toBe('reembolsado')
    expect(pedidoAposPagamento('estornado', 'entregue')).toBe('reembolsado')
  })

  it('Pix emitido deixa o pedido aguardando pagamento', () => {
    expect(pedidoAposPagamento('pendente', 'pendente')).toBe('aguardando_pagamento')
  })
})

describe('gatilhos do livro-razao de comissao', () => {
  it('credito nasce so na entrada em pago', () => {
    expect(geraCreditoDeComissao('aguardando_pagamento', 'pago')).toBe(true)
    expect(geraCreditoDeComissao('pago', 'enviado')).toBe(false)
    expect(geraCreditoDeComissao('pendente', 'aguardando_pagamento')).toBe(false)
  })

  it('estorno nasce ao desfazer uma venda que ja estava paga', () => {
    expect(geraEstornoDeComissao('pago', 'reembolsado')).toBe(true)
    expect(geraEstornoDeComissao('entregue', 'reembolsado')).toBe(true)
  })

  // Pedido que nunca chegou a ser pago nao gerou credito nenhum — estornar
  // ali lancaria um debito sem contrapartida e deixaria o saldo negativo.
  it('cancelar pedido que nunca foi pago nao estorna nada', () => {
    expect(geraEstornoDeComissao('pendente', 'cancelado')).toBe(false)
    expect(geraEstornoDeComissao('aguardando_pagamento', 'cancelado')).toBe(false)
  })
})
