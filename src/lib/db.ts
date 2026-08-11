import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { DB } from '@/lib/db-types'

// Postgres devolve int8 (bigint) como string por seguranca. Como todo
// dinheiro no sistema cabe em int4 e ids sao uuid, converter para number
// e seguro e evita string vazando para calculo.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))

declare global {
  // eslint-disable-next-line no-var
  var __milagranDb: Kysely<DB> | undefined
}

export function getDb(): Kysely<DB> {
  if (!globalThis.__milagranDb) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL nao configurada')

    globalThis.__milagranDb = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          connectionString,
          max: 5,
          idleTimeoutMillis: 10_000,
        }),
      }),
    })
  }
  return globalThis.__milagranDb
}

export async function closeDb(): Promise<void> {
  if (globalThis.__milagranDb) {
    await globalThis.__milagranDb.destroy()
    globalThis.__milagranDb = undefined
  }
}
