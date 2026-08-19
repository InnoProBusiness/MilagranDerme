'use client'

// CLIENT COMPONENT por causa do stepper de quantidade: `quantidade` e estado e
// os botoes +/- sao eventos. Nada mais nesta tela precisa de navegador — o
// preco, o registro ANVISA e o saldo de estoque chegam prontos do servidor
// (paginas `force-dynamic`), e e por isso que a vitrine NAO faz polling: quem
// mostra numero que muda sozinho e src/components/contador-estoque.tsx.
import { useState } from 'react'
import type { Kit } from '@/repositories/produtos'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { formatarBRL } from '@/lib/money'
import { textoAnvisa } from '@/lib/anvisa'
import type { AvisoEscassez } from '@/lib/escassez'
import { LinhaFrete } from '@/components/linha-frete'
import { linkDeCheckout } from '@/lib/cupom-da-url'

type Representante = { nome: string; slug: string }

/**
 * O lote PRESENCIAL do lancamento de 25/08/2026 (§5 e §11), do jeito que a
 * tela precisa dele: o saldo vivo, o tamanho do lote e a frase pronta de
 * src/lib/escassez.ts. Nasce inteiro ou nao nasce — ver o `| null` abaixo.
 *
 * `escassez === null` significa NAO HA LOTE PRESENCIAL para este kit (nenhuma
 * linha em `estoques` para o canal presencial), e nao "ainda nao carregou" nem
 * "zero". A tela entao nao mostra contador nenhum: um kit que nunca teve caixa
 * no evento nao pode anunciar "Kits disponíveis: 0" nem "os 0 kits foram
 * esgotados", que sao frases falsas sobre um lote inexistente. Mesmo contrato
 * que GET /api/estoque ja devolve (src/app/api/estoque/route.ts), e a mesma
 * disciplina do frete: sem numero verdadeiro, a tela cala.
 */
type Escassez = {
  disponivel: number
  total: number
  aviso: AvisoEscassez
}

type VitrineProps = {
  kits: Kit[]
  representante: Representante | null
  /**
   * OBRIGATORIA mesmo aceitando `null`, pelo mesmo motivo do `valor` de
   * src/components/linha-frete.tsx: opcional, uma pagina esquecida esconderia
   * o gatilho de escassez em silencio no dia do evento. Obrigatoria, o
   * compilador aponta cada rota que renderiza a vitrine e cada uma decide
   * conscientemente entre um lote e a ausencia dele.
   */
  escassez: Escassez | null
  /**
   * Cupom que veio no link de campanha (`/r/maria?cupom=PRE800`), ja
   * normalizado por cupomDaUrl. So VIAJA — a vitrine nao o exibe nem o valida;
   * ela o repassa ao checkout, que preenche o campo. Ver linkDeCheckout.
   *
   * OBRIGATORIA aceitando `''`, pelo mesmo motivo de `escassez` acima: opcional,
   * a pagina que esquecesse de repassar quebraria a campanha em silencio — o
   * link levaria ao checkout certo, sem o desconto anunciado, e ninguem
   * descobriria antes de a compradora reclamar do preco.
   */
  cupom: string
}

/**
 * DOIS TETOS INDEPENDENTES, e o segundo nasceu em 16/08/2026 com o lote
 * presencial (§5):
 *
 *   - QUANTIDADE_MAXIMA (20, src/lib/carrinho.ts) protege o BANCO: e o teto
 *     por linha que impede um erro de digitacao (ou um bot) de gerar um
 *     subtotal que estoura o int4 de pedido_itens.total_centavos. Vale sempre,
 *     em qualquer canal, tenha ou nao evento.
 *   - `disponivelPresencial` sao KITS FISICOS dentro de uma caixa no dia 25/08.
 *     Nao tem relacao nenhuma com o primeiro: um numero e limite de esquema, o
 *     outro e limite de mundo real. Por isso os dois sao aplicados juntos, e
 *     nao um "no lugar do" outro — trocar 20 por 50 no carrinho nao liberaria
 *     mais kits, e a caixa encher de novo nao libera o teto do banco.
 *
 * SALDO ZERO NAO VIRA TETO ZERO. Quantidade minima e 1 (nao existe pedido de
 * zero kit) e, quando o lote acaba, a tela troca a CTA por "COMPRAR ONLINE" —
 * e o canal online e pre-venda SEM TETO por decisao do cliente (§4). Travar o
 * stepper em 1 depois do esgotamento seria aplicar o limite da caixa do evento
 * a uma compra que nao sai mais dessa caixa. Enquanto HA lote, porem, o teto
 * aperta: um stepper que vai ate 20 logo abaixo de "Kits disponíveis: 3" faz a
 * mesma tela se contradizer sobre o mesmo lote.
 *
 * Numero nao-finito ou fracionario (SUM() do Postgres chegando como NULL ->
 * NaN, mesma armadilha documentada em src/lib/escassez.ts) cai no teto do
 * banco em vez de virar teto NaN, que desabilitaria o botao "+" para sempre.
 */
export function tetoDeQuantidade(disponivelPresencial: number | null): number {
  if (disponivelPresencial == null || !Number.isFinite(disponivelPresencial)) {
    return QUANTIDADE_MAXIMA
  }
  const kitsNaCaixa = Math.trunc(disponivelPresencial)
  if (kitsNaCaixa <= 0) return QUANTIDADE_MAXIMA
  return Math.min(QUANTIDADE_MAXIMA, kitsNaCaixa)
}

/**
 * Extraidas como funcoes puras (em vez de inline nos onClick) para que o
 * clamp em si tenha um teste que realmente o exercita. Os botoes tambem
 * ficam `disabled` no limite (ver abaixo) — o que e a defesa que o usuario
 * realmente ve e o que os testes de DOM verificam — mas o clamp aritmetico
 * aqui e a segunda linha de defesa (chamada direta da funcao, sem clique
 * nenhum) e precisa continuar coberta mesmo que o `disabled` mude amanha.
 */
export function diminuirQuantidade(quantidade: number): number {
  return Math.max(1, quantidade - 1)
}

/**
 * O segundo argumento e o saldo presencial CRU (ou `null` quando nao ha lote),
 * nao um teto ja calculado: quem sabe transformar saldo em teto e
 * `tetoDeQuantidade`, e essa regra precisa valer igual para o clique e para o
 * atributo `disabled` do botao. Passar o teto pronto abriria a porta para a
 * tela desabilitar o "+" em um numero e o clamp permitir outro.
 */
export function aumentarQuantidade(
  quantidade: number,
  disponivelPresencial: number | null,
): number {
  return Math.min(tetoDeQuantidade(disponivelPresencial), quantidade + 1)
}

export function Vitrine({ kits, representante, escassez, cupom }: VitrineProps) {
  const kit = kits[0]
  const [quantidade, setQuantidade] = useState(1)

  if (!kit) {
    return (
      <section className="section vitrine">
        <p className="kicker">Loja Milagran</p>
        <p>Nenhum kit disponivel no momento.</p>
      </section>
    )
  }

  const resumo = montarCarrinho([{
    kitId: kit.id,
    nome: kit.nome,
    precoUnitario: kit.precoCentavos,
    quantidade,
  }])

  const disponivelPresencial = escassez?.disponivel ?? null
  const teto = tetoDeQuantidade(disponivelPresencial)

  /*
    Deriva do MESMO aviso que escreve a frase na tela, e nao de uma segunda
    comparacao com zero — identico ao que GET /api/estoque faz com o campo
    `esgotado` (src/app/api/estoque/route.ts). Com duas contas independentes,
    bastaria um saldo negativo ou um limiar mudado em src/lib/escassez.ts para
    a tela dizer "Últimos 0 kits" com a CTA de compra presencial ainda ligada.
  */
  const esgotado = escassez !== null && escassez.aviso.nivel === 'esgotado'

  return (
    <section className="section vitrine">
      {representante && (
        <p className="kicker">Representante oficial: {representante.nome}</p>
      )}

      <div className="vitrine__produto">
        <h1>{kit.nome}</h1>
        <p className="vitrine__descricao">{kit.descricao}</p>
        {/*
          Esta e a UNICA linha da tela que mostra o preco sozinho, sem
          rotulo grudado no mesmo no de texto. As linhas do resumo abaixo
          ("Valor unitário: ", "Subtotal: ", "Total: ") sempre embutem o
          rotulo no proprio texto por design: com um unico kit, quantidade 1
          e frete ainda nao cotado, valor unitario, subtotal e total sao
          literalmente o mesmo valor formatado — sem essa distincao textual,
          um leitor de tela ou uma consulta por texto exato nao teria como
          saber qual das linhas esta olhando.

          A linha "Valor unitário" do resumo (§9) NASCEU dessa mesma regra em
          16/08/2026: ela e o quarto lugar da tela a imprimir o preco do kit e,
          por isso, entrou com rotulo no texto e com data-testid proprio
          ("valor-unitario"), enquanto esta aqui — o preco de vitrine, em
          destaque — mantem o seu ("preco-unitario"). Duas superficies do mesmo
          numero, cada uma identificavel sozinha.
        */}
        <p className="vitrine__preco" data-testid="preco-unitario">
          {formatarBRL(kit.precoCentavos)}
        </p>
      </div>

      {/*
        GATILHO DE ESCASSEZ (§5, §11). So existe quando ha lote presencial —
        ver o comentario do tipo Escassez sobre por que `null` nao vira zero.
        A classe de nivel usa o valor EXATO de NivelEscassez, que e o contrato
        combinado com o CSS (.escassez--normal|poucos|ultimos|esgotado em
        src/app/globals.css); nao existe mapa intermediario para desatualizar.
      */}
      {escassez && (
        <div
          className={`escassez escassez--${escassez.aviso.nivel}`}
          data-testid="escassez"
        >
          <span className="escassez__pulso" aria-hidden="true" />
          {/*
            O numerao (ou o selo, quando acabou) e DECORACAO: o mesmo numero
            aparece por extenso na frase ao lado. Sem aria-hidden, o leitor de
            tela anunciaria "3. Kits disponíveis: 3. Restam apenas 3 kits...".
            ESGOTADO troca o numero por um selo em caixa alta porque um "0"
            grande e ambiguo a distancia — pode ser lido como o comeco de outro
            numero; a palavra nao e.
          */}
          {esgotado ? (
            <span className="escassez__selo" aria-hidden="true">Esgotado</span>
          ) : (
            <span className="escassez__numero" aria-hidden="true">
              {escassez.disponivel}
            </span>
          )}
          <p className="escassez__mensagem">
            {/*
              Duas informacoes diferentes, de proposito, e cada uma com o seu
              testid: o CONTADOR e o numero cru do saldo ("Kits disponíveis: 3
              de 50"), e o AVISO e a leitura editorial dele, com a copy exata
              aprovada pelo cliente. Escrever a frase aqui na mao faria a
              vitrine discordar do balcao e do contador da home sobre o mesmo
              lote — a licao inteira esta no cabecalho de src/lib/escassez.ts.
            */}
            <span data-testid="kits-disponiveis">
              Kits disponíveis: {escassez.disponivel} de {escassez.total}
            </span>{' '}
            <span data-testid="aviso-escassez">{escassez.aviso.mensagem}</span>
          </p>
        </div>
      )}

      <div className="vitrine__stepper" role="group" aria-label="Quantidade">
        <button
          type="button"
          className="vitrine__stepper-btn"
          aria-label="Diminuir quantidade"
          disabled={quantidade <= 1}
          onClick={() => setQuantidade(diminuirQuantidade)}
        >
          −
        </button>
        <span className="vitrine__stepper-valor" data-testid="quantidade">
          {quantidade}
        </span>
        <button
          type="button"
          className="vitrine__stepper-btn"
          aria-label="Aumentar quantidade"
          // O MESMO teto que o clamp usa, calculado uma vez so acima: o
          // atributo que o usuario ve e a aritmetica que o clique executa nao
          // podem divergir.
          disabled={quantidade >= teto}
          onClick={() => setQuantidade((q) => aumentarQuantidade(q, disponivelPresencial))}
        >
          +
        </button>
      </div>

      <div className="vitrine__resumo">
        {/* §9: o comprador ve o preco de UMA unidade mesmo depois de subir a
            quantidade — sem esta linha, um subtotal de R$ 3.000,00 nao diz de
            onde veio. Ver o comentario do preco em destaque, acima, sobre por
            que o rotulo esta grudado no mesmo no de texto. */}
        <p className="vitrine__linha" data-testid="valor-unitario">
          Valor unitário: {formatarBRL(kit.precoCentavos)}
        </p>
        <p className="vitrine__linha" data-testid="subtotal">
          Subtotal: {formatarBRL(resumo.subtotal)}
        </p>
        {/*
          Frete: componente unico compartilhado pelas quatro telas que falam de
          frete — ver src/components/linha-frete.tsx. `null` aqui NAO e "frete
          zero": a vitrine nao conhece o CEP do visitante e por isso nao tem o
          que cotar (a cotacao acontece no passo 3 do checkout, §13). O
          componente traduz esse `null` em "Calculado no checkout, a partir do
          seu CEP" — nunca em "R$ 0,00", que prometeria frete gratis que
          ninguem decidiu.
        */}
        <LinhaFrete valor={null} />
        {/*
          "+ frete" NAO E ENFEITE: e o que impede esta linha de mentir.
          O numero e subtotal - desconto + frete com frete = 0 (default de
          montarCarrinho) porque ainda NAO HA frete cotado — a vitrine nao
          conhece o CEP do visitante. Sem o sufixo, a palavra "Total" logo
          abaixo de "Frete: calculado no checkout" prometia um valor final que
          a proxima tela desmentia: quem lesse "Total: R$ 1.000,00" e pagasse
          R$ 1.023,50 teria sido enganado, ainda que por pouco, na superficie
          principal de compra.
          Mesma disciplina de LinhaFrete, que traduz `null` em "a calcular" e
          nunca em "R$ 0,00" (ver src/components/linha-frete.tsx).
        */}
        <p className="vitrine__linha vitrine__linha--total" data-testid="total">
          Total: {formatarBRL(resumo.total)} + frete
        </p>
      </div>

      {/*
        DIVIDA PAGA EM 18/08/2026 — este era o antigo "DIVIDA DELIBERADA:
        um cosmetico nao pode ser vendido sem registro ANVISA". A situacao
        mudou por decisao, nao por esquecimento: o cliente declarou o
        enquadramento na Lei 15.154/2025 (producao artesanal, dispensada de
        registro previo), e o "em breve" — que prometia um numero que nunca
        vira — deixou de ser o estado honesto para ESTE kit.

        A frase vem de src/lib/anvisa.ts, a fonte unica: a home mostra a
        mesma situacao na secao do kit, e duas copies escritas a mao ja
        divergiram neste projeto (ver src/components/linha-frete.tsx). O
        "em breve" continua existindo la como default de kit futuro sem
        registro e sem declaracao.
      */}
      <p className="vitrine__anvisa" data-testid="anvisa">
        {textoAnvisa({ registro: kit.anvisaRegistro, dispensado: kit.anvisaDispensado })}
      </p>

      {/*
        MESMO DESTINO, ROTULO DIFERENTE (§5). O checkout sempre foi o caminho
        online; o que o esgotamento do lote presencial muda e a EXPECTATIVA de
        quem clica — antes de acabar, "Continuar" pode terminar com o kit na
        mao no dia 25/08; depois, so existe a compra com envio. Trocar o texto
        para "COMPRAR ONLINE" e o que impede alguem de entrar na fila do balcao
        atras de um kit que nao esta mais na caixa. A CTA continua LEVANDO a
        algum lugar: esgotar o lote do evento nao fecha a loja.
      */}
      <a
        className="btn btn--solid vitrine__cta"
        href={linkDeCheckout(kit.slug, quantidade, cupom)}
        data-testid="cta"
      >
        {esgotado ? 'COMPRAR ONLINE' : 'Continuar'}
      </a>
    </section>
  )
}
