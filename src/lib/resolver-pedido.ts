import { verificarAtribuicao } from '@/lib/atribuicao'
import { buscarRepresentanteAtivoPorSlug } from '@/repositories/representantes'
import type { EntradaPedido } from '@/repositories/pedidos'

/**
 * Os campos de atribuicao de EntradaPedido — exatamente o que o checkout do
 * Plano 2 vai espalhar dentro da chamada a criarPedido, junto com os valores
 * do carrinho. Derivado de EntradaPedido de proposito: se a entrada do
 * pedido ganhar um campo de atribuicao novo, o compilador cobra aqui.
 */
export type AtribuicaoDoPedido = Pick<
  EntradaPedido,
  'origem' | 'representanteId' | 'percentualComissao' | 'utmSource' | 'utmMedium' | 'utmCampaign'
>

const VENDA_DA_CASA: AtribuicaoDoPedido = {
  origem: 'casa',
  representanteId: null,
  percentualComissao: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
}

/**
 * Traduz o cookie do navegador na atribuicao AUTORITATIVA que sera congelada
 * na linha do pedido. Este e o segundo tempo do mecanismo: o proxy grava o
 * sinal em /r/<slug>, e aqui o servidor decide o que esse sinal vale no
 * momento da compra.
 *
 * O cookie e sinal, nunca fonte de verdade sobre dinheiro:
 *
 * - sem cookie, cookie adulterado ou cookie fora da janela de 30 dias
 *   -> 'casa'. Nao ha a quem pagar e nao ha motivo registrado.
 * - cookie valido cujo slug e de um representante ATIVO -> 'link', com o
 *   percentual LIDO DO BANCO AGORA. Nunca um percentual vindo do cookie:
 *   o cookie e escrito no navegador do visitante e sobrevive 30 dias a
 *   qualquer mudanca de cadastro.
 * - cookie valido cujo slug nao existe mais ou aponta para representante
 *   DESLIGADO -> 'rep_inativo'. E para isso que esse valor do ENUM existe:
 *   o pedido guarda POR QUE ficou sem representante, em vez de se parecer
 *   com uma venda da casa e sumir do relatorio de links mortos.
 *
 * Os UTM vem do cookie sempre que o cookie verificou — inclusive no caso
 * 'rep_inativo', onde a campanha que trouxe a visita continua sendo
 * informacao de marketing valida mesmo sem ninguem a receber comissao.
 *
 * A hierarquia completa (cupom > last click > first click) so se fecha no
 * Plano 2: o cupom informado no checkout tem prioridade sobre este
 * resultado e produz origem 'cupom'.
 */
export async function resolverAtribuicaoDoPedido(
  cookieBruto: string | null,
  segredo: string,
  agora: Date = new Date(),
): Promise<AtribuicaoDoPedido> {
  if (!cookieBruto) return VENDA_DA_CASA

  const atribuicao = verificarAtribuicao(cookieBruto, segredo, agora)
  if (!atribuicao) {
    // O visitante TINHA cookie e o pedido vai ser gravado como venda da
    // casa. Sem esta linha, esse caso e indistinguivel de uma compra sem
    // cookie nenhum — e e exatamente aqui que a comissao deixa de existir.
    // Nunca logar o valor do cookie, a assinatura ou o segredo.
    console.warn('[atribuicao] cookie descartado na criacao do pedido', {
      motivo: 'assinatura_invalida_ou_expirado',
    })
    return VENDA_DA_CASA
  }

  const utm = {
    utmSource: atribuicao.utmSource,
    utmMedium: atribuicao.utmMedium,
    utmCampaign: atribuicao.utmCampaign,
  }

  const representante = await buscarRepresentanteAtivoPorSlug(atribuicao.slug)
  if (!representante) {
    return { origem: 'rep_inativo', representanteId: null, percentualComissao: null, ...utm }
  }

  return {
    origem: 'link',
    representanteId: representante.id,
    percentualComissao: representante.percentualComissao,
    ...utm,
  }
}
