import { z } from 'zod'
import { cookieDeLogout, cookieDeSessao, tokenDoCookie } from '@/lib/sessao'
import {
  criarLimitadorPorIp, ipDoPedido,
  JANELA_RATE_LIMIT_MS, MAX_LOGINS_POR_JANELA,
} from '@/lib/rate-limit'
import { abrirSessao, revogarSessao } from '@/repositories/sessoes'
import { autenticar } from '@/repositories/usuarios'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/sessao = entrar. DELETE /api/sessao = sair.
 *
 * Handler fino, como todos os outros: quem confere a senha e `autenticar`
 * (src/repositories/usuarios.ts), quem emite e revoga o cracha e
 * src/repositories/sessoes.ts, quem monta o header Set-Cookie e
 * src/lib/sessao.ts. Esta rota so amarra as tres coisas e traduz o resultado
 * para HTTP — nenhuma regra de autenticacao nasce aqui, e nenhuma pode nascer:
 * a decisao de que "e-mail inexistente", "conta desativada" e "senha errada"
 * sao a MESMA resposta foi tomada dentro de `autenticar`, e o valor dela
 * depende de nada nesta camada distinguir os tres de volta.
 *
 * Runtime Node explicito: `autenticar` deriva scrypt (node:crypto) e o
 * repositorio fala com o Postgres pelo pool do pg — nenhum dos dois roda no
 * runtime Edge. Node ja e o padrao de um route handler; deixar escrito faz um
 * `export const runtime = 'edge'` acidental virar erro de build em vez de erro
 * de producao no dia do evento.
 */

/**
 * `Cache-Control: no-store` em TODA resposta desta rota, sem excecao — 204,
 * 401, 422, 429, 405 e 500.
 *
 * O Traefik esta na frente da aplicacao e um cache compartilhado guarda por
 * URL, nao por quem pediu. Sem este cabecalho, a resposta de um login poderia
 * ser servida a outra pessoa que pediu a mesma URL: no melhor caso um 401
 * guardado impede alguem legitimo de entrar, no pior um 204 com Set-Cookie
 * entrega a sessao de um vendedor para o proximo visitante. E o mesmo motivo
 * ja documentado em src/lib/guarda.ts para as respostas de 401/403.
 *
 * Vale tambem para os 4xx: um 429 cacheado prenderia o IP no bloqueio depois
 * de a janela ter passado.
 */
const SEM_CACHE = { 'Cache-Control': 'no-store' } as const

/**
 * Contador PROPRIO desta rota (criarLimitadorPorIp devolve um Map novo a cada
 * chamada): o teto do login nao compartilha orcamento com o do checkout nem
 * com o do formulario de candidatura. Se compartilhasse, um comprador
 * insistente no /checkout deixaria o vendedor sem conseguir entrar no balcao,
 * e um script de forca bruta no login derrubaria o checkout junto.
 *
 * O FREIO VEM ANTES DE TUDO — antes de ler o corpo, antes de qualquer
 * consulta e antes de qualquer scrypt. Duas razoes:
 *  - forca bruta: cada tentativa que passa daqui custa uma derivacao de 16 MiB
 *    (src/lib/senha.ts). Barrar so depois de derivar transformaria o proprio
 *    mecanismo de defesa em vetor de negacao de servico — o atacante nao
 *    precisaria acertar senha nenhuma para consumir a CPU e a memoria do
 *    container inteiro;
 *  - uma requisicao barrada nao abre sessao nenhuma, entao o 429 nunca deixa
 *    linha em `sessoes`.
 *
 * ATENCAO, honestamente: o contador e EM MEMORIA, POR PROCESSO (ver o
 * cabecalho de src/lib/rate-limit.ts). Isto e um quebra-molas contra abuso
 * ingenuo, NAO rate limiting distribuido e NAO controle de acesso — ele zera
 * quando o container reinicia, vira aproximacao se `replicas` passar de 1, e o
 * IP vem de um header que o cliente pode forjar. Quem protege a senha de
 * verdade e o custo do scrypt somado a uma senha boa.
 */
const excedeuRateLimit = criarLimitadorPorIp({
  janelaMs: JANELA_RATE_LIMIT_MS,
  maxPorJanela: MAX_LOGINS_POR_JANELA,
})

const Corpo = z.object({
  /**
   * `.trim()` ANTES do formato, e so aqui — `criarUsuario` de proposito NAO
   * apara (src/repositories/usuarios.ts), para que um e-mail colado com \n
   * atras exploda na cara de quem cadastrou em vez de criar a conta com um
   * endereco diferente do digitado. No login a assimetria e segura e
   * necessaria: o CHECK usuario_email_formato garante que NENHUM e-mail
   * gravado tem espaco nas bordas, entao aparar aqui nao pode fazer o login
   * cair em outra conta — no maximo faz cair na mesma. E sem aparar, o teclado
   * do celular que acrescenta um espaco depois do autocompletar (o caso comum
   * no balcao) devolveria 422 `dados_invalidos` para uma credencial correta, e
   * o vendedor ficaria olhando "dados invalidos" sem entender o que digitou de
   * errado.
   *
   * A caixa NAO e normalizada: quem cuida de "Maria@" e "maria@" serem a mesma
   * conta e o `lower(email)` de `autenticar`, servido pelo indice
   * usuario_email_unico.
   */
  email: z.string().trim().email(),
  /**
   * SEM regra de forca da senha, e sem tamanho maximo. Politica de senha
   * pertence ao CADASTRO (scripts/criar-usuario.mjs), nunca a porta de entrada:
   * um `.min(8)` aqui trancaria para fora, com um 422 que ela nao tem como
   * consertar, qualquer conta criada antes da regra existir — e ainda faria a
   * rota responder diferente conforme o TAMANHO do que foi digitado, dando ao
   * atacante um sinal de graca sobre o formato aceito. `min(1)` porque senha
   * vazia nao e tentativa de login; `conferirSenha` (src/lib/senha.ts) tambem
   * recusa string vazia por conta propria, entao a guarda existe nas duas
   * pontas.
   */
  senha: z.string().min(1),
})
  /**
   * `.strict()` recusa qualquer campo fora destes dois em vez de descarta-lo
   * em silencio. Aqui o campo perigoso nao e dinheiro, e PRIVILEGIO: um corpo
   * com `papel: 'admin'`, `usuarioId`, `ativo: true` ou `expiraEm` tem que ser
   * um 422 explicito, e nao um campo ignorado que passa despercebido. Sem
   * `.strict()`, um teste que mandasse `papel` no corpo so provaria que ele e
   * IGNORADO hoje — e o dia em que alguem espalhasse `...d` dentro de uma
   * chamada nova viraria escalacao de privilegio sem nenhum teste ficar
   * vermelho. O papel vem SEMPRE da linha em `usuarios`, lida pelo servidor.
   */
  .strict()

/**
 * Unico ponto de leitura de uma mensagem de erro para log. So `error.message`
 * e seguro: uma violacao de constraint em `usuarios` carrega A LINHA INTEIRA
 * na propriedade `detail` do erro do Postgres — nome, e-mail e o proprio
 * `senha_hash`. Um `detail` num log de aplicacao entrega material de ataque
 * offline (com o hash em maos, tenta-se dicionario a vontade, sem rate limit e
 * sem deixar rastro no servidor) para um conjunto de pessoas bem maior do que
 * o de quem tem senha de admin. Mesma regra de src/app/api/pedidos/route.ts.
 */
function mensagemSeguraDoErro(e: unknown): string {
  return e instanceof Error ? e.message : 'erro_desconhecido'
}

export async function POST(req: Request) {
  if (excedeuRateLimit(ipDoPedido(req.headers))) {
    return Response.json({ error: 'rate_limited' }, { status: 429, headers: SEM_CACHE })
  }

  const parsed = Corpo.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    // Erro achatado, sem dizer QUAL campo falhou: o formato do erro de
    // validacao nao pode ser um mapa de campos aceitos para quem sonda a rota.
    return Response.json({ error: 'dados_invalidos' }, { status: 422, headers: SEM_CACHE })
  }
  const d = parsed.data

  try {
    const usuario = await autenticar(d.email, d.senha)

    if (!usuario) {
      /**
       * UMA UNICA RECUSA PARA OS TRES CASOS — e-mail que nunca existiu, conta
       * desativada e senha errada. Nem o status, nem o corpo, nem o tempo
       * distinguem um do outro:
       *
       *  - o corpo e literalmente esta linha, sem campo `mensagem`. O doc
       *    comment de `autenticar` (src/repositories/usuarios.ts) fixa isso
       *    por escrito: nao ha o que curar do lado de ca se a diferenca ja nao
       *    existe do lado de la. A frase que o vendedor le ("e-mail ou senha
       *    invalidos") mora na tela /entrar, onde e uma constante — texto vindo
       *    do servidor e texto que uma "melhoria de UX" futura diferencia por
       *    caso sem ninguem perceber que virou um oraculo;
       *  - o tempo e igual porque `autenticar` confere a senha contra um hash
       *    descartavel quando o e-mail nao existe, e decide `ativo` DEPOIS da
       *    conferencia. Esta rota nao acrescenta ramo nenhum entre os tres:
       *    e o mesmo `if` e o mesmo `return` para todos.
       *
       * O que se ganha guardando o segredo: quem descobre por um 401 diferente
       * que "fulano@milagran" TEM conta ali passa a saber em quem gastar
       * tentativa de senha e para quem mandar phishing de "sua conta expirou";
       * e, no caso da conta desativada, descobre que a pessoa foi desligada da
       * empresa. Mesmo raciocinio de CpfDivergenteError em
       * src/app/api/pedidos/route.ts.
       *
       * NADA DO QUE FOI DIGITADO VAI PARA O LOG, nem o e-mail. Um log de
       * tentativas de login com e-mail e uma lista de contas (e, quando alguem
       * troca os campos de lugar, de senhas) legivel por todo mundo que tem
       * acesso ao log.
       */
      return Response.json({ error: 'credenciais_invalidas' }, { status: 401, headers: SEM_CACHE })
    }

    const { token, expiraEm } = await abrirSessao(usuario.id)

    /**
     * 204 SEM CORPO, de proposito.
     *
     * A resposta do login nao devolve papel, nome nem id: quem precisa saber
     * quem esta logado le a sessao NO SERVIDOR (usuarioDaSessaoNoServidor /
     * exigirPapel, src/lib/guarda.ts) a cada requisicao. Devolver `papel` aqui
     * seria o convite direto para a tela decidir o que mostrar (ou pior, o que
     * PEDIR) com base num valor que o cliente guardou — e controle de acesso
     * decidido no navegador nao e controle de acesso.
     *
     * A sessao ja existente no cookie de quem entra de novo NAO e revogada: o
     * Set-Cookie abaixo substitui o valor no navegador, e a sessao antiga
     * continua valendo ate expirar. E deliberado — o vendedor que entra
     * tambem pelo tablet do balcao nao pode derrubar a propria sessao do
     * celular. Quem encerra tudo de uma vez e revogarSessoesDoUsuario
     * (src/repositories/sessoes.ts), que e acao de emergencia, nao de login.
     *
     * Nao ha risco de fixacao de sessao: o token e sorteado agora
     * (gerarTokenDeSessao) e sobrescreve o que tiver chegado no cookie, entao
     * um valor plantado por terceiro nunca vira sessao autenticada.
     */
    return new Response(null, {
      status: 204,
      headers: {
        'Set-Cookie': cookieDeSessao(token, expiraEm),
        ...SEM_CACHE,
      },
    })
  } catch (e) {
    // Qualquer falha de infraestrutura (Postgres fora do ar, pool esgotado,
    // scrypt sem memoria). So a mensagem vai para o log — nunca o objeto de
    // erro cru, nunca `detail`, nunca o corpo da requisicao.
    console.error('[sessao] falha ao autenticar:', mensagemSeguraDoErro(e))
    return Response.json({ error: 'nao_foi_possivel_entrar' }, { status: 500, headers: SEM_CACHE })
  }
}

export async function DELETE(req: Request) {
  /**
   * Sair e IDEMPOTENTE: sem cookie, com cookie de uma instalacao antiga, com
   * token inventado ou com sessao ja revogada, a resposta e sempre o mesmo 204
   * com o cookie de logout. Duas razoes:
   *  - operacional: "sair" e a acao que a pessoa executa quando entrega o
   *    tablet para outro vendedor. Um erro ali deixa a duvida de se a sessao
   *    morreu ou nao, e a duvida no meio da fila termina com o tablet
   *    entregue mesmo assim;
   *  - seguranca: um 404 para token desconhecido transformaria esta rota num
   *    oraculo de "este token existe" — dava para sondar tokens sem nunca
   *    autenticar. `revogarSessao` ja nao sinaliza nada por essa mesma razao.
   *
   * NAO TEM RATE LIMIT, ao contrario do POST: nao ha segredo a adivinhar aqui.
   * O token tem 256 bits (src/lib/sessao.ts) e a unica coisa que um loop
   * consegue e revogar sessoes que ele proprio ja possui.
   */
  const token = tokenDoCookie(req.headers.get('cookie'))

  if (token !== null) {
    try {
      // A METADE QUE VALE do logout. Apagar o cookie so tira o token do
      // navegador; quem ja copiou o valor (extensao, proxy corporativo, um
      // print da aba de rede) nao e afetado por nada que o navegador faca — e
      // este UPDATE em `sessoes` que mata o token para todo mundo.
      await revogarSessao(token)
    } catch (e) {
      /**
       * DESVIO CONSCIENTE do "sair nunca falha": a promessa de 204 cobre os
       * casos em que NAO HA NADA A FAZER (sem cookie, token desconhecido,
       * sessao ja revogada), nao um Postgres fora do ar. Aqui a revogacao
       * REALMENTE nao aconteceu e o token continua valendo pelas horas que
       * faltam; responder 204 diria "pronto, saiu" para quem esta entregando o
       * tablet a outra pessoa, que e uma mentira com consequencia.
       *
       * O cookie de logout vai junto com o 500 assim mesmo: o navegador daquela
       * pessoa perde o acesso de qualquer jeito, e a tela pode dizer que a
       * sessao pode continuar ativa em outro lugar e que o admin precisa usar
       * revogarSessoesDoUsuario.
       */
      console.error('[sessao] falha ao revogar a sessao:', mensagemSeguraDoErro(e))
      return Response.json({ error: 'nao_foi_possivel_sair' }, {
        status: 500,
        headers: { 'Set-Cookie': cookieDeLogout(), ...SEM_CACHE },
      })
    }
  }

  // cookieDeLogout repete EXATAMENTE Path=/ e os demais atributos do cookie de
  // sessao — o navegador so substitui um cookie por outro de mesmo nome,
  // dominio e path (ver src/lib/sessao.ts). Com Path diferente, o "sair"
  // criaria um segundo cookie e a pessoa continuaria logada.
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': cookieDeLogout(), ...SEM_CACHE },
  })
}

/**
 * Verbos nao previstos respondem 405 COM `Allow`, em vez de cair no 404
 * padrao do Next: 404 diz "esta rota nao existe" e manda quem esta integrando
 * procurar o caminho certo; 405 + Allow diz "existe, e fala POST e DELETE".
 * A lista fica numa constante so para nao haver a chance de um handler anunciar
 * um conjunto de verbos diferente do outro.
 */
const METODOS_PERMITIDOS = 'POST, DELETE'

function metodoNaoPermitido(): Response {
  return Response.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: METODOS_PERMITIDOS, ...SEM_CACHE },
  })
}

export async function GET() {
  return metodoNaoPermitido()
}

export async function PUT() {
  return metodoNaoPermitido()
}

export async function PATCH() {
  return metodoNaoPermitido()
}
