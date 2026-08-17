import { cookies } from 'next/headers'
import { NOME_COOKIE_SESSAO, tokenDoCookie } from '@/lib/sessao'
import { sessaoValida } from '@/repositories/sessoes'
import type { PapelUsuario, Usuario } from '@/repositories/usuarios'

/**
 * O CONTROLE DE ACESSO DO PROJETO INTEIRO MORA AQUI, e mora num lugar so de
 * proposito.
 *
 * Sao onze rotas e cinco telas atras de sessao (§17 do documento de
 * 16/08/2026). Uma checagem copiada para onze arquivos e uma checagem que uma
 * hora vai faltar em um deles — e o arquivo que esquecer nao fica vermelho em
 * teste nenhum, porque continua respondendo 200 para quem chamou. Com a
 * decisao concentrada nestas tres funcoes, a pergunta "quem pode ver isto?"
 * tem uma resposta unica, e o teste de src/app/api/__tests__/admin-guarda.test.ts
 * percorre as rotas exigindo que todas passem por ela.
 *
 * Nada aqui decide se a senha esta certa (isso e `autenticar`,
 * src/repositories/usuarios.ts) nem se o token ainda vale (isso e
 * `sessaoValida`, src/repositories/sessoes.ts). Este arquivo so traduz "quem e
 * o dono deste cookie" em "pode ou nao pode", e devolve a recusa no formato
 * que a camada HTTP entende.
 *
 * O TOKEN NUNCA E LOGADO em nenhuma das funcoes abaixo. Um token em log de
 * aplicacao e uma sessao de administrador aberta para quem tiver acesso ao
 * log, que e um conjunto de pessoas bem maior do que o de quem tem senha de
 * admin — o mesmo cuidado que vale para `error.detail` do Postgres
 * (src/repositories/clientes.ts) vale aqui.
 */

/**
 * QUEM ENXERGA O QUE. `admin` alcanca tudo que `vendedor` alcanca; o contrario
 * nao vale.
 *
 * Poderia ser um `if (papel === 'admin') return true`, e seria pior: no dia em
 * que o ENUM papel_usuario ganhar um valor novo — a propria migration
 * 1755300300000_usuarios_sessoes.sql cita 'expedicao' como exemplo — o `if`
 * continuaria compilando e o papel novo simplesmente nao teria acesso a nada,
 * em silencio, ate alguem descobrir na cara do usuario. Como Record<PapelUsuario, ...>,
 * o valor novo QUEBRA A COMPILACAO deste arquivo e obriga a decisao a ser
 * tomada aqui, por escrito. E para isso que PapelUsuario e reexportado do ENUM
 * em vez de redeclarado (ver src/repositories/usuarios.ts).
 *
 * Le-se: "quem tem o papel X atende as exigencias da lista Y". Um papel novo
 * que nao deva herdar nada se descreve com uma lista de um elemento so.
 */
const COBERTURA: Record<PapelUsuario, readonly PapelUsuario[]> = {
  admin: ['admin', 'vendedor'],
  vendedor: ['vendedor'],
}

/**
 * LISTA VAZIA RECUSA TODO MUNDO, nunca libera geral. `some()` sobre um array
 * vazio e false, e isso e a escolha certa: `exigirPapel(req, [])` so aparece
 * por engano (uma constante importada que virou undefined, um filtro que
 * esvaziou a lista), e nesses casos a falha tem que fechar a porta em vez de
 * abrir. Fail-closed e a regra de toda decisao deste arquivo.
 */
function papelAtende(papel: PapelUsuario, exigidos: readonly PapelUsuario[]): boolean {
  const alcance = COBERTURA[papel]
  return exigidos.some((exigido) => alcance.includes(exigido))
}

/**
 * O usuario dono do cookie desta requisicao, ou null.
 *
 * Le o header Cookie CRU com tokenDoCookie (src/lib/sessao.ts) — que separa os
 * pares pelo regex /;\s* (ponto-e-virgula seguido de espacos opcionais) e
 * nunca por '; ' literal. A armadilha do split literal ja
 * custou a comissao de representante em src/app/api/pedidos/route.ts (linhas
 * 117-125); aqui ela custaria um 401 no vendedor autenticado no meio da fila
 * do evento, sem nenhum log dizendo que o cookie chegou e nao foi lido.
 *
 * Devolve null tanto para "nao ha cookie" quanto para "o cookie nao vale mais"
 * (expirado, revogado, usuario desativado). Quem chama nao precisa distinguir:
 * as duas coisas significam a mesma — nao ha sessao. Distinguir tambem seria
 * material de oraculo, pela mesma razao ja documentada em `autenticar`.
 */
export async function usuarioDaRequisicao(req: Request): Promise<Usuario | null> {
  const token = tokenDoCookie(req.headers.get('cookie'))
  if (token === null) return null

  const sessao = await sessaoValida(token)
  return sessao?.usuario ?? null
}

/**
 * Porta de entrada das rotas protegidas. Devolve o `Usuario` quando pode
 * passar, ou uma `Response` 401/403 JA PRONTA quando nao pode:
 *
 * ```ts
 * const usuario = await exigirPapel(req, ['admin'])
 * if (usuario instanceof Response) return usuario
 * ```
 *
 * A UNIAO `Usuario | Response` E A PARTE IMPORTANTE. Uma alternativa comum
 * seria devolver `{ ok: false, status: 403 }` e deixar a rota montar a
 * resposta — e ai cada rota escreveria seu proprio corpo, seu proprio codigo,
 * e uma delas escreveria 200 por engano. Pior: uma rota que ESQUECESSE de
 * tratar a recusa seguiria em frente com um objeto de recusa nas maos. Com a
 * uniao, esquecer nao compila — `usuario.papel` e erro de tipo enquanto o
 * `instanceof Response` nao estiver escrito. O compilador vira parte do
 * controle de acesso.
 *
 * 401 `nao_autenticado` = nao ha sessao valida (sem cookie, expirada, revogada
 * ou usuario desativado). 403 `acesso_negado` = ha sessao valida, mas o papel
 * nao alcanca. A diferenca aqui NAO e oraculo de nada: quem leva 403 ja provou
 * quem e, entao a resposta so conta a ele o que ele mesmo ja sabe. O 401
 * tambem nao distingue os quatro motivos, pelo mesmo raciocinio de
 * `autenticar` (src/repositories/usuarios.ts).
 *
 * `Cache-Control: no-store` nas duas: resposta de controle de acesso depende
 * de QUEM pediu, e um cache compartilhado na frente da aplicacao guarda por
 * URL. Sem o cabecalho, um 403 guardado pode ser servido a um admin logado —
 * ou, o que e muito pior, o 200 de outro caminho pode ser servido a quem nunca
 * se autenticou.
 */
export async function exigirPapel(
  req: Request,
  papeis: readonly PapelUsuario[],
): Promise<Usuario | Response> {
  const usuario = await usuarioDaRequisicao(req)

  if (!usuario) {
    return Response.json({ error: 'nao_autenticado' }, {
      status: 401,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  if (!papelAtende(usuario.papel, papeis)) {
    return Response.json({ error: 'acesso_negado' }, {
      status: 403,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  return usuario
}

/**
 * A mesma leitura de sessao para os Server Components de /admin e /venda, que
 * nao recebem `Request` nenhum — quem entrega o cookie ali e `cookies()` de
 * next/headers.
 *
 * E O UNICO LUGAR DO PROJETO QUE NAO USA tokenDoCookie, e o motivo e que aqui
 * nao ha header cru para separar: o Next ja fez o parse e entrega os pares
 * prontos. A regra do valor vazio, por outro lado, e repetida de proposito —
 * um cookie presente e vazio viraria uma consulta ao banco por um hash que
 * nunca existiu, exatamente o que tokenDoCookie evita do outro lado.
 *
 * DEVOLVE null, NAO REDIRECIONA. Quem decide o que fazer com "nao ha sessao" e
 * a pagina: /admin manda para /entrar, /venda manda para /entrar, e uma tela
 * futura pode simplesmente esconder um bloco. Um redirect() aqui dentro
 * tomaria essa decisao para todas elas e ainda tornaria a funcao impossivel de
 * usar em qualquer contexto que nao seja render de pagina.
 *
 * Uma tela que apenas ESCONDE conteudo com base neste retorno nao esta
 * protegida: os dados de admin so podem ser buscados depois da checagem, e
 * toda rota HTTP que sirva esses mesmos dados precisa passar por exigirPapel
 * por conta propria.
 */
export async function usuarioDaSessaoNoServidor(): Promise<Usuario | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(NOME_COOKIE_SESSAO)?.value ?? ''
  if (token === '') return null

  const sessao = await sessaoValida(token)
  return sessao?.usuario ?? null
}
