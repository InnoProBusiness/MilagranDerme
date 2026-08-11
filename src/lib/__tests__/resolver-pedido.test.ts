import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { getDb, closeDb } from '@/lib/db'
import { resolverAtribuicaoDoPedido } from '@/lib/resolver-pedido'
import {
  assinarAtribuicao, JANELA_ATRIBUICAO_DIAS, type Atribuicao,
} from '@/lib/atribuicao'

const SEGREDO = 'a'.repeat(64)

// Slugs proprios deste arquivo — ver a mesma justificativa em
// proxy.test.ts: o Vitest roda os arquivos em paralelo contra o mesmo
// Postgres real, entao cada arquivo so mexe nas suas proprias linhas.
const SLUG_ATIVO = 'resolver-maria'
const SLUG_INATIVO = 'resolver-ana'

let idMaria: string

async function semear() {
  const db = getDb()
  await db.deleteFrom('representantes').where('slug', 'in', [SLUG_ATIVO, SLUG_INATIVO]).execute()
  const maria = await db.insertInto('representantes').values({
    slug: SLUG_ATIVO, codigo: 'RESOLVERMARIA', nome: 'Maria (resolver)',
    email: 'resolver-maria@exemplo.com', percentual_comissao: '17.50', ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idMaria = maria.id
  await db.insertInto('representantes').values({
    slug: SLUG_INATIVO, codigo: 'RESOLVERANA', nome: 'Ana (resolver)',
    email: 'resolver-ana@exemplo.com', percentual_comissao: '20.00', ativo: false,
  }).execute()
}

function cookie(slug: string, em = Date.now()): string {
  const a: Atribuicao = {
    slug, em, utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
  }
  return assinarAtribuicao(a, SEGREDO)
}

describe('resolucao da atribuicao autoritativa do pedido', () => {
  let avisos: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    avisos = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await semear()
  })
  afterEach(() => { avisos.mockRestore() })
  afterAll(async () => { await closeDb() })

  it('sem cookie, a venda e da casa', async () => {
    expect(await resolverAtribuicaoDoPedido(null, SEGREDO)).toEqual({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
    })
  })

  it('chamadas separadas que retornam casa nao compartilham referencia de objeto', async () => {
    const a = await resolverAtribuicaoDoPedido(null, SEGREDO)
    const b = await resolverAtribuicaoDoPedido(null, SEGREDO)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })

  it('cookie que nao verifica e tratado como venda da casa, sem UTM', async () => {
    // Assinado com OUTRO segredo: nada dentro dele e confiavel, nem os UTM.
    const forjado = assinarAtribuicao(
      { slug: SLUG_ATIVO, em: Date.now(), utmSource: 'forjado', utmMedium: null, utmCampaign: null },
      'b'.repeat(64),
    )
    const r = await resolverAtribuicaoDoPedido(forjado, SEGREDO)
    expect(r.origem).toBe('casa')
    expect(r.utmSource).toBeNull()

    // ... e o descarte deixa rastro: sem ele, este pedido e indistinguivel
    // de uma compra que nunca teve cookie. O valor do cookie nao vai junto.
    expect(avisos).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(avisos.mock.calls)).not.toContain(forjado)
  })

  it('cookie malformado nao estoura e vira venda da casa', async () => {
    for (const lixo of ['', 'abc', 'a.b.c', 'nao-base64.xx']) {
      const r = await resolverAtribuicaoDoPedido(lixo, SEGREDO)
      expect(r.origem).toBe('casa')
    }
  })

  it('cookie fora da janela de 30 dias vira venda da casa', async () => {
    const em = Date.now() - (JANELA_ATRIBUICAO_DIAS + 1) * 86_400_000
    const r = await resolverAtribuicaoDoPedido(cookie(SLUG_ATIVO, em), SEGREDO)
    expect(r.origem).toBe('casa')
    expect(r.representanteId).toBeNull()
    expect(r.utmSource).toBeNull()
  })

  it('cookie valido de representante ativo credita o representante com os UTM da campanha', async () => {
    const r = await resolverAtribuicaoDoPedido(cookie(SLUG_ATIVO), SEGREDO)
    expect(r).toEqual({
      origem: 'link',
      representanteId: idMaria,
      percentualComissao: 17.5,
      utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
    })
  })

  it('representante desligado vira rep_inativo, nao venda da casa, e preserva os UTM', async () => {
    // 'casa' e 'rep_inativo' produzem o mesmo pagamento (nenhum), mas
    // apenas 'rep_inativo' registra POR QUE — sem isso, um link morto que
    // ainda vende some do relatorio.
    const r = await resolverAtribuicaoDoPedido(cookie(SLUG_INATIVO), SEGREDO)
    expect(r.origem).toBe('rep_inativo')
    expect(r.representanteId).toBeNull()
    expect(r.percentualComissao).toBeNull()
    expect(r.utmSource).toBe('instagram')
    expect(r.utmCampaign).toBe('lancamento')
  })

  it('slug que nao existe mais tambem vira rep_inativo', async () => {
    const r = await resolverAtribuicaoDoPedido(cookie('resolver-ninguem'), SEGREDO)
    expect(r.origem).toBe('rep_inativo')
    expect(r.representanteId).toBeNull()
    expect(r.utmMedium).toBe('bio')
  })

  it('DINHEIRO: o percentual vem do cadastro AGORA, nao de quando o cookie foi assinado', async () => {
    const assinadoQuandoEra17e5 = cookie(SLUG_ATIVO)
    await getDb().updateTable('representantes')
      .set({ percentual_comissao: '9.00' }).where('id', '=', idMaria).execute()

    const r = await resolverAtribuicaoDoPedido(assinadoQuandoEra17e5, SEGREDO)
    expect(r.percentualComissao).toBe(9)
  })

  it('DINHEIRO: percentual embutido no proprio cookie e ignorado', async () => {
    // Cookie assinado com o segredo VALIDO mas carregando um campo extra —
    // o cenario de quem tem acesso ao segredo, ou de um formato antigo que
    // um dia tenha carregado percentual. O resolvedor le apenas o banco.
    const payload = Buffer.from(JSON.stringify({
      slug: SLUG_ATIVO, em: Date.now(),
      utmSource: null, utmMedium: null, utmCampaign: null,
      percentualComissao: 99, percentual_comissao_snapshot: 99,
    })).toString('base64url')
    const assinatura = createHmac('sha256', SEGREDO).update(payload).digest('base64url')

    const r = await resolverAtribuicaoDoPedido(`${payload}.${assinatura}`, SEGREDO)
    expect(r.origem).toBe('link')
    expect(r.percentualComissao).toBe(17.5)
  })
})
