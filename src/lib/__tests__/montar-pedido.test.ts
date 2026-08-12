import { describe, it, expect } from 'vitest'
import { aplicarPrioridadeDoCupom } from '@/lib/montar-pedido'
import { deInteiro } from '@/lib/money'
import type { AtribuicaoDoPedido } from '@/lib/resolver-pedido'

const DA_CASA: Readonly<AtribuicaoDoPedido> = {
  origem: 'casa', representanteId: null, percentualComissao: null,
  utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
}
const DA_MARIA: Readonly<AtribuicaoDoPedido> = {
  origem: 'link', representanteId: 'id-maria', percentualComissao: 20,
  utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
}
const percentualDe = async (id: string) => (id === 'id-joao' ? 15 : 20)

// O desconto dos cupons abaixo e construido com deInteiro(), nunca com
// `0 as never`. Nenhuma asserção deste arquivo le esse valor — mas o idioma
// e copiado, e num teste que LEIA o valor `as never` deixa passar qualquer
// coisa (19.9 vira R$ 0,20 em vez de estourar em deInteiro). O construtor
// custa o mesmo e nao tem essa armadilha.

describe('prioridade do cupom sobre o last click', () => {
  it('sem cupom, a atribuicao do cookie passa intacta', async () => {
    const r = await aplicarPrioridadeDoCupom(DA_MARIA, null, percentualDe)
    expect(r).toEqual(DA_MARIA)
  })

  it('cupom do Joao vence o cookie da Maria', async () => {
    const r = await aplicarPrioridadeDoCupom(
      DA_MARIA, { id: 'c1', codigo: 'JOAO10', desconto: deInteiro(0), representanteId: 'id-joao' },
      percentualDe,
    )
    expect(r.origem).toBe('cupom')
    expect(r.representanteId).toBe('id-joao')
    expect(r.percentualComissao).toBe(15)
  })

  it('cupom da casa nao rouba a venda da Maria', async () => {
    const r = await aplicarPrioridadeDoCupom(
      DA_MARIA, { id: 'c2', codigo: 'BLACKFRIDAY', desconto: deInteiro(0), representanteId: null },
      percentualDe,
    )
    expect(r.origem).toBe('link')
    expect(r.representanteId).toBe('id-maria')
  })

  it('cupom do Joao sobre venda da casa atribui ao Joao', async () => {
    const r = await aplicarPrioridadeDoCupom(
      DA_CASA, { id: 'c1', codigo: 'JOAO10', desconto: deInteiro(0), representanteId: 'id-joao' },
      percentualDe,
    )
    expect(r.origem).toBe('cupom')
    expect(r.representanteId).toBe('id-joao')
  })

  it('os UTM da visita sobrevivem a troca de atribuicao', async () => {
    const r = await aplicarPrioridadeDoCupom(
      DA_MARIA, { id: 'c1', codigo: 'JOAO10', desconto: deInteiro(0), representanteId: 'id-joao' },
      percentualDe,
    )
    expect(r.utmSource).toBe('instagram')
    expect(r.utmCampaign).toBe('lancamento')
  })

  it('NAO muta a atribuicao recebida', async () => {
    const antes = { ...DA_MARIA }
    await aplicarPrioridadeDoCupom(
      DA_MARIA, { id: 'c1', codigo: 'JOAO10', desconto: deInteiro(0), representanteId: 'id-joao' },
      percentualDe,
    )
    expect(DA_MARIA).toEqual(antes)
  })

  it('cada chamada devolve um objeto novo', async () => {
    const a = await aplicarPrioridadeDoCupom(DA_CASA, null, percentualDe)
    const b = await aplicarPrioridadeDoCupom(DA_CASA, null, percentualDe)
    expect(a).not.toBe(b)
  })
})
