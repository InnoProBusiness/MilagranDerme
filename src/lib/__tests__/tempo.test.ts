import { describe, it, expect } from 'vitest'
import { inicioDoMesBR, fimDoMesBR, inicioDoDiaBR, mesmoMesBR } from '@/lib/tempo'

describe('limites de mes em America/Sao_Paulo', () => {
  it('venda as 21h30 BRT do dia 31 pertence ao mes que terminou', () => {
    // 31/08/2026 21:30 BRT = 01/09/2026 00:30 UTC
    const venda = new Date('2026-09-01T00:30:00Z')
    const agostoBR = new Date('2026-08-15T12:00:00Z')
    expect(mesmoMesBR(venda, agostoBR)).toBe(true)
  })

  it('venda as 22h30 BRT do dia 31 ainda pertence a agosto', () => {
    const venda = new Date('2026-09-01T01:30:00Z')
    const agostoBR = new Date('2026-08-15T12:00:00Z')
    expect(mesmoMesBR(venda, agostoBR)).toBe(true)
  })

  it('primeiro instante de setembro em BRT nao pertence a agosto', () => {
    // 01/09/2026 00:00 BRT = 01/09/2026 03:00 UTC
    const venda = new Date('2026-09-01T03:00:00Z')
    const agostoBR = new Date('2026-08-15T12:00:00Z')
    expect(mesmoMesBR(venda, agostoBR)).toBe(false)
  })

  it('inicio do mes e a meia-noite BRT do dia 1, expressa em UTC', () => {
    const r = inicioDoMesBR(new Date('2026-08-15T12:00:00Z'))
    expect(r.toISOString()).toBe('2026-08-01T03:00:00.000Z')
  })

  it('fim do mes e o instante imediatamente anterior ao inicio do proximo', () => {
    const r = fimDoMesBR(new Date('2026-08-15T12:00:00Z'))
    expect(r.toISOString()).toBe('2026-09-01T02:59:59.999Z')
  })

  it('inicio do dia e a meia-noite BRT, expressa em UTC', () => {
    const r = inicioDoDiaBR(new Date('2026-08-11T23:00:00Z'))
    // 11/08 23:00 UTC = 11/08 20:00 BRT, entao o dia BR e 11/08
    expect(r.toISOString()).toBe('2026-08-11T03:00:00.000Z')
  })

  it('DST gap day: 2014-10-19 00:00 BRT nao existe, resolve para primeiro instante valido', () => {
    // 2014-10-19 00:00 BRT nao existe; clocks saltaram de 23:59:59 BRT para 01:00:00 BRST
    // Resolucao para frente: 2014-10-19 01:00 BRST = 2014-10-19 03:00 UTC
    // Usar 2014-10-19T12:00:00Z que civiliza para Oct 19 10:00 BRST
    const r = inicioDoDiaBR(new Date('2014-10-19T12:00:00Z'))
    expect(r.toISOString()).toBe('2014-10-19T03:00:00.000Z')
  })

  it('mesmoMesBR: mesmo mes mas anos diferentes deve retornar false', () => {
    const agosto2025 = new Date('2025-08-15T12:00:00Z')
    const agosto2026 = new Date('2026-08-15T12:00:00Z')
    expect(mesmoMesBR(agosto2025, agosto2026)).toBe(false)
  })

  it('fimDoMesBR em dezembro salta para janeiro do proximo ano', () => {
    const r = fimDoMesBR(new Date('2026-12-15T12:00:00Z'))
    // Fim de dezembro 2026 = 31/12/2026 23:59:59.999 BRT = 2027-01-01 02:59:59.999 UTC
    expect(r.toISOString()).toBe('2027-01-01T02:59:59.999Z')
  })

  it('inicioDoMesBR em janeiro retorna janeiro do mesmo ano', () => {
    const r = inicioDoMesBR(new Date('2027-01-15T12:00:00Z'))
    // Inicio de janeiro 2027 = 01/01/2027 00:00 BRT = 2027-01-01 03:00 UTC
    expect(r.toISOString()).toBe('2027-01-01T03:00:00.000Z')
  })
})
