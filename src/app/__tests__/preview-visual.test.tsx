import { describe, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * VER A HOME SEM BANCO — gerador de preview visual.
 *
 * POR QUE EXISTE. A home le estoque ao vivo (`force-dynamic`), entao
 * `next dev` nao sobe sem Postgres. Numa maquina sem Docker — e no CI, que tem
 * banco mas nao tem tela — nao havia NENHUMA forma de olhar a pagina. O
 * redesenho de 20/08/2026 mexeu em treze secoes, no cabecalho, no rodape e na
 * paleta inteira: conferir aquilo so por assercao de teste e conferir que os
 * textos existem, nao que a pagina esta de pe.
 *
 * Este arquivo renderiza cabecalho + pagina + rodape com dados falsos e grava
 * um HTML autocontido (CSS embutido, fontes do Google, caminhos de
 * `public/assets` resolvidos) que abre em qualquer navegador.
 *
 * INERTE POR PADRAO. Sem `PREVIEW_OUT` no ambiente ele nao roda — no CI e mais
 * um teste pulado, e nao um arquivo aparecendo na raiz do repositorio a cada
 * `npm test`.
 *
 * USO:
 *   PREVIEW_OUT=/tmp/home.html npm test -- preview-visual
 *
 * VARIAVEIS:
 *   PREVIEW_OUT   caminho do HTML a gravar. Sem ela, o teste e pulado.
 *   PREVIEW_HIDE  seletor CSS a esconder, para isolar uma secao
 *                 (ex.: ".hero,#a-milagran" pula o topo e cai no meio).
 *   PREVIEW_CSS   CSS extra, para medir. Foi assim que o desencontro de calha
 *                 entre `.section` e `.section--panel` foi encontrado:
 *                 uma regua vermelha em `left:20px` e contorno nos blocos.
 *
 * PARA TIRAR FOTO (Chrome ou Edge, que ja existem no Windows):
 *   chrome --headless=new --window-size=1440,1700 --screenshot=out.png file:///...
 *
 * ARMADILHA JA PAGA: o Chrome headless tem largura MINIMA de janela (~500px),
 * entao `--window-size=390,...` NAO produz um viewport de celular — produz um
 * corte de 390px sobre um layout mais largo, o que parece transbordamento e
 * nao e. Para ver o mobile de verdade, embuta o preview num
 * `<iframe width="390">` dentro de outra pagina e fotografe essa.
 */

vi.mock('@/repositories/produtos', () => ({ listarKitsAtivos: vi.fn() }))
vi.mock('@/repositories/estoque', () => ({ saldoDoEstoque: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}))

import PaginaInicial from '@/app/page'
import { Cabecalho } from '@/components/cabecalho'
import { Rodape } from '@/components/rodape'
import { listarKitsAtivos, type Kit } from '@/repositories/produtos'
import { saldoDoEstoque, type SaldoEstoque } from '@/repositories/estoque'
import { deInteiro } from '@/lib/money'

/** O kit de producao, com o preco real, para o checkout mostrar o que mostra. */
const KIT: Kit = {
  id: 'k1', slug: 'kit-milagran', nome: 'Kit Milagran',
  descricao: 'Kit de limpeza de pele instantânea.',
  precoCentavos: deInteiro(100000), unidades: 1, sku: 'MG-KIT-001',
  anvisaRegistro: null, anvisaDispensado: true, ativo: true, ordem: 1,
  pesoGramas: 760, alturaCm: 6, larguraCm: 18, comprimentoCm: 23,
}

const SALDO: SaldoEstoque = {
  estoqueId: 'e1', kitId: 'k1', canal: 'presencial',
  ilimitado: false, total: 50, vendido: 8, disponivel: 42,
}

const DESTINO = process.env.PREVIEW_OUT

describe.skipIf(!DESTINO)('preview visual da home', () => {
  it('grava o HTML autocontido', async () => {
    vi.mocked(listarKitsAtivos).mockResolvedValue([KIT])
    vi.mocked(saldoDoEstoque).mockResolvedValue(SALDO)

    const pagina = await PaginaInicial({ searchParams: Promise.resolve({}) })

    const html = renderToStaticMarkup(
      <>
        <div className="bg-glow bg-glow--one" aria-hidden="true" />
        <div className="bg-glow bg-glow--two" aria-hidden="true" />
        <Cabecalho />
        <main className="conteudo" id="conteudo">{pagina}</main>
        <Rodape />
      </>,
    )

    // `file://` nao resolve `/assets/`: aponta para o public/ real do repo.
    const raiz = process.cwd().split('\\').join('/')
    const comAssets = html.split('"/assets/').join(`"file:///${raiz}/public/assets/`)

    const css = readFileSync('src/app/globals.css', 'utf8')
    const esconder = process.env.PREVIEW_HIDE
      ? `${process.env.PREVIEW_HIDE}{display:none}`
      : ''

    writeFileSync(DESTINO as string, `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview — Milagran</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400..900&family=Cormorant+Garamond:ital,wght@0,300..700;1,300..700&family=Manrope:wght@200..800&display=swap">
<style>${css}</style>
<style>
  /* A rolagem suave da loja atrapalha a foto: o navegador headless dispara o
     obturador no meio da animacao da ancora. */
  html{scroll-behavior:auto !important}
  ${esconder}
  ${process.env.PREVIEW_CSS ?? ''}
</style>
</head>
<body>${comAssets}</body>
</html>`, 'utf8')
  })
})
