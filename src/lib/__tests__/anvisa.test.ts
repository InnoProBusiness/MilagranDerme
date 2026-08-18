import { describe, it, expect } from 'vitest'
import {
  textoAnvisa, situacaoPendente,
  TEXTO_ANVISA_DISPENSADO, TEXTO_ANVISA_EM_BREVE,
} from '@/lib/anvisa'

/**
 * A fonte unica da copy ANVISA (ver o cabecalho de src/lib/anvisa.ts). Estes
 * testes fixam os TRES estados e, principalmente, a PRECEDENCIA entre eles —
 * que e a parte que um refactor desavisado inverte sem quebrar nada visivel.
 */
describe('textoAnvisa', () => {
  it('kit sem registro e sem dispensa continua dizendo "em breve"', () => {
    expect(textoAnvisa({ registro: null, dispensado: false }))
      .toBe(TEXTO_ANVISA_EM_BREVE)
  })

  // A situacao do kit do lancamento desde 18/08/2026: enquadramento declarado
  // na Lei 15.154/2025 e gravado por migration. A frase cita a lei e nao
  // promete "aprovado pela Anvisa" — dispensa nao e aprovacao.
  it('kit dispensado mostra a frase da Lei 15.154/2025', () => {
    expect(textoAnvisa({ registro: null, dispensado: true }))
      .toBe(TEXTO_ANVISA_DISPENSADO)
    expect(TEXTO_ANVISA_DISPENSADO).toContain('Lei nº 15.154/2025')
    expect(TEXTO_ANVISA_DISPENSADO).toContain('artesanal')
  })

  it('registro emitido mostra o numero', () => {
    expect(textoAnvisa({ registro: '25351.000123/2026-01', dispensado: false }))
      .toBe('Registro ANVISA: 25351.000123/2026-01')
  })

  /**
   * PRECEDENCIA: o numero vence a dispensa. Se um dia a Milagran registrar o
   * produto (a linha deixou de se enquadrar como artesanal, por exemplo), o
   * numero emitido e a informacao mais forte e mais verificavel — a flag de
   * dispensa esquecida em true nao pode esconde-lo.
   */
  it('registro emitido vence a flag de dispensa', () => {
    expect(textoAnvisa({ registro: '25351.000123/2026-01', dispensado: true }))
      .toBe('Registro ANVISA: 25351.000123/2026-01')
  })

  // String vazia nao e registro: um import de planilha que grave '' no lugar
  // de NULL nao pode fazer a tela imprimir "Registro ANVISA: " em branco.
  it('registro vazio nao conta como registro', () => {
    expect(textoAnvisa({ registro: '', dispensado: true }))
      .toBe(TEXTO_ANVISA_DISPENSADO)
    expect(textoAnvisa({ registro: '', dispensado: false }))
      .toBe(TEXTO_ANVISA_EM_BREVE)
  })
})

describe('situacaoPendente', () => {
  // So o "em breve" e pendencia — e o unico estado que merece moldura de
  // atencao na home. Dispensa legal e registro emitido sao situacoes
  // resolvidas; vesti-las de alerta faria o comprador ler problema onde
  // nao ha.
  it('pendente apenas quando nao ha registro nem dispensa', () => {
    expect(situacaoPendente({ registro: null, dispensado: false })).toBe(true)
    expect(situacaoPendente({ registro: null, dispensado: true })).toBe(false)
    expect(situacaoPendente({ registro: '25351.000123/2026-01', dispensado: false })).toBe(false)
  })
})
