import type { Selectable } from 'kysely'
import { getDb } from '@/lib/db'
import type { Kits } from '@/lib/db-types'
import { deInteiro, type Centavos } from '@/lib/money'

export type Kit = {
  id: string
  slug: string
  nome: string
  descricao: string
  precoCentavos: Centavos
  unidades: number
  sku: string
  anvisaRegistro: string | null
  ativo: boolean
  ordem: number
}

function paraKit(l: Selectable<Kits>): Kit {
  return {
    id: l.id,
    slug: l.slug,
    nome: l.nome,
    descricao: l.descricao,
    precoCentavos: deInteiro(l.preco_centavos),
    unidades: l.unidades,
    sku: l.sku,
    anvisaRegistro: l.anvisa_registro,
    ativo: l.ativo,
    ordem: l.ordem,
  }
}

export async function listarKitsAtivos(): Promise<Kit[]> {
  const linhas = await getDb()
    .selectFrom('kits')
    .selectAll()
    .where('ativo', '=', true)
    // `ordem` nao e unica (kits_ativos_ordem e um indice btree comum, nao
    // um indice unico) e nada no schema impede dois kits ativos com o
    // mesmo valor. Sem uma segunda chave de ordenacao, um empate em `ordem`
    // fica decidido pela ordem de varredura do Postgres, que nao e
    // garantida — e a storefront (Task 8) le kits[0]. Desempatar por slug
    // torna o resultado deterministico em vez de acidentalmente estavel.
    .orderBy('ordem', 'asc')
    .orderBy('slug', 'asc')
    .execute()
  return linhas.map((l) => paraKit(l))
}

export async function buscarKitAtivoPorSlug(slug: string): Promise<Kit | null> {
  const linha = await getDb()
    .selectFrom('kits')
    .selectAll()
    .where('slug', '=', slug)
    .where('ativo', '=', true)
    .executeTakeFirst()
  return linha ? paraKit(linha) : null
}
