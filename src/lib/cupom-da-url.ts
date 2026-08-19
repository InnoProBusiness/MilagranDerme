/**
 * Le o codigo de cupom da query string de um link de campanha
 * (`/?cupom=CODIGO` ou `/checkout?cupom=CODIGO`).
 *
 * POR QUE UM MODULO, e nao duas linhas repetidas nas duas paginas: a home e
 * /checkout montam o mesmo `CheckoutWizard`, e um link de campanha tem que
 * funcionar igual nos dois. Copiar a normalizacao seria abrir a porta para
 * `?cupom=lancamento` valer numa tela e nao valer na outra — a mesma classe
 * de divergencia que src/components/linha-frete.tsx e src/lib/anvisa.ts
 * existem para impedir.
 *
 * O QUE ISTO NAO E: concessao de desconto. O retorno daqui PREENCHE UM CAMPO
 * DE TEXTO na tela. Quem decide se ha desconto, e de quanto, e sempre o
 * servidor: `resgatarCupom` (src/repositories/cupons.ts) le a linha do cupom
 * sob `FOR UPDATE` dentro da transacao do pedido, confere janela de validade,
 * limite total, limite por cliente e se o representante dono do cupom ainda
 * esta ativo. Uma URL com um codigo inventado nao desconta um centavo — cai
 * no mesmo 422 de quem digitou errado no formulario.
 *
 * NORMALIZACAO, e por que cada regra existe:
 *
 *   - MAIUSCULAS. O CHECK `cupom_codigo_formato` do banco
 *     (migrations/1755000200000_cupons.sql) so aceita codigo em caixa alta,
 *     entao `?cupom=lancamento` precisa virar `LANCAMENTO` — senao o link
 *     compartilhado em minusculas (o que todo aplicativo de mensagem faz ao
 *     encurtar) simplesmente nao acharia o cupom.
 *   - LIMITE DE 24 CARACTERES. E o mesmo teto do schema Zod de
 *     POST /api/pedidos. Cortar aqui evita que uma URL absurda encha o campo
 *     da tela com lixo antes de o servidor recusar.
 *   - VAZIO VIRA VAZIO. Sem parametro, parametro em branco, ou so espacos: o
 *     campo nasce vazio e o checkout se comporta como sempre.
 *
 * `searchParams` chega como `string | string[] | undefined` porque o Next
 * entrega array quando o parametro aparece repetido (`?cupom=A&cupom=B`).
 * Nesse caso vale o PRIMEIRO — um link malformado nao pode virar erro de
 * runtime numa pagina de venda.
 */
export const TAMANHO_MAXIMO_CUPOM = 24

export function cupomDaUrl(valor: string | string[] | undefined): string {
  const bruto = Array.isArray(valor) ? valor[0] : valor
  if (typeof bruto !== 'string') return ''
  return bruto.trim().toUpperCase().slice(0, TAMANHO_MAXIMO_CUPOM)
}
