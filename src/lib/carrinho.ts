import { deInteiro, multiplicar, type Centavos } from '@/lib/money'

/**
 * Teto por linha: quantidade maxima de unidades de um kit por pedido.
 * Existe para que um erro de digitacao ou um bot nao gere uma linha de
 * R$ 2 milhoes que estoura o int4 do banco e aparece como erro cru do
 * Postgres em vez de mensagem de validacao. O subtotal do carrinho inteiro
 * e limitado por SUBTOTAL_MAXIMO_CENTAVOS.
 */
export const QUANTIDADE_MAXIMA = 20

/**
 * Teto do subtotal: limita do carrinho total para nao estouro integer.
 * Este e o limite do Postgres `integer` type usado em pedidos.subtotal_centavos
 * e pedido_itens.total_centavos. A constraint do banco rejeitaria mesmo assim,
 * mas aqui validamos mais cedo com mensagem clara.
 */
export const SUBTOTAL_MAXIMO_CENTAVOS = 2_147_483_647

export type EntradaLinha = {
  kitId: string
  nome: string
  precoUnitario: Centavos
  quantidade: number
}

export type LinhaCarrinho = EntradaLinha & { total: Centavos }

/**
 * SEM CAMPO DE FRETE, de proposito.
 *
 * A politica de frete ainda nao foi definida (ver
 * src/components/linha-frete.tsx, que e o unico lugar onde as telas dizem
 * isso). Enquanto nao for, este resumo nao tem valor de frete para entregar:
 * o que existia aqui era um `frete: 0` acompanhado de um `freteADefinir:
 * true` — ou seja, um interruptor que, virado por engano, faria a loja
 * imprimir "R$ 0,00" e prometer frete gratis que ninguem decidiu.
 *
 * Nao ter o campo e a garantia: nao ha valor de frete para nenhuma tela
 * mostrar, e o dia em que o frete for real o compilador aponta cada ponto que
 * precisa passar a receber o valor calculado — em vez de o sistema comecar a
 * exibir zero em silencio.
 *
 * O pedido continua gravando frete_centavos (a coluna existe e e NOT NULL):
 * o checkout passa deInteiro(0) explicitamente para criarPedido, marcado la
 * como placeholder de politica indefinida.
 */
export type ResumoCarrinho = {
  linhas: LinhaCarrinho[]
  subtotal: Centavos
  desconto: Centavos
  total: Centavos
}

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
  if (subtotal > SUBTOTAL_MAXIMO_CENTAVOS) {
    throw new Error(`Carrinho total nao pode exceder ${SUBTOTAL_MAXIMO_CENTAVOS} centavos, recebido ${subtotal}`)
  }

  // O desconto nunca ultrapassa o subtotal: a constraint
  // pedido_desconto_nao_excede rejeitaria, e um total negativo nao existe.
  const descontoAplicado = Math.min(desconto, subtotal) as Centavos

  return {
    linhas,
    subtotal,
    desconto: descontoAplicado,
    // Sem parcela de frete: enquanto a politica nao existir, nao ha valor
    // nenhum a somar aqui — ver o comentario em ResumoCarrinho.
    total: (subtotal - descontoAplicado) as Centavos,
  }
}
