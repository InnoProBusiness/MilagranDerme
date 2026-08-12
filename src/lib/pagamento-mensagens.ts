/**
 * Traduz o `status_detail` do Mercado Pago para uma frase que o comprador
 * consiga agir sobre.
 *
 * As mensagens do provedor vem em espanhol/ingles e com vocabulario interno
 * ("cc_rejected_call_for_authorize"). Ecoar aquilo na tela e empurrar para o
 * comprador um texto que nao diz o que fazer — e a diferenca entre uma venda
 * recuperada e um carrinho abandonado.
 *
 * A lista cobre os motivos que aparecem de verdade em volume; o resto cai no
 * texto generico, que sempre oferece o Pix como saida. NAO ha mensagem que
 * revele antifraude ("suspeita de fraude"): dizer isso ao portador ensina
 * quem esta testando cartao a ajustar a proxima tentativa.
 */
const MENSAGENS: Record<string, string> = {
  cc_rejected_insufficient_amount: 'O cartão não tem limite disponível para este valor. Tente outro cartão ou pague com Pix.',
  cc_rejected_bad_filled_card_number: 'Confira o número do cartão e tente de novo.',
  cc_rejected_bad_filled_date: 'Confira a data de validade do cartão e tente de novo.',
  cc_rejected_bad_filled_security_code: 'Confira o código de segurança do cartão e tente de novo.',
  cc_rejected_bad_filled_other: 'Confira os dados do cartão e tente de novo.',
  cc_rejected_call_for_authorize: 'Seu banco precisa autorizar esta compra. Ligue para o banco e tente de novo.',
  cc_rejected_card_disabled: 'Este cartão está desativado. Ligue para o banco ou use outro cartão.',
  cc_rejected_duplicated_payment: 'Já existe um pagamento igual em andamento. Verifique antes de tentar de novo.',
  cc_rejected_max_attempts: 'Muitas tentativas com este cartão. Use outro cartão ou pague com Pix.',
  cc_rejected_card_error: 'Não foi possível processar o cartão. Tente de novo ou pague com Pix.',
  cc_rejected_invalid_installments: 'Este cartão não aceita o número de parcelas escolhido.',
}

const GENERICA = 'Não foi possível concluir o pagamento. Tente outro cartão ou pague com Pix.'

export function mensagemDoPagamento(statusDetail: string): string {
  return MENSAGENS[statusDetail] ?? GENERICA
}
