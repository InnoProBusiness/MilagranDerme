import { aplicarPercentual, deInteiro, type Centavos } from '@/lib/money'

export type TipoDesconto = 'percentual' | 'fixo'

export type MotivoRecusa =
  | 'inexistente' | 'inativo' | 'nao_iniciado' | 'expirado'
  | 'esgotado' | 'limite_do_cliente' | 'representante_inativo'

export type CupomValido = {
  id: string
  codigo: string
  desconto: Centavos
  representanteId: string | null
}

export type ResultadoCupom =
  | { ok: true; cupom: CupomValido }
  | { ok: false; motivo: MotivoRecusa }

/**
 * Percentual usa aplicarPercentual, a MESMA funcao que calcula comissao —
 * uma regra de arredondamento so no sistema inteiro, senao o extrato do
 * representante nao fecha com o total do pedido.
 *
 * O desconto nunca ultrapassa o subtotal: a constraint
 * pedido_desconto_nao_excede rejeitaria a gravacao.
 */
export function calcularDesconto(
  tipo: TipoDesconto,
  valor: number,
  subtotal: Centavos,
): Centavos {
  const bruto = tipo === 'percentual'
    ? aplicarPercentual(subtotal, valor)
    : deInteiro(valor)
  return Math.min(bruto, subtotal) as Centavos
}

/** Mensagem para a pessoa que digitou o codigo. Nunca expoe estrutura interna. */
export function mensagemDeRecusa(motivo: MotivoRecusa): string {
  switch (motivo) {
    case 'inexistente':           return 'Cupom nao encontrado. Confira o codigo.'
    case 'inativo':               return 'Este cupom nao esta mais disponivel.'
    case 'nao_iniciado':          return 'Este cupom ainda nao comecou a valer.'
    case 'expirado':              return 'Este cupom expirou.'
    case 'esgotado':              return 'Este cupom atingiu o limite de usos.'
    case 'limite_do_cliente':     return 'Voce ja usou este cupom.'
    case 'representante_inativo': return 'Este cupom nao esta mais disponivel.'
  }
}
