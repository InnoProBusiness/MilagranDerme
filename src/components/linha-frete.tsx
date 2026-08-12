/**
 * A UNICA fonte do que qualquer tela diz sobre frete.
 *
 * DIVIDA DELIBERADA (nao "consertar"): a politica de frete ainda nao foi
 * decidida pelo cliente. Enquanto nao for, toda superficie diz "a definir" —
 * nunca "R$ 0,00", que seria uma promessa de frete gratis que ninguem fez e
 * em cima da qual o comprador pode agir.
 *
 * POR QUE UM COMPONENTE, e nao a string repetida em cada tela: eram quatro
 * superficies mostrando frete do MESMO pedido — vitrine, passo 1 e passo 4 do
 * checkout, e a pagina de confirmacao. So a vitrine consultava a flag
 * `freteADefinir`; as outras tres tinham o texto escrito na mao. Bastava
 * alguem "virar a flag" para a loja mostrar R$ 0,00 e as outras telas
 * continuarem dizendo "a definir" sobre a mesma compra. Com um componente so,
 * nao existe divergencia possivel: as quatro renderizam o mesmo no.
 *
 * QUANDO O FRETE FOR REAL: nao existe interruptor para virar. E preciso
 * calcular o valor, gravar em pedidos.frete_centavos (a coluna ja existe) e
 * substituir este componente por um que receba o valor calculado — e ai as
 * quatro telas mudam juntas, por construcao.
 */
export const TEXTO_FRETE_A_DEFINIR = 'A definir — em breve'

export function LinhaFrete() {
  return (
    <p className="vitrine__linha" data-testid="frete">
      Frete: {TEXTO_FRETE_A_DEFINIR}
    </p>
  )
}
