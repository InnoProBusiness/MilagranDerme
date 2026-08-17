'use client'

/**
 * O BALCAO DO EVENTO DE 25/08 (§10 do documento do cliente de 16/08/2026).
 *
 * ESTA TELA E OPERADA EM PE, COM FILA NA FRENTE, num celular ou tablet que o
 * vendedor olha de longe entre um comprador e outro. Todo desenho abaixo sai
 * dessa cena, e nao de gosto:
 *
 *   - UMA TELA SO, de cima para baixo (kit, quantidade, comprador, pagamento,
 *     confirmar). O checkout online e um wizard de quatro passos porque quem
 *     compra esta sentado em casa e pode voltar; aqui cada passo a mais e um
 *     toque a mais com gente esperando, e um passo escondido e um campo que o
 *     vendedor esquece de conferir.
 *   - O DESFECHO E ENORME. `.venda__aprovada` e `.venda__erro`
 *     (src/app/globals.css) tem o MESMO peso visual por decisao explicita: a
 *     tentacao de deixar o erro discreto e o que produz o pior desfecho
 *     possivel neste balcao — kit entregue com a venda nao registrada.
 *   - VERMELHO AQUI NAO QUER DIZER "DEU ERRO", QUER DIZER "NAO ENTREGUE O
 *     KIT". Por isso o Pix pendente — que e o caminho FELIZ do balcao — sai em
 *     vermelho igual a um cartao recusado: as duas situacoes pedem exatamente
 *     a mesma acao do vendedor (segure o kit), e e essa a unica leitura que
 *     nao pode falhar a um metro de distancia. Verde e so quando o kit pode
 *     sair da mao.
 *
 * A REGRA QUE ESTE ARQUIVO EXISTE PARA CUMPRIR esta escrita por extenso em
 * src/app/api/vendas-presenciais/route.ts: TODA resposta posterior ao COMMIT
 * carrega `vendaRegistrada: true` com `numero` e `token` — INCLUSIVE os erros
 * (402 cartao recusado, 502 provedor fora, 500 falha nossa). Um front que
 * olhasse so `response.ok` mostraria "VENDA APROVADA" para um cartao negado e
 * o vendedor entregaria o kit; um front que tratasse todo erro como "nao
 * aconteceu nada" faria o vendedor refazer a venda, baixando uma SEGUNDA
 * unidade da caixa por um kit so. As duas leituras erradas custam dinheiro em
 * direcoes opostas, e as duas sao evitadas por `interpretarResposta` abaixo.
 *
 * 'use client': estado (quantidade, dados do comprador, desfecho, saldo) e
 * duas coisas que so existem no navegador — o clique de confirmar e o POST em
 * /api/vendas-presenciais.
 */

import { useRef, useState } from 'react'
import type { Kit } from '@/repositories/produtos'
import type { PapelUsuario } from '@/repositories/usuarios'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { formatarBRL } from '@/lib/money'

/**
 * O saldo do lote presencial como o BALCAO precisa dele. `null` significa que
 * NAO EXISTE linha de estoque presencial para este kit — mesmo contrato de
 * `escassez: null` em src/components/vitrine.tsx e de `presencial: null` em
 * GET /api/estoque. Nao e "zero" e nao e "ainda nao carregou": e um kit que
 * nunca teve caixa no evento, e a tela nao inventa contador para ele.
 */
export type SaldoDoBalcao = {
  disponivel: number
  total: number
}

type Vendedor = {
  nome: string
  papel: PapelUsuario
}

type Props = {
  vendedor: Vendedor
  kit: Kit
  /**
   * OBRIGATORIA mesmo aceitando `null`, pelo mesmo motivo do `escassez` da
   * vitrine: opcional, uma pagina esquecida esconderia o contador de kits em
   * silencio no dia do evento. Obrigatoria, cada rota que renderiza o balcao
   * decide conscientemente entre um lote e a ausencia dele.
   */
  saldoInicial: SaldoDoBalcao | null
}

type DadosDoComprador = {
  nome: string
  email: string
  cpf: string
  whatsapp: string
}

const DADOS_VAZIOS: DadosDoComprador = { nome: '', email: '', cpf: '', whatsapp: '' }

/**
 * Mesmas regras do Zod de src/app/api/vendas-presenciais/route.ts, repetidas
 * aqui SO para habilitar o botao mais cedo. Quem decide se a venda acontece e
 * sempre o servidor — isto e UX, nunca fonte de verdade. Frouxo demais e um
 * 422 na cara do vendedor; rigido demais e uma venda travada por um formato
 * que o servidor aceitaria.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function somenteDigitos(v: string): string {
  return v.replace(/\D/g, '')
}

function dadosCompletos(d: DadosDoComprador): boolean {
  return d.nome.trim().length >= 3
    && EMAIL_REGEX.test(d.email.trim())
    && /^\d{11}$/.test(d.cpf)
    && /^\d{10,13}$/.test(d.whatsapp)
}

/**
 * O TETO DE QUANTIDADE DO BALCAO E DIFERENTE DO DA VITRINE, e a diferenca e o
 * ponto.
 *
 * `tetoDeQuantidade` (src/components/vitrine.tsx) devolve QUANTIDADE_MAXIMA
 * quando o lote presencial esta zerado, e esta certo LA: quando a caixa do
 * evento acaba, a vitrine troca a CTA por "COMPRAR ONLINE" e a compra passa
 * para um canal que e pre-venda sem teto (§4). Aplicar o limite da caixa a uma
 * compra que nao sai mais dessa caixa seria absurdo.
 *
 * AQUI NAO EXISTE canal online: o balcao so vende o que esta dentro da caixa.
 * Saldo zerado tem que travar o stepper em 1 — nao em 20 —, senao a tela
 * convida o vendedor a montar uma venda de dez kits que o servidor vai recusar
 * inteira, com a fila parada. Nao trava em 0 porque nao existe venda de zero
 * kit; quem recusa a venda com a caixa vazia e o 409 da rota, que e a unica
 * autoridade sobre o saldo.
 *
 * NaN (SUM() do Postgres chegando como NULL, a armadilha ja documentada em
 * src/lib/escassez.ts) cai no teto do banco em vez de virar teto NaN, que
 * desabilitaria o "+" para sempre e em silencio.
 */
export function tetoDoBalcao(disponivel: number | null): number {
  if (disponivel === null || !Number.isFinite(disponivel)) return QUANTIDADE_MAXIMA
  const naCaixa = Math.trunc(disponivel)
  if (naCaixa <= 0) return 1
  return Math.min(QUANTIDADE_MAXIMA, naCaixa)
}

/**
 * O QUE O VENDEDOR PRECISA SABER, EM DOIS BOOLEANOS.
 *
 * `registrada` responde "a venda existe no banco e a unidade ja saiu da
 * caixa?" e `entregar` responde "posso passar o kit para a mao dele agora?".
 * As duas perguntas sao INDEPENDENTES — o caso 402 (venda registrada, cartao
 * recusado) e exatamente o par (true, false) — e e por elas serem duas que a
 * tela nao tem estado ambiguo.
 *
 * `podeTentarDeNovo` e a terceira pergunta, a que evita o prejuizo simetrico:
 * quando a venda JA foi registrada (ou quando nao ha como saber), reenviar
 * este formulario criaria um SEGUNDO pedido e uma SEGUNDA baixa por um kit so.
 * Nesses casos o formulario sai da tela e o caminho e "Nova venda" (proximo
 * comprador) ou a pagina do pedido (cobrar de novo o MESMO pedido).
 */
export type Desfecho = {
  registrada: boolean
  entregar: boolean
  podeTentarDeNovo: boolean
  /** Legivel a distancia. O CSS ja poe em caixa alta. */
  titulo: string
  /** UMA frase dizendo, sem rodeio, se a venda foi registrada e se pode entregar. */
  frase: string
  /** A mensagem curada pelo servidor, quando ha uma. Nunca o `error` cru. */
  detalhe: string | null
  numero: number | null
  token: string | null
  pix: { copiaECola: string; qrBase64: string } | null
  /** Saldo real informado pelo servidor no 409 — mais confiavel que o local. */
  disponivelInformado: number | null
}

const SEM_CORPO: Record<string, unknown> = {}

function objeto(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : SEM_CORPO
}

function textoNaoVazio(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function inteiro(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * OS ERROS QUE ACONTECEM ANTES DO COMMIT — a lista fechada de codigos com que
 * src/app/api/vendas-presenciais/route.ts recusa a venda SEM ter gravado nada.
 * `nao_autenticado` e `acesso_negado` vem de exigirPapel (src/lib/guarda.ts),
 * que roda como primeira linha da rota.
 *
 * A LISTA E FECHADA DE PROPOSITO, e a direcao do "senao" e a parte importante:
 * qualquer resposta de erro que NAO traga um destes codigos cai em INCERTA, e
 * nao em "nao foi registrada". O motivo e concreto — um 502 do Traefik, um
 * corpo HTML de gateway, um JSON que nao deu para ler: nenhum deles prova que
 * a transacao nao commitou, e tratar essa duvida como "nada aconteceu" e
 * exatamente o que faz o vendedor refazer a venda e tirar duas unidades da
 * caixa por um kit so. Na duvida, a tela para e manda conferir.
 */
const ERROS_ANTES_DO_COMMIT: readonly string[] = [
  'nao_autenticado',
  'acesso_negado',
  'dados_invalidos',
  'kit_indisponivel',
  'estoque_esgotado',
  'estoque_nao_configurado',
  'nao_foi_possivel_registrar_a_venda',
  'method_not_allowed',
]

/** O estado que nenhuma tela gosta de ter e toda tela de dinheiro precisa. */
function desfechoIncerto(motivo: string): Desfecho {
  return {
    registrada: false,
    entregar: false,
    // Reenviar seria a pior saida possivel: se a venda commitou, o reenvio
    // grava um segundo pedido e uma segunda baixa.
    podeTentarDeNovo: false,
    titulo: 'Confira antes de continuar',
    frase:
      'NÃO é possível saber se a venda foi registrada. NÃO entregue o kit e NÃO refaça esta venda: '
      + 'confira no painel (ou com o administrador) se o pedido existe antes de qualquer outra coisa. '
      + 'O contador de kits abaixo pode estar desatualizado.',
    detalhe: motivo,
    numero: null,
    token: null,
    pix: null,
    disponivelInformado: null,
  }
}

/**
 * Traduz status + corpo de POST /api/vendas-presenciais no desfecho que a tela
 * mostra. FUNCAO PURA E EXPORTADA de proposito: e a regra que decide se um kit
 * sai da caixa, e ela precisa de teste direto, sem passar por clique nenhum.
 *
 * A ordem dos ramos e deliberada — `vendaRegistrada` e lido ANTES de qualquer
 * coisa relacionada a `response.ok`, porque e ele, e nao o codigo HTTP, que
 * responde "a unidade saiu do estoque?".
 */
export function interpretarResposta(status: number, corpo: unknown): Desfecho {
  const c = objeto(corpo)
  const registrada = c.vendaRegistrada === true
  const numero = inteiro(c.numero)
  const token = textoNaoVazio(c.token)
  const mensagem = textoNaoVazio(c.mensagem)
  const erro = textoNaoVazio(c.error)
  const pagamento = objeto(c.pagamento)
  const daVenda = numero === null ? 'A venda' : `A venda nº ${numero}`

  if (registrada) {
    /**
     * O UNICO PAR DE CAMPOS QUE AUTORIZA A ENTREGA DO KIT.
     *
     * `pagamento.pedidoPago` e o campo que a rota devolve no 201 de cartao
     * ("O unico campo que autoriza a entrega do kit no ato", diz o comentario
     * de la); `status === 'aprovado'` cobre o caso em que o provedor ja
     * devolveu a cobranca liquidada. Pix nasce PENDENTE — o QR aparece, o
     * comprador paga, o WEBHOOK confirma —, entao ele NUNCA cai aqui pelo 201,
     * e e por isso que esta tela nao pode anunciar aprovacao por `response.ok`.
     */
    const pago = pagamento.pedidoPago === true || pagamento.status === 'aprovado'

    if (status >= 200 && status < 300 && pago) {
      return {
        registrada: true,
        entregar: true,
        podeTentarDeNovo: false,
        titulo: 'Venda aprovada',
        frase: `${daVenda} está registrada e paga. Pode entregar o kit.`,
        detalhe: mensagem,
        numero,
        token,
        pix: null,
        disponivelInformado: null,
      }
    }

    if (status >= 200 && status < 300) {
      const copiaECola = textoNaoVazio(pagamento.pixCopiaECola)
      const qrBase64 = textoNaoVazio(pagamento.pixQrBase64)
      return {
        registrada: true,
        entregar: false,
        podeTentarDeNovo: false,
        titulo: 'Aguardando pagamento',
        frase:
          `${daVenda} está registrada e a unidade já saiu da caixa, mas o pagamento ainda NÃO foi `
          + 'confirmado. NÃO entregue o kit até a confirmação.',
        detalhe: mensagem,
        numero,
        token,
        pix: copiaECola && qrBase64 ? { copiaECola, qrBase64 } : null,
        disponivelInformado: null,
      }
    }

    // 402 (cartao recusado), 502 (provedor fora) e 500 (falha nossa) depois do
    // COMMIT. Titulos diferentes porque o conserto e diferente, mas a frase
    // termina igual nos tres: a venda existe e o kit nao sai.
    return {
      registrada: true,
      entregar: false,
      podeTentarDeNovo: false,
      titulo: erro === 'pagamento_recusado' ? 'Pagamento recusado' : 'Cobrança não criada',
      frase:
        `${daVenda} está registrada e a unidade já saiu da caixa, mas o pagamento NÃO aconteceu. `
        + 'NÃO entregue o kit. Cobre de novo pelo MESMO pedido, no link abaixo — refazer a venda '
        + 'tiraria um segundo kit da caixa.',
      detalhe: mensagem,
      numero,
      token,
      pix: null,
      disponivelInformado: null,
    }
  }

  // Daqui para baixo a venda NAO foi registrada — ou nao da para saber.
  if (erro === null || !ERROS_ANTES_DO_COMMIT.includes(erro)) {
    return desfechoIncerto(
      mensagem
      ?? `O sistema respondeu ${status} sem dizer se a venda foi registrada.`,
    )
  }

  if (erro === 'estoque_esgotado') {
    return {
      registrada: false,
      entregar: false,
      podeTentarDeNovo: true,
      titulo: 'Sem kit na caixa',
      frase: 'A venda NÃO foi registrada e nenhum kit saiu da caixa. Não entregue nada.',
      // A rota manda duas mensagens diferentes aqui — "restam N, ajuste a
      // quantidade" e "acabaram, ofereça a compra online" —, e as duas pedem
      // acoes diferentes do vendedor. Por isso o texto do servidor e exibido
      // como esta, sem a tela reescrever nada por cima.
      detalhe: mensagem,
      numero: null,
      token: null,
      pix: null,
      // O saldo REAL, lido dentro da transacao que recusou a venda: mais
      // confiavel que o contador local, que e um retrato do carregamento da
      // pagina e nao viu as vendas dos outros aparelhos do evento.
      disponivelInformado: inteiro(c.disponivel),
    }
  }

  if (erro === 'estoque_nao_configurado') {
    return {
      registrada: false,
      entregar: false,
      podeTentarDeNovo: true,
      titulo: 'Estoque não configurado',
      frase:
        'A venda NÃO foi registrada e nenhum kit saiu da caixa. Não entregue nada e não tente '
        + 'reduzir a quantidade: nenhuma quantidade vai passar enquanto o lote não for criado.',
      detalhe: mensagem,
      numero: null,
      token: null,
      pix: null,
      disponivelInformado: null,
    }
  }

  if (erro === 'nao_autenticado' || erro === 'acesso_negado') {
    return {
      registrada: false,
      entregar: false,
      podeTentarDeNovo: true,
      titulo: 'Sessão encerrada',
      frase:
        'A venda NÃO foi registrada e nenhum kit saiu da caixa. Entre de novo para continuar '
        + 'vendendo — os dados digitados continuam na tela.',
      detalhe: mensagem,
      numero: null,
      token: null,
      pix: null,
      disponivelInformado: null,
    }
  }

  return {
    registrada: false,
    entregar: false,
    podeTentarDeNovo: true,
    titulo: 'Venda não registrada',
    frase: 'A venda NÃO foi registrada e nenhum kit saiu da caixa. Confira os dados e tente de novo.',
    detalhe: mensagem,
    numero: null,
    token: null,
    pix: null,
    disponivelInformado: null,
  }
}

export function VendaPresencial({ vendedor, kit, saldoInicial }: Props) {
  const [quantidade, setQuantidade] = useState(1)
  const [dados, setDados] = useState<DadosDoComprador>(DADOS_VAZIOS)
  const [enviando, setEnviando] = useState(false)
  const [desfecho, setDesfecho] = useState<Desfecho | null>(null)
  const [saldo, setSaldo] = useState<SaldoDoBalcao | null>(saldoInicial)

  /**
   * SEGUNDA LINHA DE DEFESA CONTRA A VENDA DUPLA, alem do `disabled` do botao.
   *
   * O `disabled` so aparece depois de o React re-renderizar, e no celular do
   * balcao dois toques cabem folgadamente dentro do mesmo quadro — o segundo
   * chegaria a um botao que ainda esta habilitado no DOM. O `ref` e lido e
   * escrito na hora, dentro do mesmo handler, entao a segunda entrada volta
   * antes de tocar em `fetch`. Duas requisicoes aqui nao sao um clique
   * repetido: sao DOIS pedidos e DUAS baixas de estoque por um kit so.
   */
  const enviandoRef = useRef(false)

  const disponivel = saldo?.disponivel ?? null
  const teto = tetoDoBalcao(disponivel)
  // Se o teto encolheu (o 409 corrigiu o saldo para baixo), a quantidade que
  // esta na tela pode ter ficado acima dele. Clampar na renderizacao mantem o
  // resumo e o POST coerentes com o botao "+" desabilitado.
  const quantidadeEfetiva = Math.min(quantidade, teto)

  // O total NAO tem frete, e o zero aqui e um FATO do negocio e nao um
  // placeholder: venda presencial nao tem entrega porque o kit sai na mao do
  // comprador (§2). E a mesma distincao que FRETE_PRESENCIAL documenta em
  // src/app/api/vendas-presenciais/route.ts. Por isso esta tela nao renderiza
  // <LinhaFrete> — nao existe frete "a cotar" a anunciar.
  const resumo = montarCarrinho([{
    kitId: kit.id,
    nome: kit.nome,
    precoUnitario: kit.precoCentavos,
    quantidade: quantidadeEfetiva,
  }])

  const formularioVisivel = desfecho === null || desfecho.podeTentarDeNovo
  const podeConfirmar = !enviando && dadosCompletos(dados)

  function limparParaProximoComprador() {
    setDados(DADOS_VAZIOS)
    setQuantidade(1)
    setDesfecho(null)
  }

  function aplicarSaldo(d: Desfecho, vendidos: number) {
    setSaldo((atual) => {
      // Sem lote cadastrado nao ha contador para atualizar, e inventar um
      // agora seria pior do que nao ter: ver o comentario de SaldoDoBalcao.
      if (atual === null) return null
      // O numero do servidor manda sempre que existir: ele foi lido dentro da
      // transacao que recusou a venda.
      if (d.disponivelInformado !== null) {
        return { ...atual, disponivel: d.disponivelInformado }
      }
      // A BAIXA ACONTECE NO REGISTRO, NAO NO PAGAMENTO (a rota baixa o estoque
      // dentro da mesma transacao que cria o pedido, §10). Por isso o contador
      // cai tambem no 402 e no 502: a unidade saiu da caixa mesmo com o
      // pagamento recusado, e um contador que so caisse no sucesso prometeria
      // ao proximo da fila um kit que ja esta reservado.
      if (!d.registrada) return atual
      return { ...atual, disponivel: Math.max(0, atual.disponivel - vendidos) }
    })
  }

  async function confirmarVenda() {
    if (enviandoRef.current || !podeConfirmar) return

    enviandoRef.current = true
    setEnviando(true)
    setDesfecho(null)

    const vendidos = quantidadeEfetiva

    try {
      const resposta = await fetch('/api/vendas-presenciais', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /**
         * NENHUM CAMPO MONETARIO SAI DAQUI. O preco vem do catalogo dentro da
         * rota (buscarKitAtivoPorSlug + montarCarrinho) e o frete e a
         * constante FRETE_PRESENCIAL; o schema de la e `.strict()`, entao um
         * `total` neste corpo seria 422 — mas a garantia de verdade e esta
         * linha nunca existir. O que a tela calcula em `resumo` serve para o
         * vendedor dizer o valor em voz alta, e para mais nada.
         */
        body: JSON.stringify({
          kitSlug: kit.slug,
          quantidade: vendidos,
          metodo: METODO_DE_COBRANCA,
          nome: dados.nome.trim(),
          email: dados.email.trim(),
          cpf: dados.cpf,
          whatsapp: dados.whatsapp,
        }),
      })

      const corpo: unknown = await resposta.json().catch(() => null)
      const lido = interpretarResposta(resposta.status, corpo)
      setDesfecho(lido)
      aplicarSaldo(lido, vendidos)
    } catch {
      /**
       * A CONEXAO CAIU E NAO SABEMOS DE NADA. Este e o unico caminho em que a
       * tela nao tem informacao nenhuma sobre o que aconteceu do outro lado: a
       * requisicao pode ter chegado, commitado a venda e baixado a unidade
       * antes de o WiFi do evento cair. Dizer "falha de conexao, tente de
       * novo" aqui — o texto natural — mandaria o vendedor refazer uma venda
       * que talvez ja exista. O contador tambem NAO e mexido: nao ha o que
       * afirmar sobre ele.
       */
      setDesfecho(desfechoIncerto('A conexão caiu antes de a resposta chegar.'))
    }

    enviandoRef.current = false
    setEnviando(false)
  }

  return (
    <section className="section venda">
      <div className="venda__topo">
        <div>
          <p className="kicker">Balcão do evento</p>
          {/*
            O KIT E ESCOLHIDO PELA URL (?kit=<slug>), nao por um seletor nesta
            tela — ver src/app/venda/page.tsx. O catalogo do lancamento tem um
            kit so, e um <select> de uma opcao seria um toque a mais por
            comprador para uma escolha que nao existe. O nome e o preco ficam
            visiveis assim mesmo, que e o que o vendedor precisa conferir em
            voz alta.
          */}
          <h1>{kit.nome}</h1>
          <p className="venda__vendedor">Vendedor: {vendedor.nome}</p>
          {/*
            'admin' alcanca tudo que 'vendedor' alcanca (COBERTURA em
            src/lib/guarda.ts), entao quem administra o evento tambem vende
            nele e pode cair nesta tela. O link so aparece para ele porque
            /admin devolveria 403 para um vendedor — anunciar uma porta que vai
            fechar na cara nao ajuda ninguem no meio da fila.
          */}
          {vendedor.papel === 'admin' && (
            <a className="cabecalho__link" href="/admin">Painel administrativo</a>
          )}
        </div>

        {/*
          O CONTADOR DO OPERADOR, e nao o do comprador. A copy de
          src/lib/escassez.ts ("Últimos 3 kits disponíveis para compra
          presencial") fala com QUEM COMPRA sobre urgencia, e e usada na
          vitrine e no contador da home; aqui a pergunta e outra — quantas
          unidades ainda ha para vender —, e uma frase de escassez no balcao so
          apressaria o vendedor.

          O NUMERO VAI CRU, sem o clamp em zero que GET /api/estoque aplica na
          home: negativo e um estado real (ajuste de inventario maior que o
          saldo, ver `ajustarEstoque` em src/repositories/estoque.ts) e para o
          operador ele e informacao — a conferencia fisica e a contabilidade
          divergiram. Esconder isso do balcao seria esconder justamente de quem
          tem a caixa na frente e pode contar.
        */}
        {saldo !== null && (
          <p className="venda__restantes">
            <span className="venda__restantes-numero" data-testid="kits-restantes">
              {saldo.disponivel}
            </span>
            <span className="venda__restantes-rotulo">
              kits na caixa (de {saldo.total})
            </span>
          </p>
        )}
      </div>

      {/*
        ESTADO VAZIO HONESTO: sem lote presencial cadastrado nao existe numero
        verdadeiro, entao a tela nao mostra numero nenhum — nem "0", que
        anunciaria um esgotamento que nunca aconteceu. O aviso diz o que fazer.
        A venda continua tentavel de proposito: a autoridade sobre o estoque e
        a rota, e e melhor o vendedor receber o 409 explicito do servidor do
        que a tela adivinhar por ele.
      */}
      {saldo === null && (
        <div className="aviso aviso--atencao" role="status">
          <strong className="aviso__titulo">Sem lote do evento</strong>
          <p>
            Este kit não tem estoque presencial configurado, então não há contador de
            unidades para mostrar. Chame o administrador antes de vender.
          </p>
        </div>
      )}

      {desfecho !== null && <BlocoDeDesfecho desfecho={desfecho} saldo={saldo} />}

      {formularioVisivel && (
        <>
          <div className="venda__campos">
            <div className="vitrine__stepper" role="group" aria-label="Quantidade">
              <button
                type="button"
                className="vitrine__stepper-btn"
                aria-label="Diminuir quantidade"
                disabled={enviando || quantidadeEfetiva <= 1}
                // Parte do valor EFETIVO, nao do bruto em `quantidade`. Quando
                // o 409 corrige o saldo para baixo, o bruto pode ficar acima do
                // teto (pediu 3, restavam 2): decrementar o bruto ali gastaria
                // um toque sem mudar nada na tela, com a fila esperando.
                onClick={() => setQuantidade(Math.max(1, quantidadeEfetiva - 1))}
              >
                −
              </button>
              <span className="vitrine__stepper-valor" data-testid="quantidade">
                {quantidadeEfetiva}
              </span>
              <button
                type="button"
                className="vitrine__stepper-btn"
                aria-label="Aumentar quantidade"
                // O MESMO teto que o clique usa: o atributo que o vendedor ve e
                // a aritmetica nao podem divergir.
                disabled={enviando || quantidadeEfetiva >= teto}
                onClick={() => setQuantidade(Math.min(teto, quantidadeEfetiva + 1))}
              >
                +
              </button>
            </div>

            <div className="form__grid">
              <div className="form__field form__field--wide">
                <label htmlFor="comprador-nome">Nome completo</label>
                <input
                  id="comprador-nome"
                  autoComplete="off"
                  value={dados.nome}
                  disabled={enviando}
                  onChange={(e) => setDados({ ...dados, nome: e.target.value })}
                />
              </div>
              <div className="form__field">
                <label htmlFor="comprador-email">E-mail</label>
                <input
                  id="comprador-email"
                  type="email"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={dados.email}
                  disabled={enviando}
                  onChange={(e) => setDados({ ...dados, email: e.target.value })}
                />
              </div>
              <div className="form__field">
                {/*
                  CPF E OBRIGATORIO NO BALCAO, e isso e uma decisao tomada
                  contra o instinto de encurtar a fila — a rota explica por
                  extenso: clientes.cpf e NOT NULL com CHECK de onze digitos, e
                  o Mercado Pago recusa Pix sem identificacao do pagador. Uma
                  venda sem CPF nao seria mais rapida, seria uma venda que nao
                  consegue ser cobrada.
                */}
                <label htmlFor="comprador-cpf">CPF (somente números)</label>
                <input
                  id="comprador-cpf"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={11}
                  value={dados.cpf}
                  disabled={enviando}
                  onChange={(e) => setDados({ ...dados, cpf: somenteDigitos(e.target.value) })}
                />
              </div>
              <div className="form__field form__field--wide">
                <label htmlFor="comprador-whatsapp">WhatsApp com DDD</label>
                <input
                  id="comprador-whatsapp"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={13}
                  value={dados.whatsapp}
                  disabled={enviando}
                  onChange={(e) => setDados({ ...dados, whatsapp: somenteDigitos(e.target.value) })}
                />
              </div>
            </div>

            <div className="vitrine__resumo">
              <p className="vitrine__linha" data-testid="valor-unitario">
                Valor unitário: {formatarBRL(kit.precoCentavos)}
              </p>
              <p className="vitrine__linha">Quantidade: {quantidadeEfetiva}</p>
              {/*
                Sem linha de frete, e a ausencia e proposital: venda presencial
                nao tem entrega. Imprimir "Frete: R$ 0,00" aqui seria anunciar
                um frete gratis que nao existe como categoria — ver o cabecalho
                de src/components/linha-frete.tsx.
              */}
              <p className="vitrine__linha vitrine__linha--total" data-testid="total">
                Total a cobrar: {formatarBRL(resumo.total)}
              </p>
            </div>

            <PagamentoDoBalcao />
          </div>

          <div className="venda__acoes">
            <button
              type="button"
              className="btn btn--solid"
              // DUAS TRAVAS, e as duas importam: `enviando` impede a segunda
              // requisicao enquanto a primeira esta em voo (o prejuizo seria
              // duas baixas por um kit), e `dadosCompletos` impede um 422 que
              // custaria uma ida e volta com a fila parada.
              disabled={!podeConfirmar}
              onClick={() => void confirmarVenda()}
            >
              {enviando ? 'Registrando venda…' : 'Confirmar venda'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={enviando}
              onClick={limparParaProximoComprador}
            >
              Limpar
            </button>
          </div>
        </>
      )}

      {/*
        Quando o formulario sai de cena (venda registrada, ou desfecho incerto)
        este e o unico caminho para frente: comecar uma venda NOVA, para o
        proximo da fila. Reenviar a mesma criaria um segundo pedido e uma
        segunda baixa — ver `podeTentarDeNovo`.
      */}
      {!formularioVisivel && (
        <div className="venda__acoes">
          <button
            type="button"
            className="btn btn--solid"
            onClick={limparParaProximoComprador}
          >
            Nova venda
          </button>
        </div>
      )}
    </section>
  )
}

/**
 * PIX E A UNICA COBRANCA QUE ESTA TELA CRIA — DIVIDA DELIBERADA, com o motivo
 * e o caminho de pagamento escritos aqui.
 *
 * A rota aceita os dois metodos, e o de cartao exige `token`, `parcelas` e
 * `metodoPagamentoId` no corpo (uniao discriminada em
 * src/app/api/vendas-presenciais/route.ts). Esse `token` SO pode ser gerado no
 * navegador, pelo Payment Brick do Mercado Pago — e o que mantem o numero do
 * cartao fora deste servidor e a aplicacao fora do escopo de PCI. O Brick de
 * hoje mora dentro de src/components/pagamento.tsx, nao e exportado, e o botao
 * de pagar dele e o proprio disparador do envio: montar aquilo aqui daria a
 * esta tela DOIS botoes de confirmar (o "Confirmar venda" para Pix e o do
 * Brick para cartao), que e exatamente o tipo de ambiguidade que este arquivo
 * inteiro existe para nao ter.
 *
 * O QUE O VENDEDOR FAZ ENQUANTO ISSO, e nao e um beco sem saida: a venda e
 * registrada aqui e o cartao e cobrado na PAGINA DO PEDIDO, pelo link que o
 * desfecho mostra — a mesma /pedido/<token> que ja tem o Brick montado e
 * publica. O custo assumido: para um comprador de cartao, a cobranca Pix criada
 * junto fica pendente e expira sem ser paga.
 *
 * COMO PAGAR A DIVIDA: extrair o Brick de pagamento.tsx para um componente
 * proprio e usa-lo aqui, com o "Confirmar venda" desabilitado enquanto o
 * metodo for cartao e o token nao tiver chegado. O estado `metodo` ja existe
 * como constante nomeada abaixo justamente para o diff ser pequeno.
 */
const METODO_DE_COBRANCA = 'pix'

function PagamentoDoBalcao() {
  return (
    <div className="form__field">
      <div className="pagamentos-aceitos" role="group" aria-label="Forma de cobrança">
        <span className="pagamento-chip">
          PIX
          <span className="pagamento-chip__nota">QR na tela, confirmado pelo banco</span>
        </span>
        <span className="pagamento-chip">
          Cartão
          <span className="pagamento-chip__nota">na página do pedido, pelo link da venda</span>
        </span>
      </div>
      <p className="form__status">
        Esta tela cobra por PIX. Para cartão, registre a venda e abra a página do pedido
        pelo link que aparece em seguida.
      </p>
    </div>
  )
}

/**
 * O DESFECHO, GRANDE O BASTANTE PARA SER LIDO DE LONGE.
 *
 * Verde (`.venda__aprovada`) SO quando `entregar` e true. Todo o resto sai em
 * vermelho (`.venda__erro`) — inclusive o Pix pendente, que e o caminho normal
 * da venda —, porque a pergunta que a cor responde nao e "deu certo?", e sim
 * "o kit pode sair da minha mao?". Ver o cabecalho deste arquivo.
 *
 * `role` acompanha a mesma divisao: 'status' para o desfecho que so informa,
 * 'alert' para o que precisa interromper quem esta olhando para outro lado.
 * Sao dois ramos de JSX em vez de um `role` calculado justamente para o no ser
 * recriado a cada desfecho — um role trocado no mesmo elemento nao e
 * reanunciado por leitor de tela nenhum.
 */
function BlocoDeDesfecho({
  desfecho,
  saldo,
}: {
  desfecho: Desfecho
  saldo: SaldoDoBalcao | null
}) {
  return (
    <div className="venda__desfecho" data-testid="desfecho">
      {desfecho.entregar ? (
        <div className="venda__aprovada" role="status">
          <p className="venda__aprovada-titulo">{desfecho.titulo}</p>
          <p className="venda__aprovada-detalhe">{desfecho.frase}</p>
          {desfecho.detalhe && <p className="venda__aprovada-detalhe">{desfecho.detalhe}</p>}
        </div>
      ) : (
        <div className="venda__erro" role="alert">
          <p className="venda__erro-titulo">{desfecho.titulo}</p>
          <p className="venda__erro-detalhe">{desfecho.frase}</p>
          {desfecho.detalhe && <p className="venda__erro-detalhe">{desfecho.detalhe}</p>}
        </div>
      )}

      {/*
        O CONTADOR REPETIDO AQUI E DE PROPOSITO: depois do desfecho o vendedor
        precisa saber, NO MESMO OLHAR, se ainda ha kit para o proximo da fila —
        sem levantar os olhos para o topo da tela. Os dois contadores leem o
        MESMO estado, entao nao existe divergencia possivel entre eles; o que
        se paga e um `data-testid` a mais.
      */}
      {saldo !== null && (
        <p className="venda__restantes">
          <span className="venda__restantes-numero" data-testid="kits-restantes-desfecho">
            {saldo.disponivel}
          </span>
          <span className="venda__restantes-rotulo">kits ainda na caixa</span>
        </p>
      )}

      {desfecho.pix && (
        <div className="pagamento__pix">
          <img
            className="pagamento__qr"
            src={`data:image/png;base64,${desfecho.pix.qrBase64}`}
            alt="QR code do Pix desta venda"
            width={240}
            height={240}
          />
          <label htmlFor="pix-do-balcao">Ou use o Pix copia e cola</label>
          <textarea
            id="pix-do-balcao"
            className="pagamento__codigo"
            readOnly
            rows={3}
            value={desfecho.pix.copiaECola}
          />
        </div>
      )}

      {/*
        O LINK PARA A PAGINA DO PEDIDO e o que fecha os dois buracos desta tela:
        e onde o Pix pendente aparece confirmado (a pagina e force-dynamic e
        mostra o status atual) e onde o cartao e cobrado. Abre em aba nova para
        o balcao nao perder a tela da venda — o proximo comprador ja esta na
        frente.
      */}
      {desfecho.token && (
        <div className="venda__acoes">
          <a
            className="btn btn--ghost"
            href={`/pedido/${desfecho.token}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir a página do pedido
          </a>
        </div>
      )}
    </div>
  )
}
