import type { AtribuicaoDoPedido } from '@/lib/resolver-pedido'
import type { CupomValido } from '@/lib/cupom'

/**
 * HIERARQUIA DE ATRIBUICAO: cupom > last click > first click.
 *
 * O cookie ja resolveu o last click (resolverAtribuicaoDoPedido). Aqui o
 * cupom tem a ultima palavra, e apenas quando ele pertence a um
 * representante: um cupom da casa (BLACKFRIDAY) e promocao da marca e nao
 * pode roubar a venda de quem trouxe o cliente.
 *
 * Por que o cupom vence: e a acao mais deliberada do comprador. Ele digitou
 * o codigo daquela pessoa. O cookie pode ter 29 dias e vir de um clique
 * esquecido; o cupom foi digitado agora, na hora de pagar.
 *
 * O percentual vem do banco, nunca do cupom nem do cookie — mesmo motivo do
 * resolver: cadastro muda, e o pedido tem que valer o percentual de hoje.
 *
 * Devolve sempre um objeto novo. Mutar o recebido corromperia a atribuicao
 * de todos os pedidos seguintes do mesmo processo.
 */
export async function aplicarPrioridadeDoCupom(
  atribuicao: Readonly<AtribuicaoDoPedido>,
  cupom: CupomValido | null,
  buscarPercentual: (representanteId: string) => Promise<number>,
): Promise<AtribuicaoDoPedido> {
  if (!cupom || !cupom.representanteId) {
    return { ...atribuicao }
  }

  return {
    ...atribuicao,
    origem: 'cupom',
    representanteId: cupom.representanteId,
    percentualComissao: await buscarPercentual(cupom.representanteId),
  }
}
