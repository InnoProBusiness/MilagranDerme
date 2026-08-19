import { notFound } from 'next/navigation'
import { buscarRepresentanteAtivoPorSlug } from '@/repositories/representantes'
import { listarKitsAtivos } from '@/repositories/produtos'
import { escassezPresencialDoKit } from '@/lib/escassez-do-lote'
import { Vitrine } from '@/components/vitrine'
import { cupomDaUrl } from '@/lib/cupom-da-url'

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

/**
 * `?cupom=` importa MAIS AQUI do que em qualquer outra tela: o link que uma
 * representante espalha e este, e uma campanha de desconto sai pelas
 * representantes antes de sair por qualquer outro lugar. Sem repassar o
 * codigo, `/r/maria?cupom=PRE800` levaria ao checkout sem desconto nenhum —
 * URL certa na barra de enderecos, promessa quebrada na tela de pagamento.
 */
type Props = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ cupom?: string | string[] }>
}

export default async function PaginaRepresentante({ params, searchParams }: Props) {
  const [{ slug }, sp] = await Promise.all([params, searchParams])

  const representante = await buscarRepresentanteAtivoPorSlug(slug)
  if (!representante) notFound()

  const kits = await listarKitsAtivos()

  // O lote presencial e da MARCA, nao do representante: os 50 kits de §2 sao
  // do evento de 25/08 e nao pertencem a nenhuma vitrine em particular. Um
  // visitante que chega pelo link de uma representante ve o mesmo contador que
  // todo mundo — e o mesmo numero que a home mostra. Contadores diferentes por
  // vitrine seriam a mesma classe de defeito que LinhaFrete existe para
  // impedir: duas telas afirmando coisas diferentes sobre o mesmo estoque.
  const kit = kits[0]
  const escassez = kit ? await escassezPresencialDoKit(kit.id) : null

  // Sem <main> proprio: o landmark de conteudo principal e o do layout raiz
  // (src/app/layout.tsx). Um <main> aqui ficaria aninhado dentro dele.
  return (
    <Vitrine
      kits={kits}
      representante={{ nome: representante.nome, slug: representante.slug }}
      escassez={escassez}
      cupom={cupomDaUrl(sp.cupom)}
    />
  )
}
