import { deInteiro, multiplicar, type Centavos } from '@/lib/money'

/**
 * Teto por pedido. Existe para que um erro de digitacao ou um bot nao gere
 * um pedido de R$ 2 milhoes que estoura o int4 do banco e aparece como erro
 * cru do Postgres em vez de mensagem de validacao.
 */
export const QUANTIDADE_MAXIMA = 20

export type EntradaLinha = {
  kitId: string
  nome: string
  precoUnitario: Centavos
  quantidade: number
}

export type LinhaCarrinho = EntradaLinha & { total: Centavos }

export type ResumoCarrinho = {
  linhas: LinhaCarrinho[]
  subtotal: Centavos
  desconto: Centavos
  frete: Centavos
  total: Centavos
  /**
   * A politica de frete ainda nao foi definida. Enquanto for true, a
   * interface mostra "a definir" — nunca "R$ 0,00", que seria uma promessa
   * de frete gratis que ninguem tomou.
   */
  freteADefinir: boolean
}

const FRETE_A_DEFINIR = true

export function montarCarrinho(
  itens: EntradaLinha[],
  desconto: Centavos = deInteiro(0),
): ResumoCarrinho {
  if (itens.length === 0) {
    throw new Error('Carrinho vazio nao pode ser resumido')
  }

  const linhas = itens.map((i) => {
    if (!Number.isInteger(i.quantidade) || i.quantidade < 1) {
      throw new Error(`Quantidade precisa ser inteira e maior que zero: ${i.quantidade}`)
    }
    if (i.quantidade > QUANTIDADE_MAXIMA) {
      throw new Error(`Quantidade maxima por kit e ${QUANTIDADE_MAXIMA}, recebido ${i.quantidade}`)
    }
    return { ...i, total: multiplicar(i.precoUnitario, i.quantidade) }
  })

  const subtotal = linhas.reduce((acc, l) => acc + l.total, 0) as Centavos
  // O desconto nunca ultrapassa o subtotal: a constraint
  // pedido_desconto_nao_excede rejeitaria, e um total negativo nao existe.
  const descontoAplicado = Math.min(desconto, subtotal) as Centavos
  const frete = deInteiro(0)

  return {
    linhas,
    subtotal,
    desconto: descontoAplicado,
    frete,
    total: (subtotal - descontoAplicado + frete) as Centavos,
    freteADefinir: FRETE_A_DEFINIR,
  }
}
