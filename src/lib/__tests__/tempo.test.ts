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
})
