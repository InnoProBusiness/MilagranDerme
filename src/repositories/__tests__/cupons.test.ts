import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'

const CODIGOS = ['MARIA10', 'FIXO50', 'RUIM']

async function limpar() {
  const db = getDb()
  await db.deleteFrom('cupons').where('codigo', 'in', CODIGOS).execute()
}

describe('schema de cupons', () => {
  beforeEach(limpar)
  afterAll(async () => { await closeDb() })

  it('aceita cupom percentual valido', async () => {
    await getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'percentual', valor: 10 }).execute()
    const c = await getDb().selectFrom('cupons').selectAll()
      .where('codigo', '=', 'MARIA10').executeTakeFirstOrThrow()
    expect(c.limite_por_cliente).toBe(1)
    expect(c.ativo).toBe(true)
  })

  it('rejeita percentual acima de 100', async () => {
    await expect(getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'percentual', valor: 150 }).execute(),
    ).rejects.toThrow(/cupom_percentual_valido/)
  })

  it('aceita desconto fixo acima de 100 — sao centavos, nao porcentagem', async () => {
    await getDb().insertInto('cupons')
      .values({ codigo: 'FIXO50', tipo: 'fixo', valor: 5000 }).execute()
    const c = await getDb().selectFrom('cupons').select('valor')
      .where('codigo', '=', 'FIXO50').executeTakeFirstOrThrow()
    expect(c.valor).toBe(5000)
  })

  it('rejeita codigo minusculo', async () => {
    await expect(getDb().insertInto('cupons')
      .values({ codigo: 'maria10', tipo: 'percentual', valor: 10 }).execute(),
    ).rejects.toThrow(/cupom_codigo_formato/)
  })

  it('rejeita codigo duplicado', async () => {
    await getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'percentual', valor: 10 }).execute()
    await expect(getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'fixo', valor: 500 }).execute(),
    ).rejects.toThrow(/cupom_codigo_unico/)
  })

  it('rejeita janela invertida', async () => {
    await expect(getDb().insertInto('cupons').values({
      codigo: 'RUIM', tipo: 'percentual', valor: 10,
      inicia_em: new Date('2026-09-01'), expira_em: new Date('2026-08-01'),
    }).execute()).rejects.toThrow(/cupom_janela_coerente/)
  })

  it('rejeita limite por cliente zero', async () => {
    await expect(getDb().insertInto('cupons').values({
      codigo: 'RUIM', tipo: 'percentual', valor: 10, limite_por_cliente: 0,
    }).execute()).rejects.toThrow(/cupom_limites_positivos/)
  })
})
