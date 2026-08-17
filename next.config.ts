import type { NextConfig } from 'next'

/**
 * `output: 'standalone'` faz o Next emitir .next/standalone/server.js com
 * apenas as dependencias que o servidor realmente importa. E o que o
 * Dockerfile copia para o estagio de runtime.
 *
 * Nao e cosmetico nesta infraestrutura: sem standalone a imagem precisaria
 * carregar node_modules inteiro (~1.1GB, o tamanho da imagem do InnoFin na
 * mesma VPS); com ele fica em ~330MB. A maquina tem 19GB de disco no total,
 * compartilhados com outras seis stacks e o Postgres de quatro projetos.
 *
 * Contrapartida que o Dockerfile precisa cobrir: standalone deixa
 * .next/static e public/ de fora de proposito, e os dois sao copiados a mao
 * la. Ver DEPLOY.md.
 */
const config: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',

  /*
   * AQUI HAVIA UM REWRITE de "/" para "/seja-representante.html", e ele saiu
   * em 16/08/2026. Ficou o registro do que aconteceu, porque a ausencia de
   * uma linha nao conta historia nenhuma e o comentario antigo ja previa este
   * dia ("quando a vitrine entregar e '/' virar a loja, este rewrite sai").
   *
   * O QUE ERA: enquanto a landing page de recrutamento era a unica coisa
   * pronta, "/" servia o HTML estatico dela sem redirecionar e sem trocar a
   * URL na barra — o visitante via `milagranoficial.com.br`, nao
   * `milagranoficial.com.br/seja-representante.html`.
   *
   * O QUE MUDOU: o documento do cliente de 16/08/2026 (§14, §18) inverteu a
   * prioridade. A raiz e a LOJA de lancamento (`src/app/page.tsx`), e
   * representante virou um link discreto no rodape. Com um `page.tsx` de
   * verdade em "/", o rewrite deixou de ser inofensivo: rewrite ganha da rota
   * do App Router, e a loja nunca apareceria.
   *
   * O QUE NAO MUDOU: `/seja-representante.html` continua respondendo 200,
   * servido de public/ pelo mesmo container, e isso NAO e opcional. Duas
   * razoes independentes: §14 manda manter o formulario disponivel (ha
   * campanha em circulacao apontando para la), e
   * `deploy/milagran-ci-deploy.sh` aprova ou REVERTE o deploy inteiro com
   * base num curl nessa URL (`verificar_borda`, linhas ~137-153). Mexer nela
   * sem atualizar o script no mesmo commit faz todo deploy seguinte se
   * auto-reverter, com sintoma (aplicacao velha no ar) que nao aponta para a
   * causa.
   *
   * O `<link rel="canonical">` da LP foi repontado no mesmo commit: ele dizia
   * "/", ou seja, declarava o recrutamento como identidade da marca. Agora
   * aponta para a propria URL de recrutamento, e a loja fica com "/".
   *
   * E `src/app/globals.css` deixou de ser copia de `public/styles.css`: o
   * primeiro e o design system da loja, o segundo serve so a LP estatica. A
   * divergencia entre os dois e assumida — o cabecalho de globals.css conta
   * o porque.
   */
}

export default config
