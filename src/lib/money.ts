/**
 * Valor monetario em centavos inteiros. O tipo e "branded" para que passar
 * um number cru onde se espera Centavos nao compile — o que impede o erro
 * classico de misturar reais e centavos no mesmo calculo.
 */
export type Centavos = number & { readonly __marca: 'Centavos' }

const formatador = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
})

export function centavos(reais: number): Centavos {
  if (!Number.isFinite(reais)) {
    throw new Error(`Valor monetario precisa ser finito, recebido: ${reais}`)
  }
  // Multiplicar por 100 em ponto flutuante erra (19.90 * 100 = 1989.9999...).
  // Arredondar depois de multiplicar resolve para toda faixa de valor real.
  const c = Math.round(reais * 100)
  if (Math.abs(reais * 100 - c) > 1e-6) {
    throw new Error(`Valor monetario nao pode ter mais de duas casas: ${reais}`)
  }
  return c as Centavos
}

/** Constroi Centavos a partir de um inteiro que ja esta em centavos (ex.: vindo do banco). */
export function deInteiro(valor: number): Centavos {
  if (!Number.isInteger(valor)) {
    throw new Error(`Centavos precisa ser inteiro, recebido: ${valor}`)
  }
  return valor as Centavos
}

export function formatarBRL(valor: Centavos): string {
  // Intl usa NBSP entre simbolo e numero; normalizar para espaco comum
  // para que a saida seja estavel em teste e em HTML.
  return formatador.format(valor / 100).replace(/ /g, ' ')
}

export function multiplicar(valor: Centavos, quantidade: number): Centavos {
  if (!Number.isInteger(quantidade) || quantidade < 0) {
    throw new Error(`Quantidade precisa ser inteira e nao negativa: ${quantidade}`)
  }
  return (valor * quantidade) as Centavos
}

/**
 * Aplica percentual sobre um valor em centavos.
 * Arredondamento: meio para cima (round-half-up), deterministico e sempre
 * favorecendo o representante em caso de empate. A regra precisa ser unica
 * em todo o sistema, senao o extrato nao fecha com o total.
 */
export function aplicarPercentual(valor: Centavos, percentual: number): Centavos {
  if (!Number.isFinite(percentual) || percentual < 0 || percentual > 100) {
    throw new Error(`percentual precisa estar entre 0 e 100: ${percentual}`)
  }
  return Math.round((valor * percentual) / 100) as Centavos
}

/**
 * Comissao do representante.
 *
 * BASE DE CALCULO: subtotal dos produtos JA COM desconto de cupom aplicado,
 * EXCLUINDO frete. Ver "Premissa que precisa de confirmacao" no plano.
 * Trocar esta regra depois de o primeiro extrato ser exibido exige
 * recalcular extratos ja vistos por representantes.
 */
export function calcularComissao(
  subtotalComDesconto: Centavos,
  percentualComissao: number,
): Centavos {
  if (subtotalComDesconto < 0) {
    throw new Error(
      'Base de comissao nao pode ser negativa. Estorno e lancamento proprio no ledger.',
    )
  }
  return aplicarPercentual(subtotalComDesconto, percentualComissao)
}
