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
 * O CAMPO `frete` EXISTE DESDE 16/08/2026 — e ate essa data ele NAO existia,
 * de proposito. Este comentario e o antigo "SEM CAMPO DE FRETE, de proposito"
 * atualizado, nao um comentario novo: a ausencia era uma decisao, e a decisao
 * foi revogada por outra decisao, nao por esquecimento.
 *
 * O QUE ERA E POR QUE: enquanto a politica de frete nao existia, este resumo
 * nao tinha valor de frete nenhum para entregar. O que havia antes disso era
 * um `frete: 0` acompanhado de um `freteADefinir: true` — um interruptor que,
 * virado por engano, faria a loja imprimir "R$ 0,00" e prometer frete gratis
 * que ninguem decidiu. Tirar o campo foi a garantia: sem valor para nenhuma
 * tela ler, nao havia como exibir zero em silencio, e no dia em que o frete
 * fosse real o compilador apontaria cada ponto que precisava passar a receber
 * o valor calculado.
 *
 * O QUE MUDOU: em 16/08/2026 o cliente escolheu a API do Clube Envios (§13 do
 * documento) como fonte de cotacao. Existe politica e existe valor, entao o
 * campo passou a existir. O cliente do provedor mora em src/lib/frete.ts, e
 * ele prefere lancar CotacaoIlegivelError a devolver zero: o principio de
 * nunca inventar dinheiro nao mudou, so mudou de arquivo.
 *
 * O QUE SE PERDEU NA TROCA, e vale saber: o parametro novo tem DEFAULT, entao
 * o compilador NAO aponta mais quem esqueceu de cotar — era exatamente esse
 * apontamento que a ausencia do campo comprava. O default existe porque ha
 * chamador legitimo sem frete (a vitrine, que nao conhece o CEP; a venda
 * presencial, que nao tem frete). Quem guarda a regra agora e a rota, que
 * recota antes de criar o pedido, e o teste DINHEIRO: deste modulo.
 *
 * O VALOR VEM DO SERVIDOR, NUNCA DO CORPO DA REQUISICAO. Em POST /api/pedidos
 * o comprador envia apenas `idServico` (qual opcao ele escolheu); a rota
 * recota pelo CEP submetido e usa o valor que o provedor devolveu agora. O
 * schema `Corpo` e `.strict()`, entao um campo monetario no corpo nao vira
 * desconto disfarcado — vira 422. E o valor precisa estar certo ja no INSERT:
 * pedidos.frete_centavos e pedidos.total_centavos sao CONGELADOS pelo trigger
 * pedido_atribuicao_imutavel_trg (migrations/1754900300000_pedidos.sql), nao
 * existe UPDATE de correcao depois.
 *
 * ZERO AQUI NAO E MAIS "POLITICA INDEFINIDA": e "sem frete a somar", e tem dono
 * — a venda presencial do evento (§10), em que o comprador leva o kit na mao e
 * frete nao existe. "Ainda nao cotado" e um estado DIFERENTE de zero e nao se
 * expressa neste tipo: quem nao conhece o CEP (a vitrine) simplesmente nao
 * passa o argumento, e a tela mostra o texto de "a cotar" de
 * src/components/linha-frete.tsx, que recebe `null` para exatamente isso.
 * Nenhuma tela deve imprimir "R$ 0,00" por nao ter cotado.
 */
export type ResumoCarrinho = {
  linhas: LinhaCarrinho[]
  subtotal: Centavos
  desconto: Centavos
  frete: Centavos
  total: Centavos
}

export function montarCarrinho(
  itens: EntradaLinha[],
  desconto: Centavos = deInteiro(0),
  frete: Centavos = deInteiro(0),
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

  // Frete negativo seria um desconto disfarcado entrando por um parametro que
  // ninguem audita como desconto: passaria pela constraint
  // pedido_desconto_nao_excede (que so olha desconto) e reduziria o total sem
  // aparecer em cupom_usos nem no calculo de comissao. deInteiro() nao barra
  // negativos — ele so atesta que o numero e inteiro —, entao a barreira e
  // aqui.
  if (frete < 0) {
    throw new Error(`Frete nao pode ser negativo, recebido ${frete}`)
  }

  // O desconto nunca ultrapassa o subtotal: a constraint
  // pedido_desconto_nao_excede rejeitaria, e um total negativo nao existe.
  const descontoAplicado = Math.min(desconto, subtotal) as Centavos

  return {
    linhas,
    subtotal,
    desconto: descontoAplicado,
    frete,
    // ESTA FORMULA E A MESMA DA CONSTRAINT pedido_total_confere
    // (migrations/1754900300000_pedidos.sql): total = subtotal - desconto +
    // frete. Divergir dela nao produz um total errado em producao, produz um
    // INSERT recusado pelo Postgres no meio da transacao do checkout — que e o
    // fim certo, mas so depois de o comprador ter preenchido tudo.
    //
    // O frete e somado DEPOIS do desconto, e o desconto continua limitado ao
    // subtotal (nunca ao subtotal + frete): cupom e abatimento sobre produto, e
    // um cupom maior que o carrinho nao pode zerar o que a transportadora vai
    // cobrar da Milagran de qualquer jeito. Mesma base de calculo de
    // calcularComissao em src/lib/money.ts, que tambem exclui frete.
    total: (subtotal - descontoAplicado + frete) as Centavos,
  }
}
