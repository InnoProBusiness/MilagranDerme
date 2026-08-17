import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  inicioDoMesBR, fimDoMesBR, inicioDoDiaBR, mesmoMesBR,
  DATA_LANCAMENTO, lancamentoJaOcorreu, AVISO_PRE_VENDA,
} from '@/lib/tempo'

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

describe('janela de lancamento de 25/08/2026', () => {
  // NENHUM teste deste bloco pode depender do relogio do runner. O CI roda
  // hoje (antes do evento) e vai continuar rodando depois dele: um teste que
  // consultasse a data real ficaria verde por motivo errado a partir de 25/08 e
  // pararia de provar qualquer coisa exatamente quando a regra passasse a
  // valer. Por isso ou passamos o instante como argumento, ou congelamos com
  // vi.setSystemTime.
  afterEach(() => {
    // Restaura o relogio mesmo quando o teste falha no meio: timer falso que
    // vaza para o proximo arquivo do runner e um bug muito pior de achar do
    // que o teste que o vazou.
    vi.useRealTimers()
  })

  it('DATA_LANCAMENTO e a meia-noite BRT do dia 25, expressa em UTC', () => {
    // 25/08/2026 00:00 BRT = 25/08/2026 03:00 UTC. Se este numero mudar, ou o
    // fuso foi construido errado (literal de data lido como UTC), ou o Brasil
    // mudou de offset em agosto — as duas coisas exigem decisao humana.
    expect(DATA_LANCAMENTO.toISOString()).toBe('2026-08-25T03:00:00.000Z')
  })

  it('um milissegundo antes da virada o lancamento ainda nao ocorreu', () => {
    expect(lancamentoJaOcorreu(new Date(DATA_LANCAMENTO.getTime() - 1))).toBe(false)
  })

  it('a propria meia-noite ja conta como lancado', () => {
    expect(lancamentoJaOcorreu(DATA_LANCAMENTO)).toBe(true)
  })

  // O erro que este teste existe para impedir: comparar contra uma data
  // construida em UTC. 24/08 as 23:00 UTC ja e "dia 25" para quem le a data
  // sem fuso, mas no Brasil ainda sao 20:00 do dia 24 — a loja abriria a
  // vespera do evento.
  it('23h UTC do dia 24 ainda e vespera do lancamento no Brasil', () => {
    expect(lancamentoJaOcorreu(new Date('2026-08-24T23:00:00Z'))).toBe(false)
  })

  it('01h UTC do dia 26 ja e depois do lancamento', () => {
    expect(lancamentoJaOcorreu(new Date('2026-08-26T01:00:00Z'))).toBe(true)
  })

  it('sem argumento, le o relogio: congelado antes de 25/08 devolve false', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'))
    expect(lancamentoJaOcorreu()).toBe(false)
  })

  it('sem argumento, le o relogio: congelado depois de 25/08 devolve true', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-26T12:00:00Z'))
    expect(lancamentoJaOcorreu()).toBe(true)
  })

  // O default `new Date()` precisa ser avaliado A CADA chamada. Se alguem o
  // trocar por um instante capturado no import do modulo, um processo de
  // servidor que sobreviva a virada da meia-noite continuaria respondendo
  // "ainda nao lancou" pelo resto do dia do evento.
  it('a resposta muda dentro do mesmo processo quando o relogio cruza a virada', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(DATA_LANCAMENTO.getTime() - 1000))
    expect(lancamentoJaOcorreu()).toBe(false)
    vi.setSystemTime(DATA_LANCAMENTO)
    expect(lancamentoJaOcorreu()).toBe(true)
  })

  it('o aviso de pre-venda nomeia a data do lancamento, com acentuacao', () => {
    expect(AVISO_PRE_VENDA).toBe(
      'Os pedidos online serão enviados após o lançamento oficial da Milagran, realizado em 25/08/2026.',
    )
  })
})
