import { getDb } from '@/lib/db'
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

type LinhaKit = {
  id: string; slug: string; nome: string; descricao: string
  preco_centavos: number; unidades: number; sku: string
  anvisa_registro: string | null; ativo: boolean; ordem: number
}

function paraKit(l: LinhaKit): Kit {
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
    .orderBy('ordem', 'asc')
    .execute()
  return linhas.map((l) => paraKit(l as LinhaKit))
}

export async function buscarKitPorSlug(slug: string): Promise<Kit | null> {
  const linha = await getDb()
    .selectFrom('kits')
    .selectAll()
    .where('slug', '=', slug)
    .where('ativo', '=', true)
    .executeTakeFirst()
  return linha ? paraKit(linha as LinhaKit) : null
}
