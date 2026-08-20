import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FotoDaMarca } from '@/components/foto-da-marca'
import type { Foto } from '@/lib/fotos'

/**
 * O QUE ACONTECE NO LUGAR DE UMA FOTO QUE AINDA NAO EXISTE.
 *
 * Este arquivo nasceu em 20/08/2026, no dia em que as fotos oficiais chegaram
 * — e nao antes. Enquanto a loja estava sem imagem nenhuma, a home inteira
 * exercitava este caminho e um teste na pagina bastava. Com o hero e os quatro
 * produtos entregues, aquele teste ficou sem caso para medir, e a garantia
 * teria evaporado junto: ninguem repara que uma rede de seguranca sumiu
 * enquanto nada cai nela.
 *
 * ELA CONTINUA VALENDO PARA PELO MENOS TRES SITUACOES REAIS:
 *   - §15, o registro fotografico dos testes, segue vazio e depende de
 *     autorizacao de uso de imagem de cada pessoa retratada;
 *   - uma foto pode ser RETIRADA (autorizacao revogada, arte substituida), e a
 *     pagina precisa continuar publicavel no minuto seguinte;
 *   - um produto novo entra no catalogo antes de o fotografo entregar.
 *
 * A REGRA QUE ESTE ARQUIVO PROTEGE, em uma frase: a pagina de lancamento nunca
 * mostra o icone de imagem quebrada, e nunca preenche o buraco com banco de
 * imagens generico (o briefing proibe em §13).
 */

const COM_FOTO: Foto = {
  src: '/assets/kit/sabonete.webp',
  alt: 'Frasco âmbar do sabonete',
  largura: 760,
  altura: 1013,
}

const SEM_FOTO: Foto = {
  src: null,
  alt: 'Frasco âmbar do sabonete',
  largura: 760,
  altura: 1013,
}

describe('FotoDaMarca', () => {
  it('com arquivo, serve a imagem com as dimensoes declaradas', () => {
    render(<FotoDaMarca foto={COM_FOTO} />)

    const img = screen.getByRole('img', { name: 'Frasco âmbar do sabonete' })
    expect(img).toHaveAttribute('src', '/assets/kit/sabonete.webp')
    // width/height explicitos reservam o espaco e matam o salto de layout
    // (§33) — este projeto nao usa next/image, entao nao ha quem os coloque.
    expect(img).toHaveAttribute('width', '760')
    expect(img).toHaveAttribute('height', '1013')
  })

  /**
   * O CASO QUE JUSTIFICA O COMPONENTE EXISTIR.
   *
   * Sem `src`, o que NAO pode acontecer e um <img> apontando para o vazio: o
   * navegador desenha o icone de imagem quebrada, e a home do lancamento passa
   * a parecer defeituosa exatamente onde deveria estar o produto.
   */
  it('sem arquivo, nao emite <img> nenhuma', () => {
    const { container } = render(<FotoDaMarca foto={SEM_FOTO} />)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('foto-ausente')).toBeInTheDocument()
  })

  /**
   * A moldura e ORNAMENTO, nao informacao. Anunciada em voz alta, ela
   * descreveria para quem usa leitor de tela uma imagem que nao existe — pior
   * do que o silencio, porque sugere que ha algo ali a perder.
   */
  it('a moldura de espera e invisivel para o leitor de tela', () => {
    render(<FotoDaMarca foto={SEM_FOTO} />)
    expect(screen.getByTestId('foto-ausente')).toHaveAttribute('aria-hidden', 'true')
  })

  /**
   * A PROPORCAO E O QUE FAZ A TROCA SER INVISIVEL. A moldura ocupa a mesma
   * forma que a foto vai ocupar, entao preencher o `src` depois nao remexe o
   * layout da secao — e a grade de quatro cards nao fica desalinhada enquanto
   * so metade das fotos chegou, que foi o estado real da loja entre uma
   * entrega e outra.
   */
  it('a moldura reserva a proporcao da foto que vai chegar', () => {
    render(<FotoDaMarca foto={SEM_FOTO} />)
    expect(screen.getByTestId('foto-ausente')).toHaveStyle({ aspectRatio: '760 / 1013' })
  })

  /**
   * §33 pede preload SO da imagem principal. `loading="lazy"` numa imagem
   * acima da dobra ATRASA o LCP em vez de ajudar — o navegador so decide
   * baixa-la depois do layout —, e `eager` em todas devolve o problema que a
   * carga preguicosa existe para resolver.
   */
  it('so a foto marcada como prioritaria carrega adiantada', () => {
    const { rerender } = render(<FotoDaMarca foto={COM_FOTO} />)
    expect(screen.getByRole('img')).toHaveAttribute('loading', 'lazy')

    rerender(<FotoDaMarca foto={COM_FOTO} prioridade />)
    expect(screen.getByRole('img')).toHaveAttribute('loading', 'eager')
    expect(screen.getByRole('img')).toHaveAttribute('fetchpriority', 'high')
  })
})
