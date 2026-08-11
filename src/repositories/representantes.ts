import type { Selectable } from 'kysely'
import { getDb } from '@/lib/db'
import type { Representantes } from '@/lib/db-types'

export type Representante = {
  id: string
  slug: string
  codigo: string
  nome: string
  fotoUrl: string | null
  cidade: string
  estado: string
  percentualComissao: number
  ativo: boolean
}

function paraRepresentante(l: Selectable<Representantes>): Representante {
  return {
    id: l.id,
    slug: l.slug,
    codigo: l.codigo,
    nome: l.nome,
    fotoUrl: l.foto_url,
    cidade: l.cidade,
    estado: l.estado,
    // numeric chega como string do driver pg; Number aqui e seguro porque
    // percentual nao e dinheiro — o dinheiro e calculado em centavos inteiros.
    percentualComissao: Number(l.percentual_comissao),
    ativo: l.ativo,
  }
}

export async function buscarRepresentanteAtivoPorSlug(
  slug: string,
): Promise<Representante | null> {
  const linha = await getDb()
    .selectFrom('representantes')
    .selectAll()
    .where('slug', '=', slug)
    .where('ativo', '=', true)
    .executeTakeFirst()
  return linha ? paraRepresentante(linha) : null
}
