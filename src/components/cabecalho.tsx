/**
 * Cabecalho compartilhado por TODAS as rotas do App Router (renderizado uma
 * unica vez em src/app/layout.tsx).
 *
 * POR QUE NAO VIVE DENTRO DE layout.tsx: um arquivo de layout do Next so pode
 * exportar `default`, `metadata`, `viewport` e a configuracao de segmento —
 * exportar `Cabecalho` de la para poder testa-lo colocaria um export estranho
 * no arquivo que o build valida. Componente proprio resolve os dois lados: o
 * layout importa, e o teste renderiza sem precisar montar <html>/<body>.
 *
 * SERVER COMPONENT de proposito. Nao ha estado, nao ha evento e nao ha menu
 * sanfona: a navegacao da loja e curta o bastante para caber em dois alvos.
 * O menu overlay com JS que existe na landing page de recrutamento
 * (public/seja-representante.html + public/script.js) e daquela pagina, nao
 * daqui — replica-lo custaria um 'use client' no chrome de todas as telas,
 * incluindo o painel administrativo.
 */
export function Cabecalho() {
  return (
    <header className="cabecalho">
      {/*
        Primeiro elemento focavel do documento: quem navega por teclado ou
        leitor de tela pula o chrome e cai no conteudo. Fica invisivel ate
        receber foco (.pular-conteudo em globals.css).
      */}
      <a className="pular-conteudo" href="#conteudo">
        Pular para o conteúdo
      </a>

      {/*
        <img> cru, nao next/image, e a decisao vale para todo o projeto: a
        otimizacao de imagem do Next exige `sharp` em producao, que nao e
        dependencia deste repositorio e nao entra na imagem standalone
        (Dockerfile). O logo e um PNG de 31KB servido direto de public/ —
        `width`/`height` explicitos reservam o espaco e evitam o salto de
        layout que o next/image resolveria.
        alt="" porque o nome da marca ja e o texto visivel do proprio link:
        com alt preenchido, o leitor de tela anunciaria "Milagran Derme
        Milagran Derme".
      */}
      <a className="cabecalho__marca" href="/">
        <img
          className="cabecalho__logo"
          src="/assets/logo-160.png"
          alt=""
          width={44}
          height={44}
        />
        {/*
          O {' '} entre os dois spans e semantico, nao formatacao: sem ele o
          nome acessivel do link vira "MilagranDerme" numa palavra so (o
          calculo do nome concatena os nos de texto sem separador). Visualmente
          nao muda nada — os dois spans sao display:block e o espaco entre
          blocos e descartado.
        */}
        <span>
          <span className="cabecalho__nome">Milagran</span>{' '}
          <span className="cabecalho__sub">Derme</span>
        </span>
      </a>

      {/*
        /entrar e /venda e /admin NAO aparecem aqui de proposito: sao telas de
        operacao, com sessao propria, e anuncia-las no cabecalho da loja so
        convidaria visitante a bater numa porta que vai devolver 401.
      */}
      <nav className="cabecalho__acoes" aria-label="Navegação principal">
        <a className="btn btn--ghost" href="/comprar">
          Comprar o kit
        </a>
      </nav>
    </header>
  )
}
