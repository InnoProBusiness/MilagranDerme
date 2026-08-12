import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Tolerancia do carimbo de tempo da assinatura. Defesa em profundidade contra
 * replay — NAO e a protecao principal: quem realmente impede reprocessar uma
 * notificacao e o indice webhook_evento_unico
 * (migrations/1755200000000_pagamentos.sql), que descarta o mesmo
 * x-request-id na segunda vez.
 *
 * Dez minutos e generoso de proposito: relogio de servidor com desvio nao
 * pode virar pagamento perdido. Apertar isso troca uma protecao que ja existe
 * (o indice) por uma classe nova de falha silenciosa.
 */
export const JANELA_ASSINATURA_MS = 10 * 60 * 1000

export type EntradaAssinatura = {
  /** Header `x-signature`, no formato `ts=...,v1=...`. */
  assinatura: string | null
  /** Header `x-request-id`. */
  requestId: string | null
  /** `data.id` da query string da notificacao — o id do pagamento. */
  dataId: string | null
  segredo: string
  agora?: Date
}

/**
 * Verifica a assinatura HMAC que o Mercado Pago envia em `x-signature`.
 *
 * O manifesto assinado e `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`,
 * com os trechos ausentes simplesmente omitidos — e nao substituidos por
 * vazio. Montar `id:;request-id:abc;ts:1;` quando data.id falta produz um
 * manifesto diferente do que o Mercado Pago assinou, e toda notificacao sem
 * aquele campo seria recusada como forjada.
 *
 * Sem assinatura valida o webhook nao age. E o unico portao: a rota nao tem
 * autenticacao, esta exposta na internet publica, e o que ela faz e marcar
 * pedido como pago e creditar comissao. Um POST forjado sem esta checagem
 * pagaria pedidos de graca.
 */
export function verificarAssinaturaMP(e: EntradaAssinatura): boolean {
  if (!e.assinatura || !e.segredo) return false

  const { ts, v1 } = separarAssinatura(e.assinatura)
  if (!ts || !v1) return false

  if (!carimboEstaNaJanela(ts, e.agora ?? new Date())) return false

  const partes: string[] = []
  // O Mercado Pago normaliza id alfanumerico para minusculo antes de assinar.
  if (e.dataId) partes.push(`id:${e.dataId.toLowerCase()};`)
  if (e.requestId) partes.push(`request-id:${e.requestId};`)
  partes.push(`ts:${ts};`)

  const esperado = createHmac('sha256', e.segredo).update(partes.join('')).digest('hex')

  return comparaConstante(esperado, v1)
}

function separarAssinatura(cabecalho: string): { ts: string | null; v1: string | null } {
  let ts: string | null = null
  let v1: string | null = null

  for (const pedaco of cabecalho.split(',')) {
    const igual = pedaco.indexOf('=')
    if (igual < 0) continue
    const chave = pedaco.slice(0, igual).trim()
    const valor = pedaco.slice(igual + 1).trim()
    if (chave === 'ts') ts = valor
    else if (chave === 'v1') v1 = valor
  }

  return { ts, v1 }
}

function carimboEstaNaJanela(ts: string, agora: Date): boolean {
  const bruto = Number(ts)
  if (!Number.isFinite(bruto) || bruto <= 0) return false

  // O Mercado Pago ja enviou este carimbo em segundos e em milissegundos ao
  // longo do tempo. Normalizar pela ordem de grandeza evita que uma mudanca
  // no formato derrube todo pagamento — o corte em 1e12 separa
  // "segundos ate o ano 33658" de "milissegundos desde 2001".
  const ms = bruto < 1e12 ? bruto * 1000 : bruto

  return Math.abs(agora.getTime() - ms) <= JANELA_ASSINATURA_MS
}

/**
 * Compara em tempo constante. O teste de comprimento vem ANTES porque
 * timingSafeEqual lanca com buffers de tamanhos diferentes — mesmo cuidado
 * de src/lib/atribuicao.ts.
 */
function comparaConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
