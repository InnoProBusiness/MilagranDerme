/**
 * A UNICA fonte do que qualquer tela diz sobre a situacao ANVISA do kit.
 *
 * Mesmo motivo de existir de src/components/linha-frete.tsx, aprendido no
 * mesmo projeto: eram DUAS superficies (a home, na secao "O que vem no kit",
 * e a vitrine de /comprar) com a frase escrita a mao em cada uma. Bastava a
 * situacao mudar — e em 18/08/2026 ela mudou — para alguem atualizar uma tela
 * e esquecer a outra, e a loja afirmar duas coisas diferentes sobre o mesmo
 * produto na mesma sessao de compra.
 *
 * OS TRES ESTADOS, e por que a ordem de precedencia e esta:
 *
 *   1. `registro` preenchido -> mostra o numero. Vence a dispensa de
 *      proposito: se um dia a Milagran registrar o produto (porque a linha
 *      deixou de se enquadrar como artesanal, por exemplo), o numero emitido
 *      e a informacao mais forte e mais verificavel que existe.
 *   2. `dispensado` -> a frase da Lei 15.154/2025. NAO e ausencia de dado:
 *      e um status legal DECLARADO PELO CLIENTE em 18/08/2026 e gravado em
 *      kits.anvisa_dispensado (migrations/1755500000000_anvisa_dispensa.sql,
 *      que documenta as condicoes da lei e onde a declaracao veio).
 *   3. nenhum dos dois -> "em breve", o estado honesto de quem ainda nao
 *      resolveu a situacao sanitaria. E o DEFAULT de um kit novo: dispensa e
 *      afirmacao juridica e nao nasce por esquecimento.
 *
 * A frase da dispensa cita a lei e nada alem dela. Nao promete "aprovado
 * pela Anvisa" (dispensa nao e aprovacao), nao esconde a agencia, e usa o
 * termo do proprio texto legal ("produzidos de maneira artesanal").
 */
export type SituacaoAnvisa = {
  registro: string | null
  dispensado: boolean
}

export const TEXTO_ANVISA_EM_BREVE = 'Registro ANVISA: em breve'

export const TEXTO_ANVISA_DISPENSADO =
  'Produto de fabricação artesanal, dispensado de registro na Anvisa nos termos da Lei nº 15.154/2025.'

export function textoAnvisa(s: SituacaoAnvisa): string {
  if (s.registro) return `Registro ANVISA: ${s.registro}`
  if (s.dispensado) return TEXTO_ANVISA_DISPENSADO
  return TEXTO_ANVISA_EM_BREVE
}

/**
 * O estado "em breve" e o unico que merece moldura de ATENCAO nas telas que
 * tem esse recurso (o bloco `.aviso--atencao` da home): e uma pendencia. Um
 * registro emitido e uma dispensa legal sao situacoes RESOLVIDAS — vesti-las
 * de alerta faria o comprador ler problema onde nao ha.
 */
export function situacaoPendente(s: SituacaoAnvisa): boolean {
  return !s.registro && !s.dispensado
}
