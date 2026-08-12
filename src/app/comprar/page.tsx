import { listarKitsAtivos } from '@/repositories/produtos'
import { Vitrine } from '@/components/vitrine'

// Forca renderizacao dinamica: preco, ANVISA e ativo/inativo vem do banco e
// precisam refletir a linha atual a cada acesso, nao um snapshot congelado
// no momento do `next build` (esta pagina nao depende de cookie nem de
// query string como /r/[slug], mas o mesmo motivo de fundo — nao servir
// dado de catalogo desatualizado — se aplica aqui).
export const dynamic = 'force-dynamic'

export default async function PaginaComprar() {
  const kits = await listarKitsAtivos()

  return <Vitrine kits={kits} representante={null} />
}
