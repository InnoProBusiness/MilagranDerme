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
}

export default config
