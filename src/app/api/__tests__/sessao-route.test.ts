import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest'
import { sql } from 'kysely'
import { getDb, closeDb } from '@/lib/db'
import { POST, DELETE, GET, PUT, PATCH } from '@/app/api/sessao/route'
import { NOME_COOKIE_SESSAO, hashDoToken, tokenDoCookie } from '@/lib/sessao'
import { MAX_LOGINS_POR_JANELA } from '@/lib/rate-limit'
import { sessaoValida } from '@/repositories/sessoes'
import { criarUsuario } from '@/repositories/usuarios'

/**
 * UNICO ponto mockado deste arquivo, e so para reproduzir uma falha de
 * INFRAESTRUTURA no logout (Postgres fora do ar no meio do DELETE) — nao ha
 * outra costura por onde produzir isso de forma deterministica sem derrubar a
 * conexao que os outros testes usam. Com `falharAoRevogar` em false (o padrao,
 * restaurado no afterEach) a funcao real e chamada e todo o resto do arquivo
 * exercita o repositorio de verdade, inclusive `sessaoValida`, que atravessa
 * este mock intocada.
 *
 * vi.hoisted porque vi.mock e icado para o topo do modulo, antes de qualquer
 * const deste arquivo existir. Mesma tecnica de `catalogo` em
 * src/app/api/__tests__/pedidos-route.test.ts.
 */
const bancoDeSessoes = vi.hoisted(() => ({ falharAoRevogar: false }))

vi.mock('@/repositories/sessoes', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/repositories/sessoes')>()
  return {
    ...real,
    revogarSessao: async (token: string, agora?: Date) => {
      if (bancoDeSessoes.falharAoRevogar) {
        throw new Error('Connection terminated unexpectedly')
      }
      return agora === undefined ? real.revogarSessao(token) : real.revogarSessao(token, agora)
    },
  }
})

/**
 * ESPACO DE NOMES PROPRIO DESTE ARQUIVO. O Vitest roda os arquivos de teste EM
 * PARALELO contra o MESMO Postgres, e usuarios.test.ts e sessoes.test.ts
 * escrevem nas mesmas duas tabelas: um `DELETE FROM usuarios` (ou de `sessoes`)
 * sem WHERE aqui derrubaria as contas deles no meio da execucao, e o vermelho
 * apareceria no arquivo errado. A chave e o e-mail porque e ele que identifica
 * a conta — usuario_email_unico e sobre lower(email).
 */
const EMAIL_ADMIN = 'sessao-route-admin@exemplo.com'
const EMAIL_VENDEDOR = 'sessao-route-vendedor@exemplo.com'
const EMAIL_INATIVO = 'sessao-route-inativo@exemplo.com'
/**
 * NUNCA CADASTRADO. Existe so para provar que "esta conta nao existe" e
 * indistinguivel de "senha errada" e de "conta desativada" — a alegacao
 * central deste arquivo.
 */
const EMAIL_INEXISTENTE = 'sessao-route-fantasma@exemplo.com'

const EMAILS = [EMAIL_ADMIN, EMAIL_VENDEDOR, EMAIL_INATIVO] as const

const SENHA = 'balcao-sessao-route-2026-senha-boa'
const SENHA_ERRADA = 'balcao-sessao-route-2026-senha-boX'

let idAdmin: string
let idVendedor: string

/**
 * Cada requisicao sai de um IP proprio: POST /api/sessao tem rate limit por IP
 * e o contador e estado de MODULO, que vive por todo o arquivo. Sem isto, o
 * teto de MAX_LOGINS_POR_JANELA seria consumido pelo conjunto dos testes e os
 * ultimos veriam 429 sem nenhuma relacao com o que alegam provar. Mesma
 * tecnica de src/app/api/__tests__/pedidos-route.test.ts.
 *
 * Faixa 10.9.x propria, distinta da 10.0.x daquele arquivo: os contadores sao
 * mapas separados (um por rota), entao a colisao nao teria efeito hoje — mas
 * a separacao deixa a intencao explicita se um dia alguem compartilhar o
 * limitador entre rotas.
 */
let contadorIp = 0
const ipUnico = () => `10.9.0.${++contadorIp}`

function requisicaoDeEntrada(corpo: unknown, ip: string = ipUnico()): Request {
  return new Request('http://localhost/api/sessao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(corpo),
  })
}

function requisicaoDeSaida(cabecalhoCookie?: string): Request {
  return new Request('http://localhost/api/sessao', {
    method: 'DELETE',
    headers: cabecalhoCookie ? { cookie: cabecalhoCookie } : {},
  })
}

/**
 * O token que o navegador guardaria, extraido do Set-Cookie pela MESMA funcao
 * que a rota usa para ler o header Cookie de volta (tokenDoCookie, que separa
 * pelo regex /;\s* ). Fazer a ida e a volta pela funcao de producao prova de quebra
 * que o valor emitido nao precisa de escape nenhum: o que sai no Set-Cookie e
 * exatamente o que volta no Cookie.
 */
function tokenDaResposta(r: Response): string {
  const token = tokenDoCookie(r.headers.get('set-cookie'))
  // Lanca em vez de devolver '' e seguir: um token vazio faria as afirmacoes
  // seguintes ("a sessao vale", "a sessao deixou de valer") passarem por
  // motivo errado, e o teste ficaria verde sem provar nada.
  if (token === null) throw new Error('a resposta de login nao trouxe cookie de sessao')
  return token
}

/** O header Cookie que o navegador mandaria de volta com aquela sessao. */
function cookieDe(token: string): string {
  return `${NOME_COOKIE_SESSAO}=${token}`
}

async function entrar(email: string = EMAIL_ADMIN, senha: string = SENHA): Promise<Response> {
  return POST(requisicaoDeEntrada({ email, senha }))
}

async function contarSessoes(usuarioId: string): Promise<number> {
  const { total } = await getDb().selectFrom('sessoes')
    .select(sql<number>`count(*)::int`.as('total'))
    .where('usuario_id', '=', usuarioId)
    .executeTakeFirstOrThrow()
  return total
}

/**
 * Limpa APENAS as linhas deste arquivo. `sessoes.usuario_id` e ON DELETE
 * CASCADE (migrations/1755300300000_usuarios_sessoes.sql), entao apagar o
 * usuario ja leva as sessoes dele; o DELETE em pedidos vem antes porque
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

/**
 * Semeia UMA vez: cada criarUsuario custa um scrypt de 16 MiB (src/lib/senha.ts)
 * e um beforeEach com tres contas pagaria esse custo em todo `it`. Nenhum teste
 * abaixo altera as contas semeadas.
 */
beforeAll(async () => {
  await limpar()

  const admin = await criarUsuario({
    nome: 'Ana Admin (rota sessao)', email: EMAIL_ADMIN, senha: SENHA, papel: 'admin',
  })
  idAdmin = admin.id

  const vendedor = await criarUsuario({
    nome: 'Bruno Vendedor (rota sessao)', email: EMAIL_VENDEDOR, senha: SENHA, papel: 'vendedor',
  })
  idVendedor = vendedor.id

  // Nasce ativa e e DESLIGADA pelo mesmo caminho que o admin usaria: UPDATE em
  // `ativo`, nunca DELETE da linha — pedidos.vendedor_id e ON DELETE RESTRICT
  // e o historico de quem vendeu o que precisa sobreviver ao desligamento.
  await criarUsuario({
    nome: 'Carla Inativa (rota sessao)', email: EMAIL_INATIVO, senha: SENHA, papel: 'vendedor',
  })
  await getDb().updateTable('usuarios').set({ ativo: false })
    .where(sql<boolean>`lower(email) = lower(${EMAIL_INATIVO})`).execute()
})

afterEach(() => {
  bancoDeSessoes.falharAoRevogar = false
})

afterAll(async () => {
  await limpar()
  await closeDb()
})

describe('POST /api/sessao — entrar', () => {
  it('entra com a senha certa e devolve 204 sem corpo', async () => {
    const r = await entrar()
    expect(r.status).toBe(204)
    // 204 e "sem conteudo": papel, nome e id NAO voltam no login de proposito
    // — quem precisa saber quem esta logado le a sessao no servidor a cada
    // requisicao (src/lib/guarda.ts), nunca um valor guardado no navegador.
    expect(await r.text()).toBe('')
  })

  it('SEGURANCA: o cookie emitido tem __Host-, HttpOnly, Secure, SameSite=Lax e Path=/, e nenhum Domain', async () => {
    const r = await entrar()
    const setCookie = r.headers.get('set-cookie') ?? ''

    // __Host- obriga Secure + Path=/ e PROIBE Domain: nenhum subdominio
    // esquecido consegue plantar ou sobrescrever a sessao de um admin.
    expect(setCookie.startsWith(`${NOME_COOKIE_SESSAO}=`)).toBe(true)
    expect(NOME_COOKIE_SESSAO.startsWith('__Host-')).toBe(true)
    // HttpOnly tira o cookie do alcance de document.cookie: um XSS em qualquer
    // pagina da loja nao consegue ler a sessao.
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    // SameSite=Lax nao acompanha POST vindo de outro site (CSRF nas rotas de
    // admin), mas acompanha navegacao normal por link.
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).not.toContain('Domain')
    expect(setCookie).not.toContain('SameSite=None')
  })

  it('o token do cookie vale como sessao na requisicao seguinte', async () => {
    const r = await entrar()
    const s = await sessaoValida(tokenDaResposta(r))
    expect(s?.usuario.id).toBe(idAdmin)
    expect(s?.usuario.papel).toBe('admin')
  })

  /**
   * SEGURANCA: O COOKIE NAO ESTA GRAVADO EM CLARO NO BANCO.
   *
   * `sessoes.token_hash` guarda o sha256 do token; o valor cru vive so no
   * cookie do navegador (src/lib/sessao.ts). E a diferenca entre um vazamento
   * de backup ser um incidente de dados e ser um punhado de sessoes de
   * administrador prontas para uso: com o hash na mao, nao da para montar o
   * cookie de volta. O teste olha a rota inteira — se algum dia alguem
   * "facilitar a depuracao" guardando o token cru, e aqui que fica vermelho.
   */
  it('SEGURANCA: o token do cookie nao aparece em claro em sessoes', async () => {
    const r = await entrar()
    const token = tokenDaResposta(r)

    const cruas = await getDb().selectFrom('sessoes').select('id')
      .where('token_hash', '=', token).execute()
    expect(cruas).toHaveLength(0)

    const gravados = (await getDb().selectFrom('sessoes').select('token_hash')
      .where('usuario_id', '=', idAdmin).execute()).map((l) => l.token_hash)
    expect(gravados).toContain(hashDoToken(token))
    expect(gravados).not.toContain(token)
    for (const hash of gravados) expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  /**
   * SEGURANCA: O TESTE CENTRAL DESTE ARQUIVO.
   *
   * Os tres motivos de recusa saem pela MESMA porta, com o MESMO status e o
   * MESMO corpo, byte a byte. `autenticar` (src/repositories/usuarios.ts) ja
   * devolve um unico null para os tres de proposito, e a rota nao pode
   * reintroduzir a distincao que o repositorio removeu: um 401 diferente para
   * "conta desativada" conta, para qualquer um na internet, que aquele e-mail
   * TEM conta na Milagran e que a pessoa foi desligada da empresa — alvo
   * pronto para tentativa de senha e para phishing de "sua conta expirou".
   *
   * O terceiro eixo, o TEMPO, e coberto em
   * src/repositories/__tests__/usuarios.test.ts (o hash descartavel faz o
   * e-mail inexistente pagar o mesmo scrypt). A rota nao acrescenta ramo
   * nenhum entre os tres casos: e o mesmo `if (!usuario)` e o mesmo `return`.
   */
  it('SEGURANCA: senha errada, e-mail inexistente e usuario inativo dao respostas indistinguiveis', async () => {
    const respostas = [
      await POST(requisicaoDeEntrada({ email: EMAIL_ADMIN, senha: SENHA_ERRADA })),
      await POST(requisicaoDeEntrada({ email: EMAIL_INEXISTENTE, senha: SENHA })),
      await POST(requisicaoDeEntrada({ email: EMAIL_INATIVO, senha: SENHA })),
    ]

    for (const r of respostas) {
      expect(r.status).toBe(401)
      // Nenhuma recusa pode emitir cookie: um Set-Cookie so no caso "senha
      // errada de conta existente" tambem seria um oraculo.
      expect(r.headers.get('set-cookie')).toBeNull()
    }

    const corpos = await Promise.all(respostas.map((r) => r.text()))
    // Corpo IDENTICO nos tres, e igual ao unico corpo previsto — sem campo
    // `mensagem`, porque uma mensagem por caso e exatamente a distincao que
    // este teste existe para impedir (ver o doc comment de `autenticar`).
    expect(new Set(corpos).size).toBe(1)
    expect(JSON.parse(corpos[0])).toEqual({ error: 'credenciais_invalidas' })
  })

  it('SEGURANCA: o corpo do 401 nao fala de conta, de e-mail nem de estado da conta', async () => {
    const r = await POST(requisicaoDeEntrada({ email: EMAIL_INATIVO, senha: SENHA }))
    const texto = (await r.text()).toLowerCase()

    // Um "usuario_inativo", "conta_desativada" ou "email_nao_encontrado"
    // devolvido aqui teria o mesmo efeito de um status diferente.
    for (const palavra of ['inativ', 'desativ', 'nao_encontrad', 'existe', 'senha', 'email']) {
      expect(texto).not.toContain(palavra)
    }
  })

  it('entra ignorando a caixa do e-mail', async () => {
    // usuario_email_unico e sobre lower(email) e `autenticar` procura por
    // lower(email): "Admin@" e "admin@" sao a mesma conta.
    const r = await entrar(EMAIL_ADMIN.toUpperCase())
    expect(r.status).toBe(204)
  })

  it('entra com espaco nas bordas do e-mail, em vez de devolver dados_invalidos', async () => {
    // O teclado do celular acrescenta espaco depois do autocompletar. Aparar no
    // login e seguro porque o CHECK usuario_email_formato garante que nenhum
    // e-mail GRAVADO tem espaco nas bordas — nao ha outra conta em que este
    // trim pudesse fazer o login cair (ver o comentario de `Corpo` na rota).
    const r = await POST(requisicaoDeEntrada({ email: `  ${EMAIL_ADMIN} `, senha: SENHA }))
    expect(r.status).toBe(204)
  })

  /**
   * SEGURANCA: `.strict()` — o campo perigoso deste corpo nao e dinheiro, e
   * PRIVILEGIO. Mandar `papel: 'admin'` tem que ser um 422 explicito, e nao um
   * campo silenciosamente ignorado: enquanto ele so e ignorado, o dia em que
   * alguem espalhar `...d` numa chamada nova vira escalacao de privilegio sem
   * nenhum teste ficar vermelho.
   */
  it('SEGURANCA: papel no corpo e recusado, nao ignorado — e nao abre sessao nenhuma', async () => {
    const antes = await contarSessoes(idVendedor)

    const r = await POST(requisicaoDeEntrada({
      email: EMAIL_VENDEDOR, senha: SENHA, papel: 'admin',
    }))

    expect(r.status).toBe(422)
    expect(await r.json()).toEqual({ error: 'dados_invalidos' })
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(await contarSessoes(idVendedor)).toBe(antes)
  })

  it('recusa corpo sem senha, corpo vazio e JSON quebrado com o mesmo 422 achatado', async () => {
    const semSenha = await POST(requisicaoDeEntrada({ email: EMAIL_ADMIN }))
    const vazio = await POST(requisicaoDeEntrada({}))
    const quebrado = await POST(new Request('http://localhost/api/sessao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ipUnico() },
      body: 'nao e json',
    }))

    for (const r of [semSenha, vazio, quebrado]) {
      expect(r.status).toBe(422)
      // Erro achatado: sem lista de campos que faltaram — o formato do erro
      // nao pode virar um mapa do que a rota aceita para quem esta sondando.
      expect(await r.json()).toEqual({ error: 'dados_invalidos' })
    }
  })

  it('SEGURANCA: senha vazia nunca entra', async () => {
    const r = await POST(requisicaoDeEntrada({ email: EMAIL_ADMIN, senha: '' }))
    expect(r.status).toBe(422)
    expect(r.headers.get('set-cookie')).toBeNull()
  })

  /**
   * SEGURANCA: resposta de autenticacao NUNCA pode ser cacheada.
   *
   * O Traefik esta na frente e um cache compartilhado guarda por URL, nao por
   * quem pediu. Sem `no-store`, no melhor caso um 401 guardado impede alguem
   * legitimo de entrar; no pior, o 204 com Set-Cookie de um vendedor e servido
   * ao proximo visitante da mesma URL.
   */
  it('SEGURANCA: 204, 401, 422 e 429 saem todos com Cache-Control: no-store', async () => {
    const ok = await entrar()
    const recusado = await POST(requisicaoDeEntrada({ email: EMAIL_ADMIN, senha: SENHA_ERRADA }))
    const invalido = await POST(requisicaoDeEntrada({}))

    const ip = ipUnico()
    for (let i = 0; i < MAX_LOGINS_POR_JANELA; i += 1) {
      await POST(requisicaoDeEntrada({}, ip))
    }
    const barrado = await POST(requisicaoDeEntrada({ email: EMAIL_ADMIN, senha: SENHA }, ip))
    expect(barrado.status).toBe(429)

    for (const r of [ok, recusado, invalido, barrado]) {
      expect(r.headers.get('cache-control')).toBe('no-store')
    }
  })

  /**
   * Este e o unico endpoint do sistema onde forca bruta de SENHA leva a algum
   * lugar. O freio e o mesmo mecanismo por IP das outras rotas
   * (src/lib/rate-limit.ts), com contador PROPRIO e teto mais apertado que o do
   * checkout — e, honestamente, em memoria do processo: quebra-molas contra
   * abuso ingenuo, nao rate limiting distribuido.
   */
  describe('rate limit por IP', () => {
    it('permite MAX_LOGINS_POR_JANELA entradas do mesmo IP e barra a seguinte com 429', async () => {
      const ip = ipUnico()
      for (let i = 0; i < MAX_LOGINS_POR_JANELA; i += 1) {
        // O teto nao pode cortar login legitimo ANTES de ser atingido: no dia
        // do evento o balcao inteiro sai de um IP so, e um 429 cedo demais
        // deixa o vendedor sem conseguir trabalhar.
        const r = await POST(requisicaoDeEntrada({ email: EMAIL_ADMIN, senha: SENHA }, ip))
        expect(r.status).toBe(204)
      }

      const barrado = await POST(requisicaoDeEntrada({ email: EMAIL_ADMIN, senha: SENHA }, ip))
      expect(barrado.status).toBe(429)
      expect(await barrado.json()).toEqual({ error: 'rate_limited' })
      expect(barrado.headers.get('set-cookie')).toBeNull()
    })

    it('o teto e por IP: outro IP entra normalmente', async () => {
      const r = await entrar()
      expect(r.status).toBe(204)
    })

    /**
     * O 429 e decidido ANTES de ler o corpo, de consultar o banco e de derivar
     * scrypt. Se fosse decidido depois, o proprio mecanismo de defesa viraria
     * vetor de negacao de servico (16 MiB por tentativa, sem precisar acertar
     * senha nenhuma) e ainda deixaria sessao gravada.
     */
    it('SEGURANCA: a requisicao barrada nao abre sessao, mesmo com credencial certa', async () => {
      const ip = ipUnico()
      // Esgota a janela com corpos que o Zod recusa: o contador soma
      // TENTATIVAS, nao sucessos — se contasse so os 204, um script de forca
      // bruta ficaria sem freio nenhum, porque ele erra a senha o tempo todo.
      for (let i = 0; i < MAX_LOGINS_POR_JANELA; i += 1) {
        const r = await POST(requisicaoDeEntrada({}, ip))
        expect(r.status).toBe(422)
      }

      const antes = await contarSessoes(idVendedor)
      const barrado = await POST(requisicaoDeEntrada(
        { email: EMAIL_VENDEDOR, senha: SENHA }, ip,
      ))

      expect(barrado.status).toBe(429)
      expect(barrado.headers.get('set-cookie')).toBeNull()
      expect(await contarSessoes(idVendedor)).toBe(antes)
    })
  })
})

describe('DELETE /api/sessao — sair', () => {
  /**
   * SEGURANCA: SAIR REVOGA DE VERDADE.
   *
   * Apagar o cookie e so a metade visivel do logout — quem ja copiou o token
   * nao e afetado por nada que o navegador faca. A metade que vale e o carimbo
   * em `sessoes.revogada_em`, e e por isso que este teste confere o token
   * DEPOIS, pelo caminho do servidor, em vez de olhar so o Set-Cookie.
   */
  it('SEGURANCA: revoga a sessao — o mesmo token deixa de valer', async () => {
    const token = tokenDaResposta(await entrar(EMAIL_VENDEDOR))
    expect(await sessaoValida(token)).not.toBeNull()

    const r = await DELETE(requisicaoDeSaida(cookieDe(token)))
    expect(r.status).toBe(204)
    expect(await r.text()).toBe('')

    expect(await sessaoValida(token)).toBeNull()

    // Carimbo, nao DELETE da linha: "esta sessao existiu e foi encerrada as
    // 14h32" e auditoria; "nao ha linha nenhuma" nao e.
    const l = await getDb().selectFrom('sessoes').select('revogada_em')
      .where('token_hash', '=', hashDoToken(token)).executeTakeFirstOrThrow()
    expect(l.revogada_em).not.toBeNull()
  })

  it('devolve o cookie de logout com os MESMOS atributos e Max-Age=0', async () => {
    const token = tokenDaResposta(await entrar(EMAIL_VENDEDOR))
    const r = await DELETE(requisicaoDeSaida(cookieDe(token)))
    const setCookie = r.headers.get('set-cookie') ?? ''

    // O navegador so substitui um cookie por outro de mesmo nome, dominio e
    // path. Com Path diferente, "sair" criaria um SEGUNDO cookie e a pessoa
    // continuaria logada (src/lib/sessao.ts).
    expect(setCookie.startsWith(`${NOME_COOKIE_SESSAO}=;`)).toBe(true)
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('Max-Age=0')
    expect(setCookie).not.toContain('Domain')
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  /**
   * "Sair" nao pode falhar por falta do que fazer. Sem cookie, com token
   * inventado e com sessao ja revogada, a resposta e sempre a mesma:
   *  - operacionalmente, sair e o que a pessoa faz ao entregar o tablet para
   *    outro vendedor — um erro ali deixa a duvida, e a duvida no meio da fila
   *    termina com o tablet entregue mesmo assim;
   *  - em seguranca, um 404 para token desconhecido faria desta rota um oraculo
   *    de "este token existe", sondavel sem nunca autenticar.
   */
  it('SEGURANCA: sem cookie, com token inventado e ja revogado devolvem o MESMO 204', async () => {
    const token = tokenDaResposta(await entrar(EMAIL_VENDEDOR))
    await DELETE(requisicaoDeSaida(cookieDe(token)))

    const respostas = [
      await DELETE(requisicaoDeSaida()),
      await DELETE(requisicaoDeSaida(cookieDe('token-que-nunca-existiu'))),
      await DELETE(requisicaoDeSaida(cookieDe(token))), // segunda vez na mesma sessao
      await DELETE(requisicaoDeSaida('outro=1; naotemsessao=2')),
    ]

    for (const r of respostas) {
      expect(r.status).toBe(204)
      expect(await r.text()).toBe('')
      expect(r.headers.get('set-cookie') ?? '').toContain('Max-Age=0')
    }
  })

  it('revogar de novo nao move o carimbo da primeira vez', async () => {
    const token = tokenDaResposta(await entrar(EMAIL_VENDEDOR))
    await DELETE(requisicaoDeSaida(cookieDe(token)))

    const primeira = await getDb().selectFrom('sessoes').select('revogada_em')
      .where('token_hash', '=', hashDoToken(token)).executeTakeFirstOrThrow()

    await DELETE(requisicaoDeSaida(cookieDe(token)))

    const segunda = await getDb().selectFrom('sessoes').select('revogada_em')
      .where('token_hash', '=', hashDoToken(token)).executeTakeFirstOrThrow()
    // O instante que vale e o da PRIMEIRA revogacao: reescrever o carimbo a
    // cada clique em "sair" apagaria o dado que a coluna existe para guardar.
    expect(segunda.revogada_em?.getTime()).toBe(primeira.revogada_em?.getTime())
  })

  /**
   * SEGURANCA: o header Cookie SEM espaco depois do ponto-e-virgula.
   *
   * A RFC 6265 so exige o ponto-e-virgula; o espaco e costume de navegador. Um
   * split('; ') literal na rota perderia o token em silencio e o "sair"
   * responderia 204 sem revogar nada — a pessoa entregaria o tablet achando
   * que saiu. A mesma armadilha ja custou a comissao do representante em
   * src/app/api/pedidos/route.ts (linhas 117-125). A rota usa tokenDoCookie,
   * que separa pelo regex /;\s* ; este teste prende essa escolha pelo lado do HTTP.
   */
  it('SEGURANCA: le o token mesmo sem espaco depois do ponto-e-virgula', async () => {
    const token = tokenDaResposta(await entrar(EMAIL_VENDEDOR))

    const r = await DELETE(requisicaoDeSaida(`a=1;${cookieDe(token)};b=2`))

    expect(r.status).toBe(204)
    expect(await sessaoValida(token)).toBeNull()
  })

  /**
   * SEGURANCA: cookie de nome PARECIDO nao e a sessao. "x__Host-milagran_sessao"
   * nao tem o prefixo protegido, entao qualquer subdominio consegue grava-lo;
   * se a rota o aceitasse, daria para pedir a revogacao de um token alheio
   * (e, do outro lado, para forjar sessao em guarda.ts pelo mesmo caminho).
   */
  it('SEGURANCA: cookie de nome parecido nao revoga a sessao de verdade', async () => {
    const token = tokenDaResposta(await entrar(EMAIL_VENDEDOR))

    const r = await DELETE(requisicaoDeSaida(`x${NOME_COOKIE_SESSAO}=${token}`))

    expect(r.status).toBe(204)
    expect(await sessaoValida(token)).not.toBeNull()
  })

  /**
   * SEGURANCA: O UNICO CASO EM QUE "SAIR" NAO RESPONDE 204.
   *
   * A idempotencia cobre os casos em que NAO HA NADA A FAZER (sem cookie,
   * token desconhecido, sessao ja revogada). Um Postgres fora do ar nao e um
   * deles: ali a revogacao REALMENTE nao aconteceu e o token continua valendo
   * pelas horas que faltam. Responder 204 diria "pronto, saiu" para quem esta
   * entregando o tablet do balcao a outra pessoa — uma mentira com
   * consequencia, e exatamente o cenario que o logout existe para evitar.
   *
   * O cookie de logout vai junto com o 500 assim mesmo: o navegador daquela
   * pessoa perde o acesso de qualquer forma, e a tela pode avisar que a sessao
   * pode seguir ativa em outro lugar (o admin encerra com
   * revogarSessoesDoUsuario).
   */
  it('SEGURANCA: falha do banco no logout vira 500 honesto, e a sessao continua valendo', async () => {
    const token = tokenDaResposta(await entrar(EMAIL_VENDEDOR))
    bancoDeSessoes.falharAoRevogar = true

    const r = await DELETE(requisicaoDeSaida(cookieDe(token)))

    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ error: 'nao_foi_possivel_sair' })
    // O navegador e deslogado de qualquer jeito.
    expect(r.headers.get('set-cookie') ?? '').toContain('Max-Age=0')
    expect(r.headers.get('cache-control')).toBe('no-store')

    // E a resposta nao mentiu: a sessao segue valida do lado do servidor.
    bancoDeSessoes.falharAoRevogar = false
    expect(await sessaoValida(token)).not.toBeNull()
  })
})

describe('metodos nao permitidos', () => {
  it('GET, PUT e PATCH devolvem 405 anunciando POST e DELETE', async () => {
    for (const handler of [GET, PUT, PATCH]) {
      const r = await handler()
      expect(r.status).toBe(405)
      // 404 diria "esta rota nao existe" e mandaria quem integra procurar o
      // caminho certo; 405 + Allow diz "existe, e fala POST e DELETE".
      expect(r.headers.get('allow')).toBe('POST, DELETE')
      expect(r.headers.get('cache-control')).toBe('no-store')
      expect(await r.json()).toEqual({ error: 'method_not_allowed' })
    }
  })
})
