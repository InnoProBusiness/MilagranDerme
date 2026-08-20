import type { Metadata } from 'next'
import { buscarKitAtivoPorSlug, listarKitsAtivos } from '@/repositories/produtos'
import { QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { CheckoutWizard } from '@/components/checkout-wizard'
import { cupomDaUrl } from '@/lib/cupom-da-url'
import { lancamentoJaOcorreu } from '@/lib/tempo'

// Preco e disponibilidade vem do banco a cada acesso — mesmo raciocinio de
// src/app/comprar/page.tsx e src/app/r/[slug]/page.tsx: um snapshot
// congelado no build serviria um kit desativado ou um preco velho.
export const dynamic = 'force-dynamic'

/**
 * ESTA ROTA VIROU A TELA DE COMPRA EM 20/08/2026.
 *
 * Ela ja existia — a vitrine (/comprar) sempre entregou o pedido aqui —, mas
 * dividia o papel com o checkout embutido na home. O cliente pediu o fluxo em
 * tela propria, e a home passou a entregar para ca tambem. Ver a secao "A
 * compra" em src/app/page.tsx para as razoes.
 *
 * TITULO PROPRIO porque a aba do navegador passou a ser um lugar onde a
 * compradora se perde: com o formulario na home, "Milagran — Kit de limpeza de
 * pele" descrevia a aba corretamente. Agora ha duas abas possiveis da mesma
 * loja, e a que tem o pedido pela metade precisa se identificar. O template do
 * layout raiz acrescenta a marca ("Checkout · Milagran").
 *
 * `noindex` porque uma tela de checkout nao e resposta para busca nenhuma:
 * indexada, ela competiria com a home pelo nome da marca e entregaria ao
 * visitante um formulario no lugar da loja. `follow` fica ligado — os links
 * daqui (rodape, politica de privacidade) continuam valendo.
 */
export const metadata: Metadata = {
  title: 'Checkout',
  robots: { index: false, follow: true },
}

type Props = {
  searchParams: Promise<{ kit?: string; q?: string; cupom?: string | string[] }>
}

export default async function PaginaCheckout({ searchParams }: Props) {
  const sp = await searchParams

  // O slug vem da URL que a Vitrine monta (/checkout?kit=<slug>&q=<qtd>).
  // Se ele nao resolver para um kit ativo — link velho, kit desativado
  // entre o clique e o load, ou acesso direto sem query string — cai para o
  // primeiro kit ativo do catalogo, o mesmo que /comprar mostra.
  const kitPedido = sp.kit ? await buscarKitAtivoPorSlug(sp.kit) : null
  const kit = kitPedido ?? (await listarKitsAtivos())[0] ?? null

  if (!kit) {
    return (
      <section className="section checkout">
        <p className="kicker">Checkout</p>
        <p>Nenhum kit disponivel no momento.</p>
      </section>
    )
  }

  const quantidadeBruta = Number(sp.q)
  const quantidadeInicial = Number.isInteger(quantidadeBruta)
    ? Math.max(1, Math.min(QUANTIDADE_MAXIMA, quantidadeBruta))
    : 1

  // Sem <main> proprio: o landmark de conteudo principal e o do layout raiz
  // (src/app/layout.tsx). Um <main> aqui ficaria aninhado dentro dele.
  // O parametro `cupom` da query string chega dos links de campanha e apenas
  // PREENCHE o campo do formulario — o desconto continua sendo decidido no
  // servidor, sob trava de linha. Ver src/lib/cupom-da-url.ts.
  return (
    <CheckoutWizard
      kit={kit}
      quantidadeInicial={quantidadeInicial}
      cupomInicial={cupomDaUrl(sp.cupom)}
      // Decidido no SERVIDOR e passado pronto: ver o doc da prop em
      // src/components/checkout-wizard.tsx — chamar lancamentoJaOcorreu()
      // dentro de um Client Component quebra a hidratacao na virada do dia.
      lancado={lancamentoJaOcorreu()}
    />
  )
}
