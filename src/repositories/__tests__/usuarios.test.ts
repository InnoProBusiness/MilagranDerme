import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'kysely'
import { getDb, closeDb } from '@/lib/db'
import {
  criarUsuario, autenticar, buscarUsuarioPorId, listarUsuarios, type Usuario,
} from '@/repositories/usuarios'

// ESPACO DE NOMES PROPRIO DESTE ARQUIVO, como o de clientes.test.ts e o de
// cupons.test.ts. O Vitest roda os arquivos de teste EM PARALELO contra o
// MESMO Postgres, entao um `DELETE FROM usuarios` sem WHERE aqui apagaria, no
// meio da execucao, os usuarios que sessoes.test.ts acabou de criar — e o
// vermelho apareceria no arquivo errado.
//
// A chave e o e-mail porque e ele que identifica a conta: usuario_email_unico
// e sobre lower(email) (migrations/1755300300000_usuarios_sessoes.sql) e
// `autenticar` procura a linha por lower(email).
const EMAIL_ADMIN = 'Usuarios-Repo-Admin@Exemplo.com' // caixa mista de proposito
const EMAIL_VENDEDOR = 'usuarios-repo-vendedor@exemplo.com'
const EMAIL_INATIVO = 'usuarios-repo-inativo@exemplo.com'
const EMAIL_HASH_QUEBRADO = 'usuarios-repo-hash-quebrado@exemplo.com'
const EMAIL_CARIMBO = 'usuarios-repo-carimbo@exemplo.com'
// Nunca cadastrado. Existe so para provar que "nao existe" e indistinguivel de
// "senha errada" e de "conta desativada".
const EMAIL_INEXISTENTE = 'usuarios-repo-fantasma@exemplo.com'

const EMAILS = [
  EMAIL_ADMIN, EMAIL_VENDEDOR, EMAIL_INATIVO, EMAIL_HASH_QUEBRADO, EMAIL_CARIMBO,
] as const
const EMAILS_MINUSCULOS: readonly string[] = EMAILS.map((e) => e.toLowerCase())

const SENHA = 'balcao-milagran-2026-senha-boa'
const SENHA_ERRADA = 'balcao-milagran-2026-senha-boX'

/** Hash fora do formato de src/lib/senha.ts, para as linhas semeadas a mao. */
const HASH_QUEBRADO = 'nao-e-um-hash-scrypt'

let admin: Usuario

/**
 * Limpa APENAS as linhas deste arquivo, na ordem que o grafo de chaves
 * estrangeiras exige:
 *
 *  - pedidos.vendedor_id e ON DELETE RESTRICT
 *    (migrations/1755300300000_usuarios_sessoes.sql): um pedido apontando para
 *    o vendedor impede o DELETE dele. Este arquivo nao cria pedido nenhum, e o
 *    espaco de nomes acima garante que nenhum outro cria um para estes
 *    e-mails; o DELETE fica como rede contra orfao de execucao interrompida e
 *    contra um teste futuro daqui que passe a criar pedidos.
 *  - sessoes.usuario_id e ON DELETE CASCADE (mesma migration): apagar o
 *    usuario ja leva as sessoes dele, sem DELETE em separado — e e isso que o
 *    teste de cascata de sessoes.test.ts assevera.
 */
async function limpar() {
  const db = getDb()
  for (const email of EMAILS) {
    const donos = db.selectFrom('usuarios').select('id')
      .where(sql<boolean>`lower(email) = lower(${email})`)
    await db.deleteFrom('pedidos').where('vendedor_id', 'in', donos).execute()
    await db.deleteFrom('usuarios')
      .where(sql<boolean>`lower(email) = lower(${email})`).execute()
  }
}

/**
 * Semeia UMA vez, e nao a cada teste: cada `criarUsuario` custa um scrypt de
 * 16 MiB (src/lib/senha.ts), entao um beforeEach com quatro contas pagaria
 * esse custo em todo `it` do arquivo. Nenhum teste abaixo altera as contas
 * semeadas — o unico que precisa de conta desativada usa a que ja nasce
 * desativada, e o que mexe em atualizado_em tem conta so dele.
 */
beforeAll(async () => {
  await limpar()

  admin = await criarUsuario({
    nome: 'Ana Admin', email: EMAIL_ADMIN, senha: SENHA, papel: 'admin',
  })
  await criarUsuario({
    nome: 'Bruno Vendedor', email: EMAIL_VENDEDOR, senha: SENHA, papel: 'vendedor',
  })

  // Nasce ativa (o DEFAULT da coluna) e e DESLIGADA pelo mesmo caminho que o
  // admin usaria: UPDATE em `ativo`, nunca DELETE da linha — o historico de
  // quem vendeu o que precisa sobreviver ao desligamento da pessoa
  // (pedidos.vendedor_id e ON DELETE RESTRICT).
  await criarUsuario({
    nome: 'Carla Inativa', email: EMAIL_INATIVO, senha: SENHA, papel: 'vendedor',
  })
  await getDb().updateTable('usuarios').set({ ativo: false })
    .where(sql<boolean>`lower(email) = lower(${EMAIL_INATIVO})`).execute()

  // Linha com senha_hash fora do formato de src/lib/senha.ts. A coluna e text
  // sem CHECK de formato, entao este e um estado alcancavel de verdade: um
  // INSERT feito a mao, uma importacao de outro sistema trazendo hash de
  // bcrypt, uma linha truncada num restore de backup.
  await getDb().insertInto('usuarios').values({
    nome: 'Elis Hash Quebrado', email: EMAIL_HASH_QUEBRADO,
    senha_hash: HASH_QUEBRADO, papel: 'vendedor',
  }).execute()
})

afterAll(async () => {
  await limpar()
  await closeDb()
})

describe('cadastro de usuarios', () => {
  it('cria o usuario com o papel pedido e ativo por padrao', async () => {
    expect(admin).toMatchObject({
      nome: 'Ana Admin', email: EMAIL_ADMIN, papel: 'admin', ativo: true,
    })
    expect(admin.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  // O TIPO Usuario NAO TEM senha_hash, e este teste existe porque o TypeScript
  // sozinho nao garante isso em tempo de execucao: um `selectAll()` colocado
  // por engano em qualquer uma das quatro funcoes traria a coluna junto, o
  // objeto seguiria para a resposta HTTP (ou para o HTML de um Server
  // Component) com uma propriedade a mais, e a compilacao continuaria verde.
  it('SEGURANCA: nenhuma das quatro funcoes devolve senha_hash', async () => {
    const autenticado = await autenticar(EMAIL_ADMIN, SENHA)
    const buscado = await buscarUsuarioPorId(admin.id)
    const listado = (await listarUsuarios()).find((u) => u.id === admin.id)

    const chavesEsperadas = ['ativo', 'email', 'id', 'nome', 'papel']
    for (const objeto of [admin, autenticado, buscado, listado]) {
      expect(objeto).toBeTruthy()
      expect(Object.keys(objeto!).sort()).toEqual(chavesEsperadas)
      // Nem por outro nome: um `senha_hash as hash` tambem seria vazamento.
      expect(JSON.stringify(objeto)).not.toContain('scrypt$')
    }
  })

  it('SEGURANCA: o banco guarda o hash scrypt, nunca a senha em claro', async () => {
    const l = await getDb().selectFrom('usuarios').select('senha_hash')
      .where('id', '=', admin.id).executeTakeFirstOrThrow()

    // Formato de src/lib/senha.ts: scrypt$N$r$p$<salt b64>$<hash b64>.
    expect(l.senha_hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(l.senha_hash).not.toContain(SENHA)
  })

  // O CHECK usuario_email_formato recusa espaco em branco dos dois lados do
  // arroba, e criarUsuario NAO apara o valor de proposito (ver o doc comment):
  // um e-mail colado de uma variavel de ambiente com \n atras tem que virar
  // erro na cara de quem rodou `npm run usuario:criar`, e nao uma conta com um
  // e-mail diferente do que a pessoa acha que digitou.
  it('o banco recusa e-mail com espaco nas bordas, em vez de aparar em silencio', async () => {
    await expect(
      criarUsuario({
        nome: 'Espaco', email: ` ${EMAIL_VENDEDOR} `, senha: SENHA, papel: 'vendedor',
      }),
    ).rejects.toThrow(/usuario_email_formato/)
  })

  it('o banco recusa e-mail sem formato de e-mail', async () => {
    await expect(
      criarUsuario({
        nome: 'Sem Arroba', email: 'usuarios-repo-sem-arroba', senha: SENHA, papel: 'admin',
      }),
    ).rejects.toThrow(/usuario_email_formato/)
  })

  // Sem o indice sobre lower(email), "Admin@" e "admin@" seriam duas contas
  // distintas e o "trocar a senha" da operacao acertaria a errada.
  it('o banco recusa e-mail repetido, ignorando a caixa', async () => {
    await expect(
      criarUsuario({
        nome: 'Sosia', email: EMAIL_ADMIN.toLowerCase(), senha: SENHA, papel: 'admin',
      }),
    ).rejects.toThrow(/usuario_email_unico/)
  })
})

describe('autenticacao', () => {
  it('autentica com a senha certa', async () => {
    const u = await autenticar(EMAIL_ADMIN, SENHA)
    expect(u).toMatchObject({ id: admin.id, papel: 'admin', ativo: true })
  })

  it('autentica ignorando a caixa do e-mail', async () => {
    const u = await autenticar(EMAIL_ADMIN.toUpperCase(), SENHA)
    expect(u?.id).toBe(admin.id)
  })

  /**
   * SEGURANCA: O TESTE CENTRAL DESTE ARQUIVO.
   *
   * Os tres motivos de recusa saem pela mesma porta, com o mesmo valor. Se um
   * dia alguem "melhorar a mensagem de erro" e devolver algo diferente para
   * "usuario inativo", o 401 de /api/sessao passa a contar, para qualquer um
   * na internet, que aquele e-mail TEM conta na Milagran e que a pessoa foi
   * desligada. E o mesmo raciocinio ja documentado por extenso para
   * CpfDivergenteError em src/app/api/pedidos/route.ts (linhas 229-243).
   */
  it('SEGURANCA: senha errada, usuario inativo e e-mail inexistente devolvem o MESMO null', async () => {
    const senhaErrada = await autenticar(EMAIL_ADMIN, SENHA_ERRADA)
    const inativo = await autenticar(EMAIL_INATIVO, SENHA)
    const inexistente = await autenticar(EMAIL_INEXISTENTE, SENHA)

    expect([senhaErrada, inativo, inexistente]).toEqual([null, null, null])
  })

  it('SEGURANCA: senha vazia nunca autentica', async () => {
    // conferirSenha recusa string vazia antes de qualquer derivacao
    // (src/lib/senha.ts): sem isso, uma conta cadastrada por engano com senha
    // vazia viraria login de administrador sem senha nenhuma.
    expect(await autenticar(EMAIL_ADMIN, '')).toBeNull()
  })

  // Linha corrompida vira "credenciais invalidas" para UM usuario, nunca um
  // 500 em /api/sessao — que no dia do evento derrubaria o balcao inteiro.
  it('SEGURANCA: hash corrompido no banco devolve null, sem lancar', async () => {
    await expect(autenticar(EMAIL_HASH_QUEBRADO, SENHA)).resolves.toBeNull()
  })

  /**
   * SEGURANCA: O TEMPO DE RESPOSTA TAMBEM E RESPOSTA.
   *
   * Sem o hash descartavel de src/repositories/usuarios.ts, o e-mail
   * inexistente volta assim que a consulta termina (~1ms) e o existente so
   * depois do scrypt (dezenas de ms). Dois numeros que um script mede em lote,
   * e que separam com precisao quem tem conta de quem nao tem — sem nunca
   * acertar uma senha.
   *
   * TOLERANCIA GENEROSA DE PROPOSITO. Isto roda em CI compartilhado, onde
   * qualquer medicao isolada oscila; a mediana de tres rodadas e o piso de 40%
   * do tempo de referencia distinguem "paga o scrypt" de "nao paga" (uma
   * diferenca de ordem de grandeza) sem ficar vermelho por ruido. Se este
   * teste piscar, o conserto e aumentar as repeticoes — nunca apagar a
   * verificacao, porque e ela que impede a "otimizacao" de nao conferir hash
   * nenhum quando o usuario nao existe.
   */
  it('SEGURANCA: e-mail inexistente gasta o mesmo scrypt que e-mail existente', async () => {
    // Primeira chamada do processo: gera o hash descartavel e aquece o cache.
    // Sem este aquecimento, a primeira medicao carregaria um scrypt a mais.
    await autenticar(EMAIL_INEXISTENTE, SENHA)

    const comConta = mediana(await medirTresVezes(EMAIL_ADMIN, SENHA_ERRADA))
    const semConta = mediana(await medirTresVezes(EMAIL_INEXISTENTE, SENHA))

    expect(semConta).toBeGreaterThan(comConta * 0.4)
    // Piso absoluto: uma consulta que apenas nao acha a linha volta em menos
    // de 1ms num Postgres local. Acima de 5ms so pode ser derivacao de chave.
    expect(semConta).toBeGreaterThan(5)
  })
})

describe('leituras', () => {
  it('busca por id', async () => {
    const u = await buscarUsuarioPorId(admin.id)
    expect(u?.email).toBe(EMAIL_ADMIN)
  })

  it('devolve null para id inexistente', async () => {
    expect(await buscarUsuarioPorId('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  // Sem a guarda de formato, o Postgres lanca "invalid input syntax for type
  // uuid" e a tela de admin devolve 500 para uma URL digitada errada, quando o
  // certo e 404. Mesma defesa de buscarPedidoComItensPorToken
  // (src/repositories/pedidos.ts).
  it('devolve null para id malformado, sem deixar o Postgres lancar', async () => {
    expect(await buscarUsuarioPorId('nao-e-uuid')).toBeNull()
    expect(await buscarUsuarioPorId('')).toBeNull()
  })

  // Esconder os inativos deixaria o admin sem caminho para reativar quem ele
  // desligou por engano no meio do evento: a pessoa sumiria da tela e a unica
  // saida seria um UPDATE no console do banco.
  it('lista ativos E inativos, ordenados por nome', async () => {
    const meus = (await listarUsuarios())
      .filter((u) => EMAILS_MINUSCULOS.includes(u.email.toLowerCase()))

    expect(meus.map((u) => u.nome)).toEqual([
      'Ana Admin', 'Bruno Vendedor', 'Carla Inativa', 'Elis Hash Quebrado',
    ])
    expect(meus.find((u) => u.nome === 'Carla Inativa')?.ativo).toBe(false)
  })
})

// A coluna so tinha DEFAULT now(), entao sem o trigger ela marcaria a criacao
// e mentiria dali em diante. Numa tabela em que uma linha alterada significa
// "esta senha ou este papel mudaram", a data da ultima alteracao e auditoria
// de acesso. Mesmo teste de clientes.test.ts e de representantes.test.ts.
describe('trigger usuarios_atualizado_em_trg', () => {
  it('atualiza atualizado_em a cada UPDATE, sem mexer em criado_em', async () => {
    const antigo = new Date('2020-01-01T00:00:00.000Z')
    await getDb().insertInto('usuarios').values({
      nome: 'Dario Carimbo', email: EMAIL_CARIMBO, senha_hash: HASH_QUEBRADO,
      papel: 'vendedor', criado_em: antigo, atualizado_em: antigo,
    }).execute()

    await getDb().updateTable('usuarios')
      // Data velha informada de proposito: o trigger tem que vencer.
      .set({ papel: 'admin', atualizado_em: antigo })
      .where(sql<boolean>`lower(email) = lower(${EMAIL_CARIMBO})`).execute()

    const l = await getDb().selectFrom('usuarios').select(['criado_em', 'atualizado_em'])
      .where(sql<boolean>`lower(email) = lower(${EMAIL_CARIMBO})`).executeTakeFirstOrThrow()
    expect(l.criado_em.getTime()).toBe(antigo.getTime())
    expect(l.atualizado_em.getTime()).toBeGreaterThan(antigo.getTime())
  })
})

async function medirTresVezes(email: string, senha: string): Promise<number[]> {
  const tempos: number[] = []
  // SEQUENCIAL, nunca Promise.all: duas derivacoes de scrypt ao mesmo tempo
  // disputam CPU e memoria, e as medicoes deixariam de significar qualquer
  // coisa.
  for (let i = 0; i < 3; i += 1) {
    const inicio = performance.now()
    await autenticar(email, senha)
    tempos.push(performance.now() - inicio)
  }
  return tempos
}

function mediana(valores: number[]): number {
  const ordenados = [...valores].sort((a, b) => a - b)
  return ordenados[Math.floor(ordenados.length / 2)]
}
