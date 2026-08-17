import { describe, it, expect } from 'vitest'
import { deInteiro } from '@/lib/money'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'

const KIT = { kitId: 'k1', nome: 'Kit Milagran', precoUnitario: deInteiro(100000) }

describe('montarCarrinho', () => {
  it('preco e linear: 3 kits custam 3x o preco unitario', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 3 }])
    expect(r.subtotal).toBe(300000)
    expect(r.total).toBe(300000)
  })

  // ESTE TESTE MUDOU EM 16/08/2026, junto com a regra. Ate aqui ele assegurava
  // que `frete` NAO existia no resumo — enquanto a politica de frete nao fosse
  // decidida, nao podia haver valor nenhum para uma tela imprimir como
  // "R$ 0,00". Com a politica definida (Clube Envios, §13), o campo passou a
  // existir e o que sobra a garantir e a outra metade da divida antiga: a
  // FLAG nunca volta. Era `freteADefinir: true` que fazia "virar um
  // interruptor" parecer suficiente para ligar o frete; hoje quem nao cotou
  // simplesmente nao passa valor, e o texto de "a cotar" vive em
  // src/components/linha-frete.tsx, que recebe null.
  it('expoe valor de frete, nunca uma flag de politica', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 1 }])
    expect(r).toHaveProperty('frete')
    expect(r).not.toHaveProperty('freteADefinir')
  })

  // DINHEIRO: o default existe para que todo chamador que ainda nao cotou
  // (vitrine, venda presencial do balcao) continue produzindo exatamente o
  // mesmo total de antes. Se este teste falhar, algum pedido ja criado teria
  // fechado com total diferente do que o comprador viu.
  it('DINHEIRO: sem frete informado o total continua sendo o subtotal', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 1 }])
    expect(r.frete).toBe(0)
    expect(r.total).toBe(r.subtotal)
  })

  it('DINHEIRO: omitir o frete e passar zero dao o mesmo resumo', () => {
    const omitido = montarCarrinho([{ ...KIT, quantidade: 2 }], deInteiro(20000))
    const explicito = montarCarrinho([{ ...KIT, quantidade: 2 }], deInteiro(20000), deInteiro(0))
    expect(explicito).toEqual(omitido)
  })

  // A formula tem que ser a mesma da constraint pedido_total_confere
  // (migrations/1754900300000_pedidos.sql): subtotal - desconto + frete.
  it('DINHEIRO: o frete entra no total, somado depois do desconto', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 2 }], deInteiro(20000), deInteiro(3550))
    expect(r.subtotal).toBe(200000)
    expect(r.desconto).toBe(20000)
    expect(r.frete).toBe(3550)
    expect(r.total).toBe(183550)
  })

  // O cupom abate produto, nao transporte. Um cupom maior que o carrinho zera
  // o subtotal e o total fica valendo exatamente o frete — que a Milagran paga
  // a transportadora de qualquer forma.
  it('DINHEIRO: desconto maior que o subtotal nao come o frete', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 1 }], deInteiro(500000), deInteiro(4200))
    expect(r.desconto).toBe(100000)
    expect(r.frete).toBe(4200)
    expect(r.total).toBe(4200)
  })

  // Frete negativo entraria como desconto disfarcado: reduziria o total sem
  // passar por cupom_usos e sem aparecer na base de comissao. deInteiro() so
  // atesta que o numero e inteiro — negativo passa por ele sem reclamar.
  it('DINHEIRO: rejeita frete negativo', () => {
    expect(() => montarCarrinho([{ ...KIT, quantidade: 1 }], deInteiro(0), deInteiro(-1)))
      .toThrow(/frete/i)
  })

  it('desconto sai do subtotal e nao do frete', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 2 }], deInteiro(20000))
    expect(r.subtotal).toBe(200000)
    expect(r.desconto).toBe(20000)
    expect(r.total).toBe(180000)
  })

  it('limita o desconto ao subtotal — total nunca fica negativo', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 1 }], deInteiro(500000))
    expect(r.desconto).toBe(100000)
    expect(r.total).toBe(0)
  })

  it('rejeita carrinho vazio', () => {
    expect(() => montarCarrinho([])).toThrow(/vazio/)
  })

  it('rejeita quantidade zero ou negativa', () => {
    expect(() => montarCarrinho([{ ...KIT, quantidade: 0 }])).toThrow(/quantidade/i)
    expect(() => montarCarrinho([{ ...KIT, quantidade: -1 }])).toThrow(/quantidade/i)
  })

  it('rejeita quantidade fracionada', () => {
    expect(() => montarCarrinho([{ ...KIT, quantidade: 1.5 }])).toThrow(/quantidade/i)
  })

  it('rejeita quantidade acima do teto', () => {
    expect(() => montarCarrinho([{ ...KIT, quantidade: QUANTIDADE_MAXIMA + 1 }]))
      .toThrow(/maxima/i)
  })

  it('aceita exatamente o teto', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: QUANTIDADE_MAXIMA }])
    expect(r.subtotal).toBe(100000 * QUANTIDADE_MAXIMA)
  })

  it('soma varios kits diferentes', () => {
    const r = montarCarrinho([
      { ...KIT, quantidade: 2 },
      { kitId: 'k2', nome: 'Kit Duo', precoUnitario: deInteiro(180000), quantidade: 1 },
    ])
    expect(r.subtotal).toBe(380000)
    expect(r.linhas).toHaveLength(2)
    expect(r.linhas[0]!.total).toBe(200000)
  })

  it('rejeita carrinho com subtotal acima do teto (overflow de integer)', () => {
    // Cada linha com QUANTIDADE_MAXIMA e precoUnitario de 100000 totaliza 2.000.000.
    // 1074 linhas excedem o integer limit de Postgres (2.147.483.647).
    const linhas = Array.from({ length: 1074 }, (_, i) => ({
      kitId: `k${i}`,
      nome: `Kit ${i}`,
      precoUnitario: deInteiro(100000),
      quantidade: QUANTIDADE_MAXIMA,
    }))
    expect(() => montarCarrinho(linhas)).toThrow(/carrinho total nao pode exceder/i)
  })
})
