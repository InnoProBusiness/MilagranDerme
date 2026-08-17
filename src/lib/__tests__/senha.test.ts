import { describe, it, expect } from 'vitest'
import { scryptSync } from 'node:crypto'
import { gerarHashDeSenha, conferirSenha } from '@/lib/senha'

const SENHA = 'milagran-lancamento-25/08'
/** 32 bytes em base64: tem o tamanho de um hash de verdade, mas nao e de senha nenhuma. */
const HASH_FALSO = Buffer.alloc(32).toString('base64')
const SALT_FALSO = Buffer.alloc(16).toString('base64')

describe('gerarHashDeSenha', () => {
  it('devolve o formato scrypt$N$r$p$salt$hash acordado com a migration', async () => {
    // Este formato esta escrito por extenso no comentario de
    // usuarios.senha_hash (migrations/1755300300000_usuarios_sessoes.sql).
    // Mudar aqui sem mudar la deixa a coluna documentando uma mentira.
    const hash = await gerarHashDeSenha(SENHA)
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(hash.split('$')).toHaveLength(6)
  })

  it('SEGURANCA: nunca devolve a senha em claro dentro do hash', async () => {
    const hash = await gerarHashDeSenha(SENHA)
    expect(hash).not.toContain(SENHA)
    expect(hash).not.toContain('milagran')
    // Nem em base64, que e o disfarce facil de deixar passar numa revisao.
    expect(hash).not.toContain(Buffer.from(SENHA).toString('base64'))
  })

  it('SEGURANCA: dois hashes da MESMA senha sao diferentes (salt aleatorio)', async () => {
    // Sem salt por linha, um dump do banco revelaria quais contas repetem a
    // mesma senha so por comparacao visual — e uma rainbow table resolveria
    // todas de uma vez.
    const a = await gerarHashDeSenha(SENHA)
    const b = await gerarHashDeSenha(SENHA)
    expect(a).not.toBe(b)
    expect(await conferirSenha(SENHA, a)).toBe(true)
    expect(await conferirSenha(SENHA, b)).toBe(true)
  })
})

describe('conferirSenha', () => {
  it('aceita a senha certa e recusa a errada', async () => {
    const hash = await gerarHashDeSenha(SENHA)
    expect(await conferirSenha(SENHA, hash)).toBe(true)
    expect(await conferirSenha('senha-errada', hash)).toBe(false)
    // Um caractere a mais no fim ja e outra senha.
    expect(await conferirSenha(`${SENHA} `, hash)).toBe(false)
  })

  it('recusa hash adulterado com formato valido', async () => {
    const hash = await gerarHashDeSenha(SENHA)
    const partes = hash.split('$')
    const outroSalt = Buffer.from('salt-plantado-pelo-atacante').toString('base64')
    expect(await conferirSenha(SENHA, [...partes.slice(0, 4), outroSalt, partes[5]].join('$')))
      .toBe(false)
  })

  it('SEGURANCA: hash malformado devolve false e NAO lanca', async () => {
    // Uma linha corrompida em usuarios.senha_hash tem que virar "credenciais
    // invalidas" para um usuario, nunca 500 em /api/sessao — no dia do evento
    // um 500 ali derruba o balcao inteiro.
    const lixo = [
      '',                                                  // coluna vazia
      '   ',                                               // so espaco
      'scrypt',                                            // sem separador nenhum
      `scrypt$16384$8$1$${SALT_FALSO}`,                    // truncado: 5 campos
      `scrypt$16384$8$1$${SALT_FALSO}$${HASH_FALSO}$x`,    // 7 campos
      'scrypt$16384$8$1$$',                                // salt e hash vazios
      `scrypt$abc$8$1$${SALT_FALSO}$${HASH_FALSO}`,        // N nao numerico
      `scrypt$0$8$1$${SALT_FALSO}$${HASH_FALSO}`,          // N zero
      `scrypt$-16384$8$1$${SALT_FALSO}$${HASH_FALSO}`,     // N negativo
      // N nao e potencia de 2: quem lanca e o proprio scrypt, e o erro tem
      // que virar false aqui dentro em vez de subir ate a rota.
      `scrypt$16383$8$1$${SALT_FALSO}$${HASH_FALSO}`,
      'scrypt$16384$8$1$c2FsdA==$YWJj',                    // hash curto demais para ser prova
      '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', // bcrypt
      `argon2id$16384$8$1$${SALT_FALSO}$${HASH_FALSO}`,    // outro algoritmo, mesmos campos
      `md5$16384$8$1$${SALT_FALSO}$${HASH_FALSO}`,
    ]
    for (const h of lixo) {
      await expect(conferirSenha(SENHA, h)).resolves.toBe(false)
    }
  })

  it('SEGURANCA: N absurdo no banco nao vira alocacao de memoria', async () => {
    // 2^30 pediria dezenas de gigabytes ao scrypt e mataria o processo — o
    // container da VPS tem 3.8GB. Um campo texto no banco nao pode virar
    // negacao de servico; fora dos limites o hash e simplesmente invalido.
    const falso = `scrypt$1073741824$8$1$${SALT_FALSO}$${HASH_FALSO}`
    await expect(conferirSenha(SENHA, falso)).resolves.toBe(false)
  })

  it('SEGURANCA: senha vazia nunca autentica, nem contra o hash da propria vazia', async () => {
    // Rede de seguranca contra cadastro sem validacao (scripts/criar-usuario.mjs):
    // um senha_hash gerado a partir de '' viraria login de admin sem senha.
    const hashDoVazio = await gerarHashDeSenha('')
    expect(await conferirSenha('', hashDoVazio)).toBe(false)
    expect(await conferirSenha('', await gerarHashDeSenha(SENHA))).toBe(false)
  })

  it('le os parametros de dentro do hash, nao os fixa no codigo', async () => {
    // E isto que torna possivel subir o custo no futuro sem invalidar as
    // senhas ja cadastradas: uma linha antiga continua conferivel com os
    // parametros com que foi criada.
    const salt = Buffer.from('salt-de-outro-custo')
    const derivada = scryptSync(SENHA, salt, 32, { N: 1024, r: 8, p: 1 })
    const antigo = `scrypt$1024$8$1$${salt.toString('base64')}$${derivada.toString('base64')}`
    expect(await conferirSenha(SENHA, antigo)).toBe(true)
    expect(await conferirSenha('outra', antigo)).toBe(false)
  })

  it('senha com acento confere entre teclados que normalizam diferente', async () => {
    // "coração" digitado no iPhone (NFD) tem bytes diferentes do mesmo texto
    // digitado no Windows (NFC). Sem normalizar nos dois lados, o vendedor
    // cadastra no escritorio e nao entra pelo celular — e a tela so diz
    // "senha errada".
    const nfc = 'coração-2026'.normalize('NFC')
    const nfd = 'coração-2026'.normalize('NFD')
    expect(nfc).not.toBe(nfd)
    const hash = await gerarHashDeSenha(nfd)
    expect(await conferirSenha(nfc, hash)).toBe(true)
  })
})

/**
 * A COSTURA ENTRE O SCRIPT DE CADASTRO E O LOGIN.
 *
 * scripts/criar-usuario.mjs e o unico jeito de criar um operador do painel, e
 * ele NAO consegue importar este modulo: e JavaScript puro, rodado por `node`
 * sem transpilar, e src/lib/senha.ts e TypeScript. Por isso o formato do hash
 * esta reimplementado la — duplicacao consciente, declarada no cabecalho do
 * script.
 *
 * Duplicacao sem trava vira divergencia silenciosa: alguem sobe CUSTO_N aqui,
 * esquece o script, e o proximo usuario cadastrado simplesmente nao consegue
 * entrar — as 9h do dia 25/08, com a fila formada, e sem nenhum erro no log
 * alem de "credenciais invalidas". Este teste e a trava: ele gera o hash pelo
 * SCRIPT e confere pelo MODULO. Se os dois lados divergirem em algoritmo,
 * custo, salt, codificacao ou normalizacao, ele fica vermelho no CI.
 */
describe('compatibilidade com scripts/criar-usuario.mjs', () => {
  it('SEGURANCA: hash gerado pelo script de cadastro autentica pelo modulo de login', async () => {
    // Import dinamico: o script so roda seu `principal()` quando invocado
    // direto pela CLI (guarda de pathToFileURL no fim do arquivo), entao
    // importa-lo aqui nao abre conexao com o banco nem le senha do terminal.
    const script = await import('../../../scripts/criar-usuario.mjs')

    const hashDoScript = await script.gerarHashDeSenha(SENHA)
    expect(await conferirSenha(SENHA, hashDoScript)).toBe(true)
    expect(await conferirSenha('senha-errada', hashDoScript)).toBe(false)
  })

  it('os dois lados usam exatamente os mesmos parametros de custo', async () => {
    // Nao basta conferir: conferirSenha le N/r/p de DENTRO do hash, entao um
    // script com custo menor continuaria autenticando — e cada senha
    // cadastrada por ele nasceria mais fraca do que o modulo promete, sem
    // ninguem perceber. Comparar os prefixos pega isso.
    const script = await import('../../../scripts/criar-usuario.mjs')

    const doScript = (await script.gerarHashDeSenha(SENHA)).split('$').slice(0, 4).join('$')
    const doModulo = (await gerarHashDeSenha(SENHA)).split('$').slice(0, 4).join('$')
    expect(doScript).toBe(doModulo)
  })
})
