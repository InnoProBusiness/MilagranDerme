/**
 * OS CAMPOS DO PEDIDO — o nome de cada um, o passo em que ele mora e como
 * transformar uma recusa do servidor em algo que a compradora consegue agir.
 *
 * POR QUE ESTE ARQUIVO EXISTE (21/08/2026). POST /api/pedidos recusava corpo
 * invalido com `{ error: 'dados_invalidos' }` e MAIS NADA — sem `mensagem`,
 * sem dizer qual campo. O checkout, que so sabe ler `mensagem`, caia no texto
 * de ultimo recurso: "Não foi possível concluir o pedido. Confira os dados e
 * tente novamente." Quatro passos de formulario, onze campos, e a instrucao era
 * "confira os dados".
 *
 * O caso real que trouxe isto a tona veio de aparelhos iOS. A tela e o servidor
 * validavam e-mail por REGRAS DIFERENTES — a tela por um regex simples, o
 * servidor pelo `z.string().email()` do Zod —, e existe uma faixa de enderecos
 * que a primeira aceita e o segundo recusa. `ana@gmail.com.` com o ponto final
 * que o teclado do iOS acrescenta e o exemplo mais comum. O "Ir para o
 * pagamento" ficava habilitado, o POST saia, voltava 422 mudo, e a pessoa
 * relia os quatro campos sem achar nada errado — porque, pelas regras da TELA,
 * nao havia nada errado. Nao havia caminho de saida.
 *
 * A LICAO, e o motivo de o arquivo ser compartilhado: enquanto o servidor for a
 * fonte de verdade — e ele tem que ser —, a tela precisa saber TRADUZIR a
 * recusa dele para o campo certo. Igualar os dois validadores nao resolve; eles
 * vao divergir de novo no proximo detalhe. O que resolve e o servidor dizer QUAL
 * campo, nesta lista de nomes, e a tela saber onde esse nome mora.
 */

/**
 * O nome do campo COMO ESTA ESCRITO NA TELA.
 *
 * Este mapa e lido pelos DOIS lados: o servidor monta a frase da recusa com ele
 * (src/app/api/pedidos/route.ts) e o checkout destaca o campo com ele
 * (src/components/checkout-wizard.tsx). Duas copias divergiriam no dia em que um
 * rotulo mudasse, e o sintoma seria a mensagem do servidor mandando conferir um
 * campo com nome que nao existe na tela.
 */
export const ROTULO_DO_CAMPO: Readonly<Record<string, string>> = {
  nome: 'Nome completo',
  email: 'E-mail',
  cpf: 'CPF',
  whatsapp: 'WhatsApp',
  cep: 'CEP',
  estado: 'Estado (UF)',
  rua: 'Rua',
  numero: 'Número',
  complemento: 'Complemento',
  bairro: 'Bairro',
  cidade: 'Cidade',
  cupom: 'Cupom de desconto',
  quantidade: 'Quantidade',
}

export function rotuloDoCampo(campo: string): string {
  return ROTULO_DO_CAMPO[campo] ?? campo
}

/**
 * EM QUAL PASSO DO WIZARD O CAMPO MORA.
 *
 * E o que permite a tela LEVAR a pessoa ate o campo recusado, e nao so avisar
 * que ele existe: a recusa chega no passo 4, e o e-mail esta no 2. Sem este
 * mapa, "confira o e-mail" no passo da revisao seria mais um beco — o campo
 * nem esta montado ali.
 *
 * Campos sem passo (`cupom`, `quantidade`, `kitSlug`, `idServico`,
 * `tipoEntrega`) ficam de fora de proposito: ou pertencem ao proprio passo 4,
 * ou nao sao campo de formulario nenhum.
 */
export const PASSO_DO_CAMPO: Readonly<Record<string, number>> = {
  nome: 2,
  email: 2,
  cpf: 2,
  whatsapp: 2,
  cep: 3,
  estado: 3,
  rua: 3,
  numero: 3,
  complemento: 3,
  bairro: 3,
  cidade: 3,
}

/** "A", "A e B", "A, B e C" — lista humana, com o "e" do portugues no fim. */
export function listarCampos(rotulos: readonly string[]): string {
  if (rotulos.length <= 1) return rotulos[0] ?? ''
  return `${rotulos.slice(0, -1).join(', ')} e ${rotulos[rotulos.length - 1]}`
}

/**
 * A forma MINIMA de um issue do Zod que interessa aqui.
 *
 * Declarada a mao, e nao importada de `zod`, por dois motivos. O primeiro e
 * que este modulo e importado pelo CHECKOUT, que roda no navegador: puxar o
 * pacote junto so pelo tipo seria peso no bundle por nada. O segundo e que a
 * unica coisa de que a funcao precisa e `path` — depender da forma inteira do
 * issue amarraria este arquivo a versao do Zod sem ganhar checagem nenhuma.
 */
type IssueComCaminho = { readonly path: ReadonlyArray<PropertyKey> }

/**
 * QUAIS CAMPOS o Zod recusou, na ordem em que ele os reportou e sem repetir.
 *
 * IGNORA ISSUE SEM CAMINHO, e essa e a parte que importa: `.strict()` recusa
 * campo desconhecido com `path` VAZIO (o defeito e do corpo inteiro, nao de um
 * campo), e um `String(undefined)` ali dentro produziria o campo "undefined" na
 * mensagem que a compradora le. Quem chama trata a lista vazia como "nao da
 * para apontar campo nenhum" — ver `mensagemDeCamposInvalidos`.
 */
export function camposDoErroZod(issues: ReadonlyArray<IssueComCaminho>): string[] {
  const campos: string[] = []
  for (const issue of issues) {
    const primeiro = issue.path[0]
    if (typeof primeiro !== 'string' || primeiro === '') continue
    if (!campos.includes(primeiro)) campos.push(primeiro)
  }
  return campos
}

/**
 * A FRASE que vai no `mensagem` da resposta 422.
 *
 * NAO DIZ POR QUE o valor foi recusado, e a omissao e deliberada: o servidor
 * sabe que `email` falhou, nao sabe traduzir "falhou o regex do Zod" em algo
 * util, e inventar um motivo ("formato invalido") seria pior que apontar o
 * campo e deixar a pessoa reler o que digitou. Apontar o campo ja e a diferenca
 * entre onze campos para conferir e um.
 *
 * CAMPO DESCONHECIDO NAO ENTRA NA FRASE. Se o Zod recusou `idServico` ou
 * `tipoEntrega`, a compradora nao tem o que corrigir — sao campos que a tela
 * preenche sozinha, e nomea-los mandaria alguem procurar um campo inexistente.
 * O desfecho honesto ali e recarregar a pagina.
 */
export function mensagemDeCamposInvalidos(campos: readonly string[]): string {
  const conhecidos = campos.filter((c) => c in ROTULO_DO_CAMPO)

  if (conhecidos.length === 0) {
    return 'Não foi possível concluir o pedido com os dados enviados. '
      + 'Atualize a página e preencha o checkout de novo.'
  }

  const lista = listarCampos(conhecidos.map(rotuloDoCampo))
  return conhecidos.length === 1
    ? `Confira o campo ${lista}: o valor enviado não foi aceito.`
    : `Confira os campos ${lista}: os valores enviados não foram aceitos.`
}
