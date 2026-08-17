import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  NOME_COOKIE_SESSAO, DURACAO_SESSAO_MS,
  gerarTokenDeSessao, hashDoToken, cookieDeSessao, cookieDeLogout, tokenDoCookie,
} from '@/lib/sessao'

const AGORA = new Date('2026-08-25T13:00:00Z')
const EXPIRA = new Date(AGORA.getTime() + DURACAO_SESSAO_MS)

describe('constantes da sessao', () => {
  it('SEGURANCA: o cookie usa o prefixo __Host-', () => {
    // __Host- obriga Secure + Path=/ e PROIBE Domain: nenhum subdominio
    // consegue plantar ou sobrescrever a sessao. Mesmo motivo documentado em
    // src/lib/atribuicao.ts, com aposta maior — la o prejuizo e comissao, aqui
    // seria sessao de administrador forjada.
    expect(NOME_COOKIE_SESSAO).toBe('__Host-milagran_sessao')
    expect(NOME_COOKIE_SESSAO.startsWith('__Host-')).toBe(true)
  })

  it('dura 12 horas', () => {
    expect(DURACAO_SESSAO_MS).toBe(12 * 60 * 60 * 1000)
  })
})

describe('gerarTokenDeSessao', () => {
  it('devolve 32 bytes em base64url, sem caractere que precise de escape em cookie', () => {
    const token = gerarTokenDeSessao()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('SEGURANCA: dois tokens seguidos nunca sao iguais', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => gerarTokenDeSessao()))
    expect(tokens.size).toBe(50)
  })
})

describe('hashDoToken', () => {
  it('devolve sha256 hex, deterministico', () => {
    const token = gerarTokenDeSessao()
    expect(hashDoToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashDoToken(token)).toBe(hashDoToken(token))
    expect(hashDoToken(token)).toBe(createHash('sha256').update(token).digest('hex'))
  })

  it('SEGURANCA: o hash nao carrega o token — e ele que vai para sessoes.token_hash', () => {
    // Um backup do banco entrega hashes; hash nao volta a virar cookie.
    const token = gerarTokenDeSessao()
    const hash = hashDoToken(token)
    expect(hash).not.toContain(token)
    expect(hash).not.toBe(token)
    expect(hashDoToken(`${token}x`)).not.toBe(hash)
  })
})

describe('cookieDeSessao', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('SEGURANCA: carrega HttpOnly, Secure, SameSite=Lax e Path=/', () => {
    const cookie = cookieDeSessao('token-abc', EXPIRA)
    expect(cookie).toContain('HttpOnly')   // fora do alcance de document.cookie: XSS nao le a sessao
    expect(cookie).toContain('Secure')     // exigido pelo prefixo __Host-
    expect(cookie).toContain('SameSite=Lax') // POST de outro site nao leva a sessao junto (CSRF)
    expect(cookie).toContain('Path=/')     // exigido pelo prefixo __Host-
    expect(cookie.startsWith(`${NOME_COOKIE_SESSAO}=token-abc;`)).toBe(true)
  })

  it('SEGURANCA: NAO manda Domain — com ele o navegador recusaria o cookie __Host-', () => {
    expect(cookieDeSessao('token-abc', EXPIRA)).not.toContain('Domain')
  })

  it('SEGURANCA: nao usa SameSite=None, que enviaria a sessao em requisicao de terceiro', () => {
    expect(cookieDeSessao('token-abc', EXPIRA)).not.toContain('SameSite=None')
  })

  it('expira em 12 horas contadas pelo Max-Age (imune a relogio errado do celular)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(AGORA)
    const cookie = cookieDeSessao('token-abc', EXPIRA)
    expect(cookie).toContain(`Max-Age=${12 * 60 * 60}`)
    expect(cookie).toContain(`Expires=${EXPIRA.toUTCString()}`)
  })

  it('sessao ja vencida sai com Max-Age=0, nunca com valor negativo', () => {
    vi.useFakeTimers()
    vi.setSystemTime(AGORA)
    const cookie = cookieDeSessao('token-abc', new Date(AGORA.getTime() - 60_000))
    expect(cookie).toContain('Max-Age=0')
    expect(cookie).not.toContain('Max-Age=-')
  })
})

describe('cookieDeLogout', () => {
  it('apaga o valor repetindo os MESMOS atributos do cookie de sessao', () => {
    // O navegador so substitui um cookie por outro de mesmo nome, dominio e
    // path. Path diferente aqui criaria um segundo cookie e o vendedor
    // continuaria logado depois de clicar em "sair".
    const cookie = cookieDeLogout()
    expect(cookie.startsWith(`${NOME_COOKIE_SESSAO}=;`)).toBe(true)
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=0')
    expect(cookie).not.toContain('Domain')
  })
})

describe('tokenDoCookie', () => {
  it('SEGURANCA: acha o token com espaco depois do ponto-e-virgula', () => {
    expect(tokenDoCookie(`a=1; ${NOME_COOKIE_SESSAO}=XYZ; b=2`)).toBe('XYZ')
  })

  it('SEGURANCA: acha o token SEM espaco depois do ponto-e-virgula', () => {
    // A RFC 6265 so exige o ponto-e-virgula; o espaco e costume de navegador.
    // Um split('; ') literal perderia o cookie em silencio — mesma armadilha
    // ja documentada em src/app/api/pedidos/route.ts (linhas 117-125), onde
    // ela fazia a comissao do representante sumir sem log e sem 4xx. Aqui o
    // vendedor autenticado levaria 401 no meio da fila do evento.
    expect(tokenDoCookie(`a=1;${NOME_COOKIE_SESSAO}=XYZ;b=2`)).toBe('XYZ')
    expect(tokenDoCookie(`a=1;   ${NOME_COOKIE_SESSAO}=XYZ`)).toBe('XYZ')
  })

  it('acha o token quando ele e o unico cookie e quando e o primeiro', () => {
    expect(tokenDoCookie(`${NOME_COOKIE_SESSAO}=XYZ`)).toBe('XYZ')
    expect(tokenDoCookie(`${NOME_COOKIE_SESSAO}=XYZ; a=1`)).toBe('XYZ')
  })

  it('faz ida e volta com o cookie que cookieDeSessao emite', () => {
    // O navegador devolve so o par nome=valor no header Cookie; os atributos
    // ficam no Set-Cookie. Esta e a viagem real do token.
    const token = gerarTokenDeSessao()
    const par = cookieDeSessao(token, EXPIRA).split(';')[0]
    expect(tokenDoCookie(`outro=1; ${par}`)).toBe(token)
    expect(tokenDoCookie(`outro=1;${par}`)).toBe(token)
  })

  it('devolve null sem cookie, sem o cookie de sessao e com valor vazio', () => {
    expect(tokenDoCookie(null)).toBeNull()
    expect(tokenDoCookie('')).toBeNull()
    expect(tokenDoCookie('a=1; b=2')).toBeNull()
    // Cookie presente e vazio nao pode virar consulta ao banco por um hash de ''.
    expect(tokenDoCookie(`a=1; ${NOME_COOKIE_SESSAO}=`)).toBeNull()
  })

  it('SEGURANCA: nao confunde um cookie de nome parecido com o de sessao', () => {
    // Sem a ancora no inicio do par, "x__Host-milagran_sessao=forjado" — nome
    // que qualquer um pode gravar, porque nao tem o prefixo protegido —
    // passaria por sessao legitima.
    expect(tokenDoCookie(`x${NOME_COOKIE_SESSAO}=forjado`)).toBeNull()
    expect(tokenDoCookie(`${NOME_COOKIE_SESSAO}_antigo=forjado`)).toBeNull()
    expect(tokenDoCookie(`a=${NOME_COOKIE_SESSAO}=forjado`)).toBeNull()
  })
})
