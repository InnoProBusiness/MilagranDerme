import { createHash, randomBytes } from 'node:crypto'

/**
 * Prefixo __Host-: o navegador so aceita o cookie se ele vier com Secure,
 * com Path=/ e SEM atributo Domain. E a mesma escolha (e o mesmo motivo)
 * documentada em src/lib/atribuicao.ts para o cookie de atribuicao — nenhum
 * subdominio pode plantar ou sobrescrever a sessao pelo navegador. Aqui o
 * ganho e maior: la o pior caso e comissao creditada a quem nao vendeu, aqui
 * seria sessao de administrador forjada a partir de um subdominio esquecido.
 *
 * CONSEQUENCIA OPERACIONAL, valida para todo cookie __Host-: o QR code do
 * evento tem que apontar para o APEX (milagranoficial.com.br), nunca para
 * www — um cookie gravado em www nao acompanha o visitante no apex e
 * vice-versa. Isso ja esta registrado nas pendencias do plano de lancamento.
 */
export const NOME_COOKIE_SESSAO = '__Host-milagran_sessao'

/**
 * 12 horas: cobre um dia inteiro de evento sem pedir login de novo no meio da
 * fila, e ainda assim expira sozinha antes do dia seguinte. Constante nomeada,
 * nao variavel de ambiente — janela de negocio e decisao versionada
 * (convencao registrada no Plano 1), e uma sessao que dura o que a env disser
 * e uma sessao cuja duracao ninguem consegue auditar pelo git.
 */
export const DURACAO_SESSAO_MS: number = 12 * 60 * 60 * 1_000

/**
 * Token opaco de 32 bytes (256 bits) em base64url.
 *
 * randomBytes e CSPRNG; Math.random nao e e nunca pode aparecer aqui. O
 * alfabeto base64url (A-Za-z0-9-_) foi escolhido de proposito: nenhum de seus
 * caracteres precisa de escape em cookie, entao o valor que sai daqui e
 * exatamente o valor que tokenDoCookie le de volta, sem percent-encoding no
 * meio do caminho.
 *
 * O token e opaco por decisao: nao carrega usuario, papel nem validade. Quem
 * responde "esta sessao vale?" e o banco (src/repositories/sessoes.ts), que
 * pode revogar. Um token auto-contido assinado nao teria como ser revogado
 * antes de expirar.
 */
export function gerarTokenDeSessao(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * sha256 hex do token. E ISTO que vai para sessoes.token_hash — o token cru
 * so existe no cookie do navegador.
 *
 * Um vazamento de backup do banco entrega hashes, e hash nao volta a virar
 * cookie: ninguem se autentica com o conteudo da coluna. Este e o mesmo
 * raciocinio de senha_hash, com uma diferenca deliberada — aqui NAO ha salt
 * nem custo, porque o token ja tem 256 bits de entropia aleatoria: nao existe
 * dicionario a ser tentado, e a busca em sessoes.token_hash precisa ser um
 * lookup por indice unico (sessao_token_unico), nao uma varredura da tabela
 * derivando um scrypt por linha.
 */
export function hashDoToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Atributos comuns ao cookie de sessao e ao de logout. A ORDEM importa pouco;
 *  a PRESENCA e ausencia de cada um e que e contrato:
 *  - Path=/ e Secure sao exigidos pelo prefixo __Host-;
 *  - HttpOnly tira o cookie do alcance de document.cookie, entao um XSS em
 *    qualquer pagina da loja nao consegue ler a sessao do administrador;
 *  - SameSite=Lax nao acompanha POST vindo de outro site (defesa de CSRF nas
 *    rotas /api/admin/*) mas acompanha navegacao normal por link, que e o que
 *    faz o vendedor conseguir abrir /venda a partir de um link do WhatsApp;
 *  - Domain NUNCA aparece: com ele, o navegador recusa o cookie inteiro.
 */
const ATRIBUTOS_BASE = 'Path=/; HttpOnly; Secure; SameSite=Lax'

/**
 * Valor pronto do header Set-Cookie da sessao.
 *
 * Emite Max-Age E Expires de proposito: Max-Age tem prioridade nos
 * navegadores atuais e e RELATIVO ao recebimento, entao o celular do vendedor
 * com o relogio errado — comum, e o dia do evento nao e hora de descobrir
 * isso — mantem a sessao pelas 12 horas certas. Expires fica como pista
 * legivel e para clientes antigos. Se expiraEm ja passou, Max-Age vira 0 e o
 * navegador descarta na hora: cookie vencido nunca e emitido como valido.
 */
export function cookieDeSessao(token: string, expiraEm: Date): string {
  const segundos = Math.max(0, Math.floor((expiraEm.getTime() - Date.now()) / 1_000))
  return `${NOME_COOKIE_SESSAO}=${token}; ${ATRIBUTOS_BASE}; Max-Age=${segundos}; Expires=${expiraEm.toUTCString()}`
}

/**
 * Valor do Set-Cookie que apaga a sessao no navegador (DELETE /api/sessao).
 *
 * Precisa repetir EXATAMENTE Path=/ e os demais atributos: o navegador so
 * substitui um cookie por outro de mesmo nome, dominio e path. Um cookie de
 * logout com path diferente cria um segundo cookie em vez de apagar o
 * primeiro, e o vendedor continua logado depois de clicar em "sair".
 *
 * Apagar aqui e so a metade visivel do logout — a que vale e
 * revogarSessao em src/repositories/sessoes.ts, porque quem ja copiou o token
 * nao e afetado por nada que o navegador faca.
 */
export function cookieDeLogout(): string {
  return `${NOME_COOKIE_SESSAO}=; ${ATRIBUTOS_BASE}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

/**
 * Le o token do header Cookie cru. Devolve null quando nao ha cookie, quando
 * o cookie de sessao nao esta la e quando ele esta la vazio.
 *
 * SEPARA PELO REGEX "ponto-e-virgula seguido de espacos opcionais" (o mesmo
 * /;\s* de src/app/api/pedidos/route.ts), NUNCA POR '; ' LITERAL. O header Cookie separa pares por
 * ponto-e-virgula + espaco na maioria dos navegadores, mas a RFC 6265 so
 * exige o ponto-e-virgula: um proxy, um cliente de teste ou um navegador
 * antigo pode mandar "a=1;b=2" sem o espaco. Essa mesma armadilha ja esta
 * documentada em src/app/api/pedidos/route.ts (linhas 117-125), onde um
 * split('; ') literal fazia a comissao do representante desaparecer em
 * silencio. Aqui a falha e a mesma classe e igualmente muda: o vendedor
 * autenticado leva 401 no meio da fila, sem nenhum log dizendo que o cookie
 * chegou e nao foi lido.
 *
 * Valor vazio vira null (e nao ''): '' passaria adiante para hashDoToken e
 * viraria uma consulta legitima ao banco por um hash que nunca existiu — 401
 * do mesmo jeito, mas com uma ida ao Postgres por requisicao e sem
 * distinguir "sem sessao" de "sessao invalida".
 */
export function tokenDoCookie(cabecalhoCookie: string | null): string | null {
  if (!cabecalhoCookie) return null
  const prefixo = `${NOME_COOKIE_SESSAO}=`
  const par = cabecalhoCookie.split(/;\s*/).find((c) => c.startsWith(prefixo))
  if (!par) return null
  const token = par.slice(prefixo.length)
  return token === '' ? null : token
}
