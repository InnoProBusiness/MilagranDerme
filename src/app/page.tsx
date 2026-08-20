import type { Metadata } from 'next'
import { ContadorEstoque } from '@/components/contador-estoque'
import { BarraCompraMobile } from '@/components/barra-compra-mobile'
import { FotoDaMarca } from '@/components/foto-da-marca'
import { avisoDeEscassez } from '@/lib/escassez'
import { AVISO_PRE_VENDA, lancamentoJaOcorreu } from '@/lib/tempo'
import { textoAnvisa, situacaoPendente } from '@/lib/anvisa'
import { FOTO_HERO, FOTOS_DOS_PRODUTOS, FOTOS_DA_EXPERIENCIA } from '@/lib/fotos'
import { saldoDoEstoque } from '@/repositories/estoque'
import { listarKitsAtivos } from '@/repositories/produtos'
import { cupomDaUrl, linkDeCheckout } from '@/lib/cupom-da-url'
import { ENDERECO_RETIRADA, PRAZO_RETIRADA_DIAS } from '@/lib/retirada'

/**
 * A LOJA DE LANCAMENTO — "/".
 *
 * REESCRITA EM 20/08/2026 sobre o briefing de alteracao da landing page. A
 * versao anterior seguia §18 do documento de 16/08 (o que e -> kit -> preco ->
 * pagar -> receber -> comprar); esta segue §36 do briefing novo, que e uma
 * ordem DIFERENTE e com um objetivo diferente.
 *
 * O QUE MUDOU DE INTENCAO, e nao so de aparencia:
 *
 *   A pagina antiga respondia perguntas na ordem em que elas aparecem para
 *   quem ja decidiu olhar o produto. A nova constroi desejo antes de
 *   responder: identidade -> historia -> pertencimento -> produto ->
 *   procedimento -> prova -> data -> escassez -> compra (§38). Sao dois
 *   funis, nao duas paletas.
 *
 * A DECISAO MAIS CARA E A DO PRECO (§8). O valor NAO aparece nesta pagina em
 * lugar nenhum — nem no hero, nem em secao propria. Ate 20/08/2026 ele
 * aparecia duas vezes, e havia uma secao inteira "Quanto custa". A regra nova
 * e: curiosidade -> desejo -> percepcao de valor -> decisao -> checkout, e o
 * numero entra quando a compradora ja esta avancando. Por decisao do cliente
 * (20/08), ele reaparece na VITRINE (/comprar) e no checkout — nao so no
 * checkout. Quem procurar o preco o encontra a um clique; quem esta
 * conhecendo a marca nao tromba com ele.
 *
 * ISSO SO PASSOU A SER LITERAL quando o checkout mudou de tela, no mesmo dia:
 * enquanto o formulario estava embutido aqui, o preco aparecia dentro dele e
 * §8 valia com uma excecao. Hoje nao ha excecao — nenhum caminho desta pagina
 * imprime um valor em reais.
 *
 * O QUE NAO PODE SAIR DAQUI, por mais que o redesenho ande:
 *
 *   - O AVISO DA ANVISA (secao 06). E divulgacao regulatoria, nao decoracao:
 *     a frase vem de src/lib/anvisa.ts e declara o enquadramento na Lei
 *     15.154/2025. Some daqui e a loja passa a vender cosmetico sem dizer sob
 *     que regime.
 *   - O AVISO DE PRE-VENDA (§21). Enquanto 25/08 nao chega, quem compra
 *     precisa saber que o pedido sai depois. A frase e a constante
 *     AVISO_PRE_VENDA, compartilhada com o checkout.
 *
 * O CHECKOUT SAIU DAQUI EM 20/08/2026. Ate entao o formulario inteiro vivia na
 * secao 11 desta pagina; hoje ele tem tela propria em /checkout, e a secao 11
 * fecha o argumento e entrega. O porque esta escrito na propria secao — e a
 * consequencia mais importante e a de cima: sem o formulario, o preco
 * finalmente nao aparece em lugar nenhum desta pagina.
 *
 * SERVER COMPONENT. Os unicos pedacos com 'use client' sao o contador de
 * estoque e a barra de compra do celular.
 *
 * SEM A CLASSE `.reveal` EM LUGAR NENHUM, e isso e armadilha real: `.reveal`
 * comeca com `opacity:0` em globals.css e so aparece quando `public/script.js`
 * acrescenta `is-visible` via IntersectionObserver — e aquele script pertence
 * a LP estatica, nao ao App Router. Usar a classe aqui deixaria a loja inteira
 * invisivel, com o HTML impecavel no DevTools.
 */

// `force-dynamic` porque a pagina le ESTOQUE AO VIVO. Sem isso o Next serviria
// o saldo congelado no `next build` — um lote de 50 kits eternamente intacto
// na home enquanto o balcao vende.
export const dynamic = 'force-dynamic'

/**
 * Canonical POR PAGINA, nunca no layout raiz (src/app/layout.tsx explica por
 * que). Esta e a unica rota que pode reivindicar "/".
 */
export const metadata: Metadata = {
  alternates: { canonical: '/' },
}

/**
 * A MANCHETE TEM DUAS VERSOES, E A ESCOLHA E DE TEMPO VERBAL — nao de teste
 * A/B.
 *
 * §6 escreve "A NOVA EXPERIENCIA EM LIMPEZA DE PELE CHEGOU." e §7 oferece
 * "UMA NOVA FORMA DE CUIDAR DA PELE ESTA CHEGANDO." como alternativa. As duas
 * sao copy aprovada, e a segunda esta no FUTURO.
 *
 * Publicar "CHEGOU" antes de 25/08 seria a loja afirmando um fato que ainda
 * nao aconteceu, na mesma pagina que logo abaixo avisa que os pedidos so serao
 * liberados no dia do lancamento (§21). Entao a alternativa de §7 vira a
 * versao ATE 25/08 e a de §6 assume no dia — a pagina fala no futuro enquanto
 * o lancamento e futuro, e no passado quando ele passa. E a mesma disciplina
 * que `lancamentoJaOcorreu` ja impunha ao resto da tela.
 *
 * PARA RODAR O A/B DE §7 DE VERDADE: as duas variantes precisam ser sorteadas
 * no MESMO tempo verbal, e o sorteio nao pode acontecer aqui dentro — esta e
 * uma pagina de servidor sem cookie de variante, e sortear a cada render
 * mostraria manchetes diferentes a cada F5 para a mesma pessoa, o que nao
 * mede nada.
 */
const MANCHETE_LANCADA = {
  destaque: 'A NOVA EXPERIÊNCIA',
  resto: 'EM LIMPEZA DE PELE CHEGOU.',
}
const MANCHETE_PRE_VENDA = {
  destaque: 'UMA NOVA FORMA',
  resto: 'DE CUIDAR DA PELE ESTÁ CHEGANDO.',
}

/** §6, palavra por palavra. */
const SUBTITULO_LANCADA =
  'Conheça a Milagran, uma nova proposta de cuidado com a pele criada para '
  + 'transformar a experiência da limpeza de pele e abrir novas possibilidades '
  + 'para profissionais da beleza.'

/** §7, palavra por palavra. */
const SUBTITULO_PRE_VENDA =
  '15 anos de história deram origem a uma experiência que agora chega '
  + 'oficialmente ao mercado.'

/**
 * §17 e §19: a CTA da escassez e "GARANTIR MEU KIT" enquanto ha kit para levar
 * na hora, e vira "COMPRAR ONLINE" quando o lote presencial acaba.
 *
 * A TROCA MUDOU DE LUGAR NESTA REESCRITA. Ate 20/08/2026 ela vivia no botao do
 * hero; §19 a coloca junto do contador, que e onde o numero que a justifica
 * esta. O hero passou a ter copy fixa (§6/§9), e por um bom motivo: o botao do
 * topo e lido por quem ainda nao sabe que existe um lote presencial, e
 * "COMPRAR ONLINE" ali responderia uma pergunta que ninguem fez ainda.
 *
 * O DESTINO E O MESMO NOS DOIS CASOS — o que muda e a promessa da palavra, nao
 * para onde o botao leva. O canal online nunca esgota (pre-venda sem teto),
 * entao nao existe estado em que o botao aponte para uma compra impossivel.
 */
const CTA_COM_PRESENCIAL = 'GARANTIR MEU KIT'
const CTA_SO_ONLINE = 'COMPRAR ONLINE'

/**
 * §13: os quatro produtos.
 *
 * A ORDEM AQUI E A DO PROCEDIMENTO, e ela diverge de propósito da numeracao
 * escrita em §13 (que lista o hidratante em segundo). A secao seguinte, "Como
 * funciona" (§14), mostra o procedimento em quatro passos — preparacao,
 * aplicacao, extracao, finalizacao — e o hidratante e a FINALIZACAO. Numera-lo
 * como 02 poria as duas secoes se contradizendo a um palmo uma da outra, com o
 * kit dizendo que o hidratante vem antes da extracao.
 *
 * A chave `foto` casa cada produto com o manifesto de src/lib/fotos.ts. O tipo
 * e fechado sobre as quatro chaves, entao errar o nome aqui quebra o build em
 * vez de servir um card sem imagem.
 */
const PRODUTOS_DO_KIT = [
  {
    numero: '01',
    foto: 'sabonete',
    nome: 'Sabonete facial',
    texto: 'Higieniza a pele e prepara o rosto para a etapa de extração.',
  },
  {
    numero: '02',
    foto: 'mascara',
    nome: 'Máscara extratora',
    texto: 'A massa artesanal que faz a extração indolor de cravos e impurezas.',
  },
  {
    numero: '03',
    foto: 'papel',
    nome: 'Papel removedor',
    texto: 'Aplicado sobre a máscara, potencializa a remoção das impurezas ao secar.',
  },
  {
    numero: '04',
    foto: 'hidratante',
    nome: 'Hidratante facial',
    texto: 'Finaliza o procedimento devolvendo o viço natural da pele.',
  },
] as const

/**
 * §14: os quatro passos do procedimento.
 *
 * A COPY E DELIBERADAMENTE SECA. §14 manda "evitar afirmacoes medicas ou
 * resultados que nao estejam oficialmente comprovados/documentados pela
 * marca", e um bloco que descreve etapas e o lugar mais facil de escorregar
 * para "elimina", "trata", "regenera". Cada linha abaixo diz o que ACONTECE,
 * nao o que o corpo responde.
 */
const PASSOS = [
  { numero: 'Passo 01', nome: 'Preparação', texto: 'Preparação da pele para o procedimento.' },
  { numero: 'Passo 02', nome: 'Aplicação', texto: 'Aplicação dos produtos que compõem o protocolo.' },
  { numero: 'Passo 03', nome: 'Extração', texto: 'Realização da etapa de extração.' },
  { numero: 'Passo 04', nome: 'Finalização', texto: 'Finalização do cuidado com a pele.' },
] as const

/** §12: para quem a oportunidade e. */
const PARA_QUEM = [
  { nome: 'Clínicas de estética', texto: 'Amplie seu portfólio de serviços.' },
  { nome: 'Salões de beleza', texto: 'Ofereça uma nova experiência aos seus clientes.' },
  { nome: 'Barbearias', texto: 'Inclua cuidados com a pele ao seu atendimento.' },
  { nome: 'Nail designers', texto: 'Crie uma nova possibilidade de serviço.' },
  { nome: 'Lash designers', texto: 'Diversifique sua atuação.' },
  {
    nome: 'Profissionais da beleza',
    texto: 'Transforme conhecimento e atendimento em novas oportunidades.',
  },
] as const

/**
 * §10: os atributos do produto.
 *
 * Copy herdada da LP de recrutamento e ja aprovada pelo cliente. NAO foi
 * ampliada nesta reescrita, e a contencao e proposital: §14 pede para nao
 * afirmar resultado nao documentado, e acrescentar promessa nova aqui seria
 * criar exatamente o que aquela regra existe para evitar.
 */
const BENEFICIOS = [
  'Extração de cravos',
  'Desobstrução dos poros',
  'Transforma a textura da pele',
  'Devolve o viço natural',
  'Hidratação',
]

const DIFERENCIAIS = [
  'Resultado imediato',
  '30 minutos de aplicação',
  'Fórmula natural',
  'Fácil aplicação',
  'Concilia com outros procedimentos',
]

type Props = {
  /**
   * `?cupom=CODIGO` dos links de campanha. A home e o destino natural desses
   * links — e nela que o checkout esta embutido (secao 11).
   */
  searchParams: Promise<{ cupom?: string | string[] }>
}

export default async function PaginaInicial({ searchParams }: Props) {
  const sp = await searchParams
  const cupomInicial = cupomDaUrl(sp.cupom)

  /**
   * UM INSTANTE SO PARA A PAGINA INTEIRA. `lancamentoJaOcorreu()` sem
   * argumento le o relogio a cada chamada, e uma renderizacao que perguntasse
   * duas vezes poderia receber respostas diferentes se a virada de 25/08
   * acontecesse no meio dela — a mesma tela falando no futuro em cima e no
   * presente embaixo.
   */
  const agora = new Date()
  const lancado = lancamentoJaOcorreu(agora)

  const kits = await listarKitsAtivos()
  const kit = kits[0] ?? null

  /**
   * ESTADO VAZIO HONESTO (divida deliberada do projeto): catalogo vazio nao
   * pode virar pagina quebrada nem pagina com promessa inventada. Ele encerra
   * a jornada logo depois do hero — todas as secoes desembocam num checkout
   * que nao teria o que vender.
   */
  if (!kit) {
    return (
      <>
        {/*
          SEM AS CTAs AQUI, e isso e correcao de um defeito real e nao economia
          de pixels: as duas CTAs do hero apontam para ancoras (`#a-milagran` e
          `#comprar`) que so existem quando a pagina completa e renderizada. No
          estado vazio elas nao existem, e um botao que rola para lugar nenhum e
          pior do que botao nenhum — a visitante clica, nada acontece, e ela
          conclui que o site esta quebrado em vez de ler o aviso logo abaixo.
        */}
        <Hero lancado={lancado} comCompra={false} />
        <section className="section">
          <p className="aviso" data-testid="sem-kit">
            <span className="aviso__titulo">Compra indisponível</span>
            Nenhum kit está disponível para compra no momento. O lançamento oficial
            da Milagran acontece em 25 de agosto de 2026 — fale com a gente pelo
            WhatsApp do rodapé para saber quando a loja voltar.
          </p>
        </section>
      </>
    )
  }

  /**
   * O saldo presencial do lancamento. `null` quando o kit nao tem linha de
   * estoque presencial — kit que simplesmente nao entra no evento. Nao e
   * "esgotado": sem lote, nao ha contagem regressiva a exibir.
   */
  const presencial = await saldoDoEstoque(kit.id, 'presencial')

  /**
   * O aviso le o saldo CRU (que pode ser negativo, ver `ajustarEstoque`) e o
   * contador recebe o saldo CLAMPADO — a mesma divisao de
   * src/app/api/estoque/route.ts: negativo e zero caem os dois em 'esgotado',
   * e "-3 kits" nao e verdade nenhuma sobre a caixa do evento.
   */
  const aviso = presencial ? avisoDeEscassez(presencial.disponivel, presencial.total) : null
  const esgotado = aviso?.nivel === 'esgotado'

  /**
   * DIVIDA DELIBERADA, herdada e ainda nao paga: o ROTULO da CTA de escassez e
   * decidido neste render de servidor, e o NUMERO do contador continua vivo
   * depois (polling de 15s). Uma aba deixada aberta enquanto o lote acaba passa
   * a mostrar o contador dizendo "esgotados" ao lado de um botao ainda escrito
   * "GARANTIR MEU KIT".
   *
   * POR QUE CONTINUA ACEITAVEL: os dois rotulos levam ao MESMO lugar e a compra
   * online nunca esgota, entao a divergencia nao produz botao para lugar
   * nenhum — perde-se a palavra certa, com a frase correta a dois centimetros.
   *
   * COMO PAGAR: envolver contador + CTA num unico client component e mover
   * esta decisao para dentro dele.
   */
  const rotuloCta = esgotado ? CTA_SO_ONLINE : CTA_COM_PRESENCIAL

  /**
   * PARA ONDE TODO BOTAO DE COMPRA DESTA PAGINA APONTA — montado UMA vez, e
   * nao escrito em cada `href`.
   *
   * O CUPOM E A RAZAO DE ISTO NAO SER UMA CONSTANTE NO TOPO DO ARQUIVO. Um
   * link de campanha chega como `/?cupom=CODIGO`, e o codigo so PREENCHE o
   * campo do checkout — quem concede desconto e o servidor. Mas se o link
   * daqui para /checkout nao levar o codigo junto, a compradora que veio pelo
   * anuncio chega na tela de pagamento sem o cupom preenchido e precisa
   * digitar um codigo que ela nao decorou. Ninguem descobre isso por um erro:
   * descobre-se pela reclamacao de que "o desconto nao apareceu".
   * src/app/r/[slug]/page.tsx registra que o cupom importa mais no caminho de
   * campanha do que em qualquer outra tela.
   *
   * `quantidade: 1` porque a home nao pergunta mais quantidade — quem escolhe
   * e o passo 1 do checkout, que e para onde este link leva.
   */
  const hrefCompra = linkDeCheckout(kit.slug, 1, cupomInicial)

  // Uma vez, aqui, e nao inline em cada uso: a MESMA situacao alimenta o texto
  // e a decisao de moldura do bloco ANVISA.
  const situacaoAnvisaDoKit = {
    registro: kit.anvisaRegistro,
    dispensado: kit.anvisaDispensado,
  }

  return (
    <>
      {/* ---------------- §36/02: HERO + FOTO DO PRODUTO ---------------- */}
      <Hero lancado={lancado} hrefCompra={hrefCompra} />

      {/* ---------------- §36/03: O QUE E A MILAGRAN (§10) ---------------- */}
      <section className="section section--panel" id="a-milagran" aria-labelledby="a-milagran-titulo">
        <div className="section__head">
          <span className="kicker">01 — A marca</span>
          <h2 id="a-milagran-titulo">Não é apenas uma limpeza de pele.</h2>
          <p className="section__lede">
            A Milagran nasceu de uma ideia construída ao longo de 15 anos: criar uma
            nova experiência de cuidado com a pele e, ao mesmo tempo, possibilitar que
            profissionais da beleza tenham acesso a uma nova oportunidade de serviço e
            geração de renda.
          </p>
          <p className="section__lede">Agora, essa história chega ao mercado.</p>
        </div>

        <div className="two-col">
          {/*
            <h4> e nao <h3> depois de um <h2>: o rotulo pequeno em caixa alta do
            design system mora em `.two-col__block h4` (globals.css). Trocar por
            <h3> deixaria os dois rotulos sem estilo nenhum. O nivel pulado e a
            troca consciente — nao ha conteudo escondido por ela.
          */}
          <div className="two-col__block">
            <h4>Benefícios</h4>
            <ul className="check-list">
              {BENEFICIOS.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </div>
          <div className="two-col__block">
            <h4>Diferenciais</h4>
            <ul className="check-list">
              {DIFERENCIAIS.map((d) => <li key={d}>{d}</li>)}
            </ul>
          </div>
        </div>

        <div className="section__acao">
          <a className="btn btn--ghost" href="#historia">Conhecer essa história</a>
        </div>
      </section>

      {/* ---------------- §36/04: 15 ANOS DE HISTORIA (§11) ---------------- */}
      <section className="section" id="historia" aria-labelledby="historia-titulo">
        <div className="section__head">
          <span className="kicker">02 — A história</span>
          <h2 id="historia-titulo">
            15 anos de história. Um propósito que agora ganha vida.
          </h2>
        </div>

        <div className="prosa">
          <p><strong>A Milagran não nasceu ontem.</strong></p>
          <p>
            Foram 15 anos entre ideias, desenvolvimento, aperfeiçoamentos e o sonho de
            transformar uma experiência de cuidado com a pele em algo que pudesse
            chegar a muito mais pessoas.
          </p>
          <p>Agora, esse sonho se transforma em realidade.</p>
          <p>
            {lancado
              ? 'Em 25 de agosto, a Milagran foi oficialmente apresentada ao mercado.'
              : 'No dia 25 de agosto, a Milagran será oficialmente apresentada ao mercado.'}
          </p>
          <p>
            E existe um propósito por trás desse lançamento: criar uma nova
            possibilidade para profissionais da beleza oferecerem um serviço, atenderem
            seus clientes e construírem uma nova fonte de renda através do próprio
            trabalho.
          </p>
        </div>
      </section>

      {/* ---------------- §36/05: PARA QUEM E (§12) ---------------- */}
      <section className="section section--panel" id="para-quem" aria-labelledby="para-quem-titulo">
        <div className="section__head">
          <span className="kicker">03 — A oportunidade</span>
          <h2 id="para-quem-titulo">Uma nova oportunidade para quem vive da beleza.</h2>
        </div>

        <div className="publico-grid">
          {PARA_QUEM.map((p) => (
            <article className="publico-card" key={p.nome}>
              <h3>{p.nome}</h3>
              <p>{p.texto}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ---------------- §36/06: O KIT (§13) ---------------- */}
      <section className="section" id="o-kit" aria-labelledby="o-kit-titulo">
        <div className="section__head">
          <span className="kicker">04 — O kit</span>
          <h2 id="o-kit-titulo">Conheça o Kit Milagran.</h2>
          <p className="section__lede">
            {kit.descricao} Quatro produtos, na ordem de uso do procedimento.
          </p>
        </div>

        <div className="kit-grid">
          {PRODUTOS_DO_KIT.map((p) => (
            <article className="kit-card" key={p.numero}>
              {/*
                A foto oficial de cada produto (§13). Enquanto os arquivos nao
                chegam, `FotoDaMarca` desenha a moldura ornamental no lugar —
                ver src/lib/fotos.ts para o porque e para como preencher.
              */}
              <FotoDaMarca className="kit-card__foto" foto={FOTOS_DOS_PRODUTOS[p.foto]} />
              <span className="kit-card__num">{p.numero}</span>
              <h3>{p.nome}</h3>
              <p>{p.texto}</p>
            </article>
          ))}
        </div>

        {/*
          A frase vem de src/lib/anvisa.ts — FONTE UNICA com a vitrine de
          /comprar. E DIVULGACAO REGULATORIA, nao um bloco de layout: ela
          declara o enquadramento na Lei 15.154/2025 (producao artesanal,
          dispensada de registro previo). Sobreviveu ao redesenho de 20/08/2026
          de proposito, e nao por descuido de quem mexeu no arquivo.

          A moldura de ATENCAO e condicional: ela pertence ao estado pendente
          ("em breve"), que e pendencia de verdade. Dispensa legal e registro
          emitido sao situacoes RESOLVIDAS — vesti-las de alerta faria a
          compradora ler problema onde nao ha.
        */}
        <p
          className={situacaoPendente(situacaoAnvisaDoKit) ? 'aviso aviso--atencao' : 'aviso'}
          data-testid="anvisa"
        >
          <span className="aviso__titulo">ANVISA</span>
          {textoAnvisa(situacaoAnvisaDoKit)}
        </p>
      </section>

      {/* ---------------- §36/07: COMO FUNCIONA (§14) ---------------- */}
      <section className="section section--panel" id="como-funciona" aria-labelledby="como-funciona-titulo">
        <div className="section__head">
          <span className="kicker">05 — O procedimento</span>
          <h2 id="como-funciona-titulo">Como funciona.</h2>
          <p className="section__lede">
            Quatro etapas, do preparo à finalização.
          </p>
        </div>

        {/*
          <ol> e nao <div>: sao passos ORDENADOS, e a ordem e a informacao. Um
          leitor de tela anuncia "lista de 4 itens" e o numero de cada um sem
          depender do rotulo visual.
        */}
        <ol className="passos">
          {PASSOS.map((p) => (
            <li className="passo" key={p.numero}>
              <span className="passo__num">{p.numero}</span>
              <h3>{p.nome}</h3>
              <p>{p.texto}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ---------------- §36/08: EXPERIENCIA REAL (§15) ---------------- */}
      <section className="section" id="experiencia" aria-labelledby="experiencia-titulo">
        <div className="section__head">
          <span className="kicker">06 — A experiência</span>
          <h2 id="experiencia-titulo">Não é só sobre o produto. É sobre a experiência.</h2>
          <p className="section__lede">
            A Milagran foi testada na prática antes de chegar ao mercado. Profissionais
            e modelos já tiveram contato com essa nova experiência.
          </p>
        </div>

        {/*
          A GALERIA SO EXISTE QUANDO HA FOTO. Lista vazia e o estado de hoje —
          as imagens dos testes ainda nao foram entregues (src/lib/fotos.ts).
          Uma fileira de molduras vazias aqui nao acrescentaria nada ao texto
          acima e anunciaria um vazio que ninguem precisa ver.
        */}
        {FOTOS_DA_EXPERIENCIA.length > 0 && (
          <div className="galeria" data-testid="galeria-experiencia">
            {FOTOS_DA_EXPERIENCIA.map((f) => (
              <FotoDaMarca key={f.src ?? f.alt} className="galeria__item" foto={f} />
            ))}
          </div>
        )}

        <div className="section__acao">
          <a className="btn btn--ghost" href={hrefCompra}>Quero experimentar</a>
        </div>
      </section>

      {/* ---------------- §36/09: LANCAMENTO 25/08 (§16) ---------------- */}
      <section className="section section--marco" id="lancamento" aria-labelledby="lancamento-titulo">
        <div className="section__head">
          <span className="kicker">Lançamento oficial</span>
          <h2 id="lancamento-titulo">
            {lancado
              ? '25 de agosto. O dia em que a Milagran chegou ao mercado.'
              : '25 de agosto. O dia em que a Milagran chega ao mercado.'}
          </h2>
          <p className="section__lede">
            Depois de 15 anos de história, chegou o momento de apresentar a Milagran ao
            mundo. Um lançamento criado para celebrar um novo começo, novas conexões e
            uma nova experiência em cuidado com a pele.
          </p>
        </div>

        <div className="section__acao">
          <a className="btn btn--solid" href="#kits-presenciais">Quero participar</a>
        </div>
      </section>

      {/* ---------------- §36/10: 50 KITS PRESENCIAIS (§17, §19) ---------------- */}
      <section className="section" id="kits-presenciais" aria-labelledby="kits-presenciais-titulo">
        <div className="section__head">
          <span className="kicker">07 — No evento</span>
          <h2 id="kits-presenciais-titulo">
            {presencial && presencial.total > 0
              ? `Apenas ${presencial.total} kits disponíveis no evento.`
              : 'Kits disponíveis no evento.'}
          </h2>
          <p className="section__lede">
            Quem estiver presente no lançamento terá uma oportunidade especial: os kits
            separados para o evento podem ser comprados e levados na hora.
          </p>
        </div>

        {/*
          §17 pede as tres palavras em destaque. <p> com spans, e nao tres <li>:
          e uma frase so — "comprou, pagou, levou" — partida para ganhar ritmo
          visual, e transforma-la em lista faria o leitor de tela anunciar "lista
          de 3 itens" para o que e uma sentenca.
        */}
        <p className="lema" data-testid="lema-presencial">
          <span>Comprou.</span> <span>Pagou.</span> <span>Levou.</span>
        </p>

        {/*
          O CONTADOR SO EXISTE QUANDO HA LOTE (§19). Sem linha de estoque
          presencial nao ha numero honesto a mostrar, e um "0" ali seria pior
          que silencio. Ele faz polling de 15s: e ele, e nao este render, que
          conta a verdade do saldo depois que a pagina abre.
        */}
        {presencial && (
          <ContadorEstoque
            inicial={{
              disponivel: Math.max(0, presencial.disponivel),
              total: presencial.total,
            }}
            kitSlug={kit.slug}
          />
        )}

        <p className="section__nota">
          {esgotado
            ? 'Os kits presenciais acabaram. A compra continua disponível pelo site, e o pedido é enviado pelos Correios.'
            : 'Depois que os kits presenciais forem vendidos, a compra continuará disponível pelo site, e o pedido será enviado pelos Correios.'}
          {' '}
          Há também retirada no local em {ENDERECO_RETIRADA.cidade}/{ENDERECO_RETIRADA.estado},
          sem frete — você tem {PRAZO_RETIRADA_DIAS} dias para buscar.
        </p>

        <div className="section__acao">
          <a className="btn btn--solid" href={hrefCompra} data-testid="cta-escassez">
            {rotuloCta}
          </a>
        </div>
      </section>

      {/* ---------------- §36/11: CTA DE COMPRA (§37) ---------------- */}
      {/*
        O FECHAMENTO DO ARGUMENTO — e a porta para a compra, que desde
        20/08/2026 acontece em TELA PROPRIA (/checkout).

        ATE AQUI O CHECKOUT INTEIRO FICAVA EMBUTIDO NESTA SECAO, e a razao
        estava escrita: quem leu dez blocos de argumento age no lugar onde ja
        esta, e mandar para outra URL seria pedir que a decisao recomecasse numa
        tela nunca vista. A troca foi pedida pelo cliente em 20/08/2026, e ela
        paga essa perda com tres coisas concretas:

        1. §8 PASSA A VALER AO PE DA LETRA. O preco era a excecao que este bloco
           abria na home — o kit custa R$ 1.000,00 e o numero aparecia aqui,
           dentro do formulario. Agora a home inteira nao tem preco; ele mora na
           vitrine e no checkout, que e o que §8 e §20 pedem.
        2. A HOME VOLTA A TER UM <h1> SO. O passo 1 do wizard abre com
           `<h1>{kit.nome}</h1>`, e com ele embutido a home servia DOIS <h1> — o
           do hero e o do kit. Documento invalido, e dois assuntos concorrendo
           para o leitor de tela e para o buscador.
        3. O FLUXO GANHA UMA TELA SEM CONCORRENCIA. Preencher endereco e cartao
           ao lado de dez secoes de argumento, um menu e uma barra fixa de
           compra e mais ruido do que ajuda.

        O QUE A TROCA CUSTA, para ficar dito: um clique a mais entre o fim do
        argumento e o formulario. E o preco de tudo acima.
      */}
      <section className="section section--panel" id="comprar" aria-labelledby="comprar-titulo">
        <div className="section__head">
          <span className="kicker">08 — A compra</span>
          <h2 id="comprar-titulo">Uma nova experiência começa agora.</h2>
          <p className="section__lede">
            {lancado
              ? 'A Milagran chegou ao mercado depois de 15 anos de história. Escolha a quantidade na próxima tela e finalize com PIX ou cartão de crédito.'
              : 'Depois de 15 anos de história, a Milagran finalmente chega ao mercado. Escolha a quantidade na próxima tela e garanta o seu kit com PIX ou cartão de crédito.'}
          </p>
        </div>

        {/*
          §21. A frase da pre-venda NAO e reescrita aqui: ela e a constante
          AVISO_PRE_VENDA de src/lib/tempo.ts, a mesma que o checkout mostra.
          Duas telas escrevendo a propria versao do prazo e como duas
          superficies prometerem fretes diferentes para a mesma compra.

          ELA CONTINUA NESTA PAGINA mesmo com o formulario em outra: e aqui que
          a decisao de comprar acontece, e o prazo de entrega e parte dessa
          decisao. Descobri-lo so depois de preencher nome, CEP e cartao seria
          contar tarde.
        */}
        {lancado ? (
          <p className="aviso-prevenda" data-testid="prazo-online">
            <strong>Pedidos liberados.</strong> O lançamento oficial da Milagran
            aconteceu em 25 de agosto de 2026 e os pedidos online já são enviados,
            com prazo calculado no checkout a partir do seu CEP — ou retirados no
            local, sem frete.
          </p>
        ) : (
          <p className="aviso-prevenda" data-testid="prazo-online">
            <strong>Garanta seu kit antes do lançamento.</strong> {AVISO_PRE_VENDA}
          </p>
        )}

        <div className="section__acao">
          <a className="btn btn--solid" href={hrefCompra} data-testid="cta-final">
            {rotuloCta}
          </a>
        </div>
      </section>

      {/* ---------------- §36/12: REPRESENTANTES (§23) ---------------- */}
      {/*
        §23 e explicito: a funcionalidade CONTINUA e nao pode ser removida, mas
        DEIXA DE SER a CTA principal da pagina. Por isso esta secao e a
        penultima, nao tem formulario embutido (ao contrario do checkout logo
        acima) e o botao e fantasma: um botao dourado aqui competiria com a
        compra, que e o objetivo primario do lancamento (§39).

        <a> CRU, e nao next/link: /seja-representante.html e arquivo estatico de
        public/, fora do App Router. Um <Link> tentaria navegacao client-side
        para uma rota que o roteador nao conhece. E a mesma URL que
        deploy/milagran-ci-deploy.sh usa para aprovar ou reverter o deploy
        inteiro — ela precisa continuar respondendo 200.
      */}
      <section className="section" id="representantes" aria-labelledby="representantes-titulo">
        <div className="section__head">
          <span className="kicker">09 — Represente a marca</span>
          <h2 id="representantes-titulo">Quer levar a Milagran com você?</h2>
          <p className="section__lede">
            Além de comprar o kit, é possível representar a marca e trabalhar com a
            Milagran. As oportunidades de representação e distribuição continuam
            abertas.
          </p>
        </div>

        <div className="section__acao">
          <a className="btn btn--ghost" href="/seja-representante.html">
            Quero representar a Milagran
          </a>
        </div>
      </section>

      {/*
        §32. Fica por ultimo no DOM de proposito: e um elemento `position:fixed`
        e, sendo o ultimo, o Tab so chega nele depois de todo o conteudo, em vez
        de despeja-lo no meio da leitura. Ela se recolhe sozinha quando a secao
        do checkout aparece — ver o componente.
      */}
      <BarraCompraMobile href={hrefCompra} alvo="comprar" rotulo={rotuloCta} />
    </>
  )
}

/**
 * O TOPO DA PAGINA (§5, §6, §30) — compartilhado pelo caminho normal e pelo
 * estado vazio, para que sem catalogo o visitante continue vendo de quem e a
 * pagina em vez de uma tela em branco.
 *
 * O PRODUTO E PROTAGONISTA, e essa e a mudanca estrutural de §5: o hero deixou
 * de ser uma coluna de texto centralizada e virou DUAS colunas — texto a
 * esquerda, foto do Kit a direita, grande. No celular vira uma coluna so, com
 * a foto logo abaixo da manchete (§31).
 *
 * SEM PRECO E SEM CONTADOR AQUI (§8, §39). Os dois viviam neste bloco ate
 * 20/08/2026. O preco saiu da pagina inteira; o contador desceu para a secao
 * de escassez (§17), que e onde §19 o coloca e onde a frase que o explica
 * esta.
 */
function Hero({
  lancado,
  /**
   * Para onde vai a CTA secundaria (§9: "leva diretamente para a compra").
   * Chega pronta de cima porque so a pagina conhece o kit e o cupom da URL —
   * ver `hrefCompra`.
   */
  hrefCompra,
  /**
   * A CTA primaria e uma ancora para uma secao desta mesma pagina. Sem
   * catalogo, essa secao nao existe — e o hero precisa saber disso para nao
   * publicar botao que nao leva a lugar nenhum.
   */
  comCompra = true,
}: {
  lancado: boolean
  hrefCompra?: string
  comCompra?: boolean
}) {
  const manchete = lancado ? MANCHETE_LANCADA : MANCHETE_PRE_VENDA
  const subtitulo = lancado ? SUBTITULO_LANCADA : SUBTITULO_PRE_VENDA

  return (
    <section className="hero hero--loja">
      <div className="hero__texto">
        <p className="eyebrow">
          {lancado
            ? 'Lançamento oficial · 25 de agosto de 2026'
            : 'Lançamento oficial · 25 de agosto'}
        </p>

        {/*
          A manchete e uma frase so, quebrada em duas tipografias: a abertura no
          traco de display da marca e o resto no italico. O {' '} entre os dois
          <span> e SEMANTICO, nao formatacao — o nome acessivel do titulo
          concatena os nos de texto sem separador, e sem ele o leitor de tela (e
          o `getByRole('heading', { name })` do teste) ouviria as duas metades
          coladas numa palavra.
        */}
        <h1 className="hero__title">
          <span className="serif-display">{manchete.destaque}</span>{' '}
          <span className="script">{manchete.resto}</span>
        </h1>

        <p className="hero__subtitle">{subtitulo}</p>

        {/*
          §6 e §9: duas CTAs com pesos diferentes. A primeira leva a conhecer a
          marca (a secao logo abaixo) e a segunda vai direto para a compra.
          A ordem visual e a de §30 — conhecer primeiro, comprar depois — porque
          §39 manda a pagina NAO entregar tudo no primeiro bloco.
        */}
        {comCompra && (
          <div className="hero__cta">
            <a className="btn btn--solid" href="#a-milagran" data-testid="cta-principal">
              Quero conhecer a Milagran
            </a>
            <a className="btn btn--ghost" href={hrefCompra} data-testid="cta-secundaria">
              Garantir meu kit
            </a>
          </div>
        )}
      </div>

      <div className="hero__produto">
        <FotoDaMarca className="hero__foto" foto={FOTO_HERO} prioridade />
      </div>
    </section>
  )
}
