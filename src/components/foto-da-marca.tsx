import { temFoto, type Foto } from '@/lib/fotos'

/**
 * UMA FOTO OFICIAL — ou, enquanto ela nao existir, uma moldura ornamental da
 * marca no lugar exato onde ela vai entrar.
 *
 * O PROBLEMA QUE ESTE COMPONENTE RESOLVE. O briefing de 20/08/2026 constroi
 * tres secoes em cima de fotos que ainda nao foram entregues (§5, §13, §15).
 * Havia tres saidas ruins e uma boa:
 *
 *   - Banco de imagens generico: proibido por §13, e pior que nada — uma foto
 *     de outra marca no lugar do produto ensina a visitante a desconfiar.
 *   - `<img>` apontando para arquivo inexistente: publica o icone de imagem
 *     quebrada na home do lancamento.
 *   - Travar a pagina ate as fotos chegarem: cinco dias antes do evento.
 *   - ESTA: a secao e publicavel nos dois estados. Sem foto, o espaco vira um
 *     ornamento intencional da identidade (moldura fina dourada + monograma);
 *     com foto, o mesmo espaco recebe a imagem. Nenhuma das duas versoes
 *     parece defeito.
 *
 * NAO E `next/image`, e isso vale para todo o projeto: a otimizacao do Next
 * exige `sharp`, que nao e dependencia deste repositorio e nao entra na imagem
 * standalone (Dockerfile). Mesma decisao ja registrada em
 * src/components/cabecalho.tsx. As dimensoes explicitas fazem o trabalho que
 * importa — reservar o espaco e matar o salto de layout (§33).
 *
 * SERVER COMPONENT: nao ha estado nem evento.
 */
export function FotoDaMarca({
  foto,
  className,
  /**
   * `true` SO na foto do hero (§30) — ela e o maior elemento acima da dobra e
   * define o LCP.
   *
   * `loading="lazy"` numa imagem acima da dobra ATRASA o LCP em vez de
   * ajudar: o navegador so decide baixa-la depois do layout. Por isso as duas
   * propriedades andam juntas aqui e nao sao configuraveis em separado — §33
   * pede "preload apenas da imagem principal", e uma flag solta convidaria a
   * marcar todas.
   */
  prioridade = false,
}: {
  foto: Foto
  className?: string
  prioridade?: boolean
}) {
  const classe = className ? `foto ${className}` : 'foto'

  if (!temFoto(foto)) {
    return (
      <div
        className={`${classe} foto--ausente`}
        /*
          `aria-hidden` e a parte que importa para acessibilidade: sem a foto,
          isto e ornamento puro e nao ha informacao nenhuma a anunciar. Uma
          moldura decorativa descrita em voz alta so atrapalha quem depende do
          leitor de tela.

          O `style` inline carrega a PROPORCAO da foto que vai chegar, para
          que trocar `src: null` por um caminho nao mude o layout da secao —
          o espaco ja esta reservado com a forma certa.
        */
        aria-hidden="true"
        style={{ aspectRatio: `${foto.largura} / ${foto.altura}` }}
        data-testid="foto-ausente"
      >
        <span className="foto__monograma">M</span>
      </div>
    )
  }

  return (
    <img
      className={classe}
      src={foto.src as string}
      alt={foto.alt}
      width={foto.largura}
      height={foto.altura}
      loading={prioridade ? 'eager' : 'lazy'}
      fetchPriority={prioridade ? 'high' : 'auto'}
      decoding="async"
    />
  )
}
