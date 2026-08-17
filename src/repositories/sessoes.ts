import { getDb } from '@/lib/db'
import { DURACAO_SESSAO_MS, gerarTokenDeSessao, hashDoToken } from '@/lib/sessao'
import type { Usuario } from '@/repositories/usuarios'

/**
 * O que uma sessao valida entrega a quem perguntou: a pessoa e ate quando o
 * cracha dela vale.
 *
 * `expiraEm` volta junto porque quem chama precisa dele para reemitir o cookie
 * com a mesma validade (src/app/api/sessao/route.ts) — nao para decidir se a
 * sessao vale. Essa decisao ja foi tomada aqui dentro, contra o relogio do
 * servidor: um cliente que devolvesse um `expiraEm` adulterado nao ganharia
 * nada, porque a proxima chamada a sessaoValida compara com o banco de novo.
 */
export type SessaoAtiva = {
  usuario: Usuario
  expiraEm: Date
}

/**
 * Abre uma sessao para o usuario e devolve o TOKEN CRU — a unica vez, na vida
 * inteira daquele token, em que ele existe fora do cookie do navegador.
 *
 * O banco recebe so `hashDoToken(token)` (src/lib/sessao.ts). Um vazamento de
 * backup entrega a coluna token_hash, e hash nao volta a virar cookie: ninguem
 * se autentica com o conteudo do dump. O motivo esta escrito tambem na
 * migration (1755300300000_usuarios_sessoes.sql), porque e o tipo de decisao
 * que alguem "otimiza" guardando o token cru para depurar com mais conforto
 * — e ai a coluna vira uma lista de sessoes de administrador prontas para uso.
 *
 * NAO CONFERE NADA sobre o usuario: quem autentica e `autenticar`
 * (src/repositories/usuarios.ts), quem chama as duas em sequencia e a rota
 * POST /api/sessao. Esta funcao emite o cracha de quem ja provou quem e.
 *
 * `criado_em` E GRAVADO EXPLICITAMENTE com o mesmo `agora` que gera
 * `expira_em`, em vez de deixar o DEFAULT now() do banco. Sem isso, um
 * chamador que passasse um `agora` no passado (os testes fazem exatamente isso
 * para produzir uma sessao ja vencida sem esperar 12 horas) gravaria
 * expira_em <= criado_em e levaria uma violacao de sessao_janela_coerente — um
 * erro de banco no lugar do que ele quis dizer. Com os dois carimbos vindos da
 * mesma fonte, a janela e sempre coerente e o CHECK continua guardando o que
 * ele foi feito para guardar: um erro de sinal em DURACAO_SESSAO_MS.
 */
export async function abrirSessao(
  usuarioId: string,
  agora: Date = new Date(),
): Promise<{ token: string; expiraEm: Date }> {
  const token = gerarTokenDeSessao()
  const expiraEm = new Date(agora.getTime() + DURACAO_SESSAO_MS)

  await getDb()
    .insertInto('sessoes')
    .values({
      usuario_id: usuarioId,
      token_hash: hashDoToken(token),
      criado_em: agora,
      expira_em: expiraEm,
    })
    .execute()

  return { token, expiraEm }
}

/**
 * Responde "este cookie ainda vale?" — e e a UNICA autoridade sobre isso. O
 * token e opaco de proposito (nao carrega usuario, papel nem validade), entao
 * nao existe caminho que dispense esta consulta.
 *
 * TRES CONDICOES, TODAS NO MESMO WHERE, todas necessarias:
 *
 *  - `revogada_em IS NULL` — logout e "derrubar o celular perdido" tem que ter
 *    efeito na requisicao seguinte. Se a revogacao fosse conferida na
 *    aplicacao, um caminho que esquecesse de conferir seria uma porta aberta;
 *    no WHERE, a linha simplesmente nao volta.
 *  - `expira_em > agora` — comparado com o relogio do SERVIDOR, nunca com o
 *    Max-Age do cookie. O cookie e a copia da validade que esta na mao de quem
 *    pode edita-la.
 *  - `usuarios.ativo = true` — desativar um vendedor no meio do evento derruba
 *    a sessao que ele ja tem aberta no celular, sem precisar achar o registro
 *    dela. E a diferenca entre "desliguei o acesso da pessoa" e "desliguei o
 *    acesso da pessoa daqui a 12 horas". Note que isso e avaliado A CADA
 *    requisicao: reativar a conta faz a sessao antiga (se ainda nao expirou)
 *    voltar a valer. Quando a intencao e encerrar de vez, o que se usa e
 *    revogarSessoesDoUsuario, abaixo.
 *
 * O join com `usuarios` seleciona coluna por coluna e NUNCA selectAll: um
 * `selectAll()` aqui traria senha_hash para dentro do objeto que atravessa
 * guarda.ts, as rotas de admin e o HTML dos Server Components — ver o
 * comentario de COLUNAS_PUBLICAS em src/repositories/usuarios.ts.
 */
export async function sessaoValida(
  token: string,
  agora: Date = new Date(),
): Promise<SessaoAtiva | null> {
  // Cookie presente e vazio nao vira consulta: hashDoToken('') e um sha256
  // perfeitamente valido de string vazia, e a busca por ele so gastaria uma
  // ida ao Postgres por requisicao para achar nada. tokenDoCookie
  // (src/lib/sessao.ts) ja devolve null nesse caso; esta linha cobre quem
  // chegar por outro caminho.
  if (token === '') return null

  const linha = await getDb()
    .selectFrom('sessoes')
    .innerJoin('usuarios', 'usuarios.id', 'sessoes.usuario_id')
    .select([
      'sessoes.expira_em as expira_em',
      'usuarios.id as usuario_id',
      'usuarios.nome as usuario_nome',
      'usuarios.email as usuario_email',
      'usuarios.papel as usuario_papel',
      'usuarios.ativo as usuario_ativo',
    ])
    // Lookup pelo indice unico sessao_token_unico, que existe tanto para
    // impedir dois registros com o mesmo hash quanto para ser este caminho de
    // leitura — ele e percorrido em toda requisicao autenticada.
    .where('sessoes.token_hash', '=', hashDoToken(token))
    .where('sessoes.revogada_em', 'is', null)
    .where('sessoes.expira_em', '>', agora)
    .where('usuarios.ativo', '=', true)
    .executeTakeFirst()

  if (!linha) return null

  return {
    usuario: {
      id: linha.usuario_id,
      nome: linha.usuario_nome,
      email: linha.usuario_email,
      papel: linha.usuario_papel,
      ativo: linha.usuario_ativo,
    },
    expiraEm: linha.expira_em,
  }
}

/**
 * Encerra UMA sessao (o "sair" da tela, DELETE /api/sessao).
 *
 * CARIMBA `revogada_em` em vez de apagar a linha: "esta sessao existiu e foi
 * encerrada as 14h32" e informacao de auditoria, "nao ha linha nenhuma" nao e.
 * A migration registra a mesma decisao na propria coluna.
 *
 * `WHERE revogada_em IS NULL` faz a operacao idempotente NO SENTIDO QUE
 * IMPORTA: chamar de novo nao move o carimbo para frente. O instante que vale
 * e o da primeira revogacao — reescreve-lo a cada clique em "sair" apagaria
 * justamente o dado que a coluna existe para guardar.
 *
 * Nao lanca nem sinaliza quando o token nao existe: apagar um cookie que ja
 * nao vale e o caso normal de um logout repetido, e devolver erro ali so
 * transformaria uma nao-acao em um oraculo de "este token existe".
 *
 * Apagar o cookie no navegador (cookieDeLogout, src/lib/sessao.ts) e a metade
 * visivel do logout; a que vale e esta, porque quem ja copiou o token nao e
 * afetado por nada que o navegador faca.
 */
export async function revogarSessao(token: string, agora: Date = new Date()): Promise<void> {
  if (token === '') return

  await getDb()
    .updateTable('sessoes')
    .set({ revogada_em: agora })
    .where('token_hash', '=', hashDoToken(token))
    .where('revogada_em', 'is', null)
    .execute()
}

/**
 * Derruba TODAS as sessoes abertas de uma pessoa. E a acao de emergencia:
 * celular perdido no evento, desligamento no meio do expediente, suspeita de
 * senha vazada. O indice sessoes_usuario existe por causa desta consulta —
 * "derrubar tudo desta pessoa" nao pode depender de varredura da tabela.
 *
 * SEM guarda de formato de uuid, ao contrario de buscarUsuarioPorId
 * (src/repositories/usuarios.ts), e a assimetria e proposital: la, um id
 * malformado significa "nao achei" e null e a resposta honesta; aqui, um id
 * malformado significa que a emergencia NAO foi executada, e uma funcao que
 * devolve void em silencio nesse caso mentiria dizendo "pronto, derrubei" para
 * quem esta com o celular do vendedor perdido na mao. Erro do Postgres, alto e
 * claro, e o comportamento certo.
 *
 * Complementa `usuarios.ativo = false` em vez de substitui-lo: desativar ja
 * invalida as sessoes enquanto a conta estiver desligada (ver sessaoValida),
 * mas reativar a pessoa amanha faria as sessoes antigas ainda dentro das 12
 * horas voltarem a valer. Revogar e definitivo — o token nunca mais vale, com
 * a conta ativa ou nao.
 */
export async function revogarSessoesDoUsuario(usuarioId: string): Promise<void> {
  await getDb()
    .updateTable('sessoes')
    .set({ revogada_em: new Date() })
    .where('usuario_id', '=', usuarioId)
    .where('revogada_em', 'is', null)
    .execute()
}
