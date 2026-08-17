import { listarKitsAtivos } from '@/repositories/produtos'
import { escassezPresencialDoKit } from '@/lib/escassez-do-lote'
import { Vitrine } from '@/components/vitrine'

// Forca renderizacao dinamica: preco, ANVISA e ativo/inativo vem do banco e
// precisam refletir a linha atual a cada acesso, nao um snapshot congelado
// no momento do `next build` (esta pagina nao depende de cookie nem de
// query string como /r/[slug], mas o mesmo motivo de fundo — nao servir
// dado de catalogo desatualizado — se aplica aqui).
export const dynamic = 'force-dynamic'

export default async function PaginaComprar() {
  const kits = await listarKitsAtivos()

  // A Vitrine renderiza kits[0]; o lote presencial e lido para ESSE kit. Com
  // catalogo vazio nao ha kit e nao ha lote — a propria Vitrine cuida do
  // estado vazio, entao aqui basta nao consultar o banco a toa.
  const kit = kits[0]
  const escassez = kit ? await escassezPresencialDoKit(kit.id) : null

  return <Vitrine kits={kits} representante={null} escassez={escassez} />
}
