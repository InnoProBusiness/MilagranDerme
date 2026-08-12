import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verificarAssinaturaMP, JANELA_ASSINATURA_MS } from '@/lib/webhook-mp'

const SEGREDO = 'segredo-de-webhook-do-mercado-pago-para-teste'
const AGORA = new Date('2026-08-12T15:00:00Z')
const TS = String(Math.floor(AGORA.getTime() / 1000))
const DATA_ID = '1234567890'
const REQUEST_ID = 'abc-123-def'

function assinar(manifesto: string, segredo = SEGREDO): string {
  return createHmac('sha256', segredo).update(manifesto).digest('hex')
}

function cabecalhoValido(ts = TS): string {
  const v1 = assinar(`id:${DATA_ID};request-id:${REQUEST_ID};ts:${ts};`)
  return `ts=${ts},v1=${v1}`
}

const base = {
  requestId: REQUEST_ID,
  dataId: DATA_ID,
  segredo: SEGREDO,
  agora: AGORA,
}

describe('assinatura do webhook do Mercado Pago', () => {
  it('aceita assinatura valida', () => {
    expect(verificarAssinaturaMP({ ...base, assinatura: cabecalhoValido() })).toBe(true)
  })

  // O ataque que esta funcao existe para impedir: um POST forjado marcaria
  // pedido como pago e creditaria comissao, sem nenhuma outra barreira.
  it('recusa assinatura de outro segredo', () => {
    const v1 = assinar(`id:${DATA_ID};request-id:${REQUEST_ID};ts:${TS};`, 'segredo-errado-mas-do-mesmo-tamanho!!')
    expect(verificarAssinaturaMP({ ...base, assinatura: `ts=${TS},v1=${v1}` })).toBe(false)
  })

  it('recusa quando nao ha cabecalho de assinatura', () => {
    expect(verificarAssinaturaMP({ ...base, assinatura: null })).toBe(false)
  })

  it('recusa cabecalho sem v1', () => {
    expect(verificarAssinaturaMP({ ...base, assinatura: `ts=${TS}` })).toBe(false)
  })

  // Trocar o id do pagamento invalida a assinatura: sem isso, uma notificacao
  // legitima de um pagamento de R$ 1 poderia ser reapontada para outro pedido.
  it('recusa quando o data.id nao e o que foi assinado', () => {
    expect(verificarAssinaturaMP({
      ...base, dataId: '9999999999', assinatura: cabecalhoValido(),
    })).toBe(false)
  })

  it('recusa quando o request-id nao e o que foi assinado', () => {
    expect(verificarAssinaturaMP({
      ...base, requestId: 'outro-request-id', assinatura: cabecalhoValido(),
    })).toBe(false)
  })

  // O manifesto omite trechos ausentes em vez de assinar "id:;". Se o codigo
  // montasse o campo vazio, toda notificacao sem data.id seria recusada.
  it('assina corretamente quando falta o data.id', () => {
    const v1 = assinar(`request-id:${REQUEST_ID};ts:${TS};`)
    expect(verificarAssinaturaMP({
      ...base, dataId: null, assinatura: `ts=${TS},v1=${v1}`,
    })).toBe(true)
  })

  it('normaliza data.id alfanumerico para minusculo antes de conferir', () => {
    const v1 = assinar(`id:abc123;request-id:${REQUEST_ID};ts:${TS};`)
    expect(verificarAssinaturaMP({
      ...base, dataId: 'ABC123', assinatura: `ts=${TS},v1=${v1}`,
    })).toBe(true)
  })

  it('recusa carimbo fora da janela de tolerancia', () => {
    const velho = String(Math.floor((AGORA.getTime() - JANELA_ASSINATURA_MS - 1000) / 1000))
    expect(verificarAssinaturaMP({ ...base, assinatura: cabecalhoValido(velho) })).toBe(false)
  })

  it('aceita carimbo em milissegundos, nao so em segundos', () => {
    const ms = String(AGORA.getTime())
    expect(verificarAssinaturaMP({ ...base, assinatura: cabecalhoValido(ms) })).toBe(true)
  })

  // timingSafeEqual lanca com buffers de tamanhos diferentes. Um v1 curto
  // nao pode virar 500 na rota — tem que ser recusa limpa.
  it('recusa v1 de tamanho diferente sem lancar', () => {
    expect(verificarAssinaturaMP({ ...base, assinatura: `ts=${TS},v1=abc` })).toBe(false)
  })

  it('recusa quando o segredo esta vazio', () => {
    expect(verificarAssinaturaMP({ ...base, segredo: '', assinatura: cabecalhoValido() })).toBe(false)
  })
})
