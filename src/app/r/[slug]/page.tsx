import { notFound } from 'next/navigation'
import { buscarRepresentanteAtivoPorSlug } from '@/repositories/representantes'
import { listarKitsAtivos } from '@/repositories/produtos'
import { formatarBRL } from '@/lib/money'

// A atribuicao depende de cookie e query string, entao a pagina nao pode
// ser estatica. A gravacao do cookie em si acontece em src/middleware.ts —
// Server Components nao podem escrever cookies durante o render (ver
// comentario la). Esta pagina so precisa ser dinamica porque o middleware
// que a precede tambem varia por requisicao.
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
    <main className="section">
      <p className="kicker">Representante oficial Milagran</p>
      <h1>{representante.nome}</h1>
      <ul>
        {kits.map((kit) => (
          <li key={kit.id}>
            {kit.nome} — {formatarBRL(kit.precoCentavos)}
          </li>
        ))}
      </ul>
    </main>
  )
}
