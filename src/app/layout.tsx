import type { Metadata, Viewport } from 'next'
import { Playfair_Display, Cormorant_Garamond, Jost } from 'next/font/google'
import './globals.css'
import { Cabecalho } from '@/components/cabecalho'
import { Rodape } from '@/components/rodape'

/**
 * FONTES SELF-HOSTED.
 *
 * A landing page estatica de recrutamento (public/seja-representante.html,
 * linhas 28-30) puxa Playfair Display, Cormorant Garamond e Jost do
 * fonts.googleapis.com em tempo de execucao — tres requisicoes a um terceiro
 * antes do primeiro pixel, e o IP de todo visitante entregue ao Google.
 *
 * Aqui nao. `next/font/google` BAIXA a fonte no `next build` e serve os
 * .woff2 do proprio dominio: o navegador nunca fala com o Google. O custo
 * ficou no build — ele precisa de rede de saida (CI e `docker build` tem). Se
 * um dia o build passar a rodar sem rede, o caminho e vendorizar os .woff2 no
 * repositorio e trocar para `next/font/local`; a variavel CSS publicada
 * continua a mesma e nada em globals.css muda.
 *
 * SEM `weight`: as tres familias tem versao variavel no catalogo, entao um
 * arquivo por familia cobre 300..900 e o CSS (que usa 300, 500, 600 e 700)
 * continua valendo sem baixar um arquivo por peso.
 *
 * `variable` publica a familia como custom property; globals.css a consome em
 * --serif/--script/--sans com fallback para o nome da fonte, para o visual nao
 * depender deste arquivo (nos testes de componente, em jsdom, ele nao roda).
 */
const fonteSerif = Playfair_Display({
  subsets: ['latin'],
  display: 'swap',
  variable: '--fonte-serif',
})

/** Italico entra porque o traco manuscrito da marca (.script, .brand-sub) e
 *  italico — sem ele o navegador sintetizaria uma inclinacao falsa. */
const fonteScript = Cormorant_Garamond({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--fonte-script',
})

const fonteSans = Jost({
  subsets: ['latin'],
  display: 'swap',
  variable: '--fonte-sans',
})

/**
 * Dominio de producao escrito por extenso, e nao lido de `APP_URL`.
 *
 * Dois motivos. (1) `metadata` e avaliado no import do modulo, e a convencao
 * do projeto e nao ler variavel de ambiente no import — um `new URL()` sobre
 * env ausente ou torta derrubaria o `next build` inteiro (mesmo raciocinio
 * registrado em src/lib/mercadopago.ts). (2) OG e canonical precisam ser
 * absolutos e ESTAVEIS: se o preview e a producao publicarem URLs diferentes
 * para a mesma pagina, o buscador indexa a errada — que e exatamente o
 * estrago que este commit esta desfazendo na LP de recrutamento.
 */
const SITE = 'https://milagranoficial.com.br'

const TITULO = 'Milagran Derme — Kit de limpeza de pele instantânea'
const DESCRICAO =
  'O Kit Milagran de limpeza de pele instantânea. Lançamento oficial em 25 de agosto de 2026: leve o seu no evento ou receba em casa.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: TITULO,
    // Cada tela acrescenta o proprio titulo ("Checkout", "Pedido nº 1042") e
    // a marca vem de graca no fim.
    template: '%s · Milagran Derme',
  },
  description: DESCRICAO,
  // SEM `alternates.canonical` AQUI, de proposito: canonical declarado no
  // layout raiz e herdado por TODAS as rotas, e todas passariam a apontar
  // para o mesmo endereco. E literalmente o defeito que
  // public/seja-representante.html tinha (canonical para "/", declarando o
  // recrutamento como home da marca). Canonical, quando precisar existir, e
  // por pagina.
  openGraph: {
    type: 'website',
    siteName: 'Milagran Derme',
    locale: 'pt_BR',
    url: SITE,
    title: TITULO,
    description: DESCRICAO,
    // Quadrada, 1200x1200 — o mesmo arquivo que a LP ja publica.
    images: [{
      url: '/assets/og-image.jpg',
      width: 1200,
      height: 1200,
      alt: 'Kit Milagran Derme',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITULO,
    description: DESCRICAO,
    images: ['/assets/og-image.jpg'],
  },
  // Os arquivos ja existem em public/assets/ desde a LP; o App Router nao os
  // enxergava porque nao havia `icons` em lugar nenhum.
  icons: {
    icon: [
      { url: '/assets/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/assets/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/assets/favicon-48.png', sizes: '48x48', type: 'image/png' },
    ],
    apple: [{ url: '/assets/apple-touch-icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
}

/**
 * `colorScheme: 'dark'` nao e decoracao: o tema da marca e escuro e UNICO
 * (nao ha prefers-color-scheme em globals.css). Sem esta declaracao, o
 * navegador desenha campo de formulario, barra de rolagem e menu de <select>
 * no esquema claro por cima de um fundo #0b0a08 — texto escuro em campo
 * branco no meio da loja escura.
 */
export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0b0a08',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="pt-BR"
      className={`${fonteSerif.variable} ${fonteScript.variable} ${fonteSans.variable}`}
    >
      <body>
        {/* Brilhos de fundo da identidade da marca. aria-hidden: sao pura
            decoracao e nao devem aparecer para leitor de tela. */}
        <div className="bg-glow bg-glow--one" aria-hidden="true" />
        <div className="bg-glow bg-glow--two" aria-hidden="true" />

        <Cabecalho />

        {/*
          O UNICO <main> do site, e por isso ele mora aqui e nao nas paginas.
          Ate 16/08/2026 quatro paginas (checkout, pedido, /r/<slug> e o layout
          do admin) traziam cada uma o seu — o que dava dois <main> aninhados
          assim que um chrome compartilhado passou a existir: HTML invalido e
          dois landmarks concorrentes disputando o "ir para o conteudo
          principal" do leitor de tela. Todas foram esvaziadas do proprio
          <main> no mesmo commit, entao NAO acrescente um em pagina nenhuma:
          o lugar dele e este, e paginas so devolvem <section>.

          tabIndex={-1} nao e decoracao: sem ele o "pular para o conteudo" move
          a rolagem mas nao o foco, e o proximo Tab volta para o cabecalho —
          que e exatamente o que o link existe para evitar.
        */}
        <main className="conteudo" id="conteudo" tabIndex={-1}>
          {children}
        </main>

        <Rodape />
      </body>
    </html>
  )
}
