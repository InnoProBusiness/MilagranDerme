import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { buscarRepresentanteAtivoPorSlug } from '@/repositories/representantes'

// Deleta so os proprios slugs, nao a tabela inteira: um DELETE sem filtro
// aqui corre contra qualquer outro arquivo de teste que tambem escreva em
// "representantes" (ex.: src/__tests__/proxy.test.ts) quando o Vitest roda
// os arquivos em paralelo — um apaga as linhas que o outro acabou de
// inserir. Escopar por slug torna os dois arquivos independentes mesmo
// rodando ao mesmo tempo contra o mesmo Postgres real.
const SLUGS_PROPRIOS = ['maria', 'joao', 'ana'] as const

async function semear() {
  const db = getDb()
  await db.deleteFrom('representantes').where('slug', 'in', SLUGS_PROPRIOS).execute()
  await db.insertInto('representantes').values([
    {
      slug: 'maria', codigo: 'MARIA', nome: 'Maria', email: 'maria@exemplo.com',
      percentual_comissao: '20.00', ativo: true,
      foto_url: 'https://exemplo.com/maria.jpg', cidade: 'Recife', estado: 'PE',
    },
    { slug: 'joao', codigo: 'JOAO', nome: 'Joao', email: 'joao@exemplo.com', percentual_comissao: '15.50', ativo: true },
    { slug: 'ana', codigo: 'ANA', nome: 'Ana', email: 'ana@exemplo.com', percentual_comissao: '20.00', ativo: false },
  ]).execute()
}

describe('repositorio de representantes', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('busca representante ativo por slug', async () => {
    const r = await buscarRepresentanteAtivoPorSlug('maria')
    expect(r?.nome).toBe('Maria')
    expect(r?.percentualComissao).toBe(20)
  })

  it('mapeia cada campo para a coluna correta, sem trocar valores', async () => {
    const r = await buscarRepresentanteAtivoPorSlug('maria')
    expect(r).toMatchObject({
      slug: 'maria',
      codigo: 'MARIA',
      nome: 'Maria',
      fotoUrl: 'https://exemplo.com/maria.jpg',
      cidade: 'Recife',
      estado: 'PE',
      percentualComissao: 20,
      ativo: true,
    })
    expect(typeof r?.id).toBe('string')
  })

  it('devolve estado como string vazia quando nao preenchido, sem blank-padding do bpchar', async () => {
    const r = await buscarRepresentanteAtivoPorSlug('joao')
    expect(r?.estado).toBe('')
    expect(r?.estado.length).toBe(0)
  })

  it('devolve percentual fracionario como number', async () => {
    const r = await buscarRepresentanteAtivoPorSlug('joao')
    expect(r?.percentualComissao).toBe(15.5)
  })

  it('nao devolve representante inativo', async () => {
    expect(await buscarRepresentanteAtivoPorSlug('ana')).toBeNull()
  })

  it('devolve null para slug inexistente', async () => {
    expect(await buscarRepresentanteAtivoPorSlug('ninguem')).toBeNull()
  })

  it('impede reutilizar o slug de um representante desligado', async () => {
    await expect(
      getDb().insertInto('representantes').values({
        slug: 'ana', codigo: 'ANA2', nome: 'Outra Ana',
        email: 'ana2@exemplo.com', percentual_comissao: '20.00', ativo: true,
      }).execute(),
    ).rejects.toThrow(/rep_slug_unico/)
  })

  it('rejeita slug com maiuscula ou espaco', async () => {
    await expect(
      getDb().insertInto('representantes').values({
        slug: 'Maria Silva', codigo: 'MS', nome: 'Maria Silva',
        email: 'ms@exemplo.com', percentual_comissao: '20.00', ativo: true,
      }).execute(),
    ).rejects.toThrow(/rep_slug_formato/)
  })

  it('rejeita percentual acima de 100', async () => {
    await expect(
      getDb().insertInto('representantes').values({
        slug: 'ganancioso', codigo: 'GAN', nome: 'Ganancioso',
        email: 'g@exemplo.com', percentual_comissao: '150.00', ativo: true,
      }).execute(),
    ).rejects.toThrow(/rep_percentual_valido/)
  })
})
