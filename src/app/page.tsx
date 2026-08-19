import type { Metadata } from 'next'
import { ContadorEstoque } from '@/components/contador-estoque'
import { avisoDeEscassez } from '@/lib/escassez'
import { formatarBRL } from '@/lib/money'
import { AVISO_PRE_VENDA, lancamentoJaOcorreu } from '@/lib/tempo'
import { textoAnvisa, situacaoPendente } from '@/lib/anvisa'
import { saldoDoEstoque } from '@/repositories/estoque'
import { listarKitsAtivos } from '@/repositories/produtos'
import { CheckoutWizard } from '@/components/checkout-wizard'
import { cupomDaUrl } from '@/lib/cupom-da-url'

/**
 * A LOJA DE LANCAMENTO — "/" (§6, §7, §8 e §18 do documento do cliente de
 * 16/08/2026).
 *
 * Ate 16/08/2026 este endereco era um rewrite para a landing page de
 * recrutamento (next.config.ts conta a historia por extenso). A prioridade
 * inverteu: quem chega pelo QR Code do evento veio COMPRAR, e representante
 * virou um link discreto no rodape (§14).
 *
 * A ORDEM DAS SECOES E O REQUISITO §18, nao gosto: o que e -> o que vem no kit
 * -> quanto custa -> como pagar -> como receber -> comprar. E a ordem em que a
 * duvida aparece na cabeca de quem nunca ouviu falar da marca; embaralhar isso
 * (preco antes de produto, entrega antes de preco) faz a pagina responder o
 * que ninguem perguntou ainda. O <h2> de cada secao esta nessa ordem e ha
 * teste travando a sequencia.
 *
 * EXCECAO CONSCIENTE A ESSA ORDEM: preco e CTA aparecem TAMBEM no hero, antes
 * de tudo. A pagina tem dois publicos ao mesmo tempo — quem descobriu a marca
 * agora e le de cima a baixo, e quem escaneou o QR Code no evento com o cartao
 * na mao. O segundo nao pode ter que rolar seis secoes para achar o botao. O
 * numero e o mesmo objeto (`kit.precoCentavos`) formatado pela mesma funcao
 * nas duas aparicoes, entao nao existe divergencia possivel entre elas.
 *
 * SERVER COMPONENT. O unico pedaco com 'use client' e o contador de estoque,
 * que precisa de temporizador (src/components/contador-estoque.tsx).
 *
 * SEM A CLASSE `.reveal` EM LUGAR NENHUM, e isso e armadilha real: `.reveal`
 * comeca com `opacity:0` em globals.css e so aparece quando `public/script.js`
 * acrescenta `is-visible` via IntersectionObserver — e aquele script pertence
 * a LP estatica, nao ao App Router. Usar a classe aqui deixaria a loja inteira
 * invisivel, com o HTML impecavel no DevTools.
 */

// `force-dynamic` porque a pagina le ESTOQUE AO VIVO. Sem isso o Next serviria
// o saldo congelado no `next build` — um lote de 50 kits eternamente intacto
// na home enquanto o balcao vende. Vale tambem para preco e catalogo, pelo
// mesmo motivo ja registrado em src/app/comprar/page.tsx.
export const dynamic = 'force-dynamic'

/**
 * Canonical POR PAGINA, nunca no layout raiz (src/app/layout.tsx explica por
 * que). Esta e a unica rota que pode reivindicar "/" — e o defeito que este
 * commit desfaz e justamente a LP de recrutamento declarando-se home da marca.
 */
export const metadata: Metadata = {
  alternates: { canonical: '/' },
}

/** §6, palavra por palavra. */
const MANCHETE_DESTAQUE = 'A MILAGRAN'
const MANCHETE_RESTO = 'ESTÁ OFICIALMENTE NO MERCADO.'
const SUBTITULO = 'Uma nova experiência em limpeza de pele chegou.'

/**
 * §6 e §5/§11: a CTA e "GARANTIR MEU KIT" enquanto ha kit para levar na hora e
 * vira "COMPRAR ONLINE" quando o lote presencial acaba.
 *
 * O DESTINO E O MESMO NOS DOIS CASOS, e isso e o que torna a troca segura: o
 * que muda e a promessa da palavra, nao para onde o botao leva. O canal online
 * nunca esgota (pre-venda sem teto, §4), entao nao existe estado em que o
 * botao aponte para uma compra impossivel.
 *
 * O DESTINO E UMA ANCORA NESTA MESMA PAGINA, e nao mais /comprar.
 *
 * A referencia e a LP de recrutamento (public/seja-representante.html): la a
 * ultima secao NAO tem um botao que leva a outra tela — tem o formulario de
 * candidatura inteiro, ali dentro. Quem chega ao fim da pagina age no lugar
 * onde ja esta. A loja tinha o padrao oposto: seis secoes de argumento e, no
 * fim, um botao que jogava o visitante para outra URL, onde a compra so
 * comecava.
 *
 * `scroll-behavior: smooth` ja esta em globals.css, entao a ancora desliza
 * ate o checkout em vez de saltar.
 *
 * /comprar e /checkout continuam existindo e funcionando: sao o alvo do link
 * do representante (/r/<slug>), de campanha com URL propria e de quem
 * salvou o endereco. Esta mudanca troca o caminho PADRAO da home, nao remove
 * caminho nenhum.
 */
const CTA_COM_PRESENCIAL = 'GARANTIR MEU KIT'
const CTA_SO_ONLINE = 'COMPRAR ONLINE'
const DESTINO_COMPRA = '#comprar'

/**
 * O conteudo do kit vinha de public/seja-representante.html (as quatro
 * .kit-card daquela pagina). A DESCRICAO DOS PRODUTOS FOI MANTIDA porque ela
 * descreve o procedimento e vale para qualquer pessoa; o ENQUADRAMENTO DE
 * RECRUTAMENTO ficou de fora — "a demonstracao que mais converte no seu
 * balcao", "aplicavel em saloes, barbearias, studios e spas", "para o seu
 * negocio". Aqui quem le e o consumidor final comprando um kit para si, nao o
 * profissional avaliando revenda.
 */
const PRODUTOS_DO_KIT = [
  {
    numero: '01',
    nome: 'Sabonete líquido',
    texto: 'Higieniza a pele e prepara o rosto para a etapa de extração.',
  },
  {
    numero: '02',
    nome: 'Máscara extratora',
    texto: 'A massa artesanal que faz a extração indolor de cravos e impurezas.',
  },
  {
    numero: '03',
    nome: 'Papel removedor',
    texto: 'Aplicado sobre a máscara, potencializa a remoção das impurezas ao secar.',
  },
  {
    numero: '04',
    nome: 'Hidratante',
    texto: 'Finaliza o procedimento devolvendo o viço natural da pele.',
  },
]

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
   * links — e nela que o checkout esta embutido (secao "06 — A compra"),
   * entao mandar a pessoa direto para /checkout puxaria o argumento de venda
   * embaixo dela.
   *
   * Ler searchParams NAO muda o custo de renderizacao aqui: esta pagina ja e
   * `force-dynamic` por causa do estoque ao vivo.
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
   * presente embaixo. O proprio src/lib/tempo.ts documenta o parametro para
   * este uso.
   */
  const agora = new Date()
  const lancado = lancamentoJaOcorreu(agora)

  const kits = await listarKitsAtivos()
  // O kit do lancamento e o PRIMEIRO ATIVO. A ordem de listarKitsAtivos e
  // deterministica de proposito (ordem, depois slug), entao "o primeiro" e
  // sempre o mesmo entre dois acessos — mesma regra que GET /api/estoque usa
  // para o contador, o que mantem os dois falando do mesmo kit.
  const kit = kits[0] ?? null

  /**
   * ESTADO VAZIO HONESTO (DIVIDA DELIBERADA do projeto, nao um caso de borda
   * esquecido): catalogo vazio nao pode virar pagina quebrada nem pagina com
   * preco inventado. Aqui ele encerra a jornada de §18 logo depois do hero, em
   * vez de mostrar as seis secoes: todas elas desembocam num botao de compra
   * que nao teria o que comprar, e mandar o visitante para /comprar so o
   * levaria ao estado vazio da vitrine — dois passos para descobrir a mesma
   * coisa. O que a marca e continua dito; o que nao existe nao e prometido.
   */
  if (!kit) {
    return (
      <>
        <Hero lancado={lancado} />
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
   * "esgotado": sem lote, nao ha contagem regressiva a exibir, e tratar
   * ausencia de cadastro como zero faria a home anunciar que um lote que nunca
   * existiu acabou. Mesmo contrato de GET /api/estoque e da vitrine.
   */
  const presencial = await saldoDoEstoque(kit.id, 'presencial')

  /**
   * O aviso le o saldo CRU (que pode ser negativo, ver `ajustarEstoque`) e o
   * contador recebe o saldo CLAMPADO — exatamente a divisao de
   * src/app/api/estoque/route.ts, e pelo mesmo motivo: negativo e zero caem os
   * dois em 'esgotado', entao o clamp nao muda uma palavra da frase, e "-3
   * kits" nao e verdade nenhuma sobre a caixa do evento.
   */
  const aviso = presencial ? avisoDeEscassez(presencial.disponivel, presencial.total) : null
  const esgotado = aviso?.nivel === 'esgotado'

  /**
   * DIVIDA DELIBERADA, e a troca esta escrita aqui para nao ser descoberta no
   * dia do evento: o ROTULO da CTA e decidido neste render de servidor, e o
   * NUMERO do contador continua vivo depois (polling de 15s). Uma aba deixada
   * aberta enquanto o lote acaba passa a mostrar o contador dizendo "foram
   * esgotados" ao lado de um botao ainda escrito "GARANTIR MEU KIT".
   *
   * POR QUE ISSO E ACEITAVEL HOJE: os dois rotulos levam ao MESMO lugar
   * (/comprar) e a compra online nunca esgota, entao a divergencia nao produz
   * botao para lugar nenhum — o que se perde e a palavra certa, com a frase
   * correta a dois centimetros dela. E POR QUE NAO FOI RESOLVIDO AGORA: fazer
   * o rotulo acompanhar o polling exigiria a home inteira virar client
   * component, ou o contador ganhar callback e deixar de servir ao painel
   * (§17) como bloco fechado. Nenhuma das duas se paga por uma palavra.
   *
   * COMO PAGAR: quando houver um segundo consumidor do saldo vivo nesta tela,
   * extrair um componente cliente que embrulhe contador + CTA e mover esta
   * decisao para dentro dele — e atualizar este comentario contando que a
   * divergencia acabou.
   */
  const rotuloCta = esgotado ? CTA_SO_ONLINE : CTA_COM_PRESENCIAL

  // Uma vez, aqui, e nao inline em cada uso: a MESMA situacao alimenta o
  // texto e a decisao de moldura do bloco ANVISA. Dois objetos montados em
  // linhas diferentes poderiam divergir num refactor sem o compilador acusar.
  const situacaoAnvisaDoKit = {
    registro: kit.anvisaRegistro,
    dispensado: kit.anvisaDispensado,
  }

  return (
    <>
      <Hero lancado={lancado}>
        <div className="preco-lancamento">
          <span className="preco-lancamento__valor" data-testid="preco">
            {formatarBRL(kit.precoCentavos)}
          </span>
          {/* §9: o valor unitario tem linha propria e nunca some. Quem compra
              dois kits precisa conseguir conferir a conta. */}
          <span className="preco-lancamento__unitario">
            Valor unitário do kit completo
          </span>
          <p className="preco-lancamento__nota">
            Sem frete na compra presencial. Na compra online, o frete é calculado
            no checkout a partir do seu CEP.
          </p>
        </div>

        {/*
          O CONTADOR SO EXISTE QUANDO HA LOTE. Sem linha de estoque presencial
          nao ha numero honesto a mostrar, e um "0" ali seria pior que silencio.
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

        <div className="hero__cta">
          <a className="btn btn--solid" href={DESTINO_COMPRA} data-testid="cta-principal">
            {rotuloCta}
          </a>
        </div>
      </Hero>

      {/* ---------------- §18, passo 1: O QUE E ---------------- */}
      <section className="section section--panel" id="o-que-e" aria-labelledby="o-que-e-titulo">
        <div className="section__head">
          <span className="kicker">01 — O produto</span>
          <h2 id="o-que-e-titulo">O que é a Milagran</h2>
          <p className="section__lede">
            Uma limpeza de pele artesanal, indolor e com resultado visível em 30
            minutos. O kit reúne as quatro etapas do procedimento — higienizar,
            extrair, remover e hidratar — para você fazer sem sair de casa.
          </p>
        </div>

        <div className="two-col">
          {/*
            <h4> e nao <h3> depois de um <h2>: o rotulo pequeno em caixa alta do
            design system mora em `.two-col__block h4` (globals.css, bloco
            herdado da landing page). Trocar por <h3> deixaria os dois rotulos
            sem estilo nenhum; duplicar a regra de estilo criaria um segundo
            dono do mesmo visual. O nivel pulado e a troca consciente — nao ha
            conteudo escondido por ela, so uma etiqueta de lista.
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
      </section>

      {/* ---------------- §18, passo 2: O QUE VEM NO KIT ---------------- */}
      <section className="section" id="kit" aria-labelledby="kit-titulo">
        <div className="section__head">
          <span className="kicker">02 — O kit</span>
          <h2 id="kit-titulo">O que vem no kit</h2>
          <p className="section__lede">
            {kit.descricao} Quatro produtos, na ordem de uso do procedimento.
          </p>
        </div>

        <div className="kit-grid">
          {PRODUTOS_DO_KIT.map((p) => (
            <article className="kit-card" key={p.numero}>
              <span className="kit-card__num">{p.numero}</span>
              <h3>{p.nome}</h3>
              <p>{p.texto}</p>
            </article>
          ))}
        </div>

        {/*
          A frase vem de src/lib/anvisa.ts — FONTE UNICA com a vitrine de
          /comprar. Ate 18/08/2026 as duas telas escreviam a propria versao a
          mao, e quando o cliente declarou o enquadramento na Lei 15.154/2025
          (producao artesanal, dispensada de registro previo) a copy teria que
          mudar em dois lugares sem nada apontando o segundo. Mesmo remedio do
          frete (src/components/linha-frete.tsx), mesma licao.

          A moldura de ATENCAO agora e condicional: ela pertence ao estado
          pendente ("em breve"), que e pendencia de verdade. Dispensa legal e
          registro emitido sao situacoes RESOLVIDAS — vesti-las de alerta
          faria o comprador ler problema onde nao ha.

          Bloco `.aviso` (mapeado em globals.css para "qualquer tela") em vez
          de `.vitrine__anvisa`: aquela classe pertence ao componente da
          vitrine, e a convencao de blocos deste projeto e o que impede o CSS
          de virar um emaranhado de excecoes.
        */}
        <p
          className={situacaoPendente(situacaoAnvisaDoKit)
            ? 'aviso aviso--atencao'
            : 'aviso'}
          data-testid="anvisa"
        >
          <span className="aviso__titulo">ANVISA</span>
          {textoAnvisa(situacaoAnvisaDoKit)}
        </p>
      </section>

      {/* ---------------- §18, passo 3: QUANTO CUSTA ---------------- */}
      <section className="section section--panel" id="preco" aria-labelledby="preco-titulo">
        <div className="section__head">
          <span className="kicker">03 — O valor</span>
          <h2 id="preco-titulo">Quanto custa</h2>
          <p className="section__lede">
            Preço único de lançamento, igual no evento e na loja online.
          </p>
        </div>

        <ul className="check-list">
          <li data-testid="valor-unitario">
            Valor unitário do kit: {formatarBRL(kit.precoCentavos)}
          </li>
          <li>Os quatro produtos do procedimento, sem venda separada.</li>
          <li>No evento presencial não há frete: você leva o kit na hora.</li>
          {/*
            NENHUM VALOR DE FRETE APARECE NESTA PAGINA, e a ausencia e
            deliberada. A home nao conhece o CEP do visitante, e o unico numero
            que ela poderia imprimir sem cotar seria "R$ 0,00" — a promessa de
            frete gratis que src/components/linha-frete.tsx existe para impedir.
            Quem mostra valor de frete e o checkout, depois da cotacao (§13).
          */}
          <li>Na compra online, o frete é calculado no checkout a partir do seu CEP.</li>
        </ul>
      </section>

      {/* ---------------- §18, passo 4: COMO PAGAR ---------------- */}
      <section className="section" id="pagamento" aria-labelledby="pagamento-titulo">
        <div className="section__head">
          <span className="kicker">04 — O pagamento</span>
          <h2 id="pagamento-titulo">Como pagar</h2>
          <p className="section__lede">
            As duas formas valem nos dois caminhos — no balcão do evento e na
            compra online.
          </p>
        </div>

        {/*
          Os emojis sao §7 e ficam `aria-hidden`: 💳 tem nome acessivel proprio
          ("cartao de credito"), e sem esconde-lo o leitor de tela anunciaria
          "cartao de credito cartao de credito".

          A NOTA DO CARTAO NAO PROMETE "SEM JUROS". Doze parcelas e fato do
          sistema (o Brick do Mercado Pago e criado com maxInstallments: 12 em
          src/components/pagamento.tsx); juros sao do emissor e ninguem os
          conferiu. O valor real de cada parcela aparece no checkout, vindo do
          provedor — prometer aqui o que nao foi verificado e a mesma familia de
          erro que imprimir frete zero.
        */}
        <ul className="pagamentos-aceitos">
          <li className="pagamento-chip">
            <span aria-hidden="true">💳</span> Cartão de crédito
            <span className="pagamento-chip__nota">
              Em até 12x — o valor das parcelas aparece no checkout
            </span>
          </li>
          <li className="pagamento-chip">
            <span aria-hidden="true">⚡</span> PIX
            <span className="pagamento-chip__nota">
              QR Code e copia e cola na hora da compra
            </span>
          </li>
        </ul>
      </section>

      {/* ---------------- §18, passo 5: COMO RECEBER ---------------- */}
      <section className="section section--panel" id="entrega" aria-labelledby="entrega-titulo">
        <div className="section__head">
          <span className="kicker">05 — A entrega</span>
          <h2 id="entrega-titulo">Como receber</h2>
          <p className="section__lede">
            Dois caminhos para o mesmo kit. O de baixo depende de estoque; o de
            cima, não.
          </p>
        </div>

        {/*
          §7 e §8 lado a lado, com o MESMO peso visual. O modificador
          `--destaque` marca qual dos dois esta disponivel agora, nunca qual a
          loja prefere vender: enquanto ha kit no evento, presencial e o
          caminho de quem esta la; quando o lote acaba, o destaque passa para o
          online, que e o unico que continua de pe (pre-venda sem teto, §4).
          Sem linha de estoque presencial (o kit nao entra no evento) nenhum
          dos dois e destacado — a pagina nao sabe o suficiente para opinar.
        */}
        <div className="entrega-opcoes">
          <article
            className={
              'entrega-card'
              + (presencial && !esgotado ? ' entrega-card--destaque' : '')
              + (esgotado ? ' entrega-card--indisponivel' : '')
            }
          >
            <h3 className="entrega-card__titulo">Presencial, no evento</h3>
            <p className="entrega-card__prazo">Comprou → Pagou → Levou na hora.</p>
            <p>
              {lancado
                ? 'Compra feita na hora, com a equipe Milagran: você paga e sai com o kit na mão.'
                : 'No dia 25 de agosto, no evento de lançamento: você compra, paga e sai com o kit na mão.'}
            </p>
            <ul className="entrega-card__lista">
              <li>Sem frete e sem espera.</li>
              <li>Pagamento por PIX ou cartão, no balcão.</li>
              {/* A terceira linha so existe quando ha lote: sem cadastro de
                  estoque presencial a pagina nao sabe quantos kits foram
                  separados, e nao ha numero a chutar. */}
              {esgotado && <li>Os kits separados para o evento acabaram.</li>}
              {presencial && !esgotado && presencial.total > 0 && (
                <li>Enquanto durarem os {presencial.total} kits separados para o evento.</li>
              )}
            </ul>
          </article>

          <article className={'entrega-card' + (esgotado ? ' entrega-card--destaque' : '')}>
            <h3 className="entrega-card__titulo">Online, pelos Correios</h3>
            <p className="entrega-card__prazo">Comprou → Pagou → Recebe pelos Correios.</p>
            <p>
              Compra pelo site, de qualquer cidade. O frete e o prazo aparecem no
              checkout, calculados a partir do seu CEP.
            </p>
            <ul className="entrega-card__lista">
              <li>Sem limite de unidades: a loja online não esgota.</li>
              <li>Pagamento por PIX ou cartão de crédito.</li>
              <li>Código de rastreio assim que o pedido é postado.</li>
            </ul>
          </article>
        </div>

        {/*
          §3. A frase da pre-venda NAO e reescrita aqui: ela e a constante
          AVISO_PRE_VENDA de src/lib/tempo.ts, a mesma que o checkout mostra.
          Duas telas escrevendo a propria versao do prazo e como duas
          superficies prometerem fretes diferentes para a mesma compra.

          `lancamentoJaOcorreu` decide o TEMPO VERBAL da pagina: antes de 25/08
          a loja fala no futuro (os pedidos ainda serao liberados) e depois ela
          fala no presente. Depois do lancamento a frase de pre-venda sai de
          cena inteira — mante-la seria a loja continuar avisando sobre uma
          espera que nao existe mais.
        */}
        {lancado ? (
          <p className="aviso-prevenda" data-testid="prazo-online">
            <strong>Pedidos liberados.</strong> O lançamento oficial da Milagran
            aconteceu em 25 de agosto de 2026 e os pedidos online já são enviados
            pelos Correios, com prazo calculado no checkout a partir do seu CEP.
          </p>
        ) : (
          <p className="aviso-prevenda" data-testid="prazo-online">
            <strong>Pré-venda.</strong> No dia 25 de agosto os pedidos serão
            liberados. {AVISO_PRE_VENDA}
          </p>
        )}
      </section>

      {/* ---------------- §18, passo 6: COMPRAR ---------------- */}
      {/*
        A COMPRA ACONTECE AQUI, na propria pagina — o checkout inteiro, e nao
        um botao para outra tela.

        E o mesmo padrao da LP de recrutamento (public/seja-representante.html),
        cuja ultima secao traz o formulario de candidatura embutido em vez de
        um link. Quem leu os seis blocos de argumento age no lugar onde ja
        esta; mandar para outra URL nesse ponto e pedir para o visitante
        recomecar a decisao numa tela que ele nunca viu.

        `CheckoutWizard` e client component e a home e server component — o
        Next monta os dois sem ceremonia. Ele ja e autocontido: carrega o
        proprio estado, cota o frete e cria o pedido. Nao existe uma segunda
        implementacao de checkout nesta pagina.
      */}
      <section className="section" id="comprar" aria-labelledby="comprar-titulo">
        <div className="section__head">
          <span className="kicker">06 — A compra</span>
          <h2 id="comprar-titulo">Comprar o kit</h2>
          <p className="section__lede">
            {esgotado
              ? 'Os kits do evento acabaram, mas a loja online continua aberta e não tem limite de unidades. Pague com PIX ou cartão de crédito.'
              : 'Escolha a quantidade e finalize aqui mesmo. O pagamento é por PIX ou cartão de crédito.'}
          </p>
        </div>

        {/*
          `kit` e nao-nulo aqui por construcao: o catalogo vazio ja encerrou a
          pagina no retorno antecipado la em cima, com o estado vazio honesto.
          Repetir a checagem seria codigo morto — e, pior, sugeriria um segundo
          estado vazio que nunca renderiza.
        */}
        <CheckoutWizard kit={kit} quantidadeInicial={1} cupomInicial={cupomInicial} />
      </section>
    </>
  )
}

/**
 * O topo da pagina, compartilhado pelo caminho normal e pelo estado vazio —
 * sem catalogo, o visitante continua vendo de quem e a pagina em vez de uma
 * tela em branco.
 *
 * `children` e o miolo que so existe quando ha kit: preco, contador e CTA.
 */
function Hero({ lancado, children }: { lancado: boolean; children?: React.ReactNode }) {
  return (
    <section className="hero hero--loja">
      <p className="eyebrow">
        {lancado
          ? 'Lançamento oficial realizado em 25 de agosto de 2026'
          : 'Pré-venda · lançamento oficial em 25 de agosto de 2026'}
      </p>

      {/*
        A manchete de §6 e uma frase so, quebrada em duas tipografias: o nome
        no traco de display da marca e o resto no italico. O {' '} entre os dois
        <span> e SEMANTICO, nao formatacao — o nome acessivel do titulo
        concatena os nos de texto sem separador, e sem ele o leitor de tela (e
        o `getByRole('heading', { name })` do teste) ouviria "A
        MILAGRANESTÁ OFICIALMENTE NO MERCADO.". Mesma armadilha ja documentada
        em src/components/cabecalho.tsx.
      */}
      <h1 className="hero__title">
        <span className="serif-display">{MANCHETE_DESTAQUE}</span>{' '}
        <span className="script">{MANCHETE_RESTO}</span>
      </h1>

      <p className="hero__subtitle">{SUBTITULO}</p>

      {children}
    </section>
  )
}
