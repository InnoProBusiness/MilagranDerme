import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'

const CODIGOS = ['MARIA10', 'FIXO50', 'RUIM', 'FIXOTETO']

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

  // cupom_fixo_teto: limite operacional de sanidade contra erro de
  // digitacao num cupom fixo (um zero a mais cria um cupom que zera
  // qualquer pedido realista). Nao e regra de negocio — ver comentario na
  // migration. Os dois lados do teto de 10_000_000 centavos (R$ 100.000,00)
  // ficam cobertos abaixo.
  it('aceita fixo exatamente no teto de 10.000.000 centavos', async () => {
    await getDb().insertInto('cupons')
      .values({ codigo: 'FIXOTETO', tipo: 'fixo', valor: 10_000_000 }).execute()
    const c = await getDb().selectFrom('cupons').select('valor')
      .where('codigo', '=', 'FIXOTETO').executeTakeFirstOrThrow()
    expect(c.valor).toBe(10_000_000)
  })

  it('rejeita fixo um centavo acima do teto', async () => {
    await expect(getDb().insertInto('cupons').values({
      codigo: 'FIXOTETO', tipo: 'fixo', valor: 10_000_001,
    }).execute()).rejects.toThrow(/cupom_fixo_teto/)
  })

  it('cupom percentual nao e afetado pelo teto de fixo', async () => {
    // 100 e o maximo que cupom_percentual_valido permite para percentual —
    // muito abaixo de 10_000_000. Se cupom_fixo_teto estivesse mal escrito
    // (sem o "tipo <> 'fixo' OR"), este INSERT continuaria passando de
    // qualquer forma, entao o que prova a independencia entre as duas
    // constraints e a leitura da CHECK na migration, nao este teste sozinho.
    await getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'percentual', valor: 100 }).execute()
    const c = await getDb().selectFrom('cupons').select('valor')
      .where('codigo', '=', 'MARIA10').executeTakeFirstOrThrow()
    expect(c.valor).toBe(100)
  })
})
