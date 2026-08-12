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

  /**
   * "/" serve a landing page de recrutamento sem redirecionar e sem trocar a
   * URL na barra do navegador. Rewrite, nao redirect: o visitante ve
   * `milagranoficial.com.br`, nao `milagranoficial.com.br/seja-representante.html`.
   *
   * Antes disso havia um `src/app/page.tsx` que fazia `redirect()` — o que
   * funcionava, mas empurrava a URL feia para a barra de endereco, para o
   * link copiado e para o compartilhamento no WhatsApp.
   *
   * Por que rewrite e nao mover o HTML para dentro do App Router: a LP e um
   * arquivo estatico de 22KB escrito a mao, sem build. Converte-la em
   * componente React so para servir "/" trocaria uma linha de configuracao
   * por uma migracao inteira, e `src/app/globals.css` ja e uma copia de
   * `public/styles.css` que so converge quando a vitrine do Plano 2
   * substituir a LP.
   *
   * `/seja-representante.html` continua respondendo 200 de proposito — pode
   * haver link e campanha em circulacao apontando para la. As duas URLs
   * servem o mesmo conteudo, e o `<link rel="canonical">` da pagina aponta
   * para "/", que e quem os buscadores devem indexar.
   *
   * Quando o Plano 2 entregar a vitrine e "/" virar a loja, este rewrite sai
   * e a LP volta a viver so em `/seja-representante.html`. E uma linha.
   */
  async rewrites() {
    return [
      { source: '/', destination: '/seja-representante.html' },
    ]
  },
}

export default config
