import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Hash de senha com scrypt do node:crypto. SEM DEPENDENCIA NOVA de proposito:
 * bcrypt/argon2 sao addons nativos, precisam compilar no build da imagem e
 * amarram o deploy a uma versao de glibc — o container da VPS
 * (deploy/milagran-ci-deploy.sh) nao tem toolchain de compilacao. scrypt e
 * memory-hard, esta no padrao (RFC 7914) e ja vem no runtime que o Next roda.
 *
 * FORMATO GRAVADO EM usuarios.senha_hash:
 *   scrypt$N$r$p$<salt base64>$<hash base64>
 *
 * Ele e CONTRATO com migrations/1755300300000_usuarios_sessoes.sql, que
 * documenta exatamente esta string na coluna, e com
 * src/repositories/usuarios.ts, que so faz ida e volta por estas duas funcoes.
 * Os parametros viajam DENTRO do hash — sem isso, subir o custo no futuro
 * invalidaria todas as senhas ja cadastradas de uma vez, porque nao haveria
 * como conferir uma linha antiga com o parametro antigo.
 *
 * base64 (nao base64url) e seguro aqui: o alfabeto base64 padrao e
 * A-Za-z0-9+/= e nenhum desses caracteres e '$', entao o split do separador
 * nunca corta salt ou hash ao meio.
 */
const ALGORITMO = 'scrypt'

/**
 * N=16384, r=8, p=1 consomem 128*N*r = 16 MiB por conferencia. A VPS tem
 * 3.8 GB para o container inteiro (Next + pool do pg): dobrar N para 32768
 * dobra a memoria POR LOGIN SIMULTANEO, e no dia 25/08 os vendedores entram
 * todos na mesma hora. O plano fixa 16384 por isso — subir daqui exige medir
 * o pico de logins concorrentes, nao so olhar a tabela de recomendacao.
 */
const CUSTO_N = 16384
const BLOCO_R = 8
const PARALELISMO_P = 1

/** 16 bytes de salt: unico por usuario, mata rainbow table e senha repetida. */
const BYTES_SALT = 16
/** 32 bytes derivados — mesma largura de um sha256, folga de sobra. */
const BYTES_HASH = 32

/**
 * Tetos de sanidade para os parametros LIDOS DO BANCO. Uma linha corrompida
 * (ou plantada por quem conseguiu um INSERT) com N=2^30 faria o scrypt tentar
 * alocar gigabytes e derrubar o processo inteiro no login — negacao de
 * servico a partir de um campo texto. Fora destes limites, conferirSenha
 * devolve false, que e o mesmo que a senha nao bater.
 */
const MAX_N = 1 << 20
const MAX_R = 32
const MAX_P = 16
const MAX_MEM_BYTES = 64 * 1024 * 1024
/**
 * Hash gravado menor que isto e curto demais para ser levado a serio como
 * prova de senha (8 bytes sao forcaveis offline). Recusar em vez de conferir.
 */
const MIN_BYTES_HASH_ACEITO = 16

/**
 * scrypt do node so tem forma de callback. Envolver aqui em vez de importar
 * promisify de node:util mantem o arquivo com uma unica dependencia de
 * runtime (node:crypto) e o tipo do retorno explicito, sem `any`.
 */
function derivar(
  senha: string,
  salt: Buffer,
  parametros: { n: number; r: number; p: number; bytes: number },
): Promise<Buffer> {
  return new Promise((resolver, rejeitar) => {
    scrypt(
      senha,
      salt,
      parametros.bytes,
      { N: parametros.n, r: parametros.r, p: parametros.p, maxmem: MAX_MEM_BYTES },
      (erro, derivada) => {
        if (erro) rejeitar(erro)
        else resolver(derivada)
      },
    )
  })
}

/**
 * Normalizacao Unicode antes de derivar.
 *
 * A senha vira bytes UTF-8 dentro do scrypt, e "coração" digitado no iPhone
 * (NFD: 'a' + til combinante) tem bytes DIFERENTES de "coração" digitado no
 * Windows (NFC: um unico codepoint). Sem normalizar, o vendedor cadastra a
 * senha no computador do escritorio e nao consegue entrar pelo celular no
 * balcao do evento — e o erro se apresenta como "senha errada", sem pista
 * nenhuma. Precisa ser aplicada nos DOIS lados (gerar e conferir); mudar de
 * NFC para NFD aqui invalida toda senha com acento ja cadastrada.
 */
function normalizar(senha: string): string {
  return senha.normalize('NFC')
}

/**
 * Devolve a string que vai para usuarios.senha_hash. NUNCA devolve, loga ou
 * embute a senha em claro — o salt aleatorio tambem garante que duas contas
 * com a mesma senha tenham hashes diferentes, entao um dump do banco nao
 * revela nem quem repetiu senha com quem.
 */
export async function gerarHashDeSenha(senha: string): Promise<string> {
  const salt = randomBytes(BYTES_SALT)
  const derivada = await derivar(normalizar(senha), salt, {
    n: CUSTO_N, r: BLOCO_R, p: PARALELISMO_P, bytes: BYTES_HASH,
  })
  return [
    ALGORITMO, CUSTO_N, BLOCO_R, PARALELISMO_P,
    salt.toString('base64'), derivada.toString('base64'),
  ].join('$')
}

/**
 * Confere a senha contra o hash gravado.
 *
 * DEVOLVE false, NUNCA LANCA, para qualquer hash que nao seja deste formato:
 * string vazia, linha truncada, hash de outro algoritmo (um `$2b$...` de
 * bcrypt importado de outro sistema), parametros absurdos. O motivo e a tela
 * de login: uma linha corrompida no banco tem que virar "credenciais
 * invalidas" para UM usuario, nunca um 500 em /api/sessao — que no dia do
 * evento derrubaria o balcao inteiro (src/app/api/sessao/route.ts). Quem
 * precisa distinguir "hash quebrado" de "senha errada" olha o banco, nao a
 * resposta HTTP.
 *
 * A comparacao final e timingSafeEqual: comparar com === vaza, pelo tempo de
 * resposta, quantos bytes iniciais do hash o atacante acertou.
 */
export async function conferirSenha(senha: string, hash: string): Promise<boolean> {
  // Senha vazia nunca autentica, mesmo que exista uma linha no banco cujo
  // hash seja o hash de ''. Isso e rede de seguranca contra um cadastro mal
  // feito por scripts/criar-usuario.mjs ou por um formulario sem validacao:
  // sem esta linha, um senha_hash gerado a partir de string vazia vira um
  // login de administrador sem senha nenhuma.
  if (senha === '') return false

  const partes = hash.split('$')
  if (partes.length !== 6) return false

  const [algoritmo, textoN, textoR, textoP, textoSalt, textoHash] = partes as [
    string, string, string, string, string, string,
  ]
  if (algoritmo !== ALGORITMO) return false

  const n = inteiroPositivo(textoN, MAX_N)
  const r = inteiroPositivo(textoR, MAX_R)
  const p = inteiroPositivo(textoP, MAX_P)
  if (n === null || r === null || p === null) return false

  const salt = Buffer.from(textoSalt, 'base64')
  const esperado = Buffer.from(textoHash, 'base64')
  // Buffer.from(..., 'base64') e permissivo: texto invalido vira buffer vazio
  // em vez de erro. Sem estes dois testes, um campo lixo cairia no scrypt e a
  // comparacao seria feita contra nada.
  if (salt.length === 0 || esperado.length < MIN_BYTES_HASH_ACEITO) return false

  let derivada: Buffer
  try {
    // Deriva com o comprimento GRAVADO, nao com BYTES_HASH: um hash mais
    // antigo (ou mais longo) continua conferivel sem migracao de dados.
    derivada = await derivar(normalizar(senha), salt, { n, r, p, bytes: esperado.length })
  } catch {
    // scrypt lanca por conta propria quando N nao e potencia de 2 maior que
    // 1, ou quando os parametros estouram maxmem. Hash invalido, nao
    // incidente: mesma resposta que senha errada.
    return false
  }

  // timingSafeEqual estoura com buffers de tamanhos diferentes; aqui eles
  // sempre batem porque a derivacao usou esperado.length, mas a guarda fica
  // como invariante explicita — mesma defesa de src/lib/atribuicao.ts.
  if (derivada.length !== esperado.length) return false
  return timingSafeEqual(derivada, esperado)
}

/** Inteiro decimal em (0, teto]. Devolve null para qualquer outra coisa. */
function inteiroPositivo(texto: string, teto: number): number | null {
  if (!/^\d+$/.test(texto)) return null
  const valor = Number(texto)
  if (!Number.isSafeInteger(valor) || valor <= 0 || valor > teto) return null
  return valor
}
