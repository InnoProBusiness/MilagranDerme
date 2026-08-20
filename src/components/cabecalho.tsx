'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Cabecalho compartilhado por TODAS as rotas do App Router (renderizado uma
 * unica vez em src/app/layout.tsx).
 *
 * VIROU CLIENT COMPONENT EM 20/08/2026, e a troca foi paga com um requisito,
 * nao com gosto: §3 e §4 do briefing pedem um menu sanfona (hamburger) com o
 * menu completo, e menu que abre e fecha precisa de estado. Ate aqui este
 * arquivo era server component justamente porque "a navegacao da loja e curta
 * o bastante para caber em dois alvos" — deixou de ser: sao sete destinos
 * (§25) mais dois botoes.
 *
 * O QUE A TROCA CUSTA: o chrome de todas as telas passa a carregar um punhado
 * de JS, inclusive o painel administrativo. E o minimo possivel — sem
 * biblioteca, sem animacao em JS, e o menu inline do desktop e HTML puro que
 * funciona antes de qualquer hidratacao.
 *
 * ---------------------------------------------------------------------------
 * §2 E A REGRA MAIS DURA DO BRIEFING, e ela e sobre uma coisa so: a logo NAO
 * pode viver num retangulo preto proprio, diferente do fundo ao redor, com o
 * cabecalho separado do hero por uma faixa pesada.
 *
 * Como isso e cumprido AQUI: este cabecalho nao pinta fundo nenhum no topo da
 * pagina. Ele nasce TRANSPARENTE sobre o hero (a classe `cabecalho--sobreposto`
 * em globals.css) e so ganha o vidro escurecido depois que a pessoa rola —
 * quando ja nao ha hero atras dele para ser cortado. A marca fica sobre o mesmo
 * gradiente do hero, sem costura visivel.
 *
 * E POR QUE NAO E SO CSS: para o cabecalho saber se esta "no topo" ele precisa
 * ouvir a rolagem, e por isso `rolou` existe aqui e nao numa media query. Nas
 * rotas que nao tem hero (painel, balcao, checkout) ele ja comeca opaco — do
 * contrario a marca flutuaria sobre uma tabela.
 * ---------------------------------------------------------------------------
 */

/**
 * O MENU INLINE do desktop — os quatro destinos do sketch de §3.
 *
 * §3 desenha quatro itens na barra e um hamburger ao lado; §25 lista sete.
 * NAO SAO DOIS REQUISITOS BRIGANDO: a barra carrega os primarios e o hamburger
 * carrega o menu completo, que e para o que ele existe no sketch de §3 (ele
 * aparece la JUNTO do menu inline, e nao so no mobile). Sete rotulos em caixa
 * alta na barra do desktop empurrariam os botoes COMPRAR e ACESSAR para fora
 * do alcance visual — que sao o objetivo comercial da pagina.
 *
 * AS ANCORAS SAO ABSOLUTAS (`/#o-kit`, nunca `#o-kit`). Este cabecalho aparece
 * no checkout, no painel e na tela de balcao, e uma ancora relativa la dentro
 * rolaria a propria tela em vez de voltar para a loja — quando encontrasse o
 * alvo, o que nao acontece.
 */
const MENU_PRIMARIO = [
  { rotulo: 'Início', href: '/' },
  { rotulo: 'A Milagran', href: '/#a-milagran' },
  { rotulo: 'O Kit', href: '/#o-kit' },
  { rotulo: 'Lançamento', href: '/#lancamento' },
] as const

/** O menu completo de §25, servido pelo hamburger em qualquer largura. */
const MENU_COMPLETO = [
  { rotulo: 'Início', href: '/' },
  { rotulo: 'A Milagran', href: '/#a-milagran' },
  { rotulo: 'O Kit', href: '/#o-kit' },
  { rotulo: 'Como funciona', href: '/#como-funciona' },
  { rotulo: 'Lançamento', href: '/#lancamento' },
  { rotulo: 'Representantes', href: '/seja-representante.html' },
  { rotulo: 'Contato', href: '/#contato' },
] as const

/**
 * A compra mora numa ancora da home, e nao em /comprar.
 *
 * O checkout inteiro esta embutido na secao final da home desde 19/08/2026 —
 * quem clica em COMPRAR cai no formulario de compra, nao numa tela nova onde a
 * decisao recomeca. /comprar continua existindo e continua sendo o alvo dos
 * links de representante (/r/<slug>) e das campanhas com URL propria.
 */
const HREF_COMPRAR = '/#comprar'

/** §24: a area de acesso que JA EXISTE. Nao ha autenticacao nova. */
const HREF_ACESSAR = '/entrar'

/**
 * Telas de OPERACAO: painel e balcao do evento. Elas tem chrome proprio
 * (AbasAdmin) e publico proprio — quem esta ali esta trabalhando, nao
 * comprando. O menu da loja no topo do painel seria ruido, e um "COMPRAR"
 * dourado piscando por cima de uma tabela de pedidos, pior.
 *
 * A MARCA CONTINUA, e continua clicavel: e a saida do operador de volta para a
 * loja.
 */
function ehTelaDeOperacao(pathname: string | null): boolean {
  if (!pathname) return false
  return pathname.startsWith('/admin') || pathname.startsWith('/venda')
}

/**
 * A rota tem hero de tela cheia atras do cabecalho?
 *
 * So a home tem. E dela que vem a exigencia de §2 — em qualquer outra tela o
 * cabecalho opaco desde o primeiro pixel e o comportamento certo, porque atras
 * dele ha conteudo que nao pode ser lido por baixo de um vidro.
 */
function temHeroAtras(pathname: string | null): boolean {
  return pathname === '/'
}

export function Cabecalho() {
  const pathname = usePathname()
  const [aberto, setAberto] = useState(false)
  const [rolou, setRolou] = useState(false)
  const idDoMenu = useId()

  const operacao = ehTelaDeOperacao(pathname)
  const sobreposto = temHeroAtras(pathname) && !rolou && !aberto

  const fechar = useCallback(() => setAberto(false), [])

  /**
   * A rolagem decide a opacidade do cabecalho (ver o bloco de §2 no topo).
   *
   * `passive: true` porque este ouvinte NUNCA chama preventDefault: sem a
   * dica, o navegador precisa esperar o handler terminar antes de pintar o
   * proximo quadro da rolagem, e o resultado e a rolagem travada no celular —
   * exatamente o oposto do que §33 pede.
   *
   * O estado so muda quando CRUZA o limiar, e nao a cada pixel: `setRolou`
   * recebe o mesmo booleano na maioria dos eventos e o React descarta o
   * re-render, mas a comparacao aqui evita ate esse trabalho.
   */
  useEffect(() => {
    if (!temHeroAtras(pathname)) {
      setRolou(true)
      return
    }
    const aoRolar = () => setRolou(window.scrollY > 24)
    aoRolar()
    window.addEventListener('scroll', aoRolar, { passive: true })
    return () => window.removeEventListener('scroll', aoRolar)
  }, [pathname])

  /**
   * Trocar de rota fecha o menu.
   *
   * Sem isto, clicar em "O Kit" dentro do painel navega para a home com a
   * gaveta ainda aberta por cima do conteudo. Ancora na MESMA pagina nao muda
   * `pathname` — por isso cada link tambem chama `fechar` no clique; os dois
   * cobrem casos diferentes e nenhum dos dois sozinho basta.
   */
  useEffect(() => { setAberto(false) }, [pathname])

  /**
   * Escape fecha, e a rolagem do fundo trava enquanto a gaveta esta aberta.
   *
   * A TRAVA E O DETALHE QUE SE NOTA NO CELULAR: sem ela, arrastar sobre a
   * gaveta rola a pagina atras, e ao fechar o menu a pessoa esta num lugar do
   * documento onde nunca escolheu estar.
   */
  useEffect(() => {
    if (!aberto) return

    const aoTeclar = (e: KeyboardEvent) => { if (e.key === 'Escape') setAberto(false) }
    document.addEventListener('keydown', aoTeclar)

    const overflowAnterior = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', aoTeclar)
      document.body.style.overflow = overflowAnterior
    }
  }, [aberto])

  return (
    <header
      className={
        'cabecalho'
        + (sobreposto ? ' cabecalho--sobreposto' : '')
        + (operacao ? ' cabecalho--operacao' : '')
      }
      data-testid="cabecalho"
    >
      {/*
        Primeiro elemento focavel do documento: quem navega por teclado ou
        leitor de tela pula o chrome e cai no conteudo. Fica invisivel ate
        receber foco (.pular-conteudo em globals.css).
      */}
      <a className="pular-conteudo" href="#conteudo">
        Pular para o conteúdo
      </a>

      {/*
        A MARCA E A LOGO, E SO A LOGO — o texto ao lado saiu em 20/08/2026.
        Duas razoes, e a segunda e a que decide:

        1. A logo NOVA ja e o wordmark: o selo circular tem "MILAGRAN" escrito
           dentro. Repetir a palavra em tipografia ao lado dele nao e reforco,
           e a mesma palavra duas vezes a dois centimetros.
        2. O par ao lado era "Milagran" + "Derme", e "Derme" saiu da
           identidade. Sobrava um lockup com metade do conteudo.

        O TAMANHO NAO E ESTETICA, E LEGIBILIDADE. Medido renderizando a arte:
        abaixo de ~80px o "MILAGRAN" dentro do circulo vira borrao. No celular
        ela fica em 72px — ali o selo dourado funciona como marca reconhecivel
        mesmo sem a palavra ser lida, e um cabecalho de 110px comeria a
        primeira dobra. Do tablet para cima ela vai a 88px, onde a palavra le.
        Ver globals.css, `.cabecalho__logo`.

        `alt` PREENCHIDO agora, e isso e obrigatorio: antes o nome acessivel do
        link vinha do texto ao lado (por isso `alt=""` — com os dois, o leitor
        de tela anunciaria "Milagran Milagran"). Sem o texto, a imagem e o
        unico conteudo do link; com `alt=""` ele viraria um link sem nome
        nenhum, que o leitor de tela anuncia como a URL crua.

        <img> cru, nao next/image, e a decisao vale para todo o projeto: a
        otimizacao de imagem do Next exige `sharp` em producao, que nao e
        dependencia deste repositorio e nao entra na imagem standalone
        (Dockerfile). O arquivo servido tem 256px de lado — o dobro do maior uso
        (88px), para nao borrar em tela de alta densidade.
      */}
      <a className="cabecalho__marca" href="/" onClick={fechar}>
        <img
          className="cabecalho__logo"
          src="/assets/logo-milagran-256.png"
          alt="Milagran"
          width={88}
          height={88}
        />
      </a>

      {/*
        O painel e o balcao param aqui: marca e nada mais. Ver
        `ehTelaDeOperacao`.
      */}
      {!operacao && (
        <>
          <nav className="cabecalho__menu" aria-label="Navegação principal">
            <ul>
              {MENU_PRIMARIO.map((item) => (
                <li key={item.href}>
                  <a className="cabecalho__link" href={item.href}>{item.rotulo}</a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="cabecalho__acoes">
            {/*
              A ORDEM DOS DOIS BOTOES E COMERCIAL, nao alfabetica. COMPRAR e
              solido e vem por ultimo — a posicao mais proxima do polegar no
              celular e o ultimo alvo que o olho encontra varrendo a barra da
              esquerda para a direita. ACESSAR e fantasma: e servico, nao
              conversao (§39 manda a prioridade visual ser a compra).
            */}
            <a className="cabecalho__link cabecalho__link--acessar" href={HREF_ACESSAR}>
              Acessar
            </a>
            <a className="btn btn--solid cabecalho__comprar" href={HREF_COMPRAR}>
              Comprar
            </a>

            <button
              type="button"
              className="cabecalho__sanfona"
              aria-expanded={aberto}
              aria-controls={idDoMenu}
              aria-label={aberto ? 'Fechar o menu' : 'Abrir o menu'}
              onClick={() => setAberto((a) => !a)}
            >
              {/*
                Tres barras desenhadas em CSS, e nao um emoji ou um ícone de
                fonte: emoji muda de forma em cada sistema e fonte de icone e
                mais um arquivo para baixar antes do primeiro pixel (§33).
                aria-hidden porque o nome acessivel do botao ja esta no
                aria-label acima.
              */}
              <span className="cabecalho__sanfona-barras" aria-hidden="true" />
            </button>
          </div>

          {/*
            A GAVETA (§4).

            Ela existe no DOM nos dois estados e e escondida por CSS, em vez de
            ser montada e desmontada: assim a animacao de abrir tem de onde
            partir, e o conteudo ja esta no HTML servido — quem chega com JS
            lento ou bloqueado ainda tem os sete links, alcancaveis por teclado.

            `inert` desliga foco e leitor de tela quando fechada. Sem ele, o
            Tab passeia por sete links invisiveis antes de chegar ao conteudo.
          */}
          <div
            className={'gaveta' + (aberto ? ' gaveta--aberta' : '')}
            id={idDoMenu}
            inert={!aberto}
            data-testid="gaveta"
          >
            <nav aria-label="Menu completo">
              <ul className="gaveta__lista">
                {MENU_COMPLETO.map((item) => (
                  <li key={item.href}>
                    <a href={item.href} onClick={fechar}>{item.rotulo}</a>
                  </li>
                ))}
              </ul>
            </nav>

            {/*
              §4 pede COMPRAR e ACESSAR DENTRO da gaveta, e pede destaque
              visual para COMPRAR. Eles nao sao repeticao do menu acima: no
              celular a barra so mostra marca e hamburger, entao esta e a
              UNICA aparicao dos dois.
            */}
            <div className="gaveta__acoes">
              <a className="btn btn--solid" href={HREF_COMPRAR} onClick={fechar}>
                Comprar meu kit
              </a>
              <a className="btn btn--ghost" href={HREF_ACESSAR} onClick={fechar}>
                Acessar
              </a>
            </div>
          </div>

          {/*
            O veu que fecha a gaveta ao clique fora. `aria-hidden` e sem foco:
            quem usa teclado fecha com Escape, e quem usa leitor de tela nao
            deve encontrar um botao sem nome no caminho.
          */}
          {aberto && (
            <div className="gaveta__veu" aria-hidden="true" onClick={fechar} />
          )}
        </>
      )}
    </header>
  )
}
