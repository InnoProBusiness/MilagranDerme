import { describe, it, expect, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { sql } from 'kysely'

describe('conexao com o banco', () => {
  afterAll(async () => { await closeDb() })

  it('executa uma query e enxerga a extensao pgcrypto', async () => {
    const r = await sql<{ uuid: string }>`SELECT gen_random_uuid()::text AS uuid`
      .execute(getDb())
    expect(r.rows[0]!.uuid).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('devolve a mesma instancia em chamadas repetidas', () => {
    expect(getDb()).toBe(getDb())
  })
})
