import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { sql } from 'kysely'
import { getDb, closeDb } from '@/lib/db'
import { POST } from '@/app/api/pedidos/route'
import { assinarAtribuicao } from '@/lib/atribuicao'
import { MAX_PEDIDOS_POR_JANELA } from '@/lib/rate-limit'
import { deInteiro } from '@/lib/money'

// Unico ponto mockado deste arquivo, e so a LEITURA do catalogo: e a unica
// costura por onde da para reproduzir "o preco mudou entre a vitrine e o
// checkout" de forma deterministica. A rota le kits FORA da transacao e
// criarPedido le kits DE NOVO DENTRO dela; forcar um preco diferente na
// primeira leitura faz a segunda divergir — que e exatamente o cenario que a
// guarda de preco existe para pegar. O throw, a transacao e o mapeamento
// para HTTP continuam sendo os de producao, sem stub nenhum.
//
// Com precoForcadoCentavos em null (o padrao, restaurado no afterEach) a
// funcao real e chamada e todos os outros testes deste arquivo seguem
// intactos. vi.hoisted porque vi.mock e icado para o topo do modulo, antes
// de qualquer const deste arquivo existir.
const catalogo = vi.hoisted(() => ({ precoForcadoCentavos: null as number | null }))

vi.mock('@/repositories/produtos', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/repositories/produtos')>()
  return {
    ...real,
    buscarKitAtivoPorSlug: async (slug: string) => {
      const kit = await real.buscarKitAtivoPorSlug(slug)
      if (!kit || catalogo.precoForcadoCentavos === null) return kit
      return { ...kit, precoCentavos: deInteiro(catalogo.precoForcadoCentavos) }
    },
  }
})

const SEGREDO = 'a'.repeat(64)
const COMPRADOR = {
  nome: 'Ana Souza', email: 'ana.checkout@exemplo.com',
  cpf: '12345678901', whatsapp: '11988887777',
  cep: '01310100', rua: 'Av Paulista', numero: '1000',
  complemento: '', bairro: 'Bela Vista', cidade: 'Sao Paulo', estado: 'SP',
}

// E-mail usado SO na requisicao que o rate limit barra, para que "nenhuma
// linha foi criada" possa ser afirmado sobre um e-mail que nunca teve linha
// nenhuma — em vez de tentar provar ausencia num e-mail que os testes de
// sucesso ja povoaram.
const EMAIL_BLOQUEADO = 'ana.bloqueada@exemplo.com'

// Cada requisicao sai de um IP proprio: POST /api/pedidos agora tem rate
// limit por IP (src/lib/rate-limit.ts) e o contador e estado de modulo, que
// vive por todo o arquivo. Sem isto, o teto de MAX_PEDIDOS_POR_JANELA seria
// consumido pelo conjunto dos testes e os ultimos veriam 429 sem nenhuma
// relacao com o que alegam provar. Mesma tecnica de ipUnico() em
// src/lib/__tests__/candidatura.test.ts.
let contadorIp = 0
const ipUnico = () => `10.0.0.${++contadorIp}`

function requisicao(body: unknown, cookie?: string, ip: string = ipUnico()) {
  return new Request('http://localhost/api/pedidos', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
      ...(cookie ? { cookie: `__Host-mg_attr=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

function cookieDe(slug: string, utm = { utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento' }) {
  return assinarAtribuicao({ slug, em: Date.now(), ...utm }, SEGREDO)
}

// Slugs e codigos de cupom PROPRIOS deste arquivo — nao "maria"/"MARIA10",
// que ja pertencem a representantes.test.ts e a cupons.test.ts
// respectivamente (o Vitest roda os arquivos de teste em paralelo contra o
// mesmo Postgres real; os dois outros arquivos fazem DELETE+INSERT dessas
// linhas a cada teste, e reusar o mesmo slug/codigo aqui correria contra
// eles). Mesmo raciocinio de SLUG_REP_ATIVA em cupons.test.ts e SLUG_MARIA
// em pedidos.test.ts.
const SLUG_MARIA = 'checkout-maria' // dona do cookie de last-click, 20%
const SLUG_JOANA = 'checkout-joana' // dona de um cupom, 15% — para provar que o cupom vence o cookie
const SLUG_INATIVA = 'checkout-inativa' // desligada — para o caso rep_inativo
const CODIGO_CUPOM = 'CHECKOUT10' // 10%, de Maria
const CODIGO_CUPOM_JOANA = 'CHECKOUTJOANA' // 5%, de Joana — override
const CODIGO_CUPOM_CASA = 'CHECKOUTCASA' // 5%, sem representante — nao pode roubar a venda

const SLUGS = [SLUG_MARIA, SLUG_JOANA, SLUG_INATIVA] as const
const CODIGOS_CUPOM = [CODIGO_CUPOM, CODIGO_CUPOM_JOANA, CODIGO_CUPOM_CASA] as const

let idMaria: string
let idJoana: string

async function semear() {
  const db = getDb()

  for (const email of [COMPRADOR.email, EMAIL_BLOQUEADO]) {
    // pedidos primeiro: cliente_id/endereco_id/cupom_id sao ON DELETE
    // RESTRICT, e apagar o pedido leva pedido_itens e cupom_usos junto (ON
    // DELETE CASCADE) — ver migrations/1755000000000_pedido_itens.sql e
    // 1755000200000_cupons.sql.
    await db.deleteFrom('pedidos').where('cliente_id', 'in',
      db.selectFrom('clientes').select('id')
        .where(sql<boolean>`lower(email) = lower(${email})`),
    ).execute()
    // Orfaos de uma execucao anterior interrompida antes de limpar.
    await db.deleteFrom('cupom_usos').where('cliente_id', 'in',
      db.selectFrom('clientes').select('id')
        .where(sql<boolean>`lower(email) = lower(${email})`),
    ).execute()
    // enderecos.cliente_id e ON DELETE CASCADE (migrations/1755000100000_clientes.sql):
    // apagar o cliente abaixo leva o(s) endereco(s) dele junto, sem precisar
    // de um DELETE FROM enderecos em separado.
    await db.deleteFrom('clientes')
      .where(sql<boolean>`lower(email) = lower(${email})`).execute()
  }
  // cupons.representante_id e ON DELETE RESTRICT: os cupons deste arquivo
  // tem que sumir antes dos representantes poderem ser apagados.
  await db.deleteFrom('cupons').where('codigo', 'in', CODIGOS_CUPOM).execute()
  await db.deleteFrom('representantes').where('slug', 'in', SLUGS).execute()

  const maria = await db.insertInto('representantes').values({
    slug: SLUG_MARIA, codigo: 'CHECKOUTMARIA', nome: 'Maria (checkout)',
    email: 'checkout-maria@exemplo.com', percentual_comissao: '20.00', ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idMaria = maria.id

  const joana = await db.insertInto('representantes').values({
    slug: SLUG_JOANA, codigo: 'CHECKOUTJOANA', nome: 'Joana (checkout)',
    email: 'checkout-joana@exemplo.com', percentual_comissao: '15.00', ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idJoana = joana.id

  // Desligada de proposito: o teste de rep_inativo precisa de um slug que
  // EXISTE mas nao esta mais ativo — diferente de um slug que nunca
  // existiu (os dois caem no mesmo caminho no resolvedor, mas so este
  // prova que "existente porem desligado" tambem funciona).
  await db.insertInto('representantes').values({
    slug: SLUG_INATIVA, codigo: 'CHECKOUTINATIVA', nome: 'Inativa (checkout)',
    email: 'checkout-inativa@exemplo.com', percentual_comissao: '20.00', ativo: false,
  }).execute()

  // Cupom de 10% pertencente a Maria — usado no teste de desconto simples.
  await db.insertInto('cupons').values({
    codigo: CODIGO_CUPOM, tipo: 'percentual', valor: 10,
    representante_id: idMaria, ativo: true,
  }).execute()

  // Cupom de Joana — usado no teste de prioridade do cupom sobre o cookie.
  // Percentual da COMISSAO (15%) e percentual do DESCONTO do cupom (5%) sao
  // numeros deliberadamente diferentes, para que o teste nao possa
  // confundir "o desconto bateu" com "o percentual de comissao snapshot
  // bateu" — sao duas colunas diferentes, e o bug que este teste previne e
  // exatamente misturar as duas.
  await db.insertInto('cupons').values({
    codigo: CODIGO_CUPOM_JOANA, tipo: 'percentual', valor: 5,
    representante_id: idJoana, ativo: true,
  }).execute()

  // Cupom da CASA — sem representante_id. aplicarPrioridadeDoCupom
  // (src/lib/montar-pedido.ts) so troca a atribuicao quando o cupom tem
  // dono; este existe para provar que um cupom promocional da marca nao
  // rouba a venda de quem trouxe o cliente.
  await db.insertInto('cupons').values({
    codigo: CODIGO_CUPOM_CASA, tipo: 'percentual', valor: 5,
    representante_id: null, ativo: true,
  }).execute()
}

// Escopado ao cliente deste arquivo (por e-mail), NAO um "count(*) FROM
// pedidos" sem filtro: o Vitest roda os arquivos de teste em paralelo
// contra o mesmo Postgres real, e pedidos.test.ts, cupons.test.ts etc.
// criam e apagam pedidos ao mesmo tempo. Um count() global observado
// "antes" e "depois" de uma unica requisicao deste arquivo pode mudar por
// causa de QUALQUER outro arquivo rodando naquele instante — nada a ver com
// o pedido que este teste tentou criar. Contar so os pedidos deste cliente
// prova exatamente a alegacao do teste (nenhum PEDIDO NOVO DESTE
// COMPRADOR), sem depender da ordem ou do timing de arquivos que nao tem
// nada a ver com este.
async function contarPedidos(email: string = COMPRADOR.email): Promise<number> {
  const { total } = await getDb().selectFrom('pedidos')
    .select(sql<number>`count(*)::int`.as('total'))
    .where('cliente_id', 'in',
      getDb().selectFrom('clientes').select('id')
        .where(sql<boolean>`lower(email) = lower(${email})`),
    )
    .executeTakeFirstOrThrow()
  return total
}

async function pedidoPorNumero(numero: number) {
  // pedidos.numero e int8: o select type gerado e string (ver
  // src/repositories/pedidos.ts), entao um `number` cru em `.where('numero', '=', numero)`
  // nao compila. Mesma solucao sql`` usada la, sem introduzir `as` nenhum.
  return getDb().selectFrom('pedidos').selectAll()
    .where(sql<boolean>`numero = ${numero}`).executeTakeFirstOrThrow()
}

describe('POST /api/pedidos', () => {
  // A rota le o segredo de process.env.ATRIBUICAO_SECRET (segredoDeAtribuicao,
  // src/lib/atribuicao.ts) — nao um parametro que este teste pudesse
  // injetar. Mesma tecnica de src/__tests__/proxy.test.ts: sobrescreve o
  // segredo real do .env pelo SEGREDO fixo deste arquivo, so durante a vida
  // deste describe, para que os cookies assinados aqui com SEGREDO verifiquem
  // do lado do handler. Vitest isola cada arquivo de teste em seu proprio
  // worker (isolate: true, o padrao), entao esta mutacao de process.env nao
  // vaza para outros arquivos rodando em paralelo.
  beforeAll(() => {
    process.env.ATRIBUICAO_SECRET = SEGREDO
  })
  beforeEach(semear)
  afterEach(() => { catalogo.precoForcadoCentavos = null })
  afterAll(async () => { await closeDb() })

  it('cria o pedido e devolve numero e token', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 2, ...COMPRADOR }))
    expect(r.status).toBe(201)
    const body = await r.json()
    expect(typeof body.numero).toBe('number')
    // token e a chave publica da URL de confirmacao (round de correcao 1,
    // Finding 4) — um uuid, nunca o numero sequencial.
    expect(body.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  // Round de correcao 1: com Corpo.strict() (src/app/api/pedidos/route.ts),
  // um campo de dinheiro no corpo nao e mais silenciosamente IGNORADO — a
  // requisicao inteira e recusada. Isto prova mais do que o teste anterior:
  // antes, so provava que o valor gravado batia com o catalogo; agora prova
  // que a tentativa de manipulacao nem chega a criar um pedido.
  it('DINHEIRO: precoUnitarioCentavos/total no corpo sao rejeitados, nao apenas ignorados', async () => {
    const antes = await contarPedidos()
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1,
      precoUnitarioCentavos: 1, total: 1, // tentativa de manipulacao
      ...COMPRADOR,
    }))
    expect(r.status).toBe(422)
    expect(await contarPedidos()).toBe(antes)
  })

  it('DINHEIRO: a venda pelo link da Maria e atribuida a ela, com o percentual dela', async () => {
    const r = await POST(requisicao(
      { kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR },
      cookieDe(SLUG_MARIA),
    ))
    expect(r.status).toBe(201)
    const { numero } = await r.json()
    const pedido = await pedidoPorNumero(numero)
    expect(pedido.origem).toBe('link')
    expect(pedido.representante_id).toBe(idMaria)
    expect(pedido.utm_source).toBe('instagram')
    // percentual_comissao_snapshot e o numero que decide quanto a
    // representante recebe: ninguem mais no sistema testava a leitura de
    // representantes.percentual_comissao no momento da criacao do pedido
    // (round de correcao 1, Finding 3).
    expect(Number(pedido.percentual_comissao_snapshot)).toBe(20)
  })

  it('sem cookie, a venda e da casa', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR }))
    expect(r.status).toBe(201)
    const { numero } = await r.json()
    const pedido = await getDb().selectFrom('pedidos').select('origem')
      .where('numero', '=', numero).executeTakeFirstOrThrow()
    expect(pedido.origem).toBe('casa')
  })

  // Representante EXISTE mas foi desligada — diferente de um slug que nunca
  // existiu. Os dois caem em 'rep_inativo' no resolvedor
  // (src/lib/resolver-pedido.ts), mas so este teste prova o caminho de
  // "existente porem inativo" especificamente, e que os UTM da campanha
  // continuam gravados mesmo sem ninguem a receber comissao (round de
  // correcao 1, Finding 3).
  it('DINHEIRO: cookie de representante desligada vira rep_inativo, com UTM preservado', async () => {
    const r = await POST(requisicao(
      { kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR },
      cookieDe(SLUG_INATIVA, { utmSource: 'facebook', utmMedium: 'ads', utmCampaign: 'inverno' }),
    ))
    expect(r.status).toBe(201)
    const { numero } = await r.json()
    const pedido = await pedidoPorNumero(numero)
    expect(pedido.origem).toBe('rep_inativo')
    expect(pedido.representante_id).toBeNull()
    expect(pedido.percentual_comissao_snapshot).toBeNull()
    expect(pedido.utm_source).toBe('facebook')
    expect(pedido.utm_campaign).toBe('inverno')
  })

  it('cupom aplicado desconta e registra o uso', async () => {
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1, cupom: CODIGO_CUPOM, ...COMPRADOR,
    }))
    expect(r.status).toBe(201)
    const { numero } = await r.json()
    const pedido = await pedidoPorNumero(numero)
    expect(pedido.desconto_centavos).toBe(10000)
    expect(pedido.total_centavos).toBe(90000)
    const usos = await getDb().selectFrom('cupom_usos').selectAll()
      .where('pedido_id', '=', pedido.id).execute()
    expect(usos).toHaveLength(1)
  })

  // HIERARQUIA cupom > last click (src/lib/montar-pedido.ts): o cookie
  // atribui a venda a Maria, mas o cupom digitado no checkout pertence a
  // Joana — o cupom tem que vencer, e o percentual gravado tem que ser o
  // DELA (15%), nunca o de Maria (20%) nem um valor lido do cookie. Nenhum
  // teste cobria este caminho ponta a ponta antes (round de correcao 1,
  // Finding 3) — montar-pedido.test.ts testa aplicarPrioridadeDoCupom com
  // um stub, nao a fiacao real com o banco.
  it('DINHEIRO: cupom de outra representante tem prioridade sobre o cookie, com o percentual dela', async () => {
    const r = await POST(requisicao(
      { kitSlug: 'kit-milagran', quantidade: 1, cupom: CODIGO_CUPOM_JOANA, ...COMPRADOR },
      cookieDe(SLUG_MARIA),
    ))
    expect(r.status).toBe(201)
    const { numero } = await r.json()
    const pedido = await pedidoPorNumero(numero)
    expect(pedido.origem).toBe('cupom')
    expect(pedido.representante_id).toBe(idJoana)
    expect(Number(pedido.percentual_comissao_snapshot)).toBe(15)
  })

  // Um cupom da CASA (sem representante_id) e promocao da marca — nao pode
  // roubar a venda de quem trouxe o cliente por link. O desconto ainda se
  // aplica; so a atribuicao continua sendo a do cookie.
  it('cupom da casa (sem representante) nao rouba a venda do cookie', async () => {
    const r = await POST(requisicao(
      { kitSlug: 'kit-milagran', quantidade: 1, cupom: CODIGO_CUPOM_CASA, ...COMPRADOR },
      cookieDe(SLUG_MARIA),
    ))
    expect(r.status).toBe(201)
    const { numero } = await r.json()
    const pedido = await pedidoPorNumero(numero)
    expect(pedido.origem).toBe('link')
    expect(pedido.representante_id).toBe(idMaria)
    expect(Number(pedido.percentual_comissao_snapshot)).toBe(20)
    expect(pedido.desconto_centavos).toBeGreaterThan(0)
  })

  it('cupom invalido devolve 422 e NAO cria pedido', async () => {
    const antes = await contarPedidos()
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1, cupom: 'NAOEXISTE', ...COMPRADOR,
    }))
    expect(r.status).toBe(422)
    expect(await contarPedidos()).toBe(antes)
  })

  // A promessa da Tarefa 9 e mais forte do que "nenhum pedido sobra": a
  // transacao inteira (cliente, endereco, resgate do cupom, pedido, itens e
  // uso do cupom) tem que reverter junto. Sem isso, um checkout recusado
  // deixaria nome, CPF, whatsapp e endereco de um estranho commitados para
  // sempre, presos a pedido nenhum — um problema de dado pessoal, nao so um
  // pedido "quase criado". Este teste chama o endpoint de novo (o
  // beforeEach ja limpou o estado deste e-mail) e prova a atomicidade
  // olhando diretamente para clientes e enderecos, nao so para pedidos.
  //
  // NOTA (round de correcao 1): este teste NAO exercita a fiacao de
  // criarPedido(..., trx) — ele lanca RecusaDeCupom antes de criarPedido
  // ser chamado. Quem prova que criarPedido usa a transacao recebida (em
  // vez de abrir a propria) sao os testes de SUCESSO acima: se essa fiacao
  // quebrasse, o INSERT em pedidos tentaria referenciar um cliente_id que
  // ainda nao commitou numa transacao separada, e a FK falharia.
  it('DINHEIRO/LGPD: cupom invalido nao deixa cliente nem endereco orfaos', async () => {
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1, cupom: 'NAOEXISTE', ...COMPRADOR,
    }))
    expect(r.status).toBe(422)

    const clientes = await getDb().selectFrom('clientes').select('id')
      .where(sql<boolean>`lower(email) = lower(${COMPRADOR.email})`).execute()
    expect(clientes).toHaveLength(0)

    // enderecos nao tem coluna de e-mail: junta com clientes pelo mesmo
    // e-mail para provar que nenhum endereco ficou associado a este
    // comprador — nao so que a linha de cliente sumiu.
    const enderecos = await getDb().selectFrom('enderecos')
      .innerJoin('clientes', 'clientes.id', 'enderecos.cliente_id')
      .select('enderecos.id')
      .where(sql<boolean>`lower(clientes.email) = lower(${COMPRADOR.email})`)
      .execute()
    expect(enderecos).toHaveLength(0)
  })

  // Round de correcao 1, Finding 1: um CPF que diverge do ja cadastrado
  // para o mesmo e-mail NAO PODE virar uma mensagem distinta de qualquer
  // outro erro de validacao — isso seria um oraculo sem autenticacao (um
  // 422 "cpf_divergente" revela que o e-mail ja e de um cliente
  // cadastrado; uma segunda tentativa acertando o CPF cria um pedido de
  // verdade em nome de outra pessoa). A resposta tem que ser
  // INDISTINGUIVEL do 422 generico de qualquer outro dado invalido.
  it('SEGURANCA: CPF divergente do cadastro devolve o MESMO 422 generico, sem detalhe', async () => {
    // Primeiro checkout cadastra o cliente com o CPF de COMPRADOR.
    const primeiro = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR }))
    expect(primeiro.status).toBe(201)

    // Segundo checkout, mesmo e-mail, CPF diferente: a rota tem que
    // recusar, mas com o MESMO formato de erro de qualquer 422 de
    // validacao — sem um campo "mensagem", sem a palavra "cpf" ou
    // "divergente" em lugar nenhum do corpo.
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR, cpf: '98765432100',
    }))
    expect(r.status).toBe(422)
    const corpo = await r.json()
    expect(corpo).toEqual({ error: 'dados_invalidos' })
    expect(JSON.stringify(corpo).toLowerCase()).not.toContain('cpf')
    expect(JSON.stringify(corpo).toLowerCase()).not.toContain('divergente')
  })

  // NAO havia teste de rota para este mapeamento: pedidos.test.ts prova que
  // criarPedido lanca, e mais nada. Enquanto a rota despachava por
  // `mensagem.startsWith('preco_divergente')`, reescrever a frase do throw no
  // repositorio fazia o comprador passar a receber 500 — com a suite inteira
  // verde. Agora o despacho e por `instanceof PrecoDivergenteError` e este
  // teste fecha o buraco pelo lado do HTTP.
  it('DINHEIRO: preco divergente do catalogo vira 422 curado, sem vazar preco nem uuid', async () => {
    const antes = await contarPedidos()
    // O que a "vitrine" mostrou (1 centavo) deixou de bater com o catalogo.
    catalogo.precoForcadoCentavos = 1

    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR }))
    expect(r.status).toBe(422)

    // Corpo INTEIRO, nao so o codigo: a mensagem crua do throw carrega o
    // uuid do kit, o preco do catalogo e o preco enviado, e nenhum dos tres
    // pode aparecer aqui. Um toEqual exato quebra se alguem "so acrescentar
    // um detalhe util" na resposta.
    expect(await r.json()).toEqual({
      error: 'dados_invalidos',
      mensagem: 'O preco do produto mudou. Atualize a pagina e tente novamente.',
    })

    // E a transacao inteira reverteu: nenhum pedido e nenhum dado pessoal
    // ficou para tras (salvarClienteComEndereco roda ANTES de criarPedido).
    expect(await contarPedidos()).toBe(antes)
    const clientes = await getDb().selectFrom('clientes').select('id')
      .where(sql<boolean>`lower(email) = lower(${COMPRADOR.email})`).execute()
    expect(clientes).toHaveLength(0)
  })

  it('rejeita quantidade acima do teto', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 999, ...COMPRADOR }))
    expect(r.status).toBe(422)
  })

  it('rejeita corpo sem os campos do comprador', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1 }))
    expect(r.status).toBe(422)
  })

  // O endpoint nao tem autenticacao e escreve CPF, nome completo, telefone e
  // endereco residencial. O freio e o mesmo mecanismo por IP que o
  // formulario de candidatura ja usava (src/lib/rate-limit.ts) — em memoria
  // do processo, quebra-molas contra abuso ingenuo, nao rate limiting
  // distribuido.
  describe('rate limit por IP', () => {
    it('permite MAX_PEDIDOS_POR_JANELA pedidos do mesmo IP e barra o seguinte com 429', async () => {
      const ip = ipUnico()
      for (let i = 0; i < MAX_PEDIDOS_POR_JANELA; i++) {
        const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR }, undefined, ip))
        // O teto nao pode cortar trafego legitimo ANTES de ser atingido:
        // todas as MAX primeiras precisam passar de verdade.
        expect(r.status).toBe(201)
      }
      expect(await contarPedidos()).toBe(MAX_PEDIDOS_POR_JANELA)

      const bloqueado = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR }, undefined, ip))
      expect(bloqueado.status).toBe(429)
      expect(await bloqueado.json()).toEqual({ error: 'rate_limited' })
      expect(await contarPedidos()).toBe(MAX_PEDIDOS_POR_JANELA)
    })

    // Um IP DIFERENTE nao herda o contador do teste acima: o limite e por
    // IP, e um comprador legitimo nao pode ser barrado porque outro
    // exagerou.
    it('o teto e por IP: outro IP continua criando pedido normalmente', async () => {
      const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR }))
      expect(r.status).toBe(201)
    })

    it('RATE LIMIT/LGPD: a requisicao barrada nao cria cliente, endereco nem pedido', async () => {
      const ip = ipUnico()
      // Esgota a janela com corpos que o Zod recusa: o contador soma
      // TENTATIVAS, nao sucessos — se contasse so os 201, um bot mandando
      // lixo ficaria sem freio nenhum. Alem disso, um 422 nao escreve nada,
      // entao o estado do banco na hora do 429 e conhecido.
      for (let i = 0; i < MAX_PEDIDOS_POR_JANELA; i++) {
        const r = await POST(requisicao({ kitSlug: 'kit-milagran' }, undefined, ip))
        expect(r.status).toBe(422)
      }

      // A barrada leva um corpo COMPLETO e valido, com um e-mail que nunca
      // teve linha nenhuma: se o 429 fosse decidido depois de qualquer
      // escrita, o cliente e o endereco deste e-mail apareceriam.
      const bloqueado = await POST(requisicao({
        kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR, email: EMAIL_BLOQUEADO,
      }, undefined, ip))
      expect(bloqueado.status).toBe(429)

      const clientes = await getDb().selectFrom('clientes').select('id')
        .where(sql<boolean>`lower(email) = lower(${EMAIL_BLOQUEADO})`).execute()
      expect(clientes).toHaveLength(0)

      const enderecos = await getDb().selectFrom('enderecos')
        .innerJoin('clientes', 'clientes.id', 'enderecos.cliente_id')
        .select('enderecos.id')
        .where(sql<boolean>`lower(clientes.email) = lower(${EMAIL_BLOQUEADO})`)
        .execute()
      expect(enderecos).toHaveLength(0)

      expect(await contarPedidos(EMAIL_BLOQUEADO)).toBe(0)
    })
  })
})
