import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import { getDb } from '@/lib/db'
import type { PapelUsuario } from '@/lib/db-types'
import { conferirSenha, gerarHashDeSenha } from '@/lib/senha'

/**
 * kysely-codegen ja gera a uniao literal a partir do ENUM papel_usuario
 * (migrations/1755300300000_usuarios_sessoes.sql): 'admin' | 'vendedor'.
 * Reexportar em vez de redeclarar e o que da a src/lib/guarda.ts uma
 * exaustividade verificada pelo compilador — o mapa COBERTURA de la e um
 * Record<PapelUsuario, ...>, entao acrescentar um papel novo ao ENUM
 * ('expedicao' e o exemplo citado na propria migration) quebra a compilacao
 * ate alguem decidir o que aquele papel enxerga, em vez de o papel novo
 * simplesmente nao ter acesso a nada em silencio. Mesmo motivo do reexport de
 * PedidoStatus em src/repositories/pedidos.ts.
 */
export type { PapelUsuario }

/**
 * O que o resto do sistema conhece de um usuario.
 *
 * `senha_hash` NAO APARECE AQUI, e a ausencia e o proposito do tipo. Toda
 * leitura desta tabela passa por este formato, entao o hash so pode vazar para
 * um log, para uma resposta HTTP ou para o HTML de um Server Component se
 * alguem escrever um `selectAll()` novo — e e por isso que nao existe nenhum
 * neste arquivo (ver COLUNAS_PUBLICAS abaixo). O hash nao e a senha, mas e
 * material de ataque offline: com ele em maos, quem vazou tenta dicionario a
 * vontade, sem rate limit e sem deixar rastro no servidor.
 */
export type Usuario = {
  id: string
  nome: string
  email: string
  papel: PapelUsuario
  ativo: boolean
}

/**
 * A LISTA E UMA SO, DE PROPOSITO. Cada consulta a `usuarios` neste arquivo
 * seleciona exatamente estas colunas; nenhuma usa `selectAll()`. Com a lista
 * repetida em cada query, bastava um copiar-e-colar distraido para uma delas
 * passar a trazer senha_hash junto e ninguem perceber — o tipo Usuario nao
 * reclamaria, porque uma propriedade a mais no objeto de origem nao e erro de
 * atribuicao em TypeScript quando o objeto vem de uma variavel.
 *
 * A unica leitura de senha_hash no sistema inteiro esta em `autenticar`,
 * abaixo, e o valor morre dentro da funcao.
 */
const COLUNAS_PUBLICAS = ['id', 'nome', 'email', 'papel', 'ativo'] as const

function paraUsuario(l: {
  id: string
  nome: string
  email: string
  papel: PapelUsuario
  ativo: boolean
}): Usuario {
  return { id: l.id, nome: l.nome, email: l.email, papel: l.papel, ativo: l.ativo }
}

// Formato de uuid, copiado de src/repositories/pedidos.ts pelo mesmo motivo de
// la: um id que nao parece uuid vira "invalid input syntax for type uuid" do
// Postgres — um 500 — em vez do null que o chamador espera. Aqui o chamador e
// uma rota de admin com o id vindo do caminho da URL, entao lixo na URL nao
// pode virar erro de servidor.
const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Hash valido, com os parametros de custo ATUAIS de src/lib/senha.ts, que nao
 * pertence a ninguem. Serve so para `autenticar` gastar exatamente o mesmo
 * tempo quando o e-mail nao existe (ver o comentario la embaixo).
 *
 * E gerado por gerarHashDeSenha, e nao montado a mao com "scrypt$16384$8$1$...",
 * de proposito: uma string literal aqui congelaria os parametros de hoje e, no
 * dia em que src/lib/senha.ts subir o custo, o e-mail inexistente passaria a
 * responder MAIS RAPIDO que o existente — o vazamento voltaria pela porta dos
 * fundos, sem nenhum teste ficar vermelho.
 *
 * A senha usada na geracao e aleatoria e descartada na mesma linha: nao ha
 * senha nenhuma que confira contra este hash, e mesmo que houvesse o resultado
 * da comparacao e ignorado.
 *
 * Cacheado por processo porque gerar custa um scrypt inteiro (16 MiB); a
 * conferencia contra ele custa outro, que e justamente o custo que se quer
 * pagar.
 */
let promessaDoHashDescartavel: Promise<string> | null = null

function hashDescartavel(): Promise<string> {
  promessaDoHashDescartavel ??= gerarHashDeSenha(randomBytes(32).toString('base64url'))
    .catch(() => {
      // Falhar aqui NAO pode virar excecao: o e-mail inexistente responderia
      // 500 enquanto o existente responde 401, que e exatamente o oraculo que
      // este hash existe para apagar. String vazia nao tem o formato que
      // conferirSenha espera e ela devolve false sem lancar (src/lib/senha.ts)
      // — o mesmo null de sempre, so mais rapido. Zerar o cache faz a proxima
      // tentativa gerar de novo, para que uma falha transitoria de memoria nao
      // deixe o processo inteiro sem a defesa de tempo.
      promessaDoHashDescartavel = null
      return ''
    })
  return promessaDoHashDescartavel
}

/**
 * Cadastra uma pessoa com acesso ao sistema. Chamada por
 * scripts/criar-usuario.mjs (`npm run usuario:criar`), que semeia o primeiro
 * admin — NAO existe seed de usuario em migration, porque senha em SQL
 * versionado fica no historico do git para sempre, inclusive depois de trocada
 * (a propria migration 1755300300000_usuarios_sessoes.sql registra isso).
 *
 * A senha em claro entra, e so o hash sai daqui: `senha` nunca e gravada,
 * logada nem devolvida.
 *
 * O E-MAIL NAO E NORMALIZADO nem aparado. Parece descuido e nao e: o CHECK
 * usuario_email_formato usa `[^@[:space:]]` dos dois lados do arroba, entao um
 * e-mail com espaco no comeco ou no fim (o caso classico de quem cola o valor
 * numa variavel de ambiente com um \n atras) e RECUSADO PELO BANCO, alto e
 * claro, no momento do cadastro. Um `.trim()` aqui esconderia o erro de
 * digitacao do operador e criaria a conta com um e-mail diferente do que ele
 * acha que digitou. A caixa e preservada como a pessoa escreveu — quem cuida
 * de "Maria@" e "maria@" serem a mesma conta e o indice unico
 * usuario_email_unico, sobre lower(email).
 *
 * NAO HA CLASSE DE ERRO PARA E-MAIL DUPLICADO, e isso e uma escolha: o unico
 * chamador de hoje e um script de operacao, onde a violacao de
 * usuario_email_unico ja e a mensagem certa na tela de quem rodou. Uma
 * verificacao previa em JavaScript seria pior — duas execucoes simultaneas
 * leriam "nao existe" ao mesmo tempo (mesma corrida documentada em
 * creditarComissao, src/repositories/comissoes.ts). No dia em que existir uma
 * rota de admin que cadastre usuario, e ali que entra a classe exportada e o
 * despacho por instanceof, no molde de CpfDivergenteError.
 */
export async function criarUsuario(e: {
  nome: string
  email: string
  senha: string
  papel: PapelUsuario
}): Promise<Usuario> {
  const senhaHash = await gerarHashDeSenha(e.senha)

  const linha = await getDb()
    .insertInto('usuarios')
    .values({ nome: e.nome, email: e.email, senha_hash: senhaHash, papel: e.papel })
    // `returning` com a mesma lista das leituras: um `returningAll()` aqui
    // devolveria o hash recem-gravado para o chamador — e o chamador de hoje e
    // um script que imprime o que recebe no terminal.
    .returning(COLUNAS_PUBLICAS)
    .executeTakeFirstOrThrow()

  return paraUsuario(linha)
}

/**
 * Confere e-mail e senha. Devolve o usuario ou null.
 *
 * UM UNICO null PARA TRES CASOS DIFERENTES — e-mail que nao existe, usuario
 * inativo e senha errada — e nada na resposta, na mensagem ou no tempo
 * distingue um do outro. Nao e simplificacao: distinguir e um oraculo de
 * existencia de conta. Quem descobre, por um 401 diferente, que
 * "fulano@milagran" TEM conta ali passa a ter um alvo — sabe em quem gastar
 * tentativa de senha, sabe para quem mandar phishing dizendo "sua conta
 * Milagran expirou" e, no caso do usuario desativado, descobre que a pessoa
 * foi desligada da empresa. E exatamente o mesmo raciocinio ja documentado por
 * extenso para CpfDivergenteError em src/app/api/pedidos/route.ts (linhas
 * 229-243), onde um 422 especifico revelaria que um e-mail pertence a um
 * cliente cadastrado; aqui o premio para quem consulta o oraculo e maior,
 * porque do outro lado ha uma sessao de administrador.
 *
 * A rota /api/sessao devolve um unico 401 `credenciais_invalidas` sobre este
 * null, sem campo `mensagem` — nao ha o que curar do lado de la se a diferenca
 * ja nao existe do lado de ca.
 *
 * O TEMPO TAMBEM E RESPOSTA. Sem o hash descartavel, o e-mail inexistente
 * voltaria em ~1ms (so a consulta) e o existente em ~60ms (a consulta mais o
 * scrypt): dois numeros que qualquer script mede em lote e que separam, com
 * precisao, quem tem conta de quem nao tem. Conferir a senha contra um hash
 * que nao e de ninguem custa o mesmo scrypt e apaga a diferenca. O usuario
 * inativo tambem paga o custo, porque a conferencia acontece ANTES da decisao
 * — mover o `if (!linha.ativo) return null` para cima devolveria o sinal de
 * tempo para o caso "esta pessoa foi desligada".
 */
export async function autenticar(email: string, senha: string): Promise<Usuario | null> {
  // Aquece o hash descartavel no COMECO, antes de saber se o e-mail existe.
  // Assim o custo de gera-lo (uma vez por processo) cai sobre a primeira
  // autenticacao qualquer que seja, e nao especificamente sobre a primeira que
  // erra o e-mail — senao a propria inicializacao preguicosa viraria, no
  // primeiro login do dia, o sinal de tempo que ela existe para apagar. A
  // promessa nunca rejeita (ver hashDescartavel), entao deixa-la pendente aqui
  // nao produz unhandled rejection quando o e-mail existe.
  const descartavel = hashDescartavel()

  const linha = await getDb()
    .selectFrom('usuarios')
    // A UNICA leitura de senha_hash do sistema. O valor nao sai desta funcao:
    // nao vai para o retorno, nao vai para log, nao vai para excecao.
    .select([...COLUNAS_PUBLICAS, 'senha_hash'])
    // lower(email) dos dois lados, servido pelo indice usuario_email_unico
    // (que e sobre lower(email) justamente para ser tambem o caminho de
    // leitura do login). Mesma forma usada em salvarClienteComEndereco,
    // src/repositories/clientes.ts.
    .where(sql<boolean>`lower(email) = lower(${email})`)
    .executeTakeFirst()

  const senhaConfere = await conferirSenha(senha, linha?.senha_hash ?? (await descartavel))

  // As tres recusas saem pela MESMA porta, e a ordem das condicoes aqui nao
  // importa para o resultado — importa que todas sejam avaliadas depois de a
  // senha ja ter sido conferida.
  if (!linha || !linha.ativo || !senhaConfere) return null

  return paraUsuario(linha)
}

/**
 * Le um usuario pelo id. Usado por src/lib/guarda.ts e pelas telas de admin.
 *
 * Devolve null para id malformado em vez de deixar o Postgres lancar: uma URL
 * de admin com o id digitado errado tem que dar 404, nao 500.
 */
export async function buscarUsuarioPorId(id: string): Promise<Usuario | null> {
  if (!FORMATO_UUID.test(id)) return null

  const linha = await getDb()
    .selectFrom('usuarios')
    .select(COLUNAS_PUBLICAS)
    .where('id', '=', id)
    .executeTakeFirst()

  return linha ? paraUsuario(linha) : null
}

/**
 * Todas as pessoas cadastradas, ATIVAS E INATIVAS.
 *
 * Nao filtra por `ativo` de proposito: desligar alguem e mudar a coluna para
 * false, nunca apagar a linha (pedidos.vendedor_id e ON DELETE RESTRICT e o
 * relatorio de §17 precisa continuar sabendo quem vendeu cada kit). Se esta
 * lista escondesse os inativos, o admin nao teria por onde reativar quem
 * desligou por engano no meio do evento — a pessoa simplesmente sumiria da
 * tela e a unica saida seria um UPDATE no console do banco.
 *
 * Ordem por nome com desempate por id: `nome` nao e unico e nada impede dois
 * homonimos, e sem a segunda chave a ordem de dois empatados fica por conta da
 * varredura do Postgres, que nao e garantida. Mesmo desempate de
 * listarKitsAtivos (src/repositories/produtos.ts).
 */
export async function listarUsuarios(): Promise<Usuario[]> {
  const linhas = await getDb()
    .selectFrom('usuarios')
    .select(COLUNAS_PUBLICAS)
    .orderBy('nome', 'asc')
    .orderBy('id', 'asc')
    .execute()

  return linhas.map(paraUsuario)
}
