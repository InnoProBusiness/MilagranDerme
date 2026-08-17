import { z } from 'zod'
import {
  criarLimitadorPorIp, ipDoPedido,
  JANELA_RATE_LIMIT_MS, MAX_CANDIDATURAS_POR_JANELA,
} from '@/lib/rate-limit'
import { registrarLead, type TipoLead } from '@/repositories/leads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/leads — "quero saber mais" da home (§17 do documento do cliente de
 * 16/08/2026).
 *
 * E a porta de entrada de UM tipo de lead so: 'interessado', a pessoa que ainda
 * nao comprou e so quer receber novidade. Representante e distribuidor NAO
 * entram por aqui — ver o bloco de `tipo` no handler.
 *
 * A rota e publica, anonima e escreve DADO PESSOAL (nome, e-mail, whatsapp,
 * cidade). Duas consequencias que estao no codigo abaixo e nao em nenhum
 * documento a parte:
 *
 *   1. RATE LIMIT PROPRIO. Sem freio, um script enche a tabela de leads na
 *      velocidade da rede — com nome e e-mail de terceiros, se quiser — e a
 *      unica coisa que a operacao ganharia no dia 25/08 e uma lista impossivel
 *      de usar.
 *   2. SEM CONSENTIMENTO, SEM LINHA. O aceite de LGPD e checado ANTES de
 *      qualquer escrita e a recusa e um 422, nao uma gravacao com
 *      `consentimento_lgpd = false`. Ver o bloco de `lgpd` no handler.
 *
 * HANDLER FINO: quem escreve e `registrarLead` (src/repositories/leads.ts), que
 * ja normaliza os opcionais para '' e deriva o carimbo de consentimento do
 * booleano. Este arquivo valida a entrada, decide o que a rota aceita e traduz
 * para HTTP.
 */

/**
 * Contador PROPRIO, com o teto do FORMULARIO DE CANDIDATURA e nao o do
 * checkout: os dois sao a mesma coisa do ponto de vista de abuso — um
 * formulario publico que grava dado pessoal de quem preencher —, e cinco envios
 * em dez minutos do mesmo IP ja e muito acima de qualquer uso humano. O
 * checkout tem teto maior porque uma compra legitima pode ser retentada; um
 * "quero saber mais" enviado cinco vezes ja e a mesma pessoa clicando duas
 * vezes no botao.
 *
 * O Map e proprio (criarLimitadorPorIp, src/lib/rate-limit.ts): o teto daqui nao
 * consome o orcamento de POST /api/candidatura nem o do checkout. Vale o aviso
 * honesto do cabecalho daquele arquivo — contador em memoria do processo, IP de
 * header forjavel: quebra-molas contra bot ingenuo, nunca controle de acesso.
 */
const excedeuRateLimit = criarLimitadorPorIp({
  janelaMs: JANELA_RATE_LIMIT_MS,
  maxPorJanela: MAX_CANDIDATURAS_POR_JANELA,
})

/**
 * Cobertura exata do ENUM tipo_lead cobrada pelo COMPILADOR, no mesmo molde de
 * src/app/api/admin/pedidos/[id]/route.ts: um valor novo no ENUM do banco que
 * nao aparecesse aqui quebraria o build em vez de virar um 422 misterioso em
 * producao.
 *
 * A lista ter os tres tipos NAO os libera — os outros dois morrem na checagem do
 * handler, com uma mensagem que diz para onde ir. E de proposito: tira-los do
 * schema devolveria "dados_invalidos" a quem tentasse, sem contar nada. Formato
 * e regra de negocio sao camadas diferentes, e a segunda tem mais a dizer.
 */
const TIPOS = {
  interessado: 'interessado',
  representante: 'representante',
  distribuidor: 'distribuidor',
} as const satisfies { [K in TipoLead]: K }

/**
 * `.strict()` como em toda rota da casa. Aqui ele nao guarda dinheiro — nao ha
 * dinheiro nesta rota — mas guarda duas outras coisas: `consentidoEm`, que e
 * DERIVADO do aceite e nunca aceito de fora (quem manda o carimbo escolhe a
 * prova de consentimento), e `origem`, que nesta tabela significa "como conheceu
 * a marca" e e preenchida pelo `<select>` do formulario de candidatura
 * (src/lib/candidatura.ts). Escrever 'home' ali criaria dois vocabularios na
 * mesma coluna e o filtro do painel passaria a misturar canal de aquisicao com
 * nome de tela; por isso esta rota simplesmente nao grava origem, e o DEFAULT ''
 * da coluna e a resposta honesta.
 *
 * NENHUM CAMPO TEM REGEX DE FORMATO ALEM DO E-MAIL E DA UF, e isso e escolha:
 * um lead recusado nao vira mensagem de erro que alguem conserta — vira lead
 * PERDIDO, porque a pessoa fecha a aba. `whatsapp` aceita mascara ("(11) 98888-7777")
 * porque o unico uso do campo e alguem ligar de volta, e a coluna nao tem CHECK
 * de formato (migrations/1755300400000_leads.sql) justamente por isso. Diferente
 * de `clientes.whatsapp`, que vai para o Mercado Pago e por isso e so digitos em
 * src/app/api/pedidos/route.ts.
 *
 * Os tetos de tamanho nao sao formato: sao o freio para o texto colado por
 * engano de outra janela nao virar uma linha de banco com um paragrafo dentro.
 */
const Corpo = z.object({
  tipo: z.enum(TIPOS),
  nome: z.string().trim().min(3).max(120),
  email: z.string().email(),
  whatsapp: z.string().trim().min(8).max(24).optional(),
  cidade: z.string().trim().min(1).max(80).optional(),
  // A UF chega em qualquer caixa e `registrarLead` normaliza para maiusculas
  // antes do INSERT (o motivo, e o contraste com `enderecos.estado`, esta
  // escrito em src/repositories/leads.ts). O CHECK lead_uf_valida so aceita duas
  // letras maiusculas ou ''.
  estado: z.string().trim().regex(/^[A-Za-z]{2}$/).optional(),
  mensagem: z.string().trim().max(1000).optional(),
  /**
   * O aceite do checkbox de LGPD. `z.boolean()` e nao `z.literal(true)` de
   * proposito: a recusa precisa ser um erro PROPRIO, com mensagem propria, e nao
   * o "dados_invalidos" generico de um campo mal preenchido — quem desmarcou a
   * caixa tem que ler que foi isso, senao reenvia o formulario identico e conclui
   * que o site esta quebrado. Ver a checagem no handler.
   */
  lgpd: z.boolean(),
}).strict()

/**
 * Unico ponto de leitura de mensagem de erro deste arquivo. So `error.message` e
 * seguro: uma violacao de CHECK em `leads` carrega a LINHA INTEIRA — nome,
 * e-mail, whatsapp, cidade — na propriedade `detail` do erro do Postgres, e
 * logar o objeto cru derramaria dado pessoal de quem preencheu o formulario no
 * stdout do container, que vai para o log agregado do Swarm. Mesmo aviso
 * registrado em src/repositories/leads.ts e em src/repositories/clientes.ts.
 */
function mensagemSeguraDoErro(e: unknown): string {
  return e instanceof Error ? e.message : 'erro_desconhecido'
}

export async function POST(req: Request) {
  // PRIMEIRA COISA DO HANDLER: um envio barrado nao chega a tocar no banco,
  // entao um 429 nunca deixa dado pessoal gravado.
  if (excedeuRateLimit(ipDoPedido(req.headers))) {
    return Response.json({ error: 'rate_limited' }, { status: 429 })
  }

  const parsed = Corpo.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'dados_invalidos' }, { status: 422 })
  }
  const d = parsed.data

  /**
   * SO 'interessado' ENTRA POR AQUI.
   *
   * Representante e distribuidor tem caminho proprio: o formulario de
   * candidatura (public/seja-representante.html -> POST /api/candidatura), que
   * exige nivel, area de atuacao e experiencia, gera o PDF, avisa a equipe por
   * e-mail E grava o lead com o mesmo consentimento carimbado
   * (src/lib/candidatura.ts, leadDaCandidatura). Deixar esta rota — que pede
   * quatro campos e nenhuma validacao de perfil — escrever aqueles dois tipos
   * daria a qualquer pessoa uma forma de encher a lista de representantes do
   * painel sem passar por nada daquilo. A lista de §17 e usada para LIGAR DE
   * VOLTA: inflada, ela para de ser usada.
   *
   * 422 com codigo proprio, e nao 404 nem "dados_invalidos": o corpo esta bem
   * formado e o tipo existe no ENUM — o que nao existe e esta porta para ele. A
   * mensagem diz para onde ir, porque quem tentou provavelmente quer mesmo se
   * candidatar.
   */
  if (d.tipo !== TIPOS.interessado) {
    return Response.json({
      error: 'tipo_nao_aceito',
      mensagem: 'Para se candidatar a representante ou distribuidor, use o formulário de candidatura em /seja-representante.html.',
    }, { status: 422 })
  }

  /**
   * SEM ACEITE, NAO GRAVA — E A ESCOLHA ESTA AQUI, POR ESCRITO.
   *
   * A tabela `leads` ACEITA `consentimento_lgpd = false` (o CHECK
   * lead_consentimento_coerente so exige que o carimbo de data acompanhe o
   * booleano), entao gravar a linha sem aceite seria tecnicamente possivel. A
   * rota recusa mesmo assim: guardar nome, e-mail e whatsapp de quem NAO
   * consentiu e tratamento de dado pessoal sem base legal, e uma linha com
   * `false` e exatamente isso — um cadastro que ninguem pode contatar, que nao
   * pode virar campanha e que so acrescenta risco ao vazamento do dia em que
   * houver um. O unico jeito de nao ter esse dado e nao aceita-lo.
   *
   * A checagem vem ANTES de qualquer escrita, e por isso o 422 e provavelmente
   * a unica coisa neste arquivo que nao deixa rastro nenhum no banco.
   *
   * NAO usamos `z.literal(true)` no schema (ver o comentario do campo): quem
   * desmarcou a caixa precisa de uma mensagem que fale da caixa.
   */
  if (d.lgpd !== true) {
    return Response.json({
      error: 'consentimento_obrigatorio',
      mensagem: 'Para receber contato da Milagran, é necessário aceitar o uso dos seus dados.',
    }, { status: 422 })
  }

  try {
    await registrarLead({
      // LITERAL, e nao `d.tipo`. A checagem acima ja garante o valor, mas quem
      // le esta chamada le o que ela grava sem precisar subir o arquivo — e um
      // dia em que o schema aceite mais um tipo, esta linha continua sendo a
      // porta de UM so.
      tipo: 'interessado',
      nome: d.nome,
      email: d.email,
      whatsapp: d.whatsapp,
      cidade: d.cidade,
      estado: d.estado,
      mensagem: d.mensagem,
      // `consentidoEm` NAO e passado de proposito: `registrarLead` carimba
      // `new Date()` — o instante em que o aceite chegou ao servidor — e deriva
      // o campo do booleano, num lugar so (src/repositories/leads.ts). Mandar
      // uma data daqui seria dar ao chamador o poder de escolher a prova.
      consentimentoLgpd: true,
    })
  } catch (e) {
    // SO a mensagem, nunca o objeto cru nem `detail` — ver mensagemSeguraDoErro.
    console.error('[leads] falha ao registrar o interesse:', mensagemSeguraDoErro(e))
    // 500, e nao a gravacao best-effort de src/lib/candidatura.ts. La o e-mail
    // com o PDF ainda chega a equipe quando o banco falha, entao engolir o erro
    // preserva a candidatura; aqui o banco e o UNICO destino — engolir seria
    // dizer "recebemos" para um formulario que se perdeu, e a pessoa nunca mais
    // volta para reenviar.
    return Response.json({ error: 'nao_foi_possivel_registrar_o_interesse' }, { status: 500 })
  }

  // 201 e o recurso foi criado; corpo minimo de proposito. O id do lead NAO
  // volta: e identificador interno, nao serve a quem preencheu o formulario e
  // devolve-lo a um endpoint anonimo so criaria superficie para descobrir
  // quantos leads existem. Mesmo espirito do `{ ok: true }` de
  // POST /api/candidatura.
  return Response.json({ ok: true }, { status: 201 })
}

/**
 * Demais verbos: 405 com `Allow`, padrao da casa (src/app/api/pedidos/route.ts).
 *
 * NAO ha GET aqui, e a ausencia e a defesa: quem LE leads e
 * GET /api/admin/leads, atras de `exigirPapel(req, ['admin'])`
 * (src/lib/guarda.ts). Um GET nesta URL publica exporia nome, e-mail e whatsapp
 * de todo mundo que preencheu o formulario — o vazamento mais barato que este
 * sistema poderia ter.
 */
function metodoNaoPermitido() {
  return Response.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'POST' },
  })
}

export const GET = metodoNaoPermitido
export const PUT = metodoNaoPermitido
export const PATCH = metodoNaoPermitido
export const DELETE = metodoNaoPermitido
