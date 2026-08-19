import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { getDb, closeDb } from '@/lib/db'
import { POST, GET } from '@/app/api/vendas-presenciais/route'
import { NOME_COOKIE_SESSAO } from '@/lib/sessao'
import { abrirSessao, revogarSessao } from '@/repositories/sessoes'
import { saldoDoEstoque } from '@/repositories/estoque'

/**
 * O BALCAO DO EVENTO DE 25/08 (§10), pelo lado do HTTP.
 *
 * O que este arquivo existe para provar, em uma frase: nenhum kit sai da caixa
 * sem sessao de vendedor, e nenhum kit sai da caixa duas vezes.
 *
 * ESTE ARQUIVO NAO APAGA NADA, pelo mesmo motivo ja registrado em
 * src/repositories/__tests__/estoque.test.ts: estoque_movimentos tem o trigger
 * append-only (estoque_movimento_append_only_trg) que recusa DELETE de
 * proposito, e a cadeia estoque_movimentos -> pedidos -> clientes/kits e toda ON
 * DELETE RESTRICT. Desligar o trigger para limpar seria pior duas vezes: o ALTER
 * TABLE toma lock ACCESS EXCLUSIVE e travaria os arquivos que o Vitest roda em
 * paralelo contra o mesmo Postgres, e um teste que desarma a protecao para
 * funcionar deixa de provar que a protecao existe.
 *
 * A alternativa e ISOLAMENTO POR IDENTIDADE: todo identificador nasce sob o
 * prefixo `vp-`/`MG-VP-` deste arquivo E com um sufixo aleatorio novo a cada
 * teste (kit, estoque, vendedor, admin, comprador). Nenhuma assercao olha para
 * linha que este arquivo nao tenha acabado de criar. O banco local acumula
 * linhas; o de CI nasce vazio a cada rodada.
 *
 * NAO HA ipUnico() como em pedidos-route.test.ts: POST /api/vendas-presenciais
 * nao tem rate limit por IP, e a ausencia e deliberada (a rota explica por que —
 * no evento todas as vendas saem do mesmo celular, atras do mesmo IP). Se um dia
 * alguem acrescentar o freio, este arquivo comeca a falhar em bloco a partir da
 * 11a requisicao, e essa falha e a mensagem certa.
 */

/**
 * A UNICA costura mockada e a chamada de rede ao Mercado Pago. Nao ha outra
 * forma de exercitar a rota sem uma conta e um cartao reais — e o que interessa
 * aqui e o que a rota faz ANTES e DEPOIS do provedor: a transacao que registra a
 * venda, a baixa de estoque e a resposta que a tela do vendedor le.
 *
 * `chamadas` guarda o VALOR enviado ao provedor porque dinheiro tem que sair do
 * catalogo: se algum dia o corpo da requisicao conseguir influenciar o total, e
 * aqui que aparece.
 */
const provedor = vi.hoisted(() => ({
  status: 'pending',
  statusDetail: '',
  erro: false,
  recusa: false,
  chamadas: [] as Array<{ valorCentavos: number; referenciaExterna: string }>,
}))

vi.mock('@/lib/mercadopago', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/mercadopago')>()
  return {
    ...real,
    criarPagamentoMP: async (
      e: { valor: number; referenciaExterna: string },
      chaveIdempotencia: string,
    ) => {
      if (provedor.erro) {
        // Status 0 = NAO HOUVE RESPOSTA (timeout/rede). Insistir faz sentido.
        throw new real.ErroMercadoPago(0, 'sem_resposta', 'timeout na criacao da cobranca')
      }
      if (provedor.recusa) {
        // 403 do PolicyAgent — o que a conta com `address_pending` devolveu em
        // producao em 19/08/2026, para Pix, boleto E cartao. Insistir nao
        // resolve: e preciso mexer na conta do Mercado Pago.
        throw new real.ErroMercadoPago(
          403, 'PA_UNAUTHORIZED_RESULT_FROM_POLICIES', 'At least one policy returned UNAUTHORIZED.',
        )
      }
      provedor.chamadas.push({ valorCentavos: e.valor, referenciaExterna: e.referenciaExterna })
      return {
        // A chave de idempotencia e o id da linha local em `pagamentos`;
        // devolve-la como id do provedor mantem os dois lados unicos por
        // tentativa, sem inventar um gerador so para o teste.
        id: `mp-${chaveIdempotencia}`,
        status: provedor.status,
        statusDetail: provedor.statusDetail,
        referenciaExterna: e.referenciaExterna,
        pixCopiaECola: '00020126...milagran',
        pixQrBase64: 'iVBORw0KGgo=',
        expiraEm: '2026-08-25T23:59:59.000-03:00',
      }
    },
  }
})

/**
 * Conta os envios de confirmacao sem tocar na Resend. O e-mail e efeito externo
 * irreversivel: quantas vezes ele sai importa tanto quanto o saldo do estoque.
 */
const emails = vi.hoisted(() => ({ enviados: [] as string[] }))

vi.mock('@/lib/email-pedido', () => ({
  enviarConfirmacaoDePedido: async (pedidoId: string) => {
    emails.enviados.push(pedidoId)
  },
}))

const PRECO_KIT_CENTAVOS = 100000

/**
 * DOIS kits na caixa, e nao os 50 do evento. O numero de producao (§2/§4, seed
 * em migrations/1755300700000_seed_estoque.sql) esta provado onde ele importa —
 * src/repositories/__tests__/estoque.test.ts recusa a 51a unidade contando a
 * partir da mesma constante. Aqui o que se prova e o COMPORTAMENTO DA ROTA na
 * fronteira do esgotamento, e chegar la vendendo 50 vezes so tornaria o arquivo
 * lento sem provar nada a mais.
 */
const ENTRADA_PRESENCIAL = 2

let idKit: string
let slugDoKit: string
let idVendedor: string
let idAdmin: string
let tokenVendedor: string
let tokenAdmin: string
let comprador: { nome: string; email: string; cpf: string; whatsapp: string }

/**
 * Reproduz, para um kit descartavel, o desenho do seed de producao: duas linhas
 * de `estoques` para o mesmo kit com politicas OPOSTAS (presencial com teto
 * rigido, online ilimitado) e a carga inicial do presencial como MOVIMENTO —
 * nao existe coluna de saldo em lugar nenhum (src/repositories/estoque.ts).
 *
 * O canal online nasce SEM entrada nenhuma, igual ao seed: com `ilimitado =
 * true` o saldo deixa de ser teto, entao uma entrada la seria um numero sem
 * significado. E e justamente por isso que ele serve de testemunha em §4: se a
 * venda presencial encostar no online, o zero dele vira negativo.
 */
async function semear() {
  provedor.status = 'pending'
  provedor.statusDetail = ''
  provedor.erro = false
  provedor.chamadas = []
  emails.enviados = []

  const db = getDb()
  const s = randomUUID().slice(0, 8)

  slugDoKit = `vp-kit-${s}`
  const kit = await db.insertInto('kits').values({
    slug: slugDoKit, nome: 'Kit Balcao', sku: `MG-VP-${s}`,
    preco_centavos: PRECO_KIT_CENTAVOS, unidades: 1, ordem: 99, ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idKit = kit.id

  const presencial = await db.insertInto('estoques')
    .values({ kit_id: idKit, canal: 'presencial', ilimitado: false })
    .returning('id').executeTakeFirstOrThrow()

  await db.insertInto('estoques')
    .values({ kit_id: idKit, canal: 'online', ilimitado: true })
    .execute()

  await db.insertInto('estoque_movimentos').values({
    estoque_id: presencial.id, tipo: 'entrada', quantidade: ENTRADA_PRESENCIAL,
    motivo: 'Estoque de lancamento presencial 25/08/2026',
  }).execute()

  // SEGURANCA: `senha_hash` aqui nao e senha de ninguem e nao autentica nada. O
  // banco nao valida o formato da coluna (quem produz e confere e
  // src/lib/senha.ts), e esta rota nunca passa por `autenticar` — ela le sessao,
  // e a sessao e aberta abaixo por abrirSessao, que e o codigo de producao.
  const vendedor = await db.insertInto('usuarios').values({
    nome: 'Vendedora do Balcao', email: `vp-vendedor-${s}@exemplo.com`,
    senha_hash: 'scrypt$16384$8$1$naoexiste$naoexiste', papel: 'vendedor', ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idVendedor = vendedor.id

  const admin = await db.insertInto('usuarios').values({
    nome: 'Dona da Milagran', email: `vp-admin-${s}@exemplo.com`,
    senha_hash: 'scrypt$16384$8$1$naoexiste$naoexiste', papel: 'admin', ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idAdmin = admin.id

  tokenVendedor = (await abrirSessao(idVendedor)).token
  tokenAdmin = (await abrirSessao(idAdmin)).token

  // E-mail proprio de cada teste: `clientes` e identificado por lower(email)
  // (indice cliente_email_unico), e um e-mail compartilhado entre testes faria
  // um deles esbarrar no cadastro que o outro deixou — inclusive em
  // CpfDivergenteError, que nao tem nada a ver com o que se quer provar aqui.
  comprador = {
    nome: 'Ana Souza',
    email: `vp-cliente-${s}@exemplo.com`,
    cpf: '39053344705',
    whatsapp: '62999990000',
  }
}

function requisicao(corpo: unknown, token?: string) {
  return new Request('https://milagranoficial.com.br/api/vendas-presenciais', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Um cookie so, sem espaco depois do nome: e assim que o header chega
      // quando ha apenas ele. A leitura por /;\s*/ (src/lib/sessao.ts) esta
      // provada em src/lib/__tests__/sessao.test.ts — aqui se testa a rota, nao
      // o parser.
      ...(token ? { cookie: `${NOME_COOKIE_SESSAO}=${token}` } : {}),
    },
    body: JSON.stringify(corpo),
  })
}

/** Corpo minimo de uma venda de balcao paga em Pix, com o kit deste teste. */
function corpoDaVenda(quantidade = 1) {
  return {
    kitSlug: slugDoKit,
    quantidade,
    metodo: 'pix',
    ...comprador,
  }
}

/**
 * Os pedidos que tocaram ESTE kit. Escopado por kit, e nao um count(*) global:
 * o Vitest roda os arquivos em paralelo contra o mesmo Postgres, e um contador
 * global mudaria por causa de qualquer outro arquivo rodando no mesmo instante.
 */
async function pedidosDoKit() {
  return getDb()
    .selectFrom('pedidos')
    .innerJoin('pedido_itens', 'pedido_itens.pedido_id', 'pedidos.id')
    .selectAll('pedidos')
    .where('pedido_itens.kit_id', '=', idKit)
    // criado_em nao e unico dentro de uma mesma transacao; `id` desempata para
    // que a ordem seja estavel entre duas leituras.
    .orderBy('pedidos.criado_em', 'asc')
    .orderBy('pedidos.id', 'asc')
    .execute()
}

async function baixasDoPedido(pedidoId: string) {
  return getDb()
    .selectFrom('estoque_movimentos')
    .select(['quantidade', 'motivo'])
    .where('pedido_id', '=', pedidoId)
    .where('tipo', '=', 'baixa')
    .execute()
}

async function disponivelPresencial() {
  const saldo = await saldoDoEstoque(idKit, 'presencial')
  return saldo?.disponivel ?? null
}

describe('POST /api/vendas-presenciais', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  // -------------------------------------------------------------------
  // ACESSO
  // -------------------------------------------------------------------

  // A rota escreve cliente, pedido e MOVIMENTO DE ESTOQUE — ela tira kit da
  // caixa do evento. Sem a guarda, um POST anonimo esvazia o estoque do
  // lancamento antes de o evento comecar, e cada unidade "vendida" fica presa a
  // um pedido que ninguem pagou.
  it('SEGURANCA: sem cookie de sessao devolve 401 e nao registra venda nenhuma', async () => {
    const r = await POST(requisicao(corpoDaVenda()))

    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({ error: 'nao_autenticado' })
    expect(await pedidosDoKit()).toHaveLength(0)
    expect(await disponivelPresencial()).toBe(ENTRADA_PRESENCIAL)
  })

  // O 401 e decidido ANTES de qualquer leitura de corpo: um corpo perfeitamente
  // valido, com dado pessoal completo, nao pode deixar cliente gravado so
  // porque o pedido foi recusado depois.
  it('SEGURANCA/LGPD: requisicao sem sessao com corpo valido nao grava o cliente', async () => {
    const r = await POST(requisicao(corpoDaVenda()))
    expect(r.status).toBe(401)

    const clientes = await getDb().selectFrom('clientes').select('id')
      .where(sql<boolean>`lower(email) = lower(${comprador.email})`).execute()
    expect(clientes).toHaveLength(0)
  })

  it('SEGURANCA: token que nao existe no banco devolve 401', async () => {
    const r = await POST(requisicao(corpoDaVenda(), 'token-que-nunca-foi-emitido'))
    expect(r.status).toBe(401)
    expect(await pedidosDoKit()).toHaveLength(0)
  })

  // "Sair" e "derrubar o celular perdido" precisam valer na requisicao seguinte,
  // e nao daqui a 12 horas: sessaoValida exige revogada_em IS NULL.
  it('SEGURANCA: sessao revogada devolve 401', async () => {
    await revogarSessao(tokenVendedor)

    const r = await POST(requisicao(corpoDaVenda(), tokenVendedor))
    expect(r.status).toBe(401)
    expect(await pedidosDoKit()).toHaveLength(0)
  })

  it('SEGURANCA: usuario desativado no meio do evento perde a sessao na hora', async () => {
    await getDb().updateTable('usuarios').set({ ativo: false })
      .where('id', '=', idVendedor).execute()

    const r = await POST(requisicao(corpoDaVenda(), tokenVendedor))
    expect(r.status).toBe(401)
    expect(await pedidosDoKit()).toHaveLength(0)
  })

  /**
   * SOBRE O 403 NESTA ROTA — vale escrever, porque a ausencia do teste parece
   * buraco e nao e.
   *
   * O ENUM papel_usuario tem exatamente dois valores hoje, 'admin' e 'vendedor'
   * (migrations/1755300300000_usuarios_sessoes.sql), e o mapa COBERTURA de
   * src/lib/guarda.ts diz que os DOIS alcancam 'vendedor' — admin enxerga tudo
   * que vendedor enxerga. Como esta rota exige exatamente ['vendedor'], NAO
   * EXISTE sessao valida que leve 403 aqui: forjar uma exigiria um terceiro
   * papel, que o banco recusa por estar fora do ENUM, ou mockar a leitura de
   * sessao — e um teste que mente sobre o tipo do banco nao prova nada sobre o
   * banco.
   *
   * O ramo de 403 e real e esta coberto onde ele ACONTECE: em
   * src/app/api/__tests__/admin-guarda.test.ts, onde as rotas /api/admin/*
   * exigem ['admin'] e a sessao de vendedor bate na porta. O que este arquivo
   * prova do lado do acesso e o par que existe de verdade aqui: o vendedor
   * entra, o admin tambem entra, e ninguem mais entra.
   *
   * Se um dia o ENUM ganhar um papel novo ('expedicao' e o exemplo citado na
   * propria migration), o Record<PapelUsuario, ...> de guarda.ts quebra a
   * compilacao e obriga a decisao — e o teste de 403 desta rota passa a ser
   * escrivivel. Ate la, ele nao seria um teste, seria um mock.
   */
  it('sessao de admin tambem vende no balcao (COBERTURA de src/lib/guarda.ts)', async () => {
    const r = await POST(requisicao(corpoDaVenda(), tokenAdmin))

    expect(r.status).toBe(201)
    const [pedido] = await pedidosDoKit()
    expect(pedido.vendedor_id).toBe(idAdmin)
  })

  // -------------------------------------------------------------------
  // A VENDA
  // -------------------------------------------------------------------

  it('vendedor registra a venda com canal presencial e vendedor_id preenchido', async () => {
    const r = await POST(requisicao(corpoDaVenda(2), tokenVendedor))

    expect(r.status).toBe(201)
    const corpo = await r.json()
    expect(corpo.vendaRegistrada).toBe(true)
    expect(typeof corpo.numero).toBe('number')
    // token e a chave publica da URL /pedido/<token>: um uuid, nunca o numero
    // sequencial (src/repositories/pedidos.ts).
    expect(corpo.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(corpo.pagamento.metodo).toBe('pix')
    expect(corpo.pagamento.pixCopiaECola).toBeTruthy()

    const [pedido] = await pedidosDoKit()
    // As duas colunas que este teste existe para provar: o eixo do canal e a
    // pessoa atras do balcao. As duas sao CONGELADAS pelo trigger de
    // imutabilidade — se nao entrarem certas no INSERT, nao ha UPDATE que
    // conserte depois.
    expect(pedido.canal).toBe('presencial')
    expect(pedido.vendedor_id).toBe(idVendedor)
    // Atribuicao de comissao e OUTRO eixo, e no balcao ela e da casa: o cookie
    // de atribuicao mora no navegador de quem COMPRA, e no balcao o navegador e
    // o do vendedor — le-lo aqui daria todas as vendas do dia ao ultimo link de
    // representante que aquele celular tivesse aberto.
    expect(pedido.origem).toBe('casa')
    expect(pedido.representante_id).toBeNull()
  })

  // DINHEIRO: o preco sai do catalogo e o frete e zero POR NAO EXISTIR — o kit
  // sai na mao do comprador (§2). Se alguem um dia cotar frete nesta rota, este
  // teste fica vermelho, que e o comportamento desejado: a decisao teria mudado.
  it('DINHEIRO: total e o preco do catalogo, com frete zero e sem desconto', async () => {
    const r = await POST(requisicao(corpoDaVenda(2), tokenVendedor))
    expect(r.status).toBe(201)

    const [pedido] = await pedidosDoKit()
    expect(pedido.subtotal_centavos).toBe(PRECO_KIT_CENTAVOS * 2)
    expect(pedido.desconto_centavos).toBe(0)
    expect(pedido.frete_centavos).toBe(0)
    expect(pedido.total_centavos).toBe(PRECO_KIT_CENTAVOS * 2)
    // E foi ESSE valor que chegou ao provedor, e nao um numero montado no
    // navegador do vendedor.
    expect(provedor.chamadas).toEqual([
      { valorCentavos: PRECO_KIT_CENTAVOS * 2, referenciaExterna: pedido.id },
    ])
  })

  // Com Corpo.strict(), mandar dinheiro no corpo nao e mais silenciosamente
  // IGNORADO: a requisicao inteira e recusada. Prova mais do que "o valor
  // gravado bateu com o catalogo" — prova que a tentativa nem chega a virar
  // venda.
  it('DINHEIRO: valor monetario no corpo e recusado com 422, sem registrar venda', async () => {
    const r = await POST(requisicao({
      ...corpoDaVenda(),
      total: 1,
      precoUnitarioCentavos: 1,
      frete: -5000,
    }, tokenVendedor))

    expect(r.status).toBe(422)
    expect(await r.json()).toEqual({ error: 'dados_invalidos' })
    expect(await pedidosDoKit()).toHaveLength(0)
    expect(await disponivelPresencial()).toBe(ENTRADA_PRESENCIAL)
  })

  // §10: o balcao nao pergunta endereco porque nao ha entrega. A ausencia e
  // dado, nao formulario incompleto — e ela que mantem a venda de balcao fora da
  // fila da expedicao (listarLogisticaAdmin so lista pedido COM endereco).
  it('LGPD: a venda de balcao nao grava endereco nenhum', async () => {
    const r = await POST(requisicao(corpoDaVenda(), tokenVendedor))
    expect(r.status).toBe(201)

    const [pedido] = await pedidosDoKit()
    expect(pedido.endereco_id).toBeNull()

    const enderecos = await getDb().selectFrom('enderecos')
      .innerJoin('clientes', 'clientes.id', 'enderecos.cliente_id')
      .select('enderecos.id')
      .where(sql<boolean>`lower(clientes.email) = lower(${comprador.email})`)
      .execute()
    expect(enderecos).toHaveLength(0)
  })

  it('kit inexistente ou inativo devolve 422 sem tocar no estoque', async () => {
    const r = await POST(requisicao({
      ...corpoDaVenda(), kitSlug: `vp-nao-existe-${randomUUID().slice(0, 8)}`,
    }, tokenVendedor))

    expect(r.status).toBe(422)
    expect(await r.json()).toEqual({ error: 'kit_indisponivel' })
    expect(await disponivelPresencial()).toBe(ENTRADA_PRESENCIAL)
  })

  // -------------------------------------------------------------------
  // ESTOQUE (§4 e §10)
  // -------------------------------------------------------------------

  /**
   * O TESTE DO PLANO INTEIRO, do lado da rota: a venda presencial baixa a
   * unidade NA CRIACAO — antes de qualquer confirmacao do provedor, porque o
   * comprador esta na frente do vendedor e vai sair com o kit — e baixa do
   * estoque PRESENCIAL, sem encostar no online.
   *
   * O canal online e a testemunha: ele nasce sem entrada nenhuma, entao qualquer
   * baixa que caisse la deixaria o disponivel dele negativo. Zero e a prova de
   * que os dois estoques sao mesmo separados (§4).
   */
  it('§4: a venda baixa 1 no estoque presencial e NAO toca o estoque online', async () => {
    const r = await POST(requisicao(corpoDaVenda(1), tokenVendedor))
    expect(r.status).toBe(201)

    expect(await disponivelPresencial()).toBe(ENTRADA_PRESENCIAL - 1)

    const online = await saldoDoEstoque(idKit, 'online')
    expect(online?.disponivel).toBe(0)
    expect(online?.vendido).toBe(0)
  })

  // A baixa acontece com o pedido ainda NAO PAGO (Pix esperando o webhook). E o
  // ponto em que esta rota diverge do checkout online, onde a unidade so sai no
  // pagamento: carrinho abandonado nao segura estoque, comprador de pe no balcao
  // segura.
  it('§10: a unidade sai da caixa antes de o pagamento ser confirmado', async () => {
    const r = await POST(requisicao(corpoDaVenda(1), tokenVendedor))
    expect(r.status).toBe(201)

    const [pedido] = await pedidosDoKit()
    // Pix criado e ainda nao pago: conciliarPagamento levou o pedido de
    // 'pendente' para 'aguardando_pagamento'.
    expect(pedido.status).toBe('aguardando_pagamento')
    expect(await baixasDoPedido(pedido.id)).toHaveLength(1)
    expect(await disponivelPresencial()).toBe(ENTRADA_PRESENCIAL - 1)
  })

  /**
   * ESTOQUE ESGOTADO E 409, NUNCA 500 — e a tela do vendedor precisa poder ler a
   * mensagem em voz alta para quem esta na fila. Um 500 aqui ensinaria a
   * operacao a tratar "acabou" como "o sistema caiu", e a reacao seguinte seria
   * entregar o kit e anotar num papel.
   *
   * E a transacao inteira reverte: nem pedido, nem cliente, nem movimento de
   * estoque. Um "quase vendido" que consumisse a unidade seria pior do que a
   * recusa — sumiria com o kit sem ninguem ter comprado.
   */
  it('estoque insuficiente devolve 409 estoque_esgotado, com quantos restam, e nao registra venda', async () => {
    const primeira = await POST(requisicao(corpoDaVenda(1), tokenVendedor))
    expect(primeira.status).toBe(201)

    // Restou 1 na caixa e esta venda pede 2.
    const r = await POST(requisicao(corpoDaVenda(2), tokenVendedor))

    expect(r.status).toBe(409)
    const corpo = await r.json()
    expect(corpo.error).toBe('estoque_esgotado')
    expect(corpo.disponivel).toBe(ENTRADA_PRESENCIAL - 1)
    // Mensagem PROPRIA e legivel, com o numero que permite fechar a venda com
    // menos unidades. Nao e a copy de vitrine (src/lib/escassez.ts) — aquela
    // fala com o comprador sobre o saldo, esta fala com o operador sobre a venda
    // que acabou de ser recusada.
    expect(corpo.mensagem).toContain(String(ENTRADA_PRESENCIAL - 1))

    // Continua existindo UM pedido (o da primeira venda) e UMA unidade na caixa.
    expect(await pedidosDoKit()).toHaveLength(1)
    expect(await disponivelPresencial()).toBe(ENTRADA_PRESENCIAL - 1)
  })

  it('caixa zerada devolve 409 e a venda recusada nao deixa saldo negativo', async () => {
    for (let i = 0; i < ENTRADA_PRESENCIAL; i++) {
      const ok = await POST(requisicao(corpoDaVenda(1), tokenVendedor))
      expect(ok.status).toBe(201)
    }
    expect(await disponivelPresencial()).toBe(0)

    const r = await POST(requisicao(corpoDaVenda(1), tokenVendedor))
    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe('estoque_esgotado')

    expect(await pedidosDoKit()).toHaveLength(ENTRADA_PRESENCIAL)
    expect(await disponivelPresencial()).toBe(0)
  })

  /**
   * Kit que existe no catalogo mas nunca foi posto na caixa do evento: a rota
   * RECUSA, com codigo proprio.
   *
   * Deixar passar seria pior do que parece — a venda seria registrada sem
   * consumir caixa nenhuma, e o contador de §11 continuaria anunciando kits
   * disponiveis enquanto o vendedor entrega produto que ninguem controla.
   * baixarEstoque devolve `false` nesse caso (em vez de lancar) porque o outro
   * chamador dela e a conciliacao de um pagamento JA aprovado; aqui, onde nada
   * foi cobrado, a leitura correta do mesmo `false` e a oposta.
   */
  it('kit sem estoque presencial configurado devolve 409 estoque_nao_configurado', async () => {
    const s = randomUUID().slice(0, 8)
    const slugSemCaixa = `vp-kit-sem-caixa-${s}`
    const semCaixa = await getDb().insertInto('kits').values({
      slug: slugSemCaixa, nome: 'Kit Sem Caixa', sku: `MG-VP-SC-${s}`,
      preco_centavos: PRECO_KIT_CENTAVOS, unidades: 1, ordem: 99, ativo: true,
    }).returning('id').executeTakeFirstOrThrow()

    const r = await POST(requisicao({
      ...corpoDaVenda(), kitSlug: slugSemCaixa,
    }, tokenVendedor))

    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe('estoque_nao_configurado')

    const pedidos = await getDb().selectFrom('pedidos')
      .innerJoin('pedido_itens', 'pedido_itens.pedido_id', 'pedidos.id')
      .select('pedidos.id')
      .where('pedido_itens.kit_id', '=', semCaixa.id)
      .execute()
    expect(pedidos).toHaveLength(0)
  })

  // -------------------------------------------------------------------
  // PAGAMENTO
  // -------------------------------------------------------------------

  /**
   * Cartao aprovado na hora: o pedido fica pago pelo MESMO caminho do webhook
   * (conciliarPagamento) e o estoque continua com UMA baixa so.
   *
   * Esta e a armadilha que o teste existe para pegar: conciliarPagamento baixa
   * estoque ao entrar em 'pago', e esta rota ja baixou na criacao. Se a
   * idempotencia de baixarEstoque falhasse, toda venda presencial paga tiraria
   * DUAS unidades da caixa de 50 e o evento acabaria na metade.
   */
  it('DINHEIRO: cartao aprovado deixa o pedido pago e mantem UMA unica baixa de estoque', async () => {
    provedor.status = 'approved'

    const r = await POST(requisicao({
      ...corpoDaVenda(1),
      metodo: 'cartao',
      token: 'tok-do-brick',
      parcelas: 1,
      metodoPagamentoId: 'master',
    }, tokenVendedor))

    expect(r.status).toBe(201)
    const corpo = await r.json()
    expect(corpo.pagamento).toMatchObject({ metodo: 'cartao', status: 'aprovado', pedidoPago: true })

    const [pedido] = await pedidosDoKit()
    expect(pedido.status).toBe('pago')
    expect(await baixasDoPedido(pedido.id)).toHaveLength(1)
    expect(await disponivelPresencial()).toBe(ENTRADA_PRESENCIAL - 1)
    // Confirmacao ao comprador sai uma vez so, e depois do COMMIT.
    expect(emails.enviados).toEqual([pedido.id])
  })

  /**
   * Cartao recusado NAO pode responder 2xx. A unica leitura que nao pode falhar
   * nesta tela e "posso entregar o kit?", e um front-end que olhe apenas
   * `response.ok` mostraria "VENDA APROVADA" para um cartao negado — com o
   * comprador saindo pela porta com o produto.
   *
   * A venda continua REGISTRADA, e o corpo diz isso explicitamente: a proxima
   * tentativa e uma cobranca nova sobre o MESMO pedido, nunca uma venda nova,
   * que baixaria uma segunda unidade.
   */
  it('DINHEIRO: cartao recusado devolve 402 e nunca sinaliza venda aprovada', async () => {
    provedor.status = 'rejected'
    provedor.statusDetail = 'cc_rejected_insufficient_amount'

    const r = await POST(requisicao({
      ...corpoDaVenda(1),
      metodo: 'cartao',
      token: 'tok-do-brick',
      parcelas: 1,
      metodoPagamentoId: 'master',
    }, tokenVendedor))

    expect(r.status).toBe(402)
    const corpo = await r.json()
    expect(corpo.error).toBe('pagamento_recusado')
    expect(corpo.vendaRegistrada).toBe(true)
    expect(corpo.token).toBeTruthy()
    // Texto curado de src/lib/pagamento-mensagens.ts, nunca o vocabulario
    // interno do provedor ("cc_rejected_insufficient_amount").
    expect(corpo.mensagem).toContain('limite')
    expect(JSON.stringify(corpo)).not.toContain('cc_rejected')

    const [pedido] = await pedidosDoKit()
    expect(pedido.status).toBe('pendente')
    expect(emails.enviados).toEqual([])
  })

  /**
   * O CAMINHO DE FALHA QUE O BALCAO NAO PODE LER ERRADO.
   *
   * A chamada ao provedor acontece FORA da transacao e DEPOIS do COMMIT (15
   * segundos de timeout segurando o lock da linha de `estoques` travariam a fila
   * inteira, e nao so esta venda). A consequencia declarada e esta: quando o
   * provedor nao responde, a venda JA ESTA registrada e a unidade JA saiu da
   * caixa. A resposta tem que dizer isso sem ambiguidade — com numero, token e a
   * instrucao de nao entregar o kit —, porque o oposto (venda registrada tratada
   * como inexistente e refeita) tira duas unidades por um kit so.
   */

  /**
   * A RECUSA PERMANENTE, e por que ela precisa de mensagem propria.
   *
   * O balcao do evento e operado em pe, com fila na frente. Mandar o vendedor
   * "tentar cobrar de novo" quando o provedor RECUSOU — e vai recusar todas as
   * vezes — queima minutos por comprador. Foi exatamente o que aconteceu em
   * 19/08/2026: a conta ficou com `address_pending` e toda cobranca voltou 403.
   *
   * O que NAO muda entre os dois casos, e e o que mais importa nesta tela: o
   * kit nao sai da mao do vendedor enquanto a cobranca nao existir.
   */
  it('provedor que RECUSA manda nao insistir, e ainda assim segurar o kit', async () => {
    provedor.recusa = true

    const r = await POST(requisicao(corpoDaVenda(1), tokenVendedor))

    expect(r.status).toBe(502)
    const corpo = await r.json()
    expect(corpo.vendaRegistrada).toBe(true)
    expect(corpo.mensagem).toMatch(/NÃO entregue o kit/i)
    expect(corpo.mensagem).toMatch(/não insista|nao insista/i)
    expect(corpo.mensagem).not.toMatch(/tente cobrar de novo/i)

    provedor.recusa = false
  })

  it('falha do provedor devolve 502 dizendo que a venda ESTA registrada', async () => {
    provedor.erro = true

    const r = await POST(requisicao(corpoDaVenda(1), tokenVendedor))

    expect(r.status).toBe(502)
    const corpo = await r.json()
    expect(corpo.error).toBe('falha_no_provedor')
    expect(corpo.vendaRegistrada).toBe(true)
    expect(typeof corpo.numero).toBe('number')
    expect(corpo.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

    // E o banco concorda com a resposta: pedido existe, unidade baixada.
    const [pedido] = await pedidosDoKit()
    expect(pedido.token).toBe(corpo.token)
    expect(pedido.status).toBe('pendente')
    expect(await baixasDoPedido(pedido.id)).toHaveLength(1)
    expect(await disponivelPresencial()).toBe(ENTRADA_PRESENCIAL - 1)
  })

  it('GET devolve 405 com o cabecalho Allow', async () => {
    const r = await GET()
    expect(r.status).toBe(405)
    expect(r.headers.get('Allow')).toBe('POST')
  })
})
