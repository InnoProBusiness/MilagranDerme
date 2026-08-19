import type { CanalVenda, PedidoStatus } from '@/lib/db-types'
import { ROTULOS_STATUS, type TipoEntrega } from '@/lib/pedido-status'
import { instrucaoDeRetirada } from '@/lib/retirada'
import { FUSO_BR } from '@/lib/tempo'

/**
 * A linha do tempo de §12 na tela de acompanhamento do comprador
 * (src/app/pedido/[token]/page.tsx).
 *
 * POR QUE UM ARQUIVO PROPRIO, e nao um trecho dentro daquela pagina: a pagina
 * e um Server Component assincrono que abre o banco na primeira linha, entao
 * nao ha como um teste de componente exercitar a REGRA DE ORDEM atraves dela.
 * E a regra de ordem e justamente a parte que pode errar em silencio — uma
 * etapa fora de lugar mostra ao comprador um caminho que a operacao nao vai
 * percorrer. Aqui ela e uma funcao pura (`etapasDoPedido`) com teste direto,
 * no mesmo espirito de diminuirQuantidade/aumentarQuantidade em
 * src/components/vitrine.tsx.
 *
 * ELA E UM CAMINHO, NAO UM LOG DE EVENTOS. Nao existe historico de status no
 * banco: `pedidos` guarda o status ATUAL e apenas dois carimbos reais
 * (`criado_em` e `enviado_em` — ver migrations/1755300100000_pedidos_canal_
 * logistica.sql). Entao o que esta tela mostra e por onde o pedido passa ate
 * chegar onde esta, e as unicas DATAS exibidas sao as duas que existem de
 * verdade. Nenhuma etapa ganha data inventada para a linha ficar bonita —
 * mesma regra de estado vazio honesto do resto do projeto.
 */

/**
 * O caminho da venda ONLINE: os sete estados de §12, na ordem em que o
 * comprador os vive.
 */
const SEQUENCIA_ONLINE: readonly PedidoStatus[] = [
  'pendente', 'aguardando_pagamento', 'pago', 'em_preparacao', 'enviado',
  'em_transito', 'entregue',
]

/**
 * O caminho da venda PRESENCIAL (§2: "comprou → pagou → levou na hora"). Ele
 * termina em 'entregue' logo depois de 'pago' porque nao ha separacao, nao ha
 * postagem e nao ha transportadora: o comprador sai do balcao com o kit na
 * mao. Mostrar "Em preparacao / Enviado / Em transito" apagados para quem ja
 * esta com o produto na sacola seria descrever uma espera que nao existe.
 *
 * A aresta 'pago' -> 'entregue' que este caminho pressupoe e a mesma aberta
 * deliberadamente em TRANSICOES (src/lib/pedido-status.ts) — as duas mudam
 * juntas ou a tela passa a prometer um passo que o banco recusa.
 */
const SEQUENCIA_ENTREGA_EM_MAOS: readonly PedidoStatus[] = [
  'pendente', 'aguardando_pagamento', 'pago', 'entregue',
]

/**
 * 'cancelado' e 'reembolsado' nao sao ETAPAS de caminho nenhum: eles
 * INTERROMPEM o caminho e sao terminais na maquina de estados. Aparecem como
 * ultimo item da lista, e o que viria depois deles some da tela — deixar
 * "Entregue" apagado embaixo de um pedido reembolsado descreveria um futuro
 * que nao vai acontecer.
 *
 * ATE ONDE O CAMINHO CERTAMENTE CHEGOU. Sem historico no banco, a unica coisa
 * que se pode afirmar vem da propria tabela TRANSICOES:
 *   - 'cancelado' so e alcancavel a partir de 'pendente' e
 *     'aguardando_pagamento' — logo, o pedido NAO foi pago (e por isso o
 *     rotulo diz "nenhum valor foi cobrado"). O corte fica em 'pendente', o
 *     unico dos dois pelo qual todo pedido passa;
 *   - 'reembolsado' so e alcancavel a partir de um estado pago — logo, o
 *     dinheiro entrou e voltou, e o corte fica em 'pago'.
 * O corte abaixo e essa afirmacao, e nada alem dela.
 */
const ULTIMA_ETAPA_CONFIRMADA: Record<'cancelado' | 'reembolsado', PedidoStatus> = {
  cancelado: 'pendente',
  reembolsado: 'pago',
}

export type EstadoDaEtapa = 'feito' | 'atual' | 'futuro' | 'interrompido'

export type EtapaDoPedido = {
  status: PedidoStatus
  estado: EstadoDaEtapa
}

function ehInterrupcao(status: PedidoStatus): status is 'cancelado' | 'reembolsado' {
  return status === 'cancelado' || status === 'reembolsado'
}

/**
 * Qual caminho desenhar.
 *
 * O EIXO E O TIPO DE ENTREGA, E NAO MAIS O CANAL (19/08/2026). Ate a retirada
 * no local existir, "nao ha postagem" e "foi vendido no balcao" eram a mesma
 * coisa, e recortar por `canal` acertava por coincidencia. Agora existe pedido
 * ONLINE sem postagem nenhuma — o de quem vem buscar o kit em Goiania — e
 * desenhar "Em preparação / Enviado / Em trânsito" apagados para essa pessoa
 * descreveria uma espera pelos Correios que nunca vai acontecer.
 *
 * Presencial continua caindo no caminho curto sem que nada aqui precise
 * mencionar canal: a constraint pedido_presencial_e_retirada
 * (migrations/1755600000000_pedido_tipo_entrega.sql) garante que toda venda de
 * balcao e 'retirada'.
 *
 * O TIPO PROPOE, O FATO DISPOE: se a operacao mover um pedido de retirada para
 * 'enviado' — hoje impossivel pela guarda de avancarStatusDoPedido e pela CHECK
 * pedido_retirada_sem_postagem, mas o principio vale para o dia em que alguem
 * as afrouxar —, a tela cai no caminho completo em vez de renderizar uma linha
 * do tempo sem o estado em que o pedido esta. Preferir o fato ao rotulo e a
 * mesma escolha que listarLogisticaAdmin faz ao recortar por endereco.
 */
function sequenciaDoPedido(
  tipoEntrega: TipoEntrega, status: PedidoStatus,
): readonly PedidoStatus[] {
  if (tipoEntrega !== 'retirada') return SEQUENCIA_ONLINE
  if (ehInterrupcao(status)) return SEQUENCIA_ENTREGA_EM_MAOS
  return SEQUENCIA_ENTREGA_EM_MAOS.includes(status) ? SEQUENCIA_ENTREGA_EM_MAOS : SEQUENCIA_ONLINE
}

/**
 * As etapas a desenhar, em ordem, com a posicao do pedido marcada.
 *
 * Pura de proposito (ver o cabecalho do arquivo): esta e a regra que decide o
 * que o comprador ve como "ja passou" e como "ainda vem".
 */
export function etapasDoPedido(
  canal: CanalVenda, tipoEntrega: TipoEntrega, status: PedidoStatus,
): EtapaDoPedido[] {
  const sequencia = sequenciaDoPedido(tipoEntrega, status)

  if (ehInterrupcao(status)) {
    const corte = sequencia.indexOf(ULTIMA_ETAPA_CONFIRMADA[status])
    const percorridas = sequencia
      .slice(0, corte + 1)
      .map((s): EtapaDoPedido => ({ status: s, estado: 'feito' }))
    return [...percorridas, { status, estado: 'interrompido' }]
  }

  const atual = sequencia.indexOf(status)
  return sequencia.map((s, i): EtapaDoPedido => ({
    status: s,
    estado: i < atual ? 'feito' : i === atual ? 'atual' : 'futuro',
  }))
}

/**
 * A UNICA sobrescrita de ROTULOS_STATUS deste projeto, e ela existe por um
 * motivo estreito: aquele mapa (src/lib/pedido-status.ts) e a fonte unica dos
 * textos de status para o painel, o balcao e esta tela, e ele NAO tem eixo de
 * canal. A descricao de 'pago' promete "avisaremos assim que o pedido for
 * enviado" — verdade no online, MENTIRA no balcao do evento, onde o comprador
 * ja saiu com o kit (§2). E exatamente o mesmo defeito que a copy do e-mail de
 * confirmacao tinha (src/lib/email-pedido.ts) e que foi corrigido no mesmo
 * commit; deixa-lo de pe aqui faria a tela e o e-mail discordarem sobre a
 * mesma compra.
 *
 * DUPLICAR O MAPA INTEIRO POR CANAL FOI RECUSADO: duas copias divergem na
 * primeira frase reescrita em uma delas. Uma excecao nomeada, com o motivo
 * escrito, e mais barata de manter do que nove rotulos em dobro. Se um dia a
 * lista abaixo passar de duas ou tres linhas, a conversa muda e o canal vira
 * dimensao de ROTULOS_STATUS.
 *
 * Texto voltado ao comprador: acentuacao completa.
 */
const DESCRICAO_PRESENCIAL: Partial<Record<PedidoStatus, string>> = {
  pago: 'Pagamento confirmado no balcão do evento. O kit é entregue na hora, em mãos — esta compra não passa pelos Correios.',
}

/**
 * A segunda sobrescrita, pelo mesmo motivo estreito da primeira: a descricao
 * de 'pago' em ROTULOS_STATUS promete "avisaremos assim que o pedido for
 * enviado", e nao ha envio nenhum a avisar para quem vai buscar o kit.
 *
 * SO 'pago', e a lista curta e deliberada. Os unicos estados que um pedido de
 * retirada alcanca sao pendente, aguardando_pagamento, pago, entregue,
 * cancelado e reembolsado (EXIGE_POSTAGEM, src/lib/pedido-status.ts, barra o
 * resto), e desses so o texto de 'pago' mentia. Escrever aqui uma frase para
 * 'em_preparacao' seria copy sem dono — texto que nenhum caminho renderiza,
 * esperando alguem acreditar que aquele estado existe.
 */
const DESCRICAO_RETIRADA: Partial<Record<PedidoStatus, string>> = {
  pago: `Pagamento confirmado. ${instrucaoDeRetirada()}`,
}

function descricaoDaEtapa(
  canal: CanalVenda, tipoEntrega: TipoEntrega, status: PedidoStatus,
): string {
  // PRESENCIAL PRIMEIRO, e a ordem importa: toda venda de balcao tambem e
  // 'retirada' (CHECK pedido_presencial_e_retirada), entao sem esta precedencia
  // quem comprou no evento — e ja saiu com o kit — leria um endereco e um prazo
  // de 7 dias para buscar o que ja esta na sacola dele.
  if (canal === 'presencial') {
    const propria = DESCRICAO_PRESENCIAL[status]
    if (propria) return propria
  } else if (tipoEntrega === 'retirada') {
    const propria = DESCRICAO_RETIRADA[status]
    if (propria) return propria
  }
  return ROTULOS_STATUS[status].descricao
}

// Data civil brasileira, sem hora: o comprador quer saber o DIA em que a
// coisa aconteceu. O fuso e explicito pelo mesmo motivo documentado em
// src/lib/tempo.ts — o container de producao roda em UTC, e sem timeZone um
// pedido feito as 22h de Sao Paulo apareceria com a data do dia seguinte.
const dataBR = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_BR,
  day: '2-digit', month: '2-digit', year: 'numeric',
})

/**
 * O carimbo de uma etapa, quando ele EXISTE de verdade no banco.
 *
 * Sao dois, e so dois: `criado_em` (quando o pedido nasceu, sempre presente) e
 * `enviado_em` (carimbado por avancarStatusDoPedido na entrada em 'enviado').
 * As demais etapas ficam sem data — nao ha de onde tirar uma, e uma data
 * aproximada aqui viraria discussao com o comprador sobre prazo.
 */
function carimboDaEtapa(
  status: PedidoStatus,
  criadoEm: Date | null,
  enviadoEm: Date | null,
): string | null {
  if (status === 'pendente' && criadoEm) return `Pedido feito em ${dataBR.format(criadoEm)}`
  if (status === 'enviado' && enviadoEm) return `Postado em ${dataBR.format(enviadoEm)}`
  return null
}

type LinhaDoTempoProps = {
  canal: CanalVenda
  tipoEntrega: TipoEntrega
  status: PedidoStatus
  criadoEm?: Date | null
  enviadoEm?: Date | null
}

export function LinhaDoTempoPedido({
  canal, tipoEntrega, status, criadoEm = null, enviadoEm = null,
}: LinhaDoTempoProps) {
  const etapas = etapasDoPedido(canal, tipoEntrega, status)

  return (
    // <ol> e nao <div>: e uma sequencia ordenada de verdade, e o leitor de
    // tela anuncia "lista com N itens" antes de ler o primeiro — a informacao
    // "quantos passos faltam" chega junto, sem texto extra.
    <ol className="linha-tempo" aria-label="Andamento do pedido" data-testid="linha-do-tempo">
      {etapas.map((etapa) => {
        // 'atual' e 'interrompido' sao o MESMO papel para quem le: e o ponto
        // onde a historia do pedido esta agora. Por isso os dois recebem
        // aria-current e a descricao.
        const aqui = etapa.estado === 'atual' || etapa.estado === 'interrompido'
        const quando = carimboDaEtapa(etapa.status, criadoEm, enviadoEm)

        return (
          <li
            key={etapa.status}
            className={`linha-tempo__item linha-tempo__item--${etapa.estado}`}
            aria-current={aqui ? 'step' : undefined}
          >
            {/* Bolinha decorativa: a posicao ja e dita pelo aria-current e
                pela ordem da lista, entao ela nao pode virar ruido no leitor
                de tela. */}
            <span className="linha-tempo__marcador" aria-hidden="true" />
            <p className="linha-tempo__titulo">{ROTULOS_STATUS[etapa.status].titulo}</p>
            {/* SO a etapa atual explica-se. As outras oito frases de
                ROTULOS_STATUS de uma vez viram uma parede de texto em que a
                unica que importa — a de agora — deixa de saltar aos olhos. */}
            {aqui && (
              <p className="linha-tempo__descricao">{descricaoDaEtapa(canal, tipoEntrega, etapa.status)}</p>
            )}
            {quando && <span className="linha-tempo__quando">{quando}</span>}
          </li>
        )
      })}
    </ol>
  )
}
