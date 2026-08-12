import { notFound } from 'next/navigation'
import { buscarRepresentanteAtivoPorSlug } from '@/repositories/representantes'
import { listarKitsAtivos } from '@/repositories/produtos'
import { Vitrine } from '@/components/vitrine'

// A atribuicao depende de cookie e query string, entao a pagina nao pode
// ser estatica. A gravacao do cookie em si acontece em src/proxy.ts —
// Server Components nao podem escrever cookies durante o render (ver
// comentario la). Esta pagina so precisa ser dinamica porque o proxy que a
// precede tambem varia por requisicao.
//
// Esta pagina consulta buscarRepresentanteAtivoPorSlug de novo, mesmo o
// proxy ja tendo feito a mesma consulta — de proposito, ver comentario em
// src/proxy.ts sobre por que isso nao deve virar um header repassado.
export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ slug: string }>
}

export default async function PaginaRepresentante({ params }: Props) {
  const { slug } = await params

  const representante = await buscarRepresentanteAtivoPorSlug(slug)
  if (!representante) notFound()

  const kits = await listarKitsAtivos()

  return (
    <main>
      <Vitrine
        kits={kits}
        representante={{ nome: representante.nome, slug: representante.slug }}
      />
    </main>
  )
}
