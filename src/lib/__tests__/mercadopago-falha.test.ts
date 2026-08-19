import { describe, it, expect } from 'vitest'
import { ErroMercadoPago, falhaDoProvedor } from '@/lib/mercadopago'

/**
 * COMO A LOJA RESPONDE QUANDO O MERCADO PAGO NAO CRIA A COBRANCA.
 *
 * O DEFEITO QUE ESTE ARQUIVO EXISTE PARA FECHAR, encontrado em producao em
 * 19/08/2026: a rota de pagamentos traduzia TODA falha do provedor na mesma
 * frase — "O provedor de pagamento não respondeu. Tente de novo em instantes."
 * — e devolvia 502.
 *
 * No dia em que a conta do Mercado Pago ficou com `address_pending`, o provedor
 * passou a responder 403 `PA_UNAUTHORIZED_RESULT_FROM_POLICIES` a TODA
 * tentativa de cobranca (Pix, boleto e cartao). Ele respondeu — e recusou, por
 * um motivo que nenhuma retentativa resolve. A tela mandava a compradora tentar
 * de novo em instantes, para sempre.
 *
 * `chamar()` (src/lib/mercadopago.ts) sempre soube a diferenca: status 0
 * significa "nao houve resposta" e o comentario de la ja dizia que "o chamador
 * precisa distinguir os dois para decidir se pode tentar de novo". Quem jogava
 * a distincao fora era o chamador.
 */
describe('falhaDoProvedor', () => {
  /**
   * SEM RESPOSTA: timeout, DNS, rede caindo. Aqui a retentativa e o conselho
   * certo — o provedor pode estar de pe no segundo seguinte.
   */
  it('status 0 e falha de rede: pode tentar de novo', () => {
    const r = falhaDoProvedor(new ErroMercadoPago(0, 'sem_resposta', 'timeout'))

    expect(r.podeTentarDeNovo).toBe(true)
    expect(r.mensagem).toMatch(/tente de novo/i)
  })

  // 5xx e o provedor com problema DELE. Tambem passa.
  it('erro de servidor do provedor: pode tentar de novo', () => {
    for (const status of [500, 502, 503, 504]) {
      const r = falhaDoProvedor(new ErroMercadoPago(status, 'x', 'instabilidade'))
      expect(r.podeTentarDeNovo).toBe(true)
    }
  })

  /**
   * O CASO DE 19/08/2026, e o unico que a versao antiga errava.
   *
   * 403 do PolicyAgent nao muda sozinho: a conta precisa ser corrigida no painel
   * do Mercado Pago. Prometer "tente de novo em instantes" faz a compradora
   * insistir num botao que nunca vai funcionar — e faz a operacao achar que foi
   * instabilidade passageira, em vez de ir consertar a conta.
   */
  it('403 de politica: NAO promete retentativa', () => {
    const r = falhaDoProvedor(new ErroMercadoPago(
      403, 'PA_UNAUTHORIZED_RESULT_FROM_POLICIES', 'At least one policy returned UNAUTHORIZED.',
    ))

    expect(r.podeTentarDeNovo).toBe(false)
    expect(r.mensagem).not.toMatch(/tente de novo|instantes/i)
  })

  it('4xx em geral: recusa, e nao ausencia de resposta', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const r = falhaDoProvedor(new ErroMercadoPago(status, 'x', 'recusado'))
      expect(r.podeTentarDeNovo).toBe(false)
      expect(r.mensagem).not.toMatch(/não respondeu/i)
    }
  })

  /**
   * A MENSAGEM DO PROVEDOR NUNCA CHEGA A COMPRADORA. Ela carrega vocabulario
   * interno e, em varios erros do Mercado Pago, ecoa o payload enviado — que
   * tem CPF e e-mail. O texto do provedor serve ao LOG; a tela recebe uma frase
   * escrita por nos.
   */
  it('o texto do provedor fica no log, nunca na tela', () => {
    const cru = 'At least one policy returned UNAUTHORIZED. payer 39053344705'
    const r = falhaDoProvedor(new ErroMercadoPago(403, 'PA_UNAUTHORIZED_RESULT_FROM_POLICIES', cru))

    expect(r.mensagem).not.toContain('UNAUTHORIZED')
    expect(r.mensagem).not.toContain('39053344705')
    // E o log precisa nomear a causa, senao a pendencia da conta vira uma
    // semana de gente reclamando que "o Pix nao funciona".
    expect(r.paraOLog).toContain('403')
    expect(r.paraOLog).toContain('PA_UNAUTHORIZED_RESULT_FROM_POLICIES')
  })
})
