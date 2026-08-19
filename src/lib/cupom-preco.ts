import { deInteiro, type Centavos } from '@/lib/money'

/**
 * A conta que a tela de cupons faz, isolada aqui porque e a que erra caro.
 *
 * O PROBLEMA REAL: quem cria uma oferta pensa em PRECO FINAL — "vou vender a
 * 800" —, nunca em desconto — "vou dar 200 de abatimento". O banco guarda o
 * abatimento (`cupons.valor` em centavos para o tipo 'fixo'). Alguem tem que
 * fazer a subtracao, e se for a pessoa, de cabeca, num celular, com a live
 * comecando, mais cedo ou mais tarde ela digita 800 no campo de desconto e
 * cria um cupom que vende o kit de mil reais por duzentos.
 *
 * Por isso a funcao existe, e por isso ela e testada sozinha: o formulario
 * pergunta o preco final e ESTA conta produz o valor que vai para a API.
 */
export function descontoParaPrecoFinal(preco: Centavos, precoFinal: Centavos): Centavos {
  return deInteiro(Math.max(0, preco - precoFinal))
}

/**
 * O preco que um cupom produz, para a tela CONFERIR em voz alta antes de
 * criar ("Kit sai por R$ 800,00"). E a volta da funcao acima para o tipo fixo,
 * e a unica forma de ver um percentual em reais antes de publicar o link.
 *
 * Espelha calcularDesconto (src/lib/cupom.ts) de proposito e com o mesmo teto:
 * desconto nunca passa do subtotal, entao o preco final nunca fica negativo.
 * Nao chama aquela funcao para nao arrastar `aplicarPercentual` — e a mesma
 * regra de arredondamento, e ha teste amarrando as duas.
 */
export function precoComCupom(
  preco: Centavos,
  tipo: 'percentual' | 'fixo',
  valor: number,
): Centavos {
  const desconto = tipo === 'percentual' ? Math.round((preco * valor) / 100) : valor
  return deInteiro(Math.max(0, preco - Math.min(desconto, preco)))
}
