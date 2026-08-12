import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { sql } from 'kysely'
import { getDb, closeDb } from '@/lib/db'
import { POST } from '@/app/api/pedidos/route'
import { assinarAtribuicao } from '@/lib/atribuicao'

const SEGREDO = 'a'.repeat(64)
const COMPRADOR = {
  nome: 'Ana Souza', email: 'ana.checkout@exemplo.com',
  cpf: '12345678901', whatsapp: '11988887777',
  cep: '01310100', rua: 'Av Paulista', numero: '1000',
  complemento: '', bairro: 'Bela Vista', cidade: 'Sao Paulo', estado: 'SP',
}

function requisicao(body: unknown, cookie?: string) {
  return new Request('http://localhost/api/pedidos', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie: `__Host-mg_attr=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

// Slug e codigo de cupom PROPRIOS deste arquivo — nao "maria"/"MARIA10", que
// ja pertencem a representantes.test.ts e a cupons.test.ts respectivamente
// (o Vitest roda os arquivos de teste em paralelo contra o mesmo Postgres
// real; os dois outros arquivos fazem DELETE+INSERT dessas linhas a cada
// teste, e reusar o mesmo slug/codigo aqui correria contra eles). Mesmo
// raciocinio de SLUG_REP_ATIVA em cupons.test.ts e SLUG_MARIA em
// pedidos.test.ts.
const SLUG_MARIA = 'checkout-maria'
const CODIGO_CUPOM = 'CHECKOUT10'

let idMaria: string

async function semear() {
  const db = getDb()

  // pedidos primeiro: cliente_id/endereco_id/cupom_id sao ON DELETE
  // RESTRICT, e apagar o pedido leva pedido_itens e cupom_usos junto (ON
  // DELETE CASCADE) — ver migrations/1755000000000_pedido_itens.sql e
  // 1755000200000_cupons.sql.
  await db.deleteFrom('pedidos').where('cliente_id', 'in',
    db.selectFrom('clientes').select('id')
      .where(sql<boolean>`lower(email) = lower(${COMPRADOR.email})`),
  ).execute()
  // Orfaos de uma execucao anterior interrompida antes de limpar.
  await db.deleteFrom('cupom_usos').where('cliente_id', 'in',
    db.selectFrom('clientes').select('id')
      .where(sql<boolean>`lower(email) = lower(${COMPRADOR.email})`),
  ).execute()
  // enderecos.cliente_id e ON DELETE CASCADE (migrations/1755000100000_clientes.sql):
  // apagar o cliente abaixo leva o(s) endereco(s) dele junto, sem precisar
  // de um DELETE FROM enderecos em separado.
  await db.deleteFrom('clientes')
    .where(sql<boolean>`lower(email) = lower(${COMPRADOR.email})`).execute()
  // cupons.representante_id e ON DELETE RESTRICT: o cupom deste arquivo tem
  // que sumir antes do representante poder ser apagado.
  await db.deleteFrom('cupons').where('codigo', '=', CODIGO_CUPOM).execute()
  await db.deleteFrom('representantes').where('slug', '=', SLUG_MARIA).execute()

  const maria = await db.insertInto('representantes').values({
    slug: SLUG_MARIA, codigo: 'CHECKOUTMARIA', nome: 'Maria (checkout)',
    email: 'checkout-maria@exemplo.com', percentual_comissao: '20.00', ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idMaria = maria.id

  // Cupom de 10% pertencente a Maria — mesmo papel do MARIA10 do brief,
  // com um codigo proprio deste arquivo (ver comentario acima).
  await db.insertInto('cupons').values({
    codigo: CODIGO_CUPOM, tipo: 'percentual', valor: 10,
    representante_id: idMaria, ativo: true,
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
async function contarPedidos(): Promise<number> {
  const { total } = await getDb().selectFrom('pedidos')
    .select(sql<number>`count(*)::int`.as('total'))
    .where('cliente_id', 'in',
      getDb().selectFrom('clientes').select('id')
        .where(sql<boolean>`lower(email) = lower(${COMPRADOR.email})`),
    )
    .executeTakeFirstOrThrow()
  return total
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
  afterAll(async () => { await closeDb() })

  it('cria o pedido e devolve o numero', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 2, ...COMPRADOR }))
    expect(r.status).toBe(201)
    const body = await r.json()
    expect(typeof body.numero).toBe('number')
  })

  it('DINHEIRO: o preco vem do banco, nunca do corpo da requisicao', async () => {
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1,
      precoUnitarioCentavos: 1, total: 1, // tentativa de manipulacao
      ...COMPRADOR,
    }))
    const { numero } = await r.json()
    const pedido = await getDb().selectFrom('pedidos').selectAll()
      .where('numero', '=', numero).executeTakeFirstOrThrow()
    expect(pedido.subtotal_centavos).toBe(100000)
    expect(pedido.total_centavos).toBe(100000)
  })

  it('DINHEIRO: a venda pelo link da Maria e atribuida a ela', async () => {
    const cookie = assinarAtribuicao({
      slug: SLUG_MARIA, em: Date.now(),
      utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
    }, SEGREDO)
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR }, cookie))
    const { numero } = await r.json()
    const pedido = await getDb().selectFrom('pedidos').selectAll()
      .where('numero', '=', numero).executeTakeFirstOrThrow()
    expect(pedido.origem).toBe('link')
    expect(pedido.representante_id).toBe(idMaria)
    expect(pedido.utm_source).toBe('instagram')
  })

  it('sem cookie, a venda e da casa', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR }))
    const { numero } = await r.json()
    const pedido = await getDb().selectFrom('pedidos').select('origem')
      .where('numero', '=', numero).executeTakeFirstOrThrow()
    expect(pedido.origem).toBe('casa')
  })

  it('cupom aplicado desconta e registra o uso', async () => {
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1, cupom: CODIGO_CUPOM, ...COMPRADOR,
    }))
    const { numero } = await r.json()
    const pedido = await getDb().selectFrom('pedidos').selectAll()
      .where('numero', '=', numero).executeTakeFirstOrThrow()
    expect(pedido.desconto_centavos).toBe(10000)
    expect(pedido.total_centavos).toBe(90000)
    const usos = await getDb().selectFrom('cupom_usos').selectAll()
      .where('pedido_id', '=', pedido.id).execute()
    expect(usos).toHaveLength(1)
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

  it('rejeita quantidade acima do teto', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 999, ...COMPRADOR }))
    expect(r.status).toBe(422)
  })

  it('rejeita corpo sem os campos do comprador', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1 }))
    expect(r.status).toBe(422)
  })
})
