import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'kysely'
import { getDb, closeDb } from '@/lib/db'
import { POST } from '@/app/api/cupons/validar/route'
import { resgatarCupom } from '@/repositories/cupons'
import { centavos } from '@/lib/money'
import { MAX_VALIDACOES_DE_CUPOM_POR_JANELA } from '@/lib/rate-limit'

/**
 * POST /api/cupons/validar — a previa do botao "Validar cupom".
 *
 * O QUE ESTE ARQUIVO PRECISA PROVAR, e que nenhum outro prova: que a previa e o
 * RESGATE dao a mesma resposta. Elas saem da mesma funcao de regras
 * (`validarCupom`, src/repositories/cupons.ts) justamente para isso, e o ultimo
 * bloco daqui e a amarra que impede alguem de, um dia, "otimizar" a previa com
 * uma consulta propria mais rapida e mais frouxa.
 *
 * NAMESPACE PROPRIO: os codigos e o e-mail deste arquivo nao aparecem em nenhum
 * outro teste. O Vitest roda arquivos em paralelo contra o MESMO banco e
 * `cupom_codigo_unico` transformaria um codigo compartilhado em falha
 * intermitente que so aparece na maquina de outra pessoa.
 */
const PREFIXO = 'ZVAL'
const EMAIL = 'ana.validar@teste.milagran'
const SLUG = 'kit-milagran'

/**
 * Data fixa no passado, e nao o DEFAULT `now()` da coluna. `validarCupom`
 * compara contra o relogio do NODE e `inicia_em` vem do relogio do POSTGRES —
 * os dois derivam (896 ms medidos no container em 19/08/2026) e nessa janela um
 * cupom recem-criado ainda "nao comecou". Mesma solucao de JA_VALENDO em
 * src/repositories/__tests__/cupons.test.ts.
 */
const JA_VALENDO = new Date('2026-01-01T00:00:00Z')

let precoDoKit: number

async function criarCupom(sufixo: string, campos: Record<string, unknown> = {}) {
  await getDb().insertInto('cupons').values({
    codigo: `${PREFIXO}${sufixo}`, tipo: 'percentual', valor: 20,
    ativo: true, inicia_em: JA_VALENDO, ...campos,
  }).execute()
}

beforeAll(async () => {
  await limpar()
  const kit = await getDb().selectFrom('kits').select('preco_centavos')
    .where('slug', '=', SLUG).executeTakeFirstOrThrow()
  precoDoKit = kit.preco_centavos

  await criarCupom('OK')
  await criarCupom('OFF', { ativo: false })
  await criarCupom('VELHO', { expira_em: new Date('2026-01-02T00:00:00Z') })
  await criarCupom('FIXO', { tipo: 'fixo', valor: 20000 })
  await criarCupom('UMA', { limite_por_cliente: 1 })
})

async function limpar() {
  const db = getDb()
  await db.deleteFrom('cupom_usos').where('cupom_id', 'in',
    db.selectFrom('cupons').select('id').where('codigo', 'like', `${PREFIXO}%`)).execute()
  await db.deleteFrom('pedidos').where('cliente_id', 'in',
    db.selectFrom('clientes').select('id')
      .where(sql<boolean>`lower(email) = lower(${EMAIL})`)).execute()
  await db.deleteFrom('clientes').where(sql<boolean>`lower(email) = lower(${EMAIL})`).execute()
  await db.deleteFrom('cupons').where('codigo', 'like', `${PREFIXO}%`).execute()
}

afterAll(async () => {
  await limpar()
  await closeDb()
})

let ip = 0
function requisicao(corpo: unknown) {
  ip += 1
  return new Request('http://localhost/api/cupons/validar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.55.0.${ip % 250}` },
    body: JSON.stringify(corpo),
  })
}

const BASE = { kitSlug: SLUG, quantidade: 1 }

describe('POST /api/cupons/validar', () => {
  it('devolve o desconto em centavos de um cupom valido', async () => {
    const r = await POST(requisicao({ ...BASE, codigo: `${PREFIXO}OK` }))
    expect(r.status).toBe(200)

    const corpo = await r.json() as { valido: boolean; descontoCentavos: number }
    expect(corpo.valido).toBe(true)
    expect(corpo.descontoCentavos).toBe(Math.round(precoDoKit * 0.2))
  })

  /**
   * O SUBTOTAL SAI DO CATALOGO, e a quantidade multiplica. Um percentual sobre
   * dois kits tem que descontar o dobro — se a rota ignorasse `quantidade`, a
   * tela anunciaria metade do desconto que a confirmacao vai conceder, e o
   * comprador veria o total CAIR depois de pagar.
   */
  it('o desconto acompanha a quantidade', async () => {
    const r = await POST(requisicao({ ...BASE, quantidade: 2, codigo: `${PREFIXO}OK` }))
    const corpo = await r.json() as { descontoCentavos: number }
    expect(corpo.descontoCentavos).toBe(Math.round(precoDoKit * 2 * 0.2))
  })

  it('cupom fixo desconta o valor cadastrado, sem depender da quantidade', async () => {
    const r = await POST(requisicao({ ...BASE, codigo: `${PREFIXO}FIXO` }))
    const corpo = await r.json() as { descontoCentavos: number }
    expect(corpo.descontoCentavos).toBe(20000)
  })

  /**
   * RECUSA E 200, NAO 4xx. "Este cupom expirou" e a RESPOSTA da pergunta que a
   * tela fez, e nao um erro de quem chamou: um 4xx faria o front tratar como
   * falha de rede e mostrar "tente de novo" a quem precisa ler o motivo e
   * digitar outro codigo.
   */
  it('cupom recusado responde 200 com o motivo e a frase do checkout', async () => {
    for (const [sufixo, motivo] of [
      ['OFF', 'inativo'], ['VELHO', 'expirado'], ['NAOEXISTE', 'inexistente'],
    ] as const) {
      const r = await POST(requisicao({ ...BASE, codigo: `${PREFIXO}${sufixo}` }))
      expect(r.status).toBe(200)

      const corpo = await r.json() as { valido: boolean; motivo: string; mensagem: string }
      expect(corpo.valido).toBe(false)
      expect(corpo.motivo).toBe(motivo)
      expect(corpo.mensagem.length).toBeGreaterThan(0)
    }
  })

  /**
   * O TETO DE TENTATIVAS e o unico controle contra enumeracao de codigos: esta
   * rota responde, para qualquer visitante, se um codigo existe. Sem teste, o
   * limitador pode ser removido num refactor com a suite inteira verde — e o
   * espaco de codigos e pequeno de proposito (curtos e memoraveis, porque tem
   * que caber num story).
   */
  it('corta o IP que passa do teto, e so aquele IP', async () => {
    const insistente = '10.90.0.1'
    const outro = '10.90.0.2'

    const pedir = (ip: string) => POST(new Request('http://localhost/api/cupons/validar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ ...BASE, codigo: `${PREFIXO}OK` }),
    }))

    for (let i = 0; i < MAX_VALIDACOES_DE_CUPOM_POR_JANELA; i += 1) {
      expect((await pedir(insistente)).status).toBe(200)
    }
    expect((await pedir(insistente)).status).toBe(429)

    // O contador e POR IP: o teto de um nao pode fechar a loja para o vizinho.
    expect((await pedir(outro)).status).toBe(200)
  })

  // DINHEIRO NAO ENTRA PELO CORPO, nem para "ajudar" a conta. `.strict()` faz
  // disso um 422 explicito em vez de um campo ignorado em silencio — se fosse
  // ignorado, um schema futuro mais frouxo passaria a aceitar sem ninguem ver.
  it('subtotal ou desconto no corpo e 422', async () => {
    for (const contrabando of [
      { subtotal: 1 }, { descontoCentavos: 99999 }, { total: 0 },
    ]) {
      const r = await POST(requisicao({ ...BASE, codigo: `${PREFIXO}OK`, ...contrabando }))
      expect(r.status).toBe(422)
    }
  })

  it('kit inexistente e 404, e nao um desconto sobre zero', async () => {
    const r = await POST(requisicao({ ...BASE, kitSlug: 'kit-que-nao-existe', codigo: `${PREFIXO}OK` }))
    expect(r.status).toBe(404)
  })

  /**
   * A PREVIA NAO CONSOME NADA. Se ela gravasse uso, apertar "Validar cupom"
   * duas vezes queimaria o limite de quem ainda nem comprou — e um cupom de
   * limite_total baixo seria esgotado por curiosos antes da primeira venda.
   */
  it('validar nao grava uso nenhum', async () => {
    for (let i = 0; i < 3; i += 1) {
      await POST(requisicao({ ...BASE, codigo: `${PREFIXO}OK`, email: EMAIL }))
    }

    const { total } = await getDb().selectFrom('cupom_usos')
      .select(sql<number>`count(*)::int`.as('total'))
      .where('cupom_id', 'in',
        getDb().selectFrom('cupons').select('id').where('codigo', '=', `${PREFIXO}OK`))
      .executeTakeFirstOrThrow()
    expect(total).toBe(0)
  })
})

/**
 * A AMARRA ENTRE A PREVIA E O RESGATE — o teste que justifica os outros.
 *
 * As duas respostas tem que ser a mesma para o mesmo cupom, porque saem da mesma
 * funcao de regras (`validarCupom`). Sem isto, uma "otimizacao" futura da previa
 * (uma consulta propria, mais rapida e mais frouxa) faria o botao dizer VALIDO e
 * a confirmacao recusar — e a suite inteira continuaria verde.
 *
 * HA UMA DIVERGENCIA DELIBERADA, e ela tem teste proprio logo abaixo: a previa
 * passa `clienteId = null` porque a rota e publica e nao deve responder sobre
 * compras de terceiros (ver o schema em src/app/api/cupons/validar/route.ts).
 * Logo ela NAO enxerga `limite_por_cliente`. E a unica coisa que as duas nao
 * respondem igual, e o teste existe para que continue sendo a unica.
 */
describe('a previa concorda com o resgate', () => {
  it('mesmo cupom, mesmo subtotal: mesmo desconto e mesmo motivo de recusa', async () => {
    const cliente = await getDb().selectFrom('clientes').select('id')
      .where(sql<boolean>`lower(email) = lower(${EMAIL})`).executeTakeFirst()

    for (const sufixo of ['OK', 'OFF', 'VELHO', 'FIXO', 'NAOEXISTE']) {
      const codigo = `${PREFIXO}${sufixo}`

      const previa = await POST(requisicao({ ...BASE, codigo }))
        .then((r) => r.json() as Promise<{ valido: boolean; motivo?: string; descontoCentavos?: number }>)

      // O resgate roda numa transacao que e DESFEITA no fim: interessa a
      // resposta, nao o efeito — gravar o uso aqui sujaria os outros casos do
      // laco e o proprio teste de "nao consome nada".
      const resgate = await getDb().transaction().execute(async (trx) => {
        const r = await resgatarCupom(codigo, centavos(precoDoKit / 100), cliente?.id ?? '00000000-0000-4000-8000-000000000000', trx)
        return r
      })

      expect(previa.valido).toBe(resgate.ok)
      if (resgate.ok && previa.valido) {
        expect(previa.descontoCentavos).toBe(resgate.cupom.desconto)
      } else if (!resgate.ok) {
        expect(previa.motivo).toBe(resgate.motivo)
      }
    }
  })
})

/**
 * A DIVERGENCIA CONHECIDA, fixada por teste para que ninguem a descubra em
 * producao: quem ja usou o cupom recebe VALIDO na previa e recusa no resgate.
 *
 * Fixar isso num teste tem duas funcoes. A primeira e documental — a proxima
 * pessoa que estranhar o comportamento acha a explicacao aqui em vez de achar
 * que e bug. A segunda e de alarme: se alguem um dia fizer a previa enxergar o
 * limite por pessoa (passando um cliente), este teste quebra e obriga a
 * conversa sobre o vazamento que a decisao original evitou.
 */
describe('a unica coisa que a previa nao ve', () => {
  it('limite por cliente: previa diz valido, resgate recusa', async () => {
    const cliente = await getDb().insertInto('clientes').values({
      nome: 'Ana Limite', email: EMAIL, whatsapp: '62999990000', cpf: '39053344705',
    }).returning('id').executeTakeFirstOrThrow()

    // Um pedido DESTE arquivo, e nao um pedido qualquer do banco: `cupom_usos`
    // referencia pedido com ON DELETE CASCADE, e apontar para a linha de outro
    // arquivo de teste — que roda em paralelo e apaga a propria sujeira — daria
    // falha intermitente sem relacao com o assunto daqui.
    // PEDIDO E ITEM NA MESMA TRANSACAO: pedido_itens_obrigatorios_trg e
    // DEFERRABLE INITIALLY DEFERRED (migrations/1755000000000_pedido_itens.sql)
    // e roda no COMMIT — inserir o pedido sozinho estoura ali, nao aqui.
    const kit = await getDb().selectFrom('kits').select('id')
      .where('slug', '=', SLUG).executeTakeFirstOrThrow()

    const pedido = await getDb().transaction().execute(async (trx) => {
      const p = await trx.insertInto('pedidos').values({
        origem: 'casa', canal: 'online', tipo_entrega: 'retirada',
        cliente_id: cliente.id, endereco_id: null,
        subtotal_centavos: precoDoKit, desconto_centavos: 0, frete_centavos: 0,
        total_centavos: precoDoKit,
      }).returning('id').executeTakeFirstOrThrow()

      await trx.insertInto('pedido_itens').values({
        pedido_id: p.id, kit_id: kit.id, nome_snapshot: 'Kit',
        preco_unitario_centavos: precoDoKit, quantidade: 1, total_centavos: precoDoKit,
      }).execute()

      return p
    })

    const cupom = await getDb().selectFrom('cupons').select('id')
      .where('codigo', '=', `${PREFIXO}UMA`).executeTakeFirstOrThrow()
    await getDb().insertInto('cupom_usos')
      .values({ cupom_id: cupom.id, pedido_id: pedido.id, cliente_id: cliente.id })
      .execute()

    // A previa nao sabe de quem se trata, entao continua dizendo que vale.
    const previa = await POST(requisicao({ ...BASE, codigo: `${PREFIXO}UMA` }))
      .then((r) => r.json() as Promise<{ valido: boolean }>)
    expect(previa.valido).toBe(true)

    // O resgate sabe, e recusa. E a recusa que vale.
    const resgate = await getDb().transaction().execute((trx) =>
      resgatarCupom(`${PREFIXO}UMA`, centavos(precoDoKit / 100), cliente.id, trx))
    expect(resgate).toEqual({ ok: false, motivo: 'limite_do_cliente' })
  })
})
