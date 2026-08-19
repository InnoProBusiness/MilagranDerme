import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { NOME_COOKIE_SESSAO } from '@/lib/sessao'
import { criarUsuario } from '@/repositories/usuarios'
import { abrirSessao } from '@/repositories/sessoes'
import { GET, POST, PATCH } from '@/app/api/admin/cupons/route'
import { resgatarCupom } from '@/repositories/cupons'
import { centavos } from '@/lib/money'

/**
 * A rota que cria campanha (§17, 19/08/2026).
 *
 * O CONTROLE DE ACESSO NAO ESTA AQUI: ele e provado, para os tres metodos, em
 * ./admin-guarda.test.ts, que varre o diretorio inteiro. Este arquivo cuida do
 * que e proprio da rota — o significado do `valor` conforme o `tipo`, a
 * traducao do conflito de codigo, e a amarra que de fato importa: o cupom que
 * esta rota cria e resgatavel no checkout, com o desconto que a tela prometeu.
 *
 * NAMESPACE PROPRIO, mesma disciplina do arquivo de guarda: o e-mail do
 * administrador e os codigos de cupom deste arquivo nao aparecem em nenhum
 * outro teste. O Vitest roda arquivos em paralelo contra o MESMO banco, e
 * `cupom_codigo_unico` transformaria um codigo compartilhado em falha
 * intermitente que so aparece na maquina de outra pessoa.
 */
const EMAIL_ADMIN = 'admin.cupons.rota@teste.milagran'
const PREFIXO = 'ZCUP'

let cookieAdmin: string

beforeAll(async () => {
  await getDb().deleteFrom('usuarios').where('email', '=', EMAIL_ADMIN).execute()
  await getDb().deleteFrom('cupons').where('codigo', 'like', `${PREFIXO}%`).execute()

  const admin = await criarUsuario({
    nome: 'Admin dos Cupons', email: EMAIL_ADMIN, senha: 'senha-de-teste-123', papel: 'admin',
  })
  const { token } = await abrirSessao(admin.id)
  cookieAdmin = `${NOME_COOKIE_SESSAO}=${token}`
})

afterAll(async () => {
  await getDb().deleteFrom('cupons').where('codigo', 'like', `${PREFIXO}%`).execute()
  await getDb().deleteFrom('usuarios').where('email', '=', EMAIL_ADMIN).execute()
  await closeDb()
})

function post(corpo: unknown): Request {
  return new Request('http://localhost/api/admin/cupons', {
    method: 'POST',
    headers: { Cookie: cookieAdmin, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  })
}

const OFERTA = {
  tipo: 'fixo' as const,
  valor: 20000,
  expiraEm: null,
  limiteTotal: null,
  limitePorCliente: 1,
  representanteId: null,
}

describe('POST /api/admin/cupons', () => {
  it('cria o cupom fixo da oferta de lancamento', async () => {
    const r = await POST(post({ ...OFERTA, codigo: `${PREFIXO}800` }))
    expect(r.status).toBe(201)

    const { cupom } = await r.json() as { cupom: { codigo: string; tipo: string; valor: number } }
    expect(cupom).toMatchObject({ codigo: `${PREFIXO}800`, tipo: 'fixo', valor: 20000 })
  })

  it('normaliza o codigo para maiusculas', async () => {
    const r = await POST(post({ ...OFERTA, codigo: `${PREFIXO}min`.toLowerCase() }))
    expect(r.status).toBe(201)
    const { cupom } = await r.json() as { cupom: { codigo: string } }
    expect(cupom.codigo).toBe(`${PREFIXO}MIN`)
  })

  /**
   * 409, e nao 422. O corpo esta perfeito: o conflito e com o banco. A tela usa
   * a diferenca para dizer "escolha outro codigo" em vez de mandar a pessoa
   * revisar campos que estao todos certos.
   */
  it('codigo repetido devolve 409, nao 500', async () => {
    await POST(post({ ...OFERTA, codigo: `${PREFIXO}DUP` }))
    const r = await POST(post({ ...OFERTA, codigo: `${PREFIXO}DUP` }))

    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'codigo_em_uso' })
  })

  it('percentual acima de 100 e recusado antes do banco', async () => {
    const r = await POST(post({
      ...OFERTA, tipo: 'percentual', valor: 120, codigo: `${PREFIXO}PCT`,
    }))
    expect(r.status).toBe(422)
  })

  it('codigo fora do formato do banco e recusado com mensagem', async () => {
    const r = await POST(post({ ...OFERTA, codigo: 'pre-800!' }))
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ error: 'dados_invalidos' })
  })

  // .strict(): um campo a mais no corpo e engano de quem chamou, e engano
  // silencioso e o pior tipo — `ativo: false` ignorado criaria uma campanha
  // ligada que a tela acha que nasceu desligada.
  it('campo desconhecido no corpo e recusado', async () => {
    const r = await POST(post({ ...OFERTA, codigo: `${PREFIXO}XTR`, ativo: false }))
    expect(r.status).toBe(422)
  })
})

describe('PATCH /api/admin/cupons', () => {
  it('desliga e religa a campanha', async () => {
    const criacao = await POST(post({ ...OFERTA, codigo: `${PREFIXO}SW` }))
    const { cupom } = await criacao.json() as { cupom: { id: string } }

    const patch = (ativo: boolean) => PATCH(new Request('http://localhost/api/admin/cupons', {
      method: 'PATCH',
      headers: { Cookie: cookieAdmin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: cupom.id, ativo }),
    }))

    expect((await patch(false)).status).toBe(200)
    const desligado = await getDb().selectFrom('cupons').select('ativo')
      .where('id', '=', cupom.id).executeTakeFirstOrThrow()
    expect(desligado.ativo).toBe(false)

    expect((await patch(true)).status).toBe(200)
    const religado = await getDb().selectFrom('cupons').select('ativo')
      .where('id', '=', cupom.id).executeTakeFirstOrThrow()
    expect(religado.ativo).toBe(true)
  })

  it('cupom inexistente devolve 404', async () => {
    const r = await PATCH(new Request('http://localhost/api/admin/cupons', {
      method: 'PATCH',
      headers: { Cookie: cookieAdmin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000000', ativo: false }),
    }))
    expect(r.status).toBe(404)
  })
})

describe('GET /api/admin/cupons', () => {
  it('lista com a contagem de usos derivada, nunca uma coluna', async () => {
    await POST(post({ ...OFERTA, codigo: `${PREFIXO}LST` }))

    const r = await GET(new Request('http://localhost/api/admin/cupons', {
      headers: { Cookie: cookieAdmin },
    }))
    expect(r.status).toBe(200)

    const { cupons } = await r.json() as { cupons: Array<{ codigo: string; usos: number }> }
    const nosso = cupons.find((c) => c.codigo === `${PREFIXO}LST`)
    expect(nosso?.usos).toBe(0)
  })
})

/**
 * A AMARRA DE PONTA A PONTA, e o unico teste deste arquivo que justificaria os
 * outros existirem: o cupom criado pelo painel e RESGATAVEL no checkout, pelo
 * mesmo caminho que a compradora percorre, com o desconto que a tela prometeu.
 *
 * Sem isto, a rota poderia gravar um cupom perfeitamente valido em toda coluna
 * e ainda assim inutil — codigo com espaco, tipo invertido, valor em reais em
 * vez de centavos — e nenhum teste acima notaria. O que fecha o circuito e
 * `resgatarCupom` devolver 20000 de desconto sobre R$ 1.000,00.
 */
describe('do painel ao checkout', () => {
  it('o cupom criado no painel desconta R$ 200,00 no resgate', async () => {
    const criacao = await POST(post({ ...OFERTA, codigo: `${PREFIXO}E2E` }))
    expect(criacao.status).toBe(201)

    const cliente = await getDb().insertInto('clientes').values({
      nome: 'Compradora do Teste',
      email: `compradora.${PREFIXO.toLowerCase()}@teste.milagran`,
      whatsapp: '62999990000',
      cpf: '39053344705',
    }).returning('id').executeTakeFirstOrThrow()

    try {
      // `agora` VEM DO BANCO, e nao de `new Date()`. O cupom acabou de nascer
      // com o DEFAULT `now()` da coluna, que e o relogio do POSTGRES; o
      // relogio do NODE pode estar atras dele (896 ms de diferenca medidos no
      // container em 19/08/2026), e nessa janela `resgatarCupom` recusaria com
      // 'nao_iniciado' um cupom perfeitamente valido. Ler o instante do mesmo
      // relogio que gravou a linha tira a deriva da equacao — sem afrouxar
      // nada, porque a comparacao continua sendo a de producao.
      const { agora } = await getDb()
        .selectFrom('cupons')
        .select(({ eb }) => eb.fn<Date>('now').as('agora'))
        .where('codigo', '=', `${PREFIXO}E2E`)
        .executeTakeFirstOrThrow()

      const resultado = await getDb().transaction().execute((trx) =>
        resgatarCupom(`${PREFIXO}E2E`, centavos(1000), cliente.id, trx, agora))

      expect(resultado.ok).toBe(true)
      if (resultado.ok) {
        expect(resultado.cupom.desconto).toBe(20000)
        // Cupom da casa: sem representante, sem comissao atribuida.
        expect(resultado.cupom.representanteId).toBeNull()
      }
    } finally {
      await getDb().deleteFrom('cupom_usos').where('cliente_id', '=', cliente.id).execute()
      await getDb().deleteFrom('clientes').where('id', '=', cliente.id).execute()
    }
  })

  it('cupom desligado no painel para de valer no checkout', async () => {
    const criacao = await POST(post({ ...OFERTA, codigo: `${PREFIXO}OFF` }))
    const { cupom } = await criacao.json() as { cupom: { id: string } }

    await PATCH(new Request('http://localhost/api/admin/cupons', {
      method: 'PATCH',
      headers: { Cookie: cookieAdmin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: cupom.id, ativo: false }),
    }))

    const cliente = await getDb().insertInto('clientes').values({
      nome: 'Outra Compradora',
      email: `outra.${PREFIXO.toLowerCase()}@teste.milagran`,
      whatsapp: '62999990001',
      cpf: '19100000000',
    }).returning('id').executeTakeFirstOrThrow()

    try {
      const resultado = await getDb().transaction().execute((trx) =>
        resgatarCupom(`${PREFIXO}OFF`, centavos(1000), cliente.id, trx))

      expect(resultado).toEqual({ ok: false, motivo: 'inativo' })
    } finally {
      await getDb().deleteFrom('clientes').where('id', '=', cliente.id).execute()
    }
  })
})
