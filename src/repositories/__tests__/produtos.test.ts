import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { listarKitsAtivos, buscarKitAtivoPorSlug } from '@/repositories/produtos'

async function semear() {
  const db = getDb()
  await db.deleteFrom('kits').execute()
  await db.insertInto('kits').values([
    { slug: 'kit-1', nome: 'Kit 1', preco_centavos: 19990, unidades: 1, sku: 'MG-K1', ordem: 1, ativo: true },
    {
      slug: 'kit-3', nome: 'Kit 3', descricao: 'Kit com 3 unidades do creme Milagran',
      preco_centavos: 53900, unidades: 3, sku: 'MG-K3', anvisa_registro: '25351.000123/2024-01',
      ordem: 2, ativo: true,
    },
    { slug: 'kit-antigo', nome: 'Kit descontinuado', preco_centavos: 9990, unidades: 1, sku: 'MG-OLD', ordem: 3, ativo: false },
  ]).execute()
}

describe('repositorio de produtos', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('lista apenas kits ativos, na ordem definida', async () => {
    const kits = await listarKitsAtivos()
    expect(kits.map((k) => k.slug)).toEqual(['kit-1', 'kit-3'])
  })

  it('devolve preco como Centavos inteiro, nunca string', async () => {
    const [primeiro] = await listarKitsAtivos()
    expect(primeiro!.precoCentavos).toBe(19990)
    expect(typeof primeiro!.precoCentavos).toBe('number')
  })

  it('busca por slug', async () => {
    const kit = await buscarKitAtivoPorSlug('kit-3')
    expect(kit?.nome).toBe('Kit 3')
    expect(kit?.unidades).toBe(3)
    expect(kit?.sku).toBe('MG-K3')
    expect(kit?.descricao).toBe('Kit com 3 unidades do creme Milagran')
    expect(kit?.anvisaRegistro).toBe('25351.000123/2024-01')
  })

  it('devolve null para slug inexistente', async () => {
    expect(await buscarKitAtivoPorSlug('nao-existe')).toBeNull()
  })

  it('nao devolve kit inativo na busca por slug', async () => {
    expect(await buscarKitAtivoPorSlug('kit-antigo')).toBeNull()
  })

  it('impede dois kits com o mesmo slug', async () => {
    await expect(
      getDb().insertInto('kits').values({
        slug: 'kit-1', nome: 'Duplicado', preco_centavos: 100,
        unidades: 1, sku: 'MG-DUP', ordem: 9, ativo: true,
      }).execute(),
    ).rejects.toThrow(/kits_slug_unico/)
  })

  it('atualiza atualizado_em a cada UPDATE, sem mexer em criado_em', async () => {
    // A coluna tinha DEFAULT now() e nenhum trigger: marcava a criacao e
    // ficava parada ali para sempre. Semear com data antiga torna o teste
    // deterministico — nao depende de dois now() caírem em milissegundos
    // diferentes.
    const antigo = new Date('2020-01-01T00:00:00.000Z')
    await getDb().insertInto('kits').values({
      slug: 'kit-carimbo', nome: 'Carimbo', preco_centavos: 1000, unidades: 1,
      sku: 'MG-CARIMBO', ordem: 9, ativo: true, criado_em: antigo, atualizado_em: antigo,
    }).execute()

    await getDb().updateTable('kits')
      // Tenta gravar uma data velha de proposito: o trigger tem que vencer.
      .set({ preco_centavos: 2000, atualizado_em: antigo })
      .where('slug', '=', 'kit-carimbo').execute()

    const l = await getDb().selectFrom('kits').select(['criado_em', 'atualizado_em'])
      .where('slug', '=', 'kit-carimbo').executeTakeFirstOrThrow()
    expect(l.criado_em.getTime()).toBe(antigo.getTime())
    expect(l.atualizado_em.getTime()).toBeGreaterThan(antigo.getTime())
  })

  it('impede preco zero ou negativo', async () => {
    await expect(
      getDb().insertInto('kits').values({
        slug: 'kit-gratis', nome: 'Gratis', preco_centavos: 0,
        unidades: 1, sku: 'MG-FREE', ordem: 9, ativo: true,
      }).execute(),
    ).rejects.toThrow(/kits_preco_positivo/)
  })
})
