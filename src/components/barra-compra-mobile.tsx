'use client'

import { useEffect, useState } from 'react'

/**
 * A BARRA DE COMPRA FIXA DO CELULAR (§32).
 *
 * O botao de comprar nunca sai do alcance do polegar enquanto a visitante le
 * as onze secoes da pagina. So existe no mobile — no desktop o cabecalho
 * sticky ja carrega o botao COMPRAR permanentemente visivel, e uma segunda
 * barra fixa embaixo seria a mesma acao ocupando tela duas vezes.
 *
 * ELA SOME QUANDO O CHECKOUT APARECE, e essa e a unica razao de este
 * componente ter JavaScript. Sem isso a barra flutua POR CIMA do proprio
 * formulario de compra: a compradora chega no lugar onde ia agir e encontra um
 * botao "COMPRAR AGORA" cobrindo o campo de CEP, apontando para a secao em que
 * ela ja esta. O IntersectionObserver observa a secao do checkout e recolhe a
 * barra assim que ela entra em cena.
 *
 * SEM O OBSERVER (navegador antigo, JS ainda nao hidratado) a barra
 * simplesmente fica visivel — o padrao e o estado util, nao o quebrado.
 *
 * A ALTURA DELA E DEVOLVIDA AO DOCUMENTO por `padding-bottom` no body
 * (globals.css, dentro da media query do mobile). Sem isso a barra cobre para
 * sempre as ultimas linhas do rodape, incluindo o link da politica de
 * privacidade — que e compromisso de LGPD e nao pode ficar debaixo de um
 * botao.
 */
export function BarraCompraMobile({
  /** Ancora do checkout embutido na home. */
  href = '#comprar',
  /** O id da secao que, ao aparecer, recolhe a barra. */
  alvo = 'comprar',
  rotulo = 'Comprar agora',
}: {
  href?: string
  alvo?: string
  rotulo?: string
}) {
  const [escondida, setEscondida] = useState(false)

  useEffect(() => {
    const secao = document.getElementById(alvo)
    if (!secao || typeof IntersectionObserver === 'undefined') return

    const observador = new IntersectionObserver(
      ([entrada]) => setEscondida(entrada.isIntersecting),
      /*
        `rootMargin` negativo embaixo: a barra recolhe quando o checkout entra
        de verdade na tela, e nao no instante em que a primeira linha dele
        encosta na borda inferior — do contrario ela pisca durante a rolagem.
      */
      { rootMargin: '0px 0px -25% 0px' },
    )
    observador.observe(secao)
    return () => observador.disconnect()
  }, [alvo])

  return (
    <div
      className={'barra-compra' + (escondida ? ' barra-compra--escondida' : '')}
      data-testid="barra-compra-mobile"
      /*
        `aria-hidden` quando recolhida: ela continua no DOM (a transicao CSS
        precisa de um estado para o qual voltar), e um link invisivel no
        caminho do Tab e exatamente o tipo de armadilha que leitor de tela
        expoe e olho nenhum ve.
      */
      aria-hidden={escondida}
      inert={escondida}
    >
      <span className="barra-compra__produto">Kit Milagran</span>
      <a className="btn btn--solid barra-compra__botao" href={href}>
        {rotulo}
      </a>
    </div>
  )
}
