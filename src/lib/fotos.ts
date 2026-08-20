/**
 * O MANIFESTO DAS FOTOS DA LOJA — e o unico lugar a editar quando as imagens
 * oficiais chegarem.
 *
 * POR QUE ISTO EXISTE. O briefing de 20/08/2026 pede a foto do Kit como
 * PROTAGONISTA do hero (§5, §30), as quatro fotos reais dos produtos (§13) e o
 * registro fotografico dos testes (§15), e proibe banco de imagens generico
 * quando houver foto oficial (§13). Nenhuma delas veio junto do briefing: elas
 * chegam depois, uma de cada vez, e a pagina precisa ser publicavel a cada
 * ponto desse caminho.
 *
 * ESTADO EM 20/08/2026:
 *   §5/§30  a foto do hero ......... ENTREGUE
 *   §13     os quatro produtos ..... ENTREGUES
 *   §15     o registro dos testes .. pendente (e depende de autorizacao de
 *                                     uso de imagem — ver FOTOS_DA_EXPERIENCIA)
 *
 * O MECANISMO DE AUSENCIA CONTINUA VALENDO mesmo com quase tudo entregue, e
 * nao vira codigo morto: §15 ainda esta vazio, e uma foto pode ser retirada a
 * qualquer momento (autorizacao revogada, arte substituida). `FotoDaMarca` tem
 * teste proprio para esse caminho.
 *
 * A SAIDA NAO FOI INVENTAR IMAGEM NEM TRAVAR A PAGINA. Cada foto e opcional
 * por construcao: com `src` preenchido a secao mostra a foto; com `src` nulo
 * ela mostra uma moldura ornamental da marca e o texto continua fazendo
 * sentido sozinho. Nenhuma secao depende de imagem para ser publicavel, e
 * nenhuma delas exibe caixa de "imagem quebrada" para a compradora.
 *
 * COMO PREENCHER quando os arquivos chegarem:
 *   1. Coloque os arquivos em `public/assets/kit/`.
 *   2. Troque o `src: null` pelo caminho (`/assets/kit/arquivo.webp`).
 *   3. Ajuste `largura` e `altura` para as dimensoes REAIS do arquivo — elas
 *      reservam o espaco e evitam o salto de layout (§33). Numero errado aqui
 *      nao quebra nada visivelmente, so devolve o salto que elas existem para
 *      impedir.
 *   4. `alt` ja esta escrito. Ele descreve o que a foto mostra para quem nao a
 *      ve; nao repita a marca, que ja esta no texto ao lado.
 *
 * FORMATO. WebP ou AVIF (§33). Este projeto NAO usa `next/image` — a
 * otimizacao do Next exige `sharp`, que nao e dependencia daqui e nao entra na
 * imagem standalone do Dockerfile (a mesma decisao ja registrada em
 * src/components/cabecalho.tsx). As imagens sao servidas de `public/` como
 * estao, entao elas precisam chegar JA COMPRIMIDAS.
 *
 * AS QUATRO DOS PRODUTOS seguiram o mesmo caminho do hero, com o recorte 3:4
 * descrito em FOTOS_DOS_PRODUTOS: 760px de largura, WebP 84. Os originais
 * somavam 6,5 MB e as publicadas somam 127 KB.
 *
 * COMO A DO HERO FOI PREPARADA, para as proximas seguirem o mesmo caminho: o
 * arquivo original tinha 1,9 MB em PNG. Foi reduzido para 1100px de largura —
 * o dobro da coluna em que ele aparece no desktop (~490px), o que cobre tela
 * de densidade 2x — e salvo em WebP com qualidade 84, chegando a 121 KB. As
 * qualidades 78/84/90 foram comparadas: 84 e onde a curva para de valer a pena,
 * e os gradientes escuros da foto (onde WebP costuma criar bandas) foram
 * conferidos ampliados antes de publicar. Os originais ficam em `design/`, para
 * que um recorte novo saia da foto e nao de um JPEG ja comprimido.
 *
 * TAMANHO. A foto do hero e a unica com `preload` (§33): ela e o maior
 * elemento acima da dobra e define o LCP. Mire abaixo de 250 KB nela; as
 * outras carregam com `loading="lazy"` e podem ser um pouco maiores.
 */

export type Foto = {
  /** Caminho publico do arquivo, ou `null` enquanto a foto nao existe. */
  src: string | null
  /** Descricao para quem nao ve a imagem. Ja escrita, nao precisa mudar. */
  alt: string
  /** Dimensoes REAIS do arquivo, em pixels. Reservam o espaco no layout. */
  largura: number
  altura: number
}

/**
 * A foto de abertura: o Kit inteiro, protagonista do hero (§5, §30).
 *
 * Retrato de proposito — no desktop ela divide a dobra com o texto em duas
 * colunas, e um formato deitado deixaria a coluna de texto estreita demais
 * para a manchete de §6 respirar.
 */
export const FOTO_HERO: Foto = {
  src: '/assets/kit/kit-milagran-hero.webp',
  /*
    O `alt` DESCREVE O QUE A FOTO MOSTRA, e nao o que gostariamos que ela
    mostrasse: sao a caixa e TRES frascos. O papel removedor, que e o quarto
    item do kit, nao aparece nesta imagem — prometer os quatro aqui seria a
    unica pessoa que depende do `alt` recebendo uma descricao que nao bate com
    a foto ao lado do texto.
  */
  alt: 'A caixa preta do Kit Milagran, com o nome em dourado, ao lado dos frascos '
    + 'do sabonete líquido, do hidratante e do pote da máscara, sobre uma bandeja espelhada',
  largura: 1100,
  altura: 1375,
}

/**
 * As quatro fotos de §13, na ordem de uso do procedimento.
 *
 * A CHAVE E O QUE LIGA A FOTO AO PRODUTO. Ela e usada em
 * src/app/page.tsx para casar cada foto com o card certo; renomear uma chave
 * aqui sem renomear la deixa o card sem foto — e o TypeScript avisa, porque o
 * tipo e um Record fechado sobre as quatro chaves.
 */
export type ProdutoDoKit = 'sabonete' | 'mascara' | 'papel' | 'hidratante'

/*
  AS QUATRO SAO SERVIDAS EM 3:4, e nao no quadrado que este manifesto pedia
  ate 20/08/2026.

  As fotos oficiais vem em 2:3 (1024x1536), com o produto centrado e fundo
  escuro em volta. Recortar aquilo num quadrado centrado corta a VALVULA do
  sabonete, que fica na parte alta do quadro — o card mostraria um frasco
  decapitado. Em 3:4 o corte come so fundo, nas duas fotos ja entregues.

  `object-fit: cover` continua em .kit-card__foto de proposito, mesmo com os
  arquivos ja publicados na proporcao certa: faltam duas fotos, e se elas
  chegarem em outro enquadramento a grade continua uniforme em vez de ganhar um
  card mais alto que os outros.
*/
export const FOTOS_DOS_PRODUTOS: Record<ProdutoDoKit, Foto> = {
  sabonete: {
    src: '/assets/kit/sabonete.webp',
    alt: 'Frasco âmbar do sabonete líquido facial Milagran, com válvula pump dourada',
    largura: 760,
    altura: 1013,
  },
  mascara: {
    src: '/assets/kit/mascara.webp',
    alt: 'Pote âmbar da máscara extratora Milagran, com tampa preta',
    largura: 760,
    altura: 1013,
  },
  papel: {
    src: '/assets/kit/papel.webp',
    // O UNICO QUE NAO E FRASCO: e a caixa. Descrever "papel removedor" sem
    // dizer que a foto mostra a EMBALAGEM deixaria quem depende do alt
    // esperando as folhas.
    alt: 'Caixa preta do papel removedor Milagran, com 100 unidades',
    largura: 760,
    altura: 1013,
  },
  hidratante: {
    src: '/assets/kit/hidratante.webp',
    alt: 'Frasco âmbar do hidratante facial Milagran, com válvula pump dourada',
    largura: 760,
    altura: 1013,
  },
}

/**
 * O registro dos testes de §15 — a secao "experiencia real".
 *
 * LISTA VAZIA E UM ESTADO VALIDO E ESPERADO: enquanto ela estiver assim, a
 * secao mostra so o texto, sem galeria e sem moldura vazia. Nao ha promessa
 * quebrada nisso — o texto de §15 fala da experiencia, nao das fotos.
 *
 * NAO PUBLIQUE ROSTO SEM AUTORIZACAO. As fotos de §15 mostram profissionais e
 * modelos reais; cada uma precisa de consentimento de uso de imagem antes de
 * entrar aqui. Isto nao e formalidade: e a mesma LGPD que
 * /privacidade.html promete cumprir, e a foto vai para uma pagina publica e
 * indexavel.
 */
export const FOTOS_DA_EXPERIENCIA: Foto[] = []

/**
 * Alguma foto oficial ja chegou?
 *
 * Serve as secoes que mudam de forma conforme haja galeria ou nao — e
 * tambem responde, em uma linha, a pergunta "as fotos ja entraram?" para quem
 * abrir este modulo daqui a um mes.
 */
export function temFoto(f: Foto): boolean {
  return typeof f.src === 'string' && f.src.length > 0
}
