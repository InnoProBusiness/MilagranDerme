import { listarKitsAtivos } from '@/repositories/produtos'
import { escassezPresencialDoKit } from '@/lib/escassez-do-lote'
import { Vitrine } from '@/components/vitrine'
import { cupomDaUrl } from '@/lib/cupom-da-url'

// Forca renderizacao dinamica: preco, ANVISA e ativo/inativo vem do banco e
// precisam refletir a linha atual a cada acesso, nao um snapshot congelado
// no momento do `next build` (esta pagina nao depende de cookie nem de
// query string como /r/[slug], mas o mesmo motivo de fundo — nao servir
// dado de catalogo desatualizado — se aplica aqui).
export const dynamic = 'force-dynamic'

/**
 * `?cupom=` — o link de campanha tambem cai aqui, nao so na home. O codigo
 * so ATRAVESSA esta pagina: ela o repassa a Vitrine, que o pendura no link do
 * checkout. Ver src/lib/cupom-da-url.ts.
 */
type Props = {
  searchParams: Promise<{ cupom?: string | string[] }>
}

export default async function PaginaComprar({ searchParams }: Props) {
  const [kits, sp] = await Promise.all([listarKitsAtivos(), searchParams])

  // A Vitrine renderiza kits[0]; o lote presencial e lido para ESSE kit. Com
  // catalogo vazio nao ha kit e nao ha lote — a propria Vitrine cuida do
  // estado vazio, entao aqui basta nao consultar o banco a toa.
  const kit = kits[0]
  const escassez = kit ? await escassezPresencialDoKit(kit.id) : null

  return (
    <Vitrine
      kits={kits}
      representante={null}
      escassez={escassez}
      cupom={cupomDaUrl(sp.cupom)}
    />
  )
}
