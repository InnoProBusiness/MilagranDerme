import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getDb, closeDb } from '@/lib/db'
import { avisoDeEscassez } from '@/lib/escassez'
import { MAX_CANDIDATURAS_POR_JANELA, MAX_COTACOES_POR_JANELA } from '@/lib/rate-limit'
import { GET as getEstoque, POST as postEstoque } from '@/app/api/estoque/route'
import { POST as postFrete, GET as getFrete } from '@/app/api/frete/route'
import { GET as getCep, POST as postCep } from '@/app/api/cep/[cep]/route'
import { POST as postLeads, GET as getLeads } from '@/app/api/leads/route'

/**
 * QUATRO DAS ROTAS PUBLICAS DO LANCAMENTO, num arquivo so (a quinta,
 * POST /api/cupons/validar, tem arquivo proprio — ./cupons-validar-route.test.ts): GET /api/estoque,
 * POST /api/frete, GET /api/cep/[cep] e POST /api/leads (§5 do plano de
 * 16/08/2026). Elas dividem este arquivo porque dividem a propriedade que mais
 * importa aqui — nenhuma delas exige autenticacao, e cada uma e uma porta aberta
 * para a internet inteira no dia do evento.
 *
 * NENHUM TESTE DESTE ARQUIVO TOCA A REDE. `vi.stubGlobal('fetch', ...)` troca o
 * fetch global antes de cada teste, e o padrao instalado no beforeEach LANCA:
 * um teste que fizer uma chamada externa nao prevista falha em vez de sair
 * silenciosamente para a internet com a credencial que estiver no .env da
 * maquina. Os dois clientes exercitados sao os DE PRODUCAO — src/lib/frete.ts e
 * src/lib/cep.ts rodam inteiros, com a normalizacao e as classes de erro reais.
 * E o oposto de src/app/api/__tests__/pedidos-route.test.ts, que mocka o modulo
 * `@/lib/frete` porque la o assunto e o pedido; aqui o assunto e justamente a
 * traducao provedor -> HTTP, e mockar o modulo apagaria o que se quer provar.
 *
 * ISOLAMENTO POR IDENTIDADE, no molde de
 * src/repositories/__tests__/estoque.test.ts: todo kit criado aqui nasce sob o
 * prefixo `publicas-`/`MG-PUB-` com sufixo aleatorio, porque estoque_movimentos
 * tem trigger append-only (estoque_movimento_append_only_trg) e nao ha DELETE
 * possivel — a cadeia kits <- estoques <- movimentos e imovel de baixo para
 * cima. Nenhuma asserção olha para linha que este arquivo nao tenha acabado de
 * criar. Os leads, esses sim, sao apagados por e-mail: `leads` nao e
 * referenciada por ninguem e os e-mails `publicas-*@exemplo.com` sao so deste
 * arquivo (o Vitest roda os arquivos em PARALELO contra o mesmo Postgres, entao
 * um DELETE sem WHERE apagaria as linhas de
 * src/repositories/__tests__/leads.test.ts).
 */

const PRECO_KIT_CENTAVOS = 100000

/** Os 50 kits do evento (§2/§4), o mesmo numero do seed de producao. */
const LOTE_PRESENCIAL = 50

const EMAIL_INTERESSADO = 'publicas-interessado@exemplo.com'
const EMAIL_SEM_LGPD = 'publicas-sem-lgpd@exemplo.com'
const EMAIL_TIPO_RECUSADO = 'publicas-representante@exemplo.com'
const EMAIL_STRICT = 'publicas-strict@exemplo.com'
const EMAIL_RATE = 'publicas-rate@exemplo.com'
const EMAIL_BLOQUEADO = 'publicas-bloqueado@exemplo.com'
const EMAILS = [
  EMAIL_INTERESSADO, EMAIL_SEM_LGPD, EMAIL_TIPO_RECUSADO,
  EMAIL_STRICT, EMAIL_RATE, EMAIL_BLOQUEADO,
] as const

/**
 * Base FALSA do Clube Envios. Com o fetch stubado ela nunca e alcancada, mas o
 * valor esta aqui como segunda barreira: se um dia o stub deixar de ser
 * instalado, a chamada vai para um dominio que nao existe em vez de para a API
 * de producao com a credencial da Milagran. Os testes de cotacao afirmam a URL
 * chamada, entao a barreira e verificada, e nao apenas declarada.
 */
const BASE_FALSA = 'https://clube-envios.invalido.teste'

/** IP proprio por requisicao: /api/frete e /api/leads tem rate limit por IP, e o
 * contador e estado de MODULO — vive por todo o arquivo. Sem isto, o teto de uma
 * rota seria consumido pelo conjunto dos testes e os ultimos veriam 429 sem
 * relacao nenhuma com o que alegam provar. Mesma tecnica de
 * src/app/api/__tests__/pedidos-route.test.ts. */
let contadorIp = 0
const ipUnico = () => `10.9.0.${++contadorIp}`

type ChamadaHttp = { url: string; corpo: unknown }
let chamadas: ChamadaHttp[] = []

function respostaJson(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Instala o fetch falso e passa a registrar toda chamada em `chamadas` — e por
 * ela que se prova QUE corpo o servidor mandou ao provedor (o valor declarado, as
 * dimensoes, o CEP) sem depender de resposta nenhuma.
 */
function stubarFetch(responder: (url: string, corpo: unknown) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = String(entrada)
    const corpo = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    chamadas.push({ url, corpo })
    return responder(url, corpo)
  }))
}

/**
 * Duas opcoes com valor E prazo diferentes, e nenhum valor redondo: um frete
 * somado errado (ou lido como centavos quando e reais) desaparece dentro de
 * numeros redondos sem que nenhuma assercao pisque. Os nomes de campo sao os que
 * src/lib/frete.ts procura por lista de apelidos — a primeira chamada real em
 * homologacao pode corrigir aquela lista, e este e o lugar que acompanha.
 */
/**
 * NA FORMA REAL DO PROVEDOR, conferida contra uma cotacao de producao em
 * 17/08/2026: envelope `valores`, TUDO em string, preco com VIRGULA decimal e
 * o nome do servico separado do nome da transportadora.
 *
 * Antes deste commit o fixture era uma aproximacao inventada (envelope
 * `cotacao`, numeros nativos) e por isso a rota passava no teste enquanto
 * falharia em producao. Um duble que nao se parece com o original so testa a
 * si mesmo.
 */
const CORPO_COTACAO_OK = {
  id_cotacao: '987',
  valores: [
    { id_servico: '3', id_transportadora: '1', transportadora: 'CLUBE ENVIOS - Correios', servico: 'PAC', prazo: '8', valor_frete: '23,50' },
    { id_servico: '4', id_transportadora: '1', transportadora: 'CLUBE ENVIOS - Correios', servico: 'SEDEX', prazo: '3', valor_frete: '49,90' },
  ],
}

/** Resposta do ViaCEP com o hifen que ele devolve de verdade e a UF minuscula —
 * as duas normalizacoes de src/lib/cep.ts precisam aparecer na resposta HTTP. */
const CORPO_VIACEP_OK = {
  cep: '01310-100',
  logradouro: 'Avenida Paulista ',
  bairro: 'Bela Vista',
  localidade: 'São Paulo',
  uf: 'sp',
}

type KitDeTeste = {
  id: string
  slug: string
  estoquePresencialId: string | null
  estoqueOnlineId: string | null
}

/**
 * Cria um kit descartavel e, opcionalmente, o desenho de estoque do seed de
 * producao (migrations/1755300700000_seed_estoque.sql): duas linhas para o mesmo
 * kit com politicas OPOSTAS — presencial com teto rigido, online ilimitado — e a
 * carga inicial como MOVIMENTO, porque nao existe coluna de saldo.
 *
 * `ajuste` (negativo) e como este arquivo faz o saldo cair sem inventar pedido:
 * um movimento 'ajuste' nao exige pedido_id (CHECK movimento_pedido_coerente) e e
 * o unico caminho de escrita que pode levar o disponivel abaixo de zero — que e
 * exatamente o estado que a rota publica precisa saber esconder da home.
 *
 * `ordem: 99` para nao competir pelo "primeiro kit ativo" do catalogo com o kit
 * do lancamento nem com os kits de outros arquivos de teste.
 */
async function criarKit(opcoes: {
  comEstoque?: boolean
  entrada?: number
  ajuste?: number
  ativo?: boolean
} = {}): Promise<KitDeTeste> {
  const db = getDb()
  const s = randomUUID().slice(0, 8)
  const slug = `publicas-kit-${s}`

  const kit = await db.insertInto('kits').values({
    slug, nome: 'Kit Publicas', sku: `MG-PUB-${s}`,
    preco_centavos: PRECO_KIT_CENTAVOS, unidades: 1, ordem: 99,
    ativo: opcoes.ativo ?? true,
  }).returning('id').executeTakeFirstOrThrow()

  if (opcoes.comEstoque !== true) {
    return { id: kit.id, slug, estoquePresencialId: null, estoqueOnlineId: null }
  }

  const presencial = await db.insertInto('estoques')
    .values({ kit_id: kit.id, canal: 'presencial', ilimitado: false })
    .returning('id').executeTakeFirstOrThrow()

  const online = await db.insertInto('estoques')
    .values({ kit_id: kit.id, canal: 'online', ilimitado: true })
    .returning('id').executeTakeFirstOrThrow()

  if (opcoes.entrada !== undefined) {
    await db.insertInto('estoque_movimentos').values({
      estoque_id: presencial.id, tipo: 'entrada', quantidade: opcoes.entrada,
      motivo: 'Estoque de lancamento presencial 25/08/2026',
    }).execute()
  }

  if (opcoes.ajuste !== undefined) {
    await db.insertInto('estoque_movimentos').values({
      estoque_id: presencial.id, tipo: 'ajuste', quantidade: opcoes.ajuste,
      motivo: 'Conferencia do teste de rotas publicas',
    }).execute()
  }

  return {
    id: kit.id, slug,
    estoquePresencialId: presencial.id,
    estoqueOnlineId: online.id,
  }
}

function requisicaoEstoque(query = ''): Request {
  return new Request(`http://localhost/api/estoque${query}`)
}

function requisicaoFrete(corpo: unknown, ip: string = ipUnico()): Request {
  return new Request('http://localhost/api/frete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(corpo),
  })
}

function requisicaoCep(cep: string): [Request, { params: Promise<{ cep: string }> }] {
  return [
    new Request(`http://localhost/api/cep/${cep}`),
    // Em Next 16 `params` e uma Promise, e o handler tem que dar `await` nela —
    // por isso o teste entrega uma Promise de verdade, e nao o objeto cru.
    { params: Promise.resolve({ cep }) },
  ]
}

function requisicaoLead(corpo: unknown, ip: string = ipUnico()): Request {
  return new Request('http://localhost/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(corpo),
  })
}

async function lerLeads(email: string) {
  return getDb().selectFrom('leads').selectAll().where('email', '=', email).execute()
}

const INTERESSADO = {
  tipo: 'interessado' as const,
  nome: 'Ana Souza',
  email: EMAIL_INTERESSADO,
  whatsapp: '(11) 98888-7777',
  cidade: 'São Paulo',
  estado: 'sp',
  mensagem: 'Quero saber quando abre a venda online.',
  lgpd: true,
}

describe('rotas publicas do lancamento', () => {
  beforeAll(() => {
    // A rota le as variaveis DENTRO da funcao (src/lib/frete.ts, `configuracao`),
    // entao sobrescreve-las aqui basta. O Vitest isola cada arquivo em seu
    // proprio worker (isolate: true, o padrao), logo esta mutacao nao vaza para
    // os arquivos que rodam em paralelo.
    process.env.CLUBE_ENVIOS_TOKEN = 'token-de-teste'
    process.env.CLUBE_ENVIOS_CLIENTE_ID = '4242'
    process.env.CEP_ORIGEM_EXPEDICAO = '01310100'
    process.env.CLUBE_ENVIOS_BASE_URL = BASE_FALSA
  })

  beforeEach(async () => {
    await getDb().deleteFrom('leads').where('email', 'in', EMAILS).execute()
    chamadas = []
    // O teste de credencial ausente APAGA esta variavel de proposito; restaurar
    // aqui garante que ele nao deixe os testes seguintes cotando sem
    // configuracao — o sintoma seria um 503 correto pelo motivo errado.
    process.env.CLUBE_ENVIOS_TOKEN = 'token-de-teste'
    // Padrao que LANCA: nenhum teste deste arquivo pode sair para a rede sem
    // dizer, com todas as letras, que resposta espera receber.
    stubarFetch(() => {
      throw new Error('fetch inesperado: este teste nao declarou resposta de provedor')
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Os leads deste arquivo saem antes de a conexao fechar — sao as UNICAS linhas
  // que ele consegue apagar. Kits, estoques e movimentos ficam: o trigger
  // append-only e as chaves ON DELETE RESTRICT tornam a cadeia imovel de baixo
  // para cima, e o isolamento deles e por identidade (sufixo aleatorio), nunca
  // por limpeza. Ver o cabecalho do arquivo.
  afterAll(async () => {
    await getDb().deleteFrom('leads').where('email', 'in', EMAILS).execute()
    await closeDb()
  })

  // ------------------------------------------------------------------
  // GET /api/estoque — §5/§11
  // ------------------------------------------------------------------
  describe('GET /api/estoque', () => {
    it('devolve o saldo presencial, o aviso de escassez e o canal online ilimitado', async () => {
      const kit = await criarKit({ comEstoque: true, entrada: LOTE_PRESENCIAL })

      const r = await getEstoque(requisicaoEstoque(`?kit=${kit.slug}`))
      expect(r.status).toBe(200)

      // Corpo INTEIRO, e nao campo a campo: e o que impede alguem de "so
      // acrescentar um id util" na resposta desta rota publica sem que nenhum
      // teste perceba. O aviso vem da propria src/lib/escassez.ts porque o que
      // este teste prova e a FIACAO (a rota usa aquela funcao); as frases exatas
      // ja sao travadas em src/lib/__tests__/escassez.test.ts.
      expect(await r.json()).toEqual({
        kitSlug: kit.slug,
        presencial: { disponivel: LOTE_PRESENCIAL, total: LOTE_PRESENCIAL, esgotado: false },
        aviso: avisoDeEscassez(LOTE_PRESENCIAL, LOTE_PRESENCIAL),
        online: { ilimitado: true },
      })
    })

    /**
     * A resposta e consultada por POLLING de 15s por todo navegador aberto na
     * home (§11). Um contador guardado por proxy — ou pelo cache de rota do
     * Next — continuaria anunciando kits que ja sairam da caixa, e a loja
     * prometeria unidade que nao existe para quem esta na fila. Contador errado
     * e pior que contador nenhum.
     */
    it('responde Cache-Control: no-store, inclusive quando nao acha o kit', async () => {
      const kit = await criarKit({ comEstoque: true, entrada: 10 })

      const achou = await getEstoque(requisicaoEstoque(`?kit=${kit.slug}`))
      expect(achou.headers.get('cache-control')).toBe('no-store')

      const naoAchou = await getEstoque(requisicaoEstoque('?kit=publicas-kit-que-nao-existe'))
      expect(naoAchou.headers.get('cache-control')).toBe('no-store')
    })

    /**
     * SEGURANCA: esta e a unica rota publica que fala de estoque, e ela nao tem
     * autenticacao nenhuma. O que sai daqui e o que a home imprime — dois
     * numeros e uma frase. Nenhum identificador interno pode atravessar: nem
     * `kits.id`, nem `estoques.id`, nem id de pedido (que e chave de escrita no
     * livro-razao, estoque_movimentos.pedido_id), nem qualquer dado de cliente.
     *
     * A assercao e por FORMATO, e nao so pelos ids deste teste: nenhum uuid, de
     * ninguem, pode aparecer no corpo. Assim ela continua valendo para um campo
     * novo que alguem acrescente amanha.
     */
    it('SEGURANCA: nao devolve identificador interno nenhum', async () => {
      const kit = await criarKit({ comEstoque: true, entrada: LOTE_PRESENCIAL })

      const r = await getEstoque(requisicaoEstoque(`?kit=${kit.slug}`))
      const corpo = await r.json()
      const bruto = JSON.stringify(corpo)

      const uuidsCriados = [kit.id, kit.estoquePresencialId, kit.estoqueOnlineId]
        .filter((v): v is string => v !== null)
      expect(uuidsCriados).toHaveLength(3)
      for (const uuid of uuidsCriados) expect(bruto).not.toContain(uuid)
      // Qualquer uuid, em qualquer campo, presente ou futuro.
      expect(bruto).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
      // A superficie da resposta e fechada: quatro chaves, e o slug e o unico
      // identificador — publico, ja presente na URL da vitrine.
      expect(Object.keys(corpo).sort()).toEqual(['aviso', 'kitSlug', 'online', 'presencial'])
    })

    it('saldo zerado liga o esgotado e troca o aviso', async () => {
      const kit = await criarKit({
        comEstoque: true, entrada: LOTE_PRESENCIAL, ajuste: -LOTE_PRESENCIAL,
      })

      const r = await getEstoque(requisicaoEstoque(`?kit=${kit.slug}`))
      const corpo = await r.json()

      expect(corpo.presencial).toEqual({ disponivel: 0, total: LOTE_PRESENCIAL, esgotado: true })
      // Nivel literal aqui (e nao avisoDeEscassez de novo): e o valor que a
      // vitrine usa para trocar a CTA por "COMPRAR ONLINE".
      expect(corpo.aviso.nivel).toBe('esgotado')
      // O canal online NAO esgota junto: sao estoques separados (§4) e e ele que
      // continua vendendo depois que a caixa do evento acaba.
      expect(corpo.online).toEqual({ ilimitado: true })
    })

    /**
     * Um `ajuste` de inventario maior que o saldo deixa o disponivel NEGATIVO, e
     * src/repositories/estoque.ts nao recusa isso de proposito — a divergencia
     * entre a conferencia fisica e a contabilidade tem que aparecer no painel.
     * O que a HOME nao pode e imprimir "-5 kits disponiveis": abaixo de zero e
     * zero significam a mesma coisa para quem quer comprar.
     */
    it('saldo negativo nunca vira numero negativo na home', async () => {
      const kit = await criarKit({
        comEstoque: true, entrada: LOTE_PRESENCIAL, ajuste: -(LOTE_PRESENCIAL + 5),
      })

      const r = await getEstoque(requisicaoEstoque(`?kit=${kit.slug}`))
      const corpo = await r.json()

      expect(corpo.presencial.disponivel).toBe(0)
      expect(corpo.presencial.esgotado).toBe(true)
      expect(corpo.aviso.nivel).toBe('esgotado')
    })

    /**
     * Kit que nao entra no evento: existe no catalogo, vende online, e nao tem
     * caixa nenhuma no balcao. `null` e a resposta honesta — o mesmo contrato
     * que src/components/vitrine.tsx recebe (`escassez: {...} | null`). Tratar a
     * ausencia de cadastro como zero faria a home anunciar "Os 0 kits
     * disponiveis para compra presencial foram esgotados", frase falsa sobre um
     * lote que nunca existiu.
     */
    it('kit sem linha de estoque devolve presencial e aviso nulos, sem inventar esgotado', async () => {
      const kit = await criarKit({ comEstoque: false })

      const r = await getEstoque(requisicaoEstoque(`?kit=${kit.slug}`))
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({
        kitSlug: kit.slug,
        presencial: null,
        aviso: null,
        // Sem linha de estoque, `baixarEstoque` nao aplica teto nenhum: o
        // comportamento efetivo do canal online E ilimitado, e dizer `false`
        // aqui esconderia da tela o unico canal que nunca acaba.
        online: { ilimitado: true },
      })
    })

    it('kit inexistente e kit desativado devolvem o MESMO 404', async () => {
      const desativado = await criarKit({ comEstoque: true, entrada: 10, ativo: false })

      const inexistente = await getEstoque(requisicaoEstoque('?kit=publicas-kit-nunca-existiu'))
      expect(inexistente.status).toBe(404)
      expect(await inexistente.json()).toEqual({ error: 'kit_nao_encontrado' })

      // Kit fora do catalogo nao anuncia contador — e a resposta e
      // indistinguivel da de um slug inventado, para nao contar a um curioso o
      // que existe desligado.
      const fora = await getEstoque(requisicaoEstoque(`?kit=${desativado.slug}`))
      expect(fora.status).toBe(404)
      expect(await fora.json()).toEqual({ error: 'kit_nao_encontrado' })
    })

    /**
     * Sem `?kit` a rota responde sobre o primeiro kit ATIVO do catalogo — e a
     * forma que a home usa. O teste NAO fixa qual slug e esse de proposito: o
     * Vitest roda os arquivos em paralelo contra o mesmo Postgres e
     * src/repositories/__tests__/produtos.test.ts insere e apaga kits ativos com
     * `ordem` baixa enquanto isto roda. Fixar o slug faria este teste falhar por
     * causa de um vizinho, e mandaria quem investiga para o lugar errado. O que
     * ele prova e o contrato: a forma default responde 200, diz de qual kit
     * esta falando e devolve a mesma superficie de campos.
     */
    it('sem ?kit responde sobre o primeiro kit ativo, com a mesma superficie', async () => {
      await criarKit({ comEstoque: true, entrada: LOTE_PRESENCIAL })

      const r = await getEstoque(requisicaoEstoque())
      expect(r.status).toBe(200)
      const corpo = await r.json()
      expect(typeof corpo.kitSlug).toBe('string')
      expect(corpo.kitSlug.length).toBeGreaterThan(0)
      expect(Object.keys(corpo).sort()).toEqual(['aviso', 'kitSlug', 'online', 'presencial'])
    })

    // Escrever estoque e acao de admin (`ajustarEstoque`, atras de sessao). Um
    // POST nesta URL publica seria qualquer pessoa mexendo no numero que decide
    // quem leva kit no dia 25/08.
    it('outros verbos respondem 405 com Allow', async () => {
      const r = postEstoque()
      expect(r.status).toBe(405)
      expect(r.headers.get('allow')).toBe('GET')
      expect(await r.json()).toEqual({ error: 'method_not_allowed' })
    })
  })

  // ------------------------------------------------------------------
  // POST /api/frete — §13
  // ------------------------------------------------------------------
  describe('POST /api/frete', () => {
    it('devolve as opcoes do provedor com valor em centavos inteiros e prazo em dias', async () => {
      const kit = await criarKit()
      stubarFetch(() => respostaJson(CORPO_COTACAO_OK))

      const r = await postFrete(requisicaoFrete({
        cep: '01310100', kitSlug: kit.slug, quantidade: 1,
      }))
      expect(r.status).toBe(200)

      // DINHEIRO: o provedor respondeu com STRING E VIRGULA ("23,50" / "49,90")
      // e a rota devolve CENTAVOS INTEIROS. Um erro de fator 100 aqui vira
      // frete cem vezes maior (ou menor) na tela do comprador sem quebrar nada.
      // Corpo inteiro: nem `idCotacao` nem `idTransportadora` atravessam, e
      // `servico` atravessa porque e o que separa PAC de SEDEX na tela — as
      // duas opcoes chegam com a MESMA transportadora.
      expect(await r.json()).toEqual({
        opcoes: [
          { idServico: 3, transportadora: 'CLUBE ENVIOS - Correios', servico: 'PAC', valorCentavos: 2350, prazoDias: 8 },
          { idServico: 4, transportadora: 'CLUBE ENVIOS - Correios', servico: 'SEDEX', valorCentavos: 4990, prazoDias: 3 },
        ],
      })

      // UMA chamada por requisicao, e para a base configurada — nunca para a API
      // real. Cotar duas vezes gastaria o dobro da cota da Milagran por tela.
      expect(chamadas).toHaveLength(1)
      expect(chamadas[0].url).toBe(`${BASE_FALSA}/cotacao`)
    })

    /**
     * DINHEIRO: o que a rota DECLARA ao provedor sai do catalogo e do cadastro,
     * nunca do corpo da requisicao. Valor declarado errado e indenizacao errada
     * em caso de extravio; peso e medida errados sao frete errado, e o erro so
     * aparece no balcao dos Correios — depois de `pedidos.frete_centavos` ja
     * estar congelado pelo trigger de imutabilidade.
     */
    it('DINHEIRO: cota com o preco do CATALOGO e as dimensoes do cadastro do kit', async () => {
      const kit = await criarKit()
      stubarFetch(() => respostaJson(CORPO_COTACAO_OK))

      const r = await postFrete(requisicaoFrete({
        cep: '20040020', kitSlug: kit.slug, quantidade: 2,
      }))
      expect(r.status).toBe(200)

      const linha = await getDb().selectFrom('kits')
        .select(['preco_centavos', 'peso_gramas', 'altura_cm', 'largura_cm', 'comprimento_cm'])
        .where('id', '=', kit.id)
        .executeTakeFirstOrThrow()

      const enviado = chamadas[0].corpo as Record<string, unknown>
      expect(enviado.cep_destino).toBe('20040020')
      // A UNICA conversao centavos -> decimal do sistema acontece em
      // src/lib/frete.ts: 2 x R$ 1.000,00 = 2000.00 reais declarados.
      expect(enviado.valor_declarado).toBe((linha.preco_centavos * 2) / 100)
      expect(enviado.volumes).toEqual([{
        altura: linha.altura_cm,
        largura: linha.largura_cm,
        comprimento: linha.comprimento_cm,
        peso: linha.peso_gramas,
        quantidade_volumes: 2,
      }])
    })

    /**
     * DINHEIRO: mandar valor no corpo e RECUSADO, nao ignorado — e a diferenca
     * importa. Um campo ignorado deixaria a tentativa de manipulacao
     * indistinguivel de uma cotacao normal, inclusive no log. O `.strict()` do
     * schema e quem transforma isso em 422.
     *
     * E a recusa acontece ANTES da chamada ao provedor: um corpo invalido nao
     * pode gastar cota paga da Milagran.
     */
    it('DINHEIRO: valor de frete no corpo e 422 e nao gasta chamada no provedor', async () => {
      const kit = await criarKit()
      const base = { cep: '01310100', kitSlug: kit.slug, quantidade: 1 }
      const tentativas = [
        { valorCentavos: 1 },
        { frete: 0 },
        { freteCentavos: 1 },
        { precoUnitarioCentavos: 1 },
        { total: 1 },
      ]

      for (const extra of tentativas) {
        const r = await postFrete(requisicaoFrete({ ...base, ...extra }))
        expect(r.status).toBe(422)
        expect(await r.json()).toEqual({ error: 'dados_invalidos' })
      }

      expect(chamadas).toHaveLength(0)
    })

    it('CEP fora do formato vira 422 cep_invalido, sem chamar o provedor', async () => {
      const kit = await criarKit()
      // Sete digitos, com hifen (o formato que o proprio ViaCEP devolve), com
      // letra e vazio. O hifen esta na lista de proposito: aceita-lo aqui faria a
      // cotacao funcionar com um valor que POST /api/pedidos recusa no submit.
      const invalidos = ['0131010', '01310-100', 'abcdefgh', '', '013101000']

      for (const cep of invalidos) {
        const r = await postFrete(requisicaoFrete({ cep, kitSlug: kit.slug, quantidade: 1 }))
        expect(r.status, `cep=${cep}`).toBe(422)
        expect(await r.json()).toEqual({
          error: 'cep_invalido',
          mensagem: 'Informe um CEP com 8 dígitos, apenas números.',
        })
      }

      expect(chamadas).toHaveLength(0)
    })

    it('kit inexistente vira 422 sem gastar chamada no provedor', async () => {
      const r = await postFrete(requisicaoFrete({
        cep: '01310100', kitSlug: 'publicas-kit-nunca-existiu', quantidade: 1,
      }))
      expect(r.status).toBe(422)
      expect(await r.json()).toEqual({ error: 'kit_indisponivel' })
      expect(chamadas).toHaveLength(0)
    })

    /**
     * DINHEIRO: os tres modos de indisponibilidade tem o MESMO desfecho para
     * quem esta comprando — 503 com mensagem curada. O que NENHUM deles pode
     * produzir e uma lista de opcoes com valor zero "para nao travar o
     * checkout": frete zero vira "R$ 0,00" na tela e prejuizo da Milagran em
     * cada postagem (ver o cabecalho de src/lib/frete.ts).
     *
     * As classes de erro sao as REAIS: este arquivo nao mocka `@/lib/frete`, o
     * cliente roda inteiro em cima do fetch falso. Um despacho por prefixo de
     * string em vez de `instanceof` cairia aqui.
     */
    it('DINHEIRO: provedor indisponivel vira 503 curado, nunca frete zero', async () => {
      const kit = await criarKit()
      const modos = [
        {
          nome: 'provedor recusou (envelope result:false com HTTP 200)',
          preparar: () => stubarFetch(() => respostaJson({ result: false, messages: 'cliente_id invalido' })),
        },
        {
          nome: 'resposta ilegivel (servico sem preco nem prazo)',
          preparar: () => stubarFetch(() => respostaJson({
            id_cotacao: 1, cotacao: [{ id_servico: 3, transportadora: 'Correios PAC' }],
          })),
        },
        {
          nome: 'credencial ausente na stack',
          preparar: () => { delete process.env.CLUBE_ENVIOS_TOKEN },
        },
        {
          nome: 'provedor fora do ar (rede)',
          preparar: () => stubarFetch(() => { throw new Error('ECONNREFUSED') }),
        },
      ]

      for (const modo of modos) {
        // A credencial volta ANTES de cada modo: sem isto, o modo que a apaga
        // faria todos os seguintes falharem por FreteNaoConfiguradoError e o
        // teste continuaria verde provando uma coisa so, quatro vezes.
        process.env.CLUBE_ENVIOS_TOKEN = 'token-de-teste'
        modo.preparar()
        const r = await postFrete(requisicaoFrete({
          cep: '01310100', kitSlug: kit.slug, quantidade: 1,
        }))
        expect(r.status, modo.nome).toBe(503)
        expect(await r.json()).toEqual({
          error: 'frete_indisponivel',
          mensagem: 'Não foi possível calcular o frete agora. Tente novamente em instantes.',
        })
      }
    })

    /**
     * DINHEIRO: o provedor aceitou a cotacao e nao devolveu servico nenhum —
     * nenhuma transportadora atende aquele CEP. Devolver 200 com `opcoes: []`
     * seria a versao educada de inventar frete zero: a tela desenharia uma lista
     * vazia e o comprador seguiria sem opcao escolhida.
     *
     * 422 e nao 503 porque repetir nao adianta: nao ha indisponibilidade a
     * esperar, ha um destino que aquele volume nao alcanca.
     */
    it('DINHEIRO: cotacao sem opcao nenhuma nao vira 200 com lista vazia', async () => {
      const kit = await criarKit()
      stubarFetch(() => respostaJson({ id_cotacao: 1, cotacao: [] }))

      const r = await postFrete(requisicaoFrete({
        cep: '01310100', kitSlug: kit.slug, quantidade: 1,
      }))
      expect(r.status).toBe(422)
      const corpo = await r.json()
      expect(corpo.error).toBe('frete_sem_atendimento')
      // Nem lista vazia, nem valor nenhum: a resposta nao carrega `opcoes`.
      expect(corpo.opcoes).toBeUndefined()
    })

    /**
     * O freio existe porque CADA requisicao que chega a cotacao gasta uma
     * chamada paga na conta da Milagran no Clube Envios — aqui o abuso nao enche
     * tabela, consome cota, e o sintoma no dia 25/08 apareceria como "frete
     * indisponivel" para comprador legitimo.
     */
    it('rate limit por IP: permite MAX_COTACOES_POR_JANELA e barra a seguinte', async () => {
      const kit = await criarKit()
      stubarFetch(() => respostaJson(CORPO_COTACAO_OK))
      const ip = ipUnico()

      for (let i = 0; i < MAX_COTACOES_POR_JANELA; i++) {
        const r = await postFrete(requisicaoFrete({
          cep: '01310100', kitSlug: kit.slug, quantidade: 1,
        }, ip))
        // O teto nao pode cortar trafego legitimo ANTES de ser atingido.
        expect(r.status, `cotacao ${i + 1}`).toBe(200)
      }
      expect(chamadas).toHaveLength(MAX_COTACOES_POR_JANELA)

      const bloqueada = await postFrete(requisicaoFrete({
        cep: '01310100', kitSlug: kit.slug, quantidade: 1,
      }, ip))
      expect(bloqueada.status).toBe(429)
      expect(await bloqueada.json()).toEqual({ error: 'rate_limited' })
      // A requisicao barrada nao chegou ao provedor: o freio vem antes de tudo.
      expect(chamadas).toHaveLength(MAX_COTACOES_POR_JANELA)
    })

    it('o teto e por IP: outro IP continua cotando', async () => {
      const kit = await criarKit()
      stubarFetch(() => respostaJson(CORPO_COTACAO_OK))

      const r = await postFrete(requisicaoFrete({
        cep: '01310100', kitSlug: kit.slug, quantidade: 1,
      }))
      expect(r.status).toBe(200)
    })

    it('outros verbos respondem 405 com Allow', async () => {
      const r = getFrete()
      expect(r.status).toBe(405)
      expect(r.headers.get('allow')).toBe('POST')
    })
  })

  // ------------------------------------------------------------------
  // GET /api/cep/[cep] — autofill do checkout
  // ------------------------------------------------------------------
  describe('GET /api/cep/[cep]', () => {
    it('devolve o endereco ja normalizado para o formulario', async () => {
      stubarFetch(() => respostaJson(CORPO_VIACEP_OK))

      const r = await getCep(...requisicaoCep('01310100'))
      expect(r.status).toBe(200)
      // CEP so com digitos (a coluna `enderecos.cep` recusa o hifen pelo CHECK
      // endereco_cep_digitos) e UF em maiusculas: preencher o formulario com o
      // valor formatado do provedor faria o proprio wizard considerar o campo
      // invalido no submit.
      expect(await r.json()).toEqual({
        cep: '01310100',
        rua: 'Avenida Paulista',
        bairro: 'Bela Vista',
        cidade: 'São Paulo',
        estado: 'SP',
      })
      expect(chamadas).toHaveLength(1)
      expect(chamadas[0].url).toContain('viacep.com.br')
      // Acerto PODE ser guardado: a rua de um CEP nao muda no dia do
      // lancamento, e cada resposta reaproveitada e uma consulta a menos num
      // servico publico e gratuito. E o oposto do 404, que leva `no-store`.
      expect(r.headers.get('cache-control')).toBe('public, max-age=86400')
    })

    /**
     * AUTOFILL E CONVENIENCIA, NUNCA BLOQUEIO. Os tres caminhos abaixo — CEP que
     * nao existe, provedor fora do ar e HTTP de erro — sao o MESMO 404 para
     * quem chamou, e a tela trata 404 deixando os campos vazios para a pessoa
     * digitar. O ViaCEP e gratuito e sem contrato de disponibilidade; se ele
     * cair no dia 25/08, isso nao pode impedir uma unica venda.
     */
    it('CEP inexistente, provedor fora do ar e erro HTTP viram o mesmo 404', async () => {
      const modos = [
        { nome: 'inexistente', preparar: () => stubarFetch(() => respostaJson({ erro: true })) },
        { nome: 'rede', preparar: () => stubarFetch(() => { throw new Error('ETIMEDOUT') }) },
        { nome: 'http 500', preparar: () => stubarFetch(() => respostaJson({}, 500)) },
      ]

      for (const modo of modos) {
        modo.preparar()
        const r = await getCep(...requisicaoCep('99999999'))
        expect(r.status, modo.nome).toBe(404)
        expect(await r.json()).toEqual({ error: 'cep_nao_encontrado' })
        // Falha NUNCA fica guardada: um provedor fora do ar por trinta segundos
        // nao pode virar um dia inteiro de autofill morto para aquele CEP.
        expect(r.headers.get('cache-control')).toBe('no-store')
      }
    })

    it('CEP fora do formato vira 404 sem consultar o ViaCEP', async () => {
      for (const cep of ['0131010', '01310-100', 'abcdefgh', '013101000']) {
        const r = await getCep(...requisicaoCep(cep))
        expect(r.status, `cep=${cep}`).toBe(404)
        expect(await r.json()).toEqual({ error: 'cep_nao_encontrado' })
      }
      expect(chamadas).toHaveLength(0)
    })

    it('outros verbos respondem 405 com Allow', async () => {
      const r = postCep()
      expect(r.status).toBe(405)
      expect(r.headers.get('allow')).toBe('GET')
    })
  })

  // ------------------------------------------------------------------
  // POST /api/leads — §17
  // ------------------------------------------------------------------
  describe('POST /api/leads', () => {
    it('grava o interessado com o consentimento carimbado e devolve 201', async () => {
      const antes = new Date()
      const r = await postLeads(requisicaoLead(INTERESSADO))
      expect(r.status).toBe(201)
      // Corpo minimo: o id do lead NAO volta para um endpoint anonimo.
      expect(await r.json()).toEqual({ ok: true })

      const [lead] = await lerLeads(EMAIL_INTERESSADO)
      expect(lead).toBeDefined()
      expect(lead.tipo).toBe('interessado')
      expect(lead.nome).toBe('Ana Souza')
      // Mascara preservada: o unico uso do campo e alguem ligar de volta, e a
      // coluna nao tem CHECK de formato de proposito.
      expect(lead.whatsapp).toBe('(11) 98888-7777')
      // UF normalizada para maiusculas por registrarLead — o CHECK
      // lead_uf_valida so aceita duas letras maiusculas.
      expect(lead.estado).toBe('SP')
      // LGPD: a PROVA de consentimento e o par booleano + carimbo. Um "sim" sem
      // quando nao responde nem ao titular que pede exclusao nem a ANPD.
      expect(lead.consentimento_lgpd).toBe(true)
      expect(lead.consentido_em).toBeInstanceOf(Date)
      // O carimbo e o instante em que o aceite CHEGOU ao servidor, e nao uma
      // data escolhida por quem chamou (o `.strict()` recusa `consentidoEm` no
      // corpo). `Number(Date)` devolve o timestamp; `Number(null)` devolve 0, que
      // reprovaria a comparacao — a assercao continua honesta sem `!` nenhum.
      expect(Number(lead.consentido_em)).toBeGreaterThanOrEqual(antes.getTime() - 1000)
      // `origem` nesta coluna significa "como conheceu a marca" (o select do
      // formulario de candidatura). Esta rota nao inventa valor para ela.
      expect(lead.origem).toBe('')
    })

    /**
     * LGPD: SEM ACEITE, NAO GRAVA. A tabela aceitaria a linha com
     * `consentimento_lgpd = false` (o CHECK lead_consentimento_coerente so exige
     * coerencia com o carimbo), entao a recusa e uma ESCOLHA desta rota, escrita
     * la: guardar nome, e-mail e whatsapp de quem nao consentiu e tratamento de
     * dado pessoal sem base legal — um cadastro que ninguem pode contatar e que
     * so acrescenta risco ao vazamento do dia em que houver um.
     *
     * A checagem vem antes de qualquer escrita, entao o 422 nao deixa rastro
     * nenhum no banco. E o que este teste afirma.
     */
    it('LGPD: sem consentimento recusa com 422 e NAO grava dado pessoal nenhum', async () => {
      const r = await postLeads(requisicaoLead({
        ...INTERESSADO, email: EMAIL_SEM_LGPD, lgpd: false,
      }))
      expect(r.status).toBe(422)
      expect(await r.json()).toEqual({
        error: 'consentimento_obrigatorio',
        mensagem: 'Para receber contato da Milagran, é necessário aceitar o uso dos seus dados.',
      })

      expect(await lerLeads(EMAIL_SEM_LGPD)).toHaveLength(0)
    })

    /**
     * Representante e distribuidor entram pelo formulario de candidatura
     * (POST /api/candidatura), que exige nivel, area de atuacao e experiencia,
     * gera o PDF, avisa a equipe E grava o lead com o mesmo consentimento
     * carimbado (src/lib/candidatura.ts). Deixar esta rota — quatro campos,
     * nenhuma validacao de perfil — escrever aqueles tipos daria a qualquer
     * pessoa uma forma de inflar a lista de representantes do painel, que a
     * operacao usa para LIGAR DE VOLTA.
     */
    it('recusa tipo representante e distribuidor sem gravar linha nenhuma', async () => {
      for (const tipo of ['representante', 'distribuidor'] as const) {
        const r = await postLeads(requisicaoLead({
          ...INTERESSADO, email: EMAIL_TIPO_RECUSADO, tipo,
        }))
        expect(r.status, tipo).toBe(422)
        expect((await r.json()).error).toBe('tipo_nao_aceito')
      }

      expect(await lerLeads(EMAIL_TIPO_RECUSADO)).toHaveLength(0)
    })

    it('tipo fora do ENUM, e-mail invalido e campo extra sao 422 achatado', async () => {
      const corpos: unknown[] = [
        { ...INTERESSADO, email: EMAIL_STRICT, tipo: 'comprador' },
        { ...INTERESSADO, email: 'nao-e-email' },
        // `.strict()`: `consentidoEm` e `origem` sao derivados/decididos pelo
        // servidor — quem manda o carimbo escolheria a propria prova de
        // consentimento.
        { ...INTERESSADO, email: EMAIL_STRICT, consentidoEm: '2020-01-01T00:00:00Z' },
        { ...INTERESSADO, email: EMAIL_STRICT, origem: 'home' },
        { ...INTERESSADO, email: EMAIL_STRICT, lgpd: 'sim' },
      ]

      for (const corpo of corpos) {
        const r = await postLeads(requisicaoLead(corpo))
        expect(r.status).toBe(422)
        expect(await r.json()).toEqual({ error: 'dados_invalidos' })
      }

      expect(await lerLeads(EMAIL_STRICT)).toHaveLength(0)
    })

    it('rate limit por IP: permite MAX_CANDIDATURAS_POR_JANELA e barra o seguinte sem gravar', async () => {
      const ip = ipUnico()

      for (let i = 0; i < MAX_CANDIDATURAS_POR_JANELA; i++) {
        const r = await postLeads(requisicaoLead({ ...INTERESSADO, email: EMAIL_RATE }, ip))
        expect(r.status, `envio ${i + 1}`).toBe(201)
      }
      // Cada envio e uma linha NOVA de proposito: nao ha upsert nem deduplicacao
      // por e-mail, porque cada envio e um evento de consentimento com instante
      // proprio (migrations/1755300400000_leads.sql).
      expect(await lerLeads(EMAIL_RATE)).toHaveLength(MAX_CANDIDATURAS_POR_JANELA)

      // A barrada leva um e-mail que nunca teve linha nenhuma: se o 429 fosse
      // decidido depois de qualquer escrita, ele apareceria.
      const bloqueada = await postLeads(requisicaoLead({ ...INTERESSADO, email: EMAIL_BLOQUEADO }, ip))
      expect(bloqueada.status).toBe(429)
      expect(await bloqueada.json()).toEqual({ error: 'rate_limited' })
      expect(await lerLeads(EMAIL_BLOQUEADO)).toHaveLength(0)
    })

    /**
     * NAO ha GET nesta URL, e a ausencia e a defesa: quem le leads e
     * GET /api/admin/leads, atras de sessao de administrador. Um GET publico
     * aqui exporia nome, e-mail e whatsapp de todo mundo que preencheu o
     * formulario.
     */
    it('SEGURANCA: nao existe GET publico de leads — outros verbos sao 405', async () => {
      const r = getLeads()
      expect(r.status).toBe(405)
      expect(r.headers.get('allow')).toBe('POST')
      expect(await r.json()).toEqual({ error: 'method_not_allowed' })
    })
  })
})
