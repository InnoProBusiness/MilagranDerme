import { ROTULOS_STATUS } from '@/lib/pedido-status'
import { FUSO_BR } from '@/lib/tempo'
import type { CanalVenda, MetodoPagamento, PedidoStatus } from '@/repositories/pedidos'

/**
 * O vocabulario visual compartilhado pelas cinco telas de §17: data, etiqueta
 * de status, etiqueta de canal e nome da forma de pagamento.
 *
 * MORA AQUI, e nao em src/components/, porque nada disto e usado fora do
 * painel — e porque as quatro coisas sao a MESMA decisao repetida: como esta
 * aplicacao escreve na tela um valor que veio do banco. Espalhado por cinco
 * `page.tsx`, o primeiro `new Intl.DateTimeFormat` sem `timeZone` faria uma
 * tela mostrar a data em UTC e a de baixo em Sao Paulo, para o mesmo pedido.
 *
 * SEM 'use client': sao funcoes puras e componentes sem estado. Render de
 * servidor, como todo o resto do painel.
 */

/**
 * Data e hora civis brasileiras. O FUSO E EXPLICITO pelo mesmo motivo
 * documentado em src/lib/tempo.ts e em src/components/linha-do-tempo-pedido.tsx:
 * o container de producao roda em UTC, e sem `timeZone` uma venda das 22h do
 * dia 25 apareceria no painel como dia 26 — no relatorio do evento isso e uma
 * venda contada no dia errado.
 *
 * COM HORA, ao contrario da tela do comprador (que mostra so o dia): no painel
 * a pergunta e "o que acabou de entrar", e duas vendas do mesmo dia precisam
 * ser distinguiveis na coluna de data.
 */
const dataHoraFormatador = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_BR,
  day: '2-digit', month: '2-digit', year: '2-digit',
  hour: '2-digit', minute: '2-digit',
})

export function dataHoraBR(data: Date): string {
  return dataHoraFormatador.format(data)
}

const dataFormatador = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_BR,
  day: '2-digit', month: '2-digit', year: 'numeric',
})

export function dataBR(data: Date): string {
  return dataFormatador.format(data)
}

/**
 * O TRAVESSAO E O "NAO EXISTE" DO PAINEL INTEIRO.
 *
 * Toda coluna que pode vir nula (cliente sem cadastro, pedido sem pagamento,
 * endereco sem complemento, pedido sem rastreio) escreve isto. NUNCA um zero,
 * NUNCA uma string vazia que some no meio da tabela e nunca um valor plausivel
 * inventado para a celula nao ficar feia: "R$ 0,00" na coluna de frete de um
 * pedido que ainda nao foi cotado e uma informacao falsa, e quem le a tabela
 * nao tem como saber disso. E o mesmo principio de
 * src/components/linha-frete.tsx e do `disponivel: null` do canal ilimitado.
 */
export const AUSENTE = '—'

/** Texto quando o valor pode ser nulo ou vazio. Vazio e ausencia, nao dado. */
export function ouAusente(valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return AUSENTE
  const limpo = valor.trim()
  return limpo === '' ? AUSENTE : limpo
}

/**
 * Etiqueta de status do pedido.
 *
 * O TEXTO SAI DE ROTULOS_STATUS (src/lib/pedido-status.ts), a mesma constante
 * que a tela do comprador usa. E de proposito que o painel repita palavra por
 * palavra o que o comprador esta lendo: quem atende o telefone precisa ver na
 * tela exatamente a frase que a pessoa do outro lado esta citando. Um segundo
 * dicionario de status "mais curto para caber na tabela" divergiria do
 * primeiro na primeira reescrita, e a operacao passaria a falar uma lingua que
 * o site nao fala.
 *
 * A classe usa o valor CRU do ENUM (`etiqueta--em_transito`), sem mapa
 * intermediario — o CSS de globals.css foi escrito assim de proposito e o
 * comentario de la explica o preco: renomear um valor do ENUM obriga a
 * renomear a regra CSS.
 */
export function EtiquetaStatus({ status }: { status: PedidoStatus }) {
  return (
    <span className={`etiqueta etiqueta--${status}`}>
      {ROTULOS_STATUS[status].titulo}
    </span>
  )
}

/**
 * ORIGEM DA VENDA (§17): presencial ou online.
 *
 * Record<CanalVenda, string> e nao um `if canal === 'presencial'`: um terceiro
 * valor no ENUM canal_venda (marketplace, revenda) quebra a compilacao aqui em
 * vez de renderizar `undefined` na coluna de origem do relatorio.
 *
 * NAO E `pedidos.origem`. Aquela coluna parece isto e nao e — ela e atribuicao
 * de comissao, amarrada a presenca de representante pelo CHECK
 * pedido_origem_coerente. O canal e um eixo proprio, criado justamente porque
 * misturar os dois quebraria a comissao
 * (migrations/1755300100000_pedidos_canal_logistica.sql).
 */
export const ROTULOS_CANAL: Record<CanalVenda, string> = {
  presencial: 'Presencial',
  online: 'Online',
}

export function EtiquetaCanal({ canal }: { canal: CanalVenda }) {
  return <span className={`etiqueta etiqueta--${canal}`}>{ROTULOS_CANAL[canal]}</span>
}

/**
 * Forma de pagamento. Record pelo mesmo motivo do canal: o dia em que
 * `metodo_pagamento` ganhar 'boleto', esta linha para de compilar em vez de a
 * tabela do painel mostrar celula vazia numa coluna de dinheiro.
 */
const ROTULO_METODO: Record<MetodoPagamento, string> = {
  pix: 'Pix',
  cartao: 'Cartão',
}

/** `null` = nenhum pagamento registrado ainda. Ausencia, nunca "R$ 0,00". */
export function rotuloDoMetodo(metodo: MetodoPagamento | null): string {
  return metodo === null ? AUSENTE : ROTULO_METODO[metodo]
}
