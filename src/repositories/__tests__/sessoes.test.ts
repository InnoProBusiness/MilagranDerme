import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'kysely'
import { getDb, closeDb } from '@/lib/db'
import { DURACAO_SESSAO_MS, hashDoToken } from '@/lib/sessao'
import {
  abrirSessao, sessaoValida, revogarSessao, revogarSessoesDoUsuario,
} from '@/repositories/sessoes'

// ESPACO DE NOMES PROPRIO, distinto do de usuarios.test.ts: os dois arquivos
// escrevem em `usuarios` e o Vitest os roda EM PARALELO contra o mesmo
// Postgres. Um `DELETE FROM usuarios` ou `DELETE FROM sessoes` sem WHERE aqui
// derrubaria as contas do arquivo vizinho no meio da execucao dele.
const EMAIL_VENDEDOR = 'sessoes-repo-vendedor@exemplo.com'
const EMAIL_OUTRO = 'sessoes-repo-outro@exemplo.com'
const EMAIL_DESATIVAVEL = 'sessoes-repo-desativavel@exemplo.com'
const EMAIL_CASCATA = 'sessoes-repo-cascata@exemplo.com'
const EMAILS = [EMAIL_VENDEDOR, EMAIL_OUTRO, EMAIL_DESATIVAVEL, EMAIL_CASCATA] as const

/**
 * As contas deste arquivo nascem por INSERT direto, com um senha_hash que nao
 * confere nunca, e nao por criarUsuario: nada aqui autentica. `abrirSessao`
 * emite o cracha de quem JA provou quem e — quem confere senha e `autenticar`
 * (src/repositories/usuarios.ts), coberto pelo arquivo vizinho. Semear por
 * INSERT deixa explicito que a sessao nao depende de senha nenhuma e evita
 * pagar quatro scrypts de 16 MiB so para chegar ao assunto do arquivo.
 */
const HASH_QUE_NUNCA_CONFERE = 'nao-e-um-hash-scrypt'

let idVendedor: string
let idOutro: string
let idDesativavel: string

/**
 * Limpa so as proprias linhas. `sessoes.usuario_id` e ON DELETE CASCADE
 * (migrations/1755300300000_usuarios_sessoes.sql), entao apagar o usuario ja
 * leva as sessoes dele — o DELETE em pedidos vem antes porque
 * `pedidos.vendedor_id` e ON DELETE RESTRICT e seguraria a linha do usuario.
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

async function semearUsuario(nome: string, email: string): Promise<string> {
  const l = await getDb().insertInto('usuarios').values({
    nome, email, senha_hash: HASH_QUE_NUNCA_CONFERE, papel: 'vendedor',
  }).returning('id').executeTakeFirstOrThrow()
  return l.id
}

beforeAll(async () => {
  await limpar()
  idVendedor = await semearUsuario('Vendedor de Sessao', EMAIL_VENDEDOR)
  idOutro = await semearUsuario('Outro Vendedor', EMAIL_OUTRO)
  idDesativavel = await semearUsuario('Vendedor Desativavel', EMAIL_DESATIVAVEL)
})

afterAll(async () => {
  await limpar()
  await closeDb()
})

describe('abrir e validar sessao', () => {
  it('abre a sessao e reconhece o token na requisicao seguinte', async () => {
    const { token } = await abrirSessao(idVendedor)

    const s = await sessaoValida(token)
    expect(s?.usuario.id).toBe(idVendedor)
    expect(s?.usuario.nome).toBe('Vendedor de Sessao')
    expect(s?.usuario.papel).toBe('vendedor')
  })

  /**
   * SEGURANCA: A COLUNA GUARDA O HASH, NUNCA O TOKEN.
   *
   * E a diferenca entre um vazamento de backup ser um incidente de dados e ser
   * um punhado de sessoes de administrador prontas para uso na mao de quem
   * vazou: com o hash, nao da para montar o cookie de volta. O token cru vive
   * exclusivamente no cookie do navegador (src/lib/sessao.ts) e so existe do
   * lado do servidor durante a requisicao que o cria.
   */
  it('SEGURANCA: o banco guarda o hash do token, nunca o token', async () => {
    const { token } = await abrirSessao(idVendedor)

    // Le TODAS as sessoes deste vendedor, e nao "a mais recente": criado_em
    // pode empatar no milissegundo entre duas linhas e o desempate por id
    // seria por uuid aleatorio, nao por ordem de insercao. A afirmacao que
    // interessa e sobre o conjunto inteiro, de qualquer forma.
    const gravados = (await getDb().selectFrom('sessoes').select('token_hash')
      .where('usuario_id', '=', idVendedor).execute()).map((l) => l.token_hash)

    expect(gravados).toContain(hashDoToken(token))
    expect(gravados).not.toContain(token)
    for (const hash of gravados) expect(hash).toMatch(/^[0-9a-f]{64}$/)

    // Nenhuma linha da tabela INTEIRA guarda o valor cru — nem esta, nem uma
    // gravada por outro caminho.
    const cruas = await getDb().selectFrom('sessoes').select('id')
      .where('token_hash', '=', token).execute()
    expect(cruas).toHaveLength(0)
  })

  it('a sessao vale por 12 horas contadas do instante informado', async () => {
    const agora = new Date()
    const { expiraEm } = await abrirSessao(idVendedor, agora)
    expect(expiraEm.getTime()).toBe(agora.getTime() + DURACAO_SESSAO_MS)
  })

  // O usuario que atravessa guarda.ts, as rotas de admin e o HTML dos Server
  // Components sai daqui: um selectAll() no join com `usuarios` colocaria
  // senha_hash dentro dele sem quebrar compilacao nenhuma.
  it('SEGURANCA: o usuario devolvido nao carrega senha_hash', async () => {
    const { token } = await abrirSessao(idVendedor)
    const s = await sessaoValida(token)

    expect(Object.keys(s!.usuario).sort()).toEqual(['ativo', 'email', 'id', 'nome', 'papel'])
    expect(JSON.stringify(s)).not.toContain(HASH_QUE_NUNCA_CONFERE)
  })

  it('token desconhecido e token vazio devolvem null', async () => {
    expect(await sessaoValida('token-que-nunca-existiu')).toBeNull()
    expect(await sessaoValida('')).toBeNull()
  })
})

describe('sessao que nao vale mais', () => {
  /**
   * SEGURANCA: SESSAO VENCIDA NAO VALE.
   *
   * A validade e conferida contra o relogio do SERVIDOR, nunca contra o
   * Max-Age do cookie — o cookie esta na mao de quem pode edita-lo. O teste
   * confirma tambem que a LINHA CONTINUA LA, para provar que o null veio do
   * `expira_em > agora` no WHERE e nao de um INSERT que nunca aconteceu.
   */
  it('SEGURANCA: sessao expirada nao vale, mesmo com a linha intacta no banco', async () => {
    const ontem = new Date(Date.now() - 25 * 60 * 60 * 1_000)
    const { token, expiraEm } = await abrirSessao(idVendedor, ontem)

    expect(expiraEm.getTime()).toBeLessThan(Date.now())
    expect(await sessaoValida(token)).toBeNull()

    const l = await getDb().selectFrom('sessoes').select(['id', 'revogada_em'])
      .where('token_hash', '=', hashDoToken(token)).executeTakeFirstOrThrow()
    expect(l.revogada_em).toBeNull()
  })

  /**
   * SEGURANCA: LOGOUT TEM EFEITO NA REQUISICAO SEGUINTE.
   *
   * Nao ha JWT justamente por isto: token auto-contido assinado so morre
   * quando expira, e o evento precisa poder encerrar a sessao do celular
   * perdido na hora.
   */
  it('SEGURANCA: sessao revogada nao vale', async () => {
    const { token } = await abrirSessao(idVendedor)
    expect(await sessaoValida(token)).not.toBeNull()

    await revogarSessao(token)
    expect(await sessaoValida(token)).toBeNull()
  })

  it('carimba revogada_em em vez de apagar a linha', async () => {
    const { token } = await abrirSessao(idVendedor)
    const instante = new Date('2026-08-25T17:32:00.000Z')

    await revogarSessao(token, instante)

    const l = await getDb().selectFrom('sessoes').select('revogada_em')
      .where('token_hash', '=', hashDoToken(token)).executeTakeFirstOrThrow()
    // "Esta sessao existiu e foi encerrada as 14h32" e auditoria; "nao ha
    // linha nenhuma" nao e.
    expect(l.revogada_em?.getTime()).toBe(instante.getTime())
  })

  // O instante que vale e o da PRIMEIRA revogacao. Sem o `WHERE revogada_em IS
  // NULL`, cada clique repetido em "sair" empurraria o carimbo para frente e
  // apagaria justamente o dado que a coluna existe para guardar.
  it('revogar de novo nao move o carimbo da primeira vez', async () => {
    const { token } = await abrirSessao(idVendedor)
    const primeira = new Date('2026-08-25T17:32:00.000Z')
    const segunda = new Date('2026-08-25T19:00:00.000Z')

    await revogarSessao(token, primeira)
    await revogarSessao(token, segunda)

    const l = await getDb().selectFrom('sessoes').select('revogada_em')
      .where('token_hash', '=', hashDoToken(token)).executeTakeFirstOrThrow()
    expect(l.revogada_em?.getTime()).toBe(primeira.getTime())
  })

  // Logout repetido, cookie de uma instalacao antiga, token inventado: nada
  // disso e erro. Sinalizar aqui transformaria uma nao-acao num oraculo de
  // "este token existe".
  it('revogar token desconhecido nao lanca', async () => {
    await expect(revogarSessao('token-que-nunca-existiu')).resolves.toBeUndefined()
    await expect(revogarSessao('')).resolves.toBeUndefined()
  })
})

describe('desligar a pessoa derruba o acesso dela', () => {
  /**
   * SEGURANCA: O CENARIO DO DIA DO EVENTO.
   *
   * O vendedor foi desligado (ou perdeu o celular) e ja esta com uma sessao
   * aberta, valida por mais horas. Marcar `ativo = false` tem que derrubar
   * essa sessao NA HORA, sem ninguem precisar achar o registro dela — e por
   * isso que sessaoValida junta com `usuarios` e exige ativo = true no mesmo
   * WHERE, em vez de confiar no que foi lido no login.
   */
  it('SEGURANCA: desativar o usuario invalida a sessao que ele ja tem aberta', async () => {
    const { token } = await abrirSessao(idDesativavel)
    expect(await sessaoValida(token)).not.toBeNull()

    await getDb().updateTable('usuarios').set({ ativo: false })
      .where('id', '=', idDesativavel).execute()

    expect(await sessaoValida(token)).toBeNull()

    // E O CONTRARIO TAMBEM: a sessao nao foi revogada, so estava suspensa
    // junto com a conta. Reativar quem foi desligado por engano devolve o
    // acesso sem obrigar a pessoa a entrar de novo no meio da fila. Quando a
    // intencao e encerrar de vez, o que se usa e revogarSessoesDoUsuario — e e
    // por isso que as duas coisas existem separadas.
    await getDb().updateTable('usuarios').set({ ativo: true })
      .where('id', '=', idDesativavel).execute()
    expect(await sessaoValida(token)).not.toBeNull()
  })

  it('revogarSessoesDoUsuario derruba todas as sessoes daquela pessoa', async () => {
    const celular = await abrirSessao(idVendedor)
    const balcao = await abrirSessao(idVendedor)
    const deOutraPessoa = await abrirSessao(idOutro)

    await revogarSessoesDoUsuario(idVendedor)

    expect(await sessaoValida(celular.token)).toBeNull()
    expect(await sessaoValida(balcao.token)).toBeNull()
    // A acao e por PESSOA. Se ela vazasse para outros usuarios, "derrubar o
    // celular perdido de um vendedor" desconectaria o balcao inteiro no meio
    // do evento.
    expect(await sessaoValida(deOutraPessoa.token)).not.toBeNull()
  })
})

describe('garantias do banco', () => {
  // Uma sessao que nasce vencida seria um login que "da certo" e derruba a
  // pessoa na tela seguinte, sem mensagem de erro em lugar nenhum. Um erro de
  // sinal em DURACAO_SESSAO_MS (src/lib/sessao.ts) produz exatamente isso, e o
  // CHECK o transforma em erro imediato e legivel no login.
  it('recusa sessao que nasce vencida', async () => {
    const instante = new Date()
    await expect(
      getDb().insertInto('sessoes').values({
        usuario_id: idVendedor, token_hash: hashDoToken('sessao-nascida-vencida'),
        criado_em: instante, expira_em: instante,
      }).execute(),
    ).rejects.toThrow(/sessao_janela_coerente/)
  })

  // Alem da unicidade, este indice e o caminho de leitura de toda requisicao
  // autenticada. A unicidade garante que uma colisao (ou um bug que
  // reaproveitasse o mesmo valor) falhe no INSERT em vez de dar a duas pessoas
  // a mesma sessao.
  it('recusa duas sessoes com o mesmo token_hash', async () => {
    const { token } = await abrirSessao(idVendedor)
    const agora = new Date()

    await expect(
      getDb().insertInto('sessoes').values({
        usuario_id: idOutro, token_hash: hashDoToken(token),
        criado_em: agora, expira_em: new Date(agora.getTime() + DURACAO_SESSAO_MS),
      }).execute(),
    ).rejects.toThrow(/sessao_token_unico/)
  })

  // ON DELETE CASCADE, ao contrario do RESTRICT de pedidos.vendedor_id: sessao
  // nao e historico de negocio, e chave de acesso. Se a conta deixa de existir,
  // as chaves dela tem que sumir junto — nao ha nada a preservar.
  it('apagar o usuario leva as sessoes dele junto', async () => {
    const idCascata = await semearUsuario('Vendedor Cascata', EMAIL_CASCATA)
    const { token } = await abrirSessao(idCascata)

    await getDb().deleteFrom('usuarios').where('id', '=', idCascata).execute()

    const sobrou = await getDb().selectFrom('sessoes').select('id')
      .where('token_hash', '=', hashDoToken(token)).execute()
    expect(sobrou).toHaveLength(0)
    expect(await sessaoValida(token)).toBeNull()
  })
})
