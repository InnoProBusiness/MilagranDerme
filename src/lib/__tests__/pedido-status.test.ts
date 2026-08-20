import { describe, it, expect } from 'vitest'
import {
  mapearStatusMP, mapearStatusOrder, transicaoPermitida, pedidoAposPagamento,
  geraCreditoDeComissao, geraEstornoDeComissao, ROTULOS_STATUS,
  transicaoPermitidaNaEntrega, EXIGE_POSTAGEM,
} from '@/lib/pedido-status'
import type { PedidoStatus } from '@/lib/db-types'

// Na ordem do ciclo de vida, que e tambem a ordem do ENUM depois de
// migrations/1755300200000_status_em_transito.sql (ADD VALUE ... AFTER
// 'enviado').
const TODOS_OS_STATUS: readonly PedidoStatus[] = [
  'pendente', 'aguardando_pagamento', 'pago', 'em_preparacao',
  'enviado', 'em_transito', 'entregue', 'cancelado', 'reembolsado',
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

/**
 * O SEGUNDO VOCABULARIO — o da Orders API, por onde o Pix passa desde
 * 20/08/2026 (docs/2026-08-19-migrar-pix-para-orders.md).
 *
 * O DEFEITO QUE ESTE BLOCO EXISTE PARA IMPEDIR e silencioso e caro: a Orders
 * NAO diz 'approved'. Se o webhook passasse a resposta de uma order por
 * `mapearStatusMP`, TODO status cairia em `default: return null` — inclusive a
 * aprovacao. A compradora pagaria o Pix, o dinheiro entraria na conta, e o
 * pedido ficaria parado em 'aguardando_pagamento', sem comissao e sem e-mail
 * de confirmacao, sem NENHUM erro em log alem de uma linha de "status
 * desconhecido".
 */
describe('traducao do status da Orders API', () => {
  // A aprovacao. Se so um teste deste bloco puder existir, e este.
  it('processed/accredited e o pedido pago', () => {
    expect(mapearStatusOrder('processed', 'accredited')).toBe('aprovado')
  })

  // O estado em que todo Pix nasce — observado em producao na criacao real de
  // uma cobranca.
  it('action_required/waiting_transfer e Pix aguardando pagamento', () => {
    expect(mapearStatusOrder('action_required', 'waiting_transfer')).toBe('pendente')
    expect(mapearStatusOrder('action_required', 'waiting_payment')).toBe('pendente')
  })

  /**
   * MESMO `status`, LEITURAS OPOSTAS — e por isso a funcao recebe os dois
   * campos. 'waiting_capture' e limite reservado no cartao, nao dinheiro
   * capturado: trata-lo como pendente ja seria errado, e trata-lo como
   * aprovado pagaria comissao por uma venda que pode nunca liquidar.
   */
  it('action_required/waiting_capture segura o saldo em vez de aguardar a compradora', () => {
    expect(mapearStatusOrder('action_required', 'waiting_capture')).toBe('em_analise')
  })

  it('processing e in_review seguram o saldo sem decidir nada', () => {
    expect(mapearStatusOrder('processing', 'in_process')).toBe('em_analise')
    expect(mapearStatusOrder('processing', 'pending_review_manual')).toBe('em_analise')
    expect(mapearStatusOrder('in_review', 'in_review')).toBe('em_analise')
  })

  it('o dinheiro de volta e estorno, venha por refund ou por contestacao', () => {
    expect(mapearStatusOrder('refunded', 'refunded')).toBe('estornado')
    expect(mapearStatusOrder('charged_back', 'settled')).toBe('estornado')
    expect(mapearStatusOrder('charged_back', 'reimbursed')).toBe('estornado')
  })

  // Mesma regra de 'in_mediation' em mapearStatusMP: disputa ABERTA com o
  // dinheiro retido nao estorna comissao de uma briga que a Milagran pode
  // ganhar.
  it('contestacao em andamento segura, nao estorna', () => {
    expect(mapearStatusOrder('charged_back', 'in_process')).toBe('em_analise')
  })

  /**
   * O PIX QUE EXPIROU PRECISA DEIXAR O PEDIDO VENDAVEL.
   *
   * 'cancelado' seria o rotulo intuitivo e o errado: e um estado TERMINAL, e a
   * rota de pagamento so aceita pedido em 'pendente' ou 'aguardando_pagamento'.
   * A compradora que gerasse o QR a noite e voltasse no dia seguinte
   * encontraria a loja recusando o proprio pedido dela. 'recusado' devolve o
   * pedido a 'pendente', pronto para a proxima tentativa — e o teste logo
   * abaixo prova o caminho inteiro, nao so o rotulo.
   */
  it('Pix expirado e cobranca falha nao matam o pedido', () => {
    expect(mapearStatusOrder('expired', 'expired')).toBe('recusado')
    expect(mapearStatusOrder('failed', 'rejected_by_issuer')).toBe('recusado')
  })

  it('Pix expirado devolve o pedido para pendente, e nao para um beco sem saida', () => {
    const status = mapearStatusOrder('expired', 'expired')!
    expect(pedidoAposPagamento(status, 'aguardando_pagamento')).toBe('pendente')
  })

  // A Orders escreve 'canceled' com um L; /v1/payments escreve 'cancelled'
  // com dois. Os dois precisam cair no mesmo lugar.
  it('canceled e cancelled sao o mesmo estado', () => {
    expect(mapearStatusOrder('canceled', 'canceled')).toBe('cancelado')
    expect(mapearStatusOrder('cancelled', 'cancelled')).toBe('cancelado')
  })

  it('created e a order que ainda nao foi processada', () => {
    expect(mapearStatusOrder('created', 'created')).toBe('pendente')
  })

  /**
   * Estorno PARCIAL continua sendo venda paga. O ENUM nao tem "pago menos um
   * pedaco", e devolver 'estornado' reverteria a comissao INTEIRA de uma venda
   * desfeita pela metade. E o mesmo que `/v1/payments` ja faz: la um pagamento
   * parcialmente estornado permanece 'approved'.
   */
  it('estorno parcial continua sendo pedido pago', () => {
    expect(mapearStatusOrder('processed', 'partially_refunded')).toBe('aprovado')
  })

  // A rede embaixo de tudo: o que nao e reconhecido nao vira pedido pago por
  // engano. Vai para a fila de processado_em NULL.
  it('par desconhecido devolve null em vez de adivinhar', () => {
    expect(mapearStatusOrder('quantum_superposition', 'x')).toBeNull()
    expect(mapearStatusOrder('', '')).toBeNull()
    // 'approved' e do OUTRO vocabulario: nao pode ser aceito aqui por acidente.
    expect(mapearStatusOrder('approved', '')).toBeNull()
  })

  // E a reciproca: o vocabulario da Orders nao pode ser lido pela funcao de
  // /v1/payments. Se um dia alguem trocar a chamada de lugar, este teste cai.
  it('mapearStatusMP nao entende o vocabulario da Orders', () => {
    expect(mapearStatusMP('processed')).toBeNull()
    expect(mapearStatusMP('action_required')).toBeNull()
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

  // TODOS_OS_STATUS e escrito a mao e os dois testes acima varrem essa lista:
  // se um valor novo entrar no ENUM e ninguem lembrar de acrescentar aqui, as
  // varreduras passariam sem nunca ter olhado o estado novo. ROTULOS_STATUS e
  // Record<PedidoStatus, ...>, entao o COMPILADOR ja obriga a lista completa
  // la — comparar as chaves com esta lista traz essa garantia para dentro do
  // teste.
  it('a lista de status do teste cobre o ENUM inteiro', () => {
    expect([...TODOS_OS_STATUS].sort()).toEqual(Object.keys(ROTULOS_STATUS).sort())
  })
})

describe('caminho presencial e caminho da transportadora', () => {
  // MUDANCA DE REGRA DE 16/08/2026 (§2). Antes disso a transicao era proibida
  // de proposito. A venda presencial do evento e "comprou → pagou → levou na
  // hora": nao passa por separacao, nao passa pelos Correios, e o pedido tem
  // que poder ir de 'pago' direto a 'entregue' no mesmo minuto do webhook.
  // Se este teste comecar a falhar, a venda do balcao parou de fechar — nao
  // "conserte" removendo a aresta.
  it('pago -> entregue e permitido: a venda presencial nao passa pela expedicao', () => {
    expect(transicaoPermitida('pago', 'entregue')).toBe(true)
  })

  it('o caminho online completo continua valido passo a passo', () => {
    expect(transicaoPermitida('pago', 'em_preparacao')).toBe(true)
    expect(transicaoPermitida('em_preparacao', 'enviado')).toBe(true)
    expect(transicaoPermitida('enviado', 'em_transito')).toBe(true)
    expect(transicaoPermitida('em_transito', 'entregue')).toBe(true)
  })

  // Nem toda transportadora emite o evento intermediario. O pedido que chega
  // ao destino sem nenhum "em transito" registrado nao pode ficar preso em
  // 'enviado' por falta de aresta.
  it('enviado -> entregue segue valido sem passar por em_transito', () => {
    expect(transicaoPermitida('enviado', 'entregue')).toBe(true)
  })

  it('em_transito nao regride para enviado nem para em_preparacao', () => {
    expect(transicaoPermitida('em_transito', 'enviado')).toBe(false)
    expect(transicaoPermitida('em_transito', 'em_preparacao')).toBe(false)
  })

  // Mesma regra dos outros estados pagos: depois que o dinheiro entrou, o
  // caminho de desfazer e reembolso, nunca cancelamento.
  it('em_transito nao pode ser cancelado, so reembolsado', () => {
    expect(transicaoPermitida('em_transito', 'cancelado')).toBe(false)
    expect(transicaoPermitida('em_transito', 'reembolsado')).toBe(true)
  })

  it('em_preparacao nao pula direto para entregue: no online alguem tem que postar', () => {
    expect(transicaoPermitida('em_preparacao', 'entregue')).toBe(false)
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
    // Chargeback que chega com o objeto ainda na rua: o estado novo nao pode
    // ser um buraco por onde o estorno deixe de ser aplicado.
    expect(pedidoAposPagamento('estornado', 'em_transito')).toBe('reembolsado')
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

  // DINHEIRO: 'em_transito' e tao "pago" quanto 'enviado'. Deixar o estado
  // novo fora da lista de geraEstornoDeComissao nao quebraria nada de forma
  // visivel — so deixaria o credito de uma venda desfeita parado no saldo do
  // representante, dinheiro pago por venda que nao existe mais.
  it('DINHEIRO: estorno nasce tambem a partir de em_transito', () => {
    expect(geraEstornoDeComissao('em_transito', 'reembolsado')).toBe(true)
    expect(geraEstornoDeComissao('em_transito', 'cancelado')).toBe(true)
  })

  it('DINHEIRO: todo estado ja pago estorna ao ser reembolsado', () => {
    const jaPagos: readonly PedidoStatus[] = ['pago', 'em_preparacao', 'enviado', 'em_transito', 'entregue']
    for (const de of jaPagos) {
      expect(geraEstornoDeComissao(de, 'reembolsado')).toBe(true)
    }
  })

  // Pedido que nunca chegou a ser pago nao gerou credito nenhum — estornar
  // ali lancaria um debito sem contrapartida e deixaria o saldo negativo.
  it('cancelar pedido que nunca foi pago nao estorna nada', () => {
    expect(geraEstornoDeComissao('pendente', 'cancelado')).toBe(false)
    expect(geraEstornoDeComissao('aguardando_pagamento', 'cancelado')).toBe(false)
  })
})

describe('rotulos de status mostrados ao comprador', () => {
  it('todo status tem titulo e descricao preenchidos', () => {
    for (const s of TODOS_OS_STATUS) {
      expect(ROTULOS_STATUS[s].titulo.trim().length).toBeGreaterThan(0)
      expect(ROTULOS_STATUS[s].descricao.trim().length).toBeGreaterThan(0)
    }
  })

  // ROTULOS_STATUS substitui o mapa ROTULOS local de
  // src/app/pedido/[token]/page.tsx. Estes sao os textos que aquela pagina ja
  // mostrava, palavra por palavra: a mudanca e de LUGAR, nao de conteudo, e
  // este teste e o que impede que ela perca um rotulo no caminho.
  it('preserva os titulos que a pagina de acompanhamento ja mostrava', () => {
    expect(ROTULOS_STATUS.pendente.titulo).toBe('Aguardando pagamento')
    expect(ROTULOS_STATUS.aguardando_pagamento.titulo).toBe('Aguardando confirmação do pagamento')
    expect(ROTULOS_STATUS.pago.titulo).toBe('Pagamento confirmado')
    expect(ROTULOS_STATUS.em_preparacao.titulo).toBe('Em preparação')
    expect(ROTULOS_STATUS.enviado.titulo).toBe('Enviado')
    expect(ROTULOS_STATUS.entregue.titulo).toBe('Entregue')
    expect(ROTULOS_STATUS.cancelado.titulo).toBe('Cancelado')
    expect(ROTULOS_STATUS.reembolsado.titulo).toBe('Reembolsado')
  })

  it('o estado novo do rastreio tem rotulo proprio', () => {
    expect(ROTULOS_STATUS.em_transito.titulo).toBe('Em trânsito')
  })

  // Texto voltado ao comprador leva acentuacao completa — a convencao de
  // ASCII vale para identificador e comentario, nunca para o que a pessoa le.
  it('os textos do comprador vem acentuados', () => {
    expect(ROTULOS_STATUS.em_preparacao.titulo).toMatch(/ç/)
    expect(ROTULOS_STATUS.em_transito.titulo).toMatch(/â/)
    expect(ROTULOS_STATUS.pago.descricao).toMatch(/Você receberá/)
    expect(ROTULOS_STATUS.aguardando_pagamento.descricao).toMatch(/confirmação/)
  })

  // Dois estados com o mesmo titulo deixariam o comprador sem saber se o
  // pagamento foi so iniciado ou ja confirmado — e a operacao sem saber o que
  // ele esta vendo quando liga para perguntar.
  it('nenhum titulo se repete entre dois estados', () => {
    const titulos = TODOS_OS_STATUS.map((s) => ROTULOS_STATUS[s].titulo)
    expect(new Set(titulos).size).toBe(titulos.length)
  })

  // A frase de 'cancelado' afirma que nada foi cobrado. Isso so e verdade
  // porque 'pago' NAO transiciona para 'cancelado': um pedido so chega la
  // vindo de 'pendente' ou 'aguardando_pagamento'. Se alguem abrir essa
  // aresta, o texto vira mentira para quem ja pagou — os dois andam juntos.
  it('a descricao de cancelado so e verdadeira enquanto pago nao cancelar', () => {
    expect(ROTULOS_STATUS.cancelado.descricao).toMatch(/nenhum valor foi cobrado/)
    expect(transicaoPermitida('pago', 'cancelado')).toBe(false)
  })
})

/**
 * O EIXO DE ENTREGA sobre a maquina de estados (19/08/2026).
 *
 * A regra e SUBTRATIVA de proposito: retirada tira arestas, nunca acrescenta.
 * Um defeito aqui que ACRESCENTASSE uma transicao viraria pedido movido para um
 * estado que a maquina nao admite — por isso o primeiro teste e o que prova que
 * a funcao nunca e mais permissiva que transicaoPermitida.
 */
describe('transicaoPermitidaNaEntrega', () => {
  const TODOS = Object.keys(ROTULOS_STATUS) as PedidoStatus[]

  it('nunca permite mais que a maquina de estados', () => {
    for (const de of TODOS) {
      for (const para of TODOS) {
        for (const tipo of ['envio', 'retirada'] as const) {
          if (transicaoPermitidaNaEntrega(de, para, tipo)) {
            expect(transicaoPermitida(de, para)).toBe(true)
          }
        }
      }
    }
  })

  it('envio se comporta exatamente como antes', () => {
    for (const de of TODOS) {
      for (const para of TODOS) {
        expect(transicaoPermitidaNaEntrega(de, para, 'envio'))
          .toBe(transicaoPermitida(de, para))
      }
    }
  })

  // O DEFAULT importa: todo chamador anterior a esta funcao existir tratava de
  // pedidos de envio, e nenhum deles pode mudar de comportamento.
  it('sem tipo declarado, vale envio', () => {
    expect(transicaoPermitidaNaEntrega('pago', 'enviado')).toBe(true)
  })

  it('retirada nao passa por nenhum estado de postagem', () => {
    for (const postagem of EXIGE_POSTAGEM) {
      for (const de of TODOS) {
        expect(transicaoPermitidaNaEntrega(de, postagem, 'retirada')).toBe(false)
      }
    }
  })

  /**
   * O CAMINHO DA RETIRADA TEM QUE EXISTIR INTEIRO. Um filtro bem-intencionado
   * demais que tirasse 'entregue' junto deixaria todo pedido de retirada preso
   * em 'pago' para sempre, sem nenhum botao capaz de conclui-lo — e o teste
   * acima, sozinho, continuaria verde.
   */
  it('retirada chega a entregue direto de pago, e ainda pode ser reembolsada', () => {
    expect(transicaoPermitidaNaEntrega('pago', 'entregue', 'retirada')).toBe(true)
    expect(transicaoPermitidaNaEntrega('pago', 'reembolsado', 'retirada')).toBe(true)
    expect(transicaoPermitidaNaEntrega('entregue', 'reembolsado', 'retirada')).toBe(true)
  })

  it('cancelar antes do pagamento continua possivel na retirada', () => {
    expect(transicaoPermitidaNaEntrega('pendente', 'cancelado', 'retirada')).toBe(true)
    expect(transicaoPermitidaNaEntrega('aguardando_pagamento', 'cancelado', 'retirada')).toBe(true)
  })
})
