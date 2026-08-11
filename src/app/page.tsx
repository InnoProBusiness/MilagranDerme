import { redirect } from 'next/navigation'

/**
 * A raiz ainda nao e a loja. Ate o Plano 2 entregar a vitrine, "/" tem que
 * servir alguma coisa real: a landing page de recrutamento de
 * representantes, que e o que o dominio publica hoje. Ela vive em
 * public/seja-representante.html (HTML estatico, sem build) e continuara
 * acessivel por essa URL depois que a loja assumir a raiz.
 *
 * Ver DEPLOY.md para o mapa completo de o que serve o que apos o merge.
 */
export default function Home() {
  redirect('/seja-representante.html')
}
