import type { PedidoStatus, PagamentoStatus, PedidoTipoEntrega as TipoEntrega } from '@/lib/db-types'

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
 * Traduz o status de uma ORDER (`/v1/orders`) para o mesmo ENUM
 * pagamento_status.
 *
 * NAO ESTA EM USO HOJE, e isso e deliberado: ela acompanha `criarOrderPixMP`
 * (src/lib/mercadopago.ts), que e a saida de emergencia do Pix e nao o caminho
 * atual. As condicoes para liga-la estao escritas la, e ligar uma sem a outra
 * quebra a conciliacao — por isso as duas se citam.
 *
 * A SEGUNDA FUNCAO EXISTE PORQUE HA UM SEGUNDO VOCABULARIO, e nao porque ha um
 * segundo gateway. A Orders API NAO fala as mesmas palavras de `/v1/payments`:
 * onde o pagamento diz `approved`, a order diz `processed` + `accredited`; onde
 * diz `pending`, a order diz `action_required` + `waiting_transfer`.
 * Reaproveitar `mapearStatusMP` devolveria null para TODOS eles — inclusive
 * para a aprovacao — e o pedido pago nunca sairia de `aguardando_pagamento`.
 *
 * PRECISA DOS DOIS CAMPOS. Ao contrario de `/v1/payments`, aqui o `status`
 * sozinho e ambiguo: `action_required` tanto significa "a compradora ainda nao
 * pagou o Pix" quanto "o cartao foi autorizado e falta capturar" — estados com
 * efeitos opostos sobre a comissao. Quem separa e o `status_detail`.
 *
 * A REGRA DE DEVOLVER null PARA O DESCONHECIDO e a mesma de `mapearStatusMP`, e
 * pelo mesmo motivo: o webhook grava o evento, responde 200 (senao o Mercado
 * Pago reenvia em laco) e deixa `processado_em` NULL — a fila do que chegou e
 * ninguem tratou.
 *
 * Vocabulario conferido na documentacao oficial da Orders API (paginas "Status
 * da order" e "Status da transacao"). O par `action_required`/`waiting_transfer`
 * foi observado em producao na criacao de um Pix real; os demais vieram da
 * documentacao. O QUE ISSO SIGNIFICA NA PRATICA: se um par desconhecido
 * aparecer, ele cai em null e vira linha na fila — nao vira pedido pago por
 * engano nem comissao creditada por engano.
 */
export function mapearStatusOrder(status: string, statusDetail: string): PagamentoStatus | null {
  switch (status) {
    // 'processed' e o unico estado em que o dinheiro entrou. Vale tambem com
    // status_detail 'partially_refunded': a venda aconteceu e o pedido esta
    // pago: quem devolveu parte do valor foi a Milagran, depois. E exatamente
    // o que `/v1/payments` ja fazia — la um pagamento parcialmente estornado
    // continua com status 'approved', e o estorno parcial e um recurso a
    // parte. O ENUM nao tem estado para "pago menos um pedaco", e inventar um
    // aqui reverteria a comissao inteira de uma venda que so foi desfeita pela
    // metade.
    case 'processed':
      return 'aprovado'

    // A order nasceu e ainda nao foi processada.
    case 'created':
      return 'pendente'

    // Falta alguem agir. QUEM age muda tudo:
    //   waiting_capture -> nos. O cartao esta AUTORIZADO e nao capturado: e
    //     limite reservado, nao dinheiro nosso. Mesmo tratamento que
    //     'authorized' recebe em mapearStatusMP, e pelo mesmo motivo —
    //     creditar comissao aqui paga o representante por uma venda que pode
    //     nunca liquidar.
    //   waiting_transfer / waiting_payment / waiting_retry / pending_challenge
    //     -> a compradora. E o estado normal de um Pix recem-criado: o QR
    //     esta na tela dela e o dinheiro ainda nao saiu.
    case 'action_required':
      return statusDetail === 'waiting_capture' ? 'em_analise' : 'pendente'

    // Analise de risco, revisao manual, processamento assincrono. Segura o
    // saldo sem decidir nada.
    case 'processing':
    case 'in_review':
      return 'em_analise'

    // Contestacao. 'in_process' e a disputa ABERTA, com o dinheiro ainda
    // retido — segurar aqui evita estornar a comissao de uma disputa que a
    // Milagran vai ganhar, exatamente como 'in_mediation' em mapearStatusMP.
    // 'settled' e 'reimbursed' sao o desfecho com o valor de volta na mao da
    // compradora, e ai o credito tem que ser revertido.
    case 'charged_back':
      return statusDetail === 'in_process' ? 'em_analise' : 'estornado'

    case 'refunded':
      return 'estornado'

    // A Orders API escreve com um L so; `/v1/payments` escreve com dois. Os
    // dois entram porque errar a grafia aqui deixaria uma order cancelada
    // caindo em null para sempre, e ninguem descobriria olhando o codigo.
    case 'canceled':
    case 'cancelled':
      return 'cancelado'

    // A COBRANCA MORREU SEM PAGAMENTO — e o pedido precisa continuar
    // VENDAVEL.
    //
    // 'recusado' e nao 'cancelado', e a escolha e deliberada: 'cancelado'
    // leva o pedido a um estado TERMINAL (ver TRANSICOES abaixo: nao ha
    // aresta saindo de 'cancelado'), e a rota de pagamento so aceita pedido
    // em 'pendente' ou 'aguardando_pagamento'. Um Pix que expirou de
    // madrugada cancelaria o pedido, e a compradora que voltasse no dia
    // seguinte para pagar encontraria a loja recusando o proprio pedido dela,
    // sem saida nenhuma. 'recusado' devolve o pedido para 'pendente' — pronto
    // para a proxima tentativa, que e o que 'recusado' ja faz com cartao
    // negado.
    case 'expired':
    case 'failed':
      return 'recusado'

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
  //
  // MUDANCA DELIBERADA DE REGRA (16/08/2026). Ate aqui esta lista era
  // ['em_preparacao', 'enviado', 'reembolsado'] e 'pago' -> 'entregue' era
  // PROIBIDO de proposito: no fluxo online, um pedido que pulasse de pago a
  // entregue sem passar por 'enviado' seria quase sempre um clique errado no
  // painel, e a proibicao pegava esse erro.
  //
  // O documento do cliente de 16/08/2026 (§2) criou um segundo fluxo em que o
  // pulo e o caminho CERTO: na venda presencial do evento e "comprou → pagou →
  // levou na hora". Nao ha separacao, nao ha postagem, nao ha transportadora —
  // o comprador sai do balcao com o kit na mao, e o pedido tem que registrar
  // isso no mesmo minuto em que o webhook confirma o pagamento. Sem esta
  // aresta, a operacao do evento teria que mentir passando por 'enviado' para
  // conseguir marcar 'entregue', e o relatorio de logistica passaria a contar
  // como postados kits que nunca viram os Correios.
  //
  // O que a mudanca CUSTA: o painel online perde aquela rede de protecao
  // contra o clique errado. Quem quiser recupera-la tem que faze-lo olhando
  // pedidos.canal (migrations/1755300100000_pedidos_canal_logistica.sql), e
  // nao removendo a aresta daqui — remover quebra a venda presencial inteira.
  pago: ['em_preparacao', 'enviado', 'entregue', 'reembolsado'],
  em_preparacao: ['enviado', 'reembolsado'],
  // 'enviado' -> 'entregue' continua direto, alem do caminho por
  // 'em_transito': nem toda transportadora emite o evento intermediario, e o
  // pedido que chega ao destino sem ele nao pode ficar preso em 'enviado'.
  enviado: ['em_transito', 'entregue', 'reembolsado'],
  // Nao ha volta de 'em_transito' para 'enviado'. O rastreio pode oscilar
  // (objeto que retorna a um centro de distribuicao continua em transito), e
  // regredir o status por causa disso trocaria a tela do comprador para tras
  // sem que nada de real tenha acontecido.
  em_transito: ['entregue', 'reembolsado'],
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
 *
 * 'em_transito' entrou na lista junto com o valor novo do ENUM
 * (migrations/1755300200000_status_em_transito.sql): ele e um estado tao pago
 * quanto 'enviado', e um chargeback que chegue com o objeto na rua tem que
 * estornar a comissao igual. Esquecer um estado aqui nao quebra nada de forma
 * visivel — so deixa credito de venda desfeita parado no saldo do
 * representante, que e dinheiro pago por venda que nao existe.
 */
export function geraEstornoDeComissao(de: PedidoStatus, para: PedidoStatus): boolean {
  const estavaPago = de === 'pago' || de === 'em_preparacao' || de === 'enviado'
    || de === 'em_transito' || de === 'entregue'
  return estavaPago && (para === 'reembolsado' || para === 'cancelado')
}

/**
 * O que a tela de acompanhamento do comprador diz sobre cada status.
 *
 * FONTE UNICA, pelo mesmo motivo de src/components/linha-frete.tsx: estes
 * textos vinham de um mapa `ROTULOS` local dentro de
 * src/app/pedido/[token]/page.tsx, e a partir de agora as telas de admin (§17)
 * e o balcao do evento (§10) mostram os mesmos estados. Tres copias do mapa
 * divergem na primeira vez que alguem reescrever uma frase em uma delas, e o
 * comprador que ligar para a Milagran ouviria da operacao uma descricao
 * diferente da que esta lendo na propria tela.
 *
 * As `descricao` absorveram tambem os dois blocos `confirmacao__aviso` que a
 * pagina escrevia na mao para 'pago' e 'reembolsado' — os textos estao aqui
 * palavra por palavra para que a migracao daquela pagina nao perca nada.
 *
 * Os sete primeiros sao os estados de §12; 'cancelado' e 'reembolsado'
 * completam o ENUM. O tipo Record<PedidoStatus, ...> e o que garante a
 * cobertura: um valor novo no ENUM pedido_status quebra o build aqui em vez de
 * renderizar `undefined` na tela do comprador.
 *
 * Texto voltado ao comprador: acentuacao completa.
 */
export const ROTULOS_STATUS: Record<PedidoStatus, { titulo: string; descricao: string }> = {
  pendente: {
    titulo: 'Aguardando pagamento',
    descricao: 'Recebemos o seu pedido. Finalize o pagamento para garantir o seu kit.',
  },
  aguardando_pagamento: {
    titulo: 'Aguardando confirmação do pagamento',
    descricao: 'O pagamento foi iniciado e estamos aguardando a confirmação do provedor. No Pix isso costuma levar poucos minutos.',
  },
  pago: {
    titulo: 'Pagamento confirmado',
    descricao: 'Pagamento confirmado. Você receberá um e-mail com os detalhes e avisaremos assim que o pedido for enviado.',
  },
  em_preparacao: {
    titulo: 'Em preparação',
    descricao: 'Seu kit está sendo separado e embalado para o envio.',
  },
  enviado: {
    titulo: 'Enviado',
    descricao: 'Seu pedido foi postado e já saiu da nossa expedição.',
  },
  em_transito: {
    titulo: 'Em trânsito',
    descricao: 'Seu pedido está a caminho do endereço informado. Acompanhe pelo código de rastreio.',
  },
  entregue: {
    titulo: 'Entregue',
    descricao: 'Seu pedido foi entregue. Obrigado por comprar com a Milagran!',
  },
  cancelado: {
    // "nenhum valor foi cobrado" so e verdade por causa da tabela TRANSICOES
    // acima: 'pago' NAO vai para 'cancelado', e um pedido so chega a
    // 'cancelado' vindo de 'pendente' ou 'aguardando_pagamento'. Se algum dia
    // alguem abrir essa aresta, esta frase vira mentira para quem ja pagou —
    // trocar as duas coisas no mesmo commit.
    titulo: 'Cancelado',
    descricao: 'Este pedido foi cancelado e nenhum valor foi cobrado.',
  },
  reembolsado: {
    titulo: 'Reembolsado',
    descricao: 'Este pedido foi reembolsado. O valor volta para a mesma forma de pagamento usada na compra, no prazo do seu banco.',
  },
}

/**
 * COMO O KIT CHEGA A QUEM COMPROU — o terceiro eixo do pedido, ao lado de
 * `origem` (atribuicao de comissao) e `canal` (onde a venda aconteceu).
 *
 * 'envio'    = sai daqui por transportadora, para um endereco.
 * 'retirada' = e entregue em maos, sem transportadora e sem frete.
 *
 * O tipo vem do banco (migrations/1755600000000_pedido_tipo_entrega.sql) e e
 * reexportado daqui porque este modulo e quem decide o que cada tipo pode
 * fazer. Ver EXIGE_POSTAGEM logo abaixo.
 */
export type { PedidoTipoEntrega as TipoEntrega } from '@/lib/db-types'

/**
 * Os status que so existem porque houve POSTAGEM.
 *
 * Um pedido de retirada nunca passa por nenhum deles: nao ha separacao para
 * despacho, nao ha objeto postado e nao ha nada em transito — o kit fica na
 * prateleira ate a compradora aparecer. O caminho dela e
 * pago -> entregue, exatamente o mesmo da venda de balcao, que ja e permitido
 * em TRANSICOES desde 16/08/2026.
 *
 * NAO HOUVE STATUS NOVO, e a decisao foi consciente. Um 'aguardando_retirada'
 * no ENUM exigiria ALTER TYPE ADD VALUE — que no Postgres nao pode ser usado na
 * mesma migration que o cria, forcando dois deploys encadeados — e quebraria a
 * compilacao de ROTULOS_STATUS, TRANSICOES e de cada `switch` exaustivo sobre
 * PedidoStatus, tudo isso a seis dias do lancamento. O que a operacao precisa
 * enxergar ("quem vem buscar, e ate quando") nao e um estado do pedido: e um
 * RECORTE de `pago` por tipo de entrega, e a tela de logistica faz esse recorte
 * sem que o ENUM precise saber da existencia da retirada.
 *
 * 'em_preparacao' esta na lista por um motivo ADICIONAL ao de nao haver
 * postagem: ele e BECO SEM SAIDA para a retirada. TRANSICOES.em_preparacao e
 * ['enviado', 'reembolsado'] — de la so se sai postando. Um pedido de retirada
 * que entrasse nesse status ficaria impossivel de concluir sem mentir.
 */
export const EXIGE_POSTAGEM: readonly PedidoStatus[] = [
  'em_preparacao', 'enviado', 'em_transito',
]

/**
 * A transicao e permitida PARA ESTE TIPO DE ENTREGA?
 *
 * Envolve transicaoPermitida em vez de substitui-la: a maquina de estados
 * continua sendo uma so, e este eixo apenas SUBTRAI arestas. Nenhuma transicao
 * passa a ser possivel por causa da retirada — o que seria a forma de um bug
 * aqui virar dinheiro perdido.
 *
 * O DEFAULT 'envio' e deliberado e faz todo chamador antigo continuar exato:
 * antes desta funcao existir, todo pedido era de envio.
 */
export function transicaoPermitidaNaEntrega(
  de: PedidoStatus,
  para: PedidoStatus,
  tipoEntrega: TipoEntrega = 'envio',
): boolean {
  if (!transicaoPermitida(de, para)) return false
  return tipoEntrega === 'envio' || !EXIGE_POSTAGEM.includes(para)
}
