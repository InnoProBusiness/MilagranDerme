import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { buscarRepresentanteAtivoPorSlug } from '@/repositories/representantes'

// Deleta so os proprios slugs, nao a tabela inteira: um DELETE sem filtro
// aqui corre contra qualquer outro arquivo de teste que tambem escreva em
// "representantes" (ex.: src/__tests__/proxy.test.ts) quando o Vitest roda
// os arquivos em paralelo — um apaga as linhas que o outro acabou de
// inserir. Escopar por slug torna os dois arquivos independentes mesmo
// rodando ao mesmo tempo contra o mesmo Postgres real.
const SLUGS_PROPRIOS = ['maria', 'joao', 'ana', 'rep-carimbo'] as const

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

  it('rejeita slug longo demais para caber num link ditado por telefone', async () => {
    await expect(
      getDb().insertInto('representantes').values({
        slug: 'a'.repeat(300), codigo: 'LONGO', nome: 'Slug Longo',
        email: 'longo@exemplo.com', percentual_comissao: '20.00', ativo: true,
      }).execute(),
    ).rejects.toThrow(/rep_slug_tamanho/)
  })

  // O indice unico sozinho so impede duas linhas com o mesmo slug ao mesmo
  // tempo. Sem o trigger, renomear o slug de um representante desligado
  // liberava o valor antigo para o proximo cadastro — e todo link ainda em
  // circulacao passava a creditar outra pessoa.
  describe('trigger que trava a identidade publica contra UPDATE', () => {
    it('rejeita alterar o slug de um representante ja cadastrado', async () => {
      await expect(
        getDb().updateTable('representantes')
          .set({ slug: 'maria-nova' }).where('slug', '=', 'maria').execute(),
      ).rejects.toThrow(/rep_identidade_imutavel: coluna slug/)
    })

    it('rejeita alterar o codigo de cupom de um representante ja cadastrado', async () => {
      await expect(
        getDb().updateTable('representantes')
          .set({ codigo: 'MARIA2' }).where('slug', '=', 'maria').execute(),
      ).rejects.toThrow(/rep_identidade_imutavel: coluna codigo/)
    })

    it('permite ao admin editar nome e percentual — o trigger nao pode travar o cadastro', async () => {
      await getDb().updateTable('representantes')
        .set({ nome: 'Maria Silva', percentual_comissao: '25.50' })
        .where('slug', '=', 'maria').execute()

      const r = await buscarRepresentanteAtivoPorSlug('maria')
      expect(r?.nome).toBe('Maria Silva')
      expect(r?.percentualComissao).toBe(25.5)
    })

    it('atualiza atualizado_em a cada UPDATE, sem mexer em criado_em', async () => {
      // Mesma correcao aplicada a kits: a coluna so tinha DEFAULT now(),
      // entao marcava a criacao e mentia dali em diante. Numa tabela em que
      // uma edicao muda quanto alguem recebe, a data da ultima alteracao e
      // auditoria.
      const antigo = new Date('2020-01-01T00:00:00.000Z')
      await getDb().insertInto('representantes').values({
        slug: 'rep-carimbo', codigo: 'REPCARIMBO', nome: 'Carimbo',
        email: 'carimbo@exemplo.com', percentual_comissao: '20.00', ativo: true,
        criado_em: antigo, atualizado_em: antigo,
      }).execute()

      await getDb().updateTable('representantes')
        // Data velha informada de proposito: o trigger tem que sobrescrever.
        .set({ percentual_comissao: '30.00', atualizado_em: antigo })
        .where('slug', '=', 'rep-carimbo').execute()

      const l = await getDb().selectFrom('representantes')
        .select(['criado_em', 'atualizado_em'])
        .where('slug', '=', 'rep-carimbo').executeTakeFirstOrThrow()
      expect(l.criado_em.getTime()).toBe(antigo.getTime())
      expect(l.atualizado_em.getTime()).toBeGreaterThan(antigo.getTime())
    })

    it('permite desativar o representante e trocar email, foto, cidade e estado', async () => {
      await getDb().updateTable('representantes')
        .set({
          ativo: false, email: 'maria.nova@exemplo.com',
          foto_url: null, cidade: 'Olinda', estado: 'PE', whatsapp: '81999999999',
        })
        .where('slug', '=', 'maria').execute()

      const linha = await getDb().selectFrom('representantes')
        .selectAll().where('slug', '=', 'maria').executeTakeFirstOrThrow()
      expect(linha.ativo).toBe(false)
      expect(linha.cidade).toBe('Olinda')
    })
  })
})
