import { formatarBRL, type Centavos } from '@/lib/money'

/**
 * A UNICA fonte do que qualquer tela diz sobre frete.
 *
 * POR QUE UM COMPONENTE, e nao a string repetida em cada tela (a historia que
 * deu origem a este arquivo, e que continua valendo): eram quatro superficies
 * mostrando frete do MESMO pedido — vitrine, passo 1 e passo 4 do checkout, e a
 * pagina de confirmacao. So a vitrine consultava a flag `freteADefinir`; as
 * outras tres tinham o texto escrito na mao. Bastava alguem "virar a flag" para
 * a loja mostrar R$ 0,00 e as outras tres telas continuarem dizendo "a definir"
 * sobre a mesma compra. Com um componente so, nao existe divergencia possivel:
 * as quatro renderizam o mesmo no.
 *
 * DIVIDA PAGA EM 16/08/2026 — este bloco e o antigo "DIVIDA DELIBERADA: a
 * politica de frete ainda nao foi decidida pelo cliente" ATUALIZADO, nao um
 * comentario novo. A ausencia de valor era uma decisao, e ela foi revogada por
 * outra decisao, nao por esquecimento:
 *
 *   - O QUE ERA: enquanto nao havia politica, toda superficie dizia
 *     "A definir — em breve". Nunca "R$ 0,00", que seria promessa de frete
 *     gratis que ninguem fez e em cima da qual o comprador pode agir.
 *   - O QUE MUDOU: o cliente escolheu a API do Clube Envios (§13 do documento
 *     de 16/08/2026). Existe politica, existe cotacao e existe valor, entao o
 *     componente passou a RECEBER o valor em vez de anunciar sua ausencia.
 *   - O QUE NAO MUDOU, e e a razao de existir deste arquivo: **nunca imprimir
 *     "R$ 0,00" quando nao ha valor.** Zero e um numero legitimo (venda
 *     presencial, §10: o comprador leva o kit na mao e nao ha frete a somar) e
 *     "ainda nao cotado" e um ESTADO DIFERENTE — por isso ele nao e zero aqui,
 *     e `null`. Um interruptor virado por engano faria a loja prometer frete
 *     gratis que ninguem decidiu; nao ha interruptor.
 *
 * `valor` E OBRIGATORIO DE PROPOSITO, mesmo aceitando `null`. Era exatamente
 * isso que o comentario antigo prometia para o dia em que o frete fosse real:
 * "e ai as quatro telas mudam juntas, por construcao". Uma prop opcional
 * deixaria uma tela esquecida renderizar o texto de "a cotar" para sempre, em
 * silencio; obrigatoria, o compilador aponta cada superficie e cada uma decide
 * conscientemente entre um valor cotado e o `null` de quem nao tem CEP para
 * cotar (a vitrine).
 */
export const TEXTO_FRETE_A_COTAR = 'Calculado no checkout, a partir do seu CEP'

/**
 * O que esta linha diz quando nao ha transporte a cobrar porque nao ha
 * transporte. Nao e "Frete: R$ 0,00" — esse texto, sozinho, e lido como frete
 * gratis promocional, e frete gratis e uma promessa que a Milagran nao fez.
 */
export const TEXTO_RETIRADA_SEM_FRETE = 'Retirada no local — sem frete'

type Props = {
  valor: Centavos | null
  prazoDias?: number | null
  /**
   * O pedido e retirada no local?
   *
   * OBRIGATORIA, e pelo mesmo motivo escrito acima para `valor`: sem isto, uma
   * tela esquecida imprimiria "Frete: R$ 0,00" para quem vai buscar o kit —
   * numero verdadeiro (o frete E zero) e frase enganosa, porque quem le
   * entende frete gratis num envio. Obrigatoria, o compilador aponta cada
   * superficie e cada uma declara o que aquele pedido e.
   *
   * ELA GANHA DE `valor`. Um pedido de retirada tem valor zero E tipo
   * retirada; se as duas informacoes disputassem, a tela imprimiria o numero e
   * perderia o motivo. Por isso a verificacao vem primeiro no corpo.
   */
  retirada: boolean
}

/**
 * Prazo e ESTIMATIVA do transportador (src/lib/frete.ts, campo `prazoDias` de
 * OpcaoDeFrete), nunca promessa de data — dai "prazo estimado" no texto.
 *
 * Devolve null para qualquer numero que nao descreva um prazo de verdade
 * (zero, negativo, fracionario, NaN vindo de um JSON malformado). Mesma
 * disciplina do valor: sem dado confiavel, a tela cala em vez de escrever
 * "prazo estimado: 0 dias úteis", que soa como entrega no mesmo dia.
 */
function textoDePrazo(prazoDias: number | null | undefined): string | null {
  if (prazoDias == null || !Number.isFinite(prazoDias)) return null
  const dias = Math.trunc(prazoDias)
  if (dias < 1) return null
  return dias === 1 ? 'prazo estimado: 1 dia útil' : `prazo estimado: ${dias} dias úteis`
}

export function LinhaFrete({ valor, prazoDias, retirada }: Props) {
  // PRIMEIRO DE TUDO, antes ate do teste de `valor`: numa retirada nao ha frete
  // a cotar nem a exibir, entao nem "a cotar" nem "R$ 0,00" descrevem o que
  // esta acontecendo. Ver TEXTO_RETIRADA_SEM_FRETE.
  if (retirada) {
    return (
      <p className="vitrine__linha" data-testid="frete">
        {TEXTO_RETIRADA_SEM_FRETE}
      </p>
    )
  }

  // `== null` (frouxo) e nao `=== null`: pega tambem o `undefined` de um
  // chamador que ainda nao foi atualizado para passar a prop. O compilador
  // continua cobrando o argumento — a obrigatoriedade da prop e a garantia de
  // verdade —, mas se um render escapar em desenvolvimento a tela mostra "a
  // cotar" em vez de "R$ NaN", que seria pior do que dizer que ainda nao
  // cotamos.
  if (valor == null) {
    return (
      <p className="vitrine__linha" data-testid="frete">
        Frete: {TEXTO_FRETE_A_COTAR}
      </p>
    )
  }

  const prazo = textoDePrazo(prazoDias)

  return (
    <p className="vitrine__linha" data-testid="frete">
      Frete: {formatarBRL(valor)}
      {prazo && ` (${prazo})`}
    </p>
  )
}
