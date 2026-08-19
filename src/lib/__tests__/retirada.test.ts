import { describe, it, expect } from 'vitest'
import {
  PRAZO_RETIRADA_DIAS, ENDERECO_RETIRADA, FRETE_RETIRADA,
  cepFormatado, enderecoRetiradaEmLinha, instrucaoDeRetirada,
  disponivelParaRetiradaEm, retirarAte,
} from '@/lib/retirada'
import { DATA_LANCAMENTO } from '@/lib/tempo'

describe('o ponto de retirada', () => {
  it('o CEP e so digito, como todo CEP do sistema', () => {
    // Comparado e enviado sempre sem mascara, igual ao que src/lib/cep.ts
    // normaliza. A mascara existe so para LER.
    expect(ENDERECO_RETIRADA.cep).toMatch(/^\d{8}$/)
    expect(cepFormatado()).toBe('74693-158')
  })

  it('a linha unica traz endereco, cidade, UF e CEP', () => {
    const linha = enderecoRetiradaEmLinha()
    expect(linha).toContain('Rua ACP 23')
    expect(linha).toContain('Goiânia/GO')
    expect(linha).toContain('74693-158')
  })

  it('a instrucao diz onde e por quanto tempo', () => {
    expect(instrucaoDeRetirada()).toContain('Goiânia')
    expect(instrucaoDeRetirada()).toContain(String(PRAZO_RETIRADA_DIAS))
  })

  // Zero com dono, e nao `deInteiro(0)` solto: e o valor que a rota grava e que
  // a CHECK pedido_retirada_sem_frete garante.
  it('retirada nao tem frete', () => {
    expect(FRETE_RETIRADA).toBe(0)
  })
})

/**
 * A CONTA MAIS PERIGOSA DESTE MODULO, e a razao de ela ter teste proprio.
 *
 * A loja vende em PRE-VENDA ate 25/08/2026: o pedido e pago na hora e a entrega
 * espera o lancamento. Contar os 7 dias a partir do PAGAMENTO daria, para uma
 * compra feita em 19/08, o prazo "retire ate 26/08" — uma janela que comeca no
 * dia 19, sete dias antes de existir kit na prateleira. A compradora apareceria
 * no dia 21 na frente de uma porta sem nada atras.
 */
describe('quando o kit fica disponivel, e ate quando ha prazo', () => {
  const ANTES = new Date('2026-08-19T14:00:00Z')
  const DEPOIS = new Date('2026-09-10T14:00:00Z')

  it('pagamento ANTES do lancamento: a contagem so comeca no lancamento', () => {
    expect(disponivelParaRetiradaEm(ANTES).getTime()).toBe(DATA_LANCAMENTO.getTime())
  })

  it('pagamento DEPOIS do lancamento: a contagem comeca no pagamento', () => {
    expect(disponivelParaRetiradaEm(DEPOIS).getTime()).toBe(DEPOIS.getTime())
  })

  // O caso de borda que decide de qual lado a virada cai. `>=` significa que a
  // propria meia-noite de 25/08 ja e "lancado", igual a lancamentoJaOcorreu.
  it('pagamento exatamente no instante do lancamento conta a partir dele', () => {
    const noPonto = new Date(DATA_LANCAMENTO.getTime())
    expect(disponivelParaRetiradaEm(noPonto).getTime()).toBe(DATA_LANCAMENTO.getTime())
  })

  it('o prazo de quem pagou na pre-venda nasce no lancamento, nao no pagamento', () => {
    const limite = retirarAte(ANTES)
    const seFosseDoPagamento = new Date(ANTES.getTime())
    seFosseDoPagamento.setDate(seFosseDoPagamento.getDate() + PRAZO_RETIRADA_DIAS)

    expect(limite.getTime()).toBeGreaterThan(seFosseDoPagamento.getTime())
    // Sete dias corridos depois da meia-noite de 25/08 em Sao Paulo.
    expect(limite.toISOString()).toBe('2026-09-01T03:00:00.000Z')
  })

  it('depois do lancamento o prazo e simplesmente pagamento mais sete dias', () => {
    expect(retirarAte(DEPOIS).toISOString()).toBe('2026-09-17T14:00:00.000Z')
  })

  /**
   * A REGRA ESPECIAL TEM QUE SUMIR SOZINHA. Depois do lancamento as duas contas
   * coincidem, e e isso que impede a excecao de virar codigo morto que alguem
   * precisa lembrar de remover — e que, esquecido, ficaria errado para sempre.
   */
  it('passado o lancamento, a regra da pre-venda vira identidade', () => {
    for (const dias of [1, 30, 400]) {
      const pago = new Date(DATA_LANCAMENTO.getTime() + dias * 86_400_000)
      expect(disponivelParaRetiradaEm(pago).getTime()).toBe(pago.getTime())
    }
  })

  it('o prazo nunca anda para tras', () => {
    const pagamentos = [ANTES, DATA_LANCAMENTO, DEPOIS]
    const limites = pagamentos.map((p) => retirarAte(p).getTime())
    expect(limites).toEqual([...limites].sort((a, b) => a - b))
  })
})
