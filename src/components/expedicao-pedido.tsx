'use client'

/**
 * A UNICA ESCRITA DO PAINEL (§17): mover o pedido pela fila da expedicao e
 * gravar o codigo de rastreio, por PATCH /api/admin/pedidos/[id].
 *
 * POR QUE 'use client' — e o unico pedaco do painel que precisa: ha estado
 * (o que foi digitado, o que a rota respondeu), ha evento (o submit) e ha um
 * verbo que formulario HTML nao emite (PATCH). Todo o resto de /admin/logistica
 * continua Server Component: a tabela inteira e renderizada no servidor e so
 * esta ilha, por linha, roda no navegador.
 *
 * O QUE ESTA TELA DELIBERADAMENTE NAO OFERECE: 'pago' e 'reembolsado'. Nao e
 * uma lista de exclusao escrita a mao aqui — os dois caem sozinhos pelos mesmos
 * predicados que o repositorio usa para RECUSAR (ver `statusOferecidos`). Quem
 * move dinheiro e a confirmacao do Mercado Pago, porque e ela que escreve no
 * livro-razao de comissao; um clique no painel marcando 'reembolsado' deixaria
 * credito de venda desfeita parado no saldo de uma representante E faria o
 * estorno automatico do webhook virar no-op, por encontrar o pedido ja no
 * estado alvo. O doc comment de TransicaoFinanceiraError
 * (src/repositories/pedidos.ts) conta a historia inteira.
 */

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import {
  geraCreditoDeComissao,
  geraEstornoDeComissao,
  ROTULOS_STATUS,
  transicaoPermitida,
} from '@/lib/pedido-status'
import type { PedidoStatus } from '@/repositories/pedidos'

/**
 * A lista completa do ENUM, DERIVADA de ROTULOS_STATUS em vez de escrita de
 * novo. Aquele mapa e `Record<PedidoStatus, ...>`, entao o compilador ja
 * garante que ele tem exatamente os valores do ENUM: um status novo em
 * pedido_status quebra a compilacao la e aparece aqui de graca. Uma segunda
 * lista escrita a mao neste arquivo divergiria em silencio — e o defeito seria
 * um estado inalcancavel pela expedicao, descoberto so com um pedido parado.
 *
 * A ordem das chaves e a de declaracao no mapa, que e a ordem do funil
 * (pendente → … → entregue). E o que faz o <select> ler como uma fila.
 */
const TODOS_OS_STATUS = Object.keys(ROTULOS_STATUS) as PedidoStatus[]

/**
 * Para onde ESTE pedido pode ir pela mao da operacao.
 *
 * Tres condicoes, todas emprestadas de quem decide de verdade:
 *  1. `transicaoPermitida` — a maquina de estados (src/lib/pedido-status.ts);
 *  2. NAO gera credito de comissao (entrada em 'pago');
 *  3. NAO gera estorno de comissao (saida de um estado pago para
 *     'reembolsado'/'cancelado').
 *
 * As duas ultimas sao EXATAMENTE o teste que `avancarStatusDoPedido` faz antes
 * de lancar TransicaoFinanceiraError. Perguntar para as mesmas funcoes e o que
 * garante que a tela nunca ofereca um botao que o servidor vai recusar com 422
 * — e, no sentido inverso, que uma mudanca de regra no repositorio apareca na
 * tela sem ninguem lembrar de vir aqui.
 *
 * Devolve lista VAZIA para 'entregue' (so poderia ir a 'reembolsado', que e
 * financeiro) e para os estados finais. Lista vazia nao e erro: e "nao ha nada
 * a fazer com o status deste pedido por aqui", e a tela diz isso em vez de
 * mostrar um <select> so com "manter".
 *
 * Exportada para ter teste proprio: e a regra que impede o painel de mexer em
 * dinheiro, e ela precisa de um teste que nao dependa de renderizar a tabela.
 */
export function statusOferecidos(atual: PedidoStatus): PedidoStatus[] {
  return TODOS_OS_STATUS.filter((alvo) => (
    transicaoPermitida(atual, alvo)
    && !geraCreditoDeComissao(atual, alvo)
    && !geraEstornoDeComissao(atual, alvo)
  ))
}

type Props = {
  pedidoId: string
  /** Numero do PEDIDO, so para os rotulos acessiveis nao ficarem iguais entre linhas. */
  numero: number
  status: PedidoStatus
  rastreioCodigo: string | null
  rastreioTransportadora: string | null
}

type Desfecho =
  | { tipo: 'parado' }
  | { tipo: 'salvando' }
  | { tipo: 'ok'; mensagem: string }
  | { tipo: 'erro'; mensagem: string }

/**
 * Mensagem de erro da rota, quando ela mandou uma.
 *
 * As respostas de PATCH /api/admin/pedidos/[id] trazem `mensagem` curada em
 * portugues justamente para a tela nao ter que traduzir codigo de erro —
 * 'transicao_financeira' vira "Pagamento e reembolso não se marcam pelo
 * painel…", que e o texto que o administrador precisa ler. Reescrever essas
 * frases aqui criaria uma segunda versao delas, que divergiria da primeira.
 *
 * O corpo vem da rede e nao e confiavel: so string vira texto na tela.
 */
function mensagemDaResposta(corpo: unknown): string | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const { mensagem } = corpo as { mensagem?: unknown }
  return typeof mensagem === 'string' && mensagem.trim() !== '' ? mensagem : null
}

export function ExpedicaoPedido({
  pedidoId, numero, status, rastreioCodigo, rastreioTransportadora,
}: Props) {
  const router = useRouter()

  // '' = "manter o status atual". O <select> nasce sempre nesse valor: a acao
  // mais comum na fila e so gravar o rastreio, e um alvo pre-selecionado
  // moveria o pedido no primeiro submit sem ninguem ter pedido.
  const [novoStatus, setNovoStatus] = useState<PedidoStatus | ''>('')
  const [codigo, setCodigo] = useState(rastreioCodigo ?? '')
  const [transportadora, setTransportadora] = useState(rastreioTransportadora ?? '')
  const [desfecho, setDesfecho] = useState<Desfecho>({ tipo: 'parado' })

  const alvos = statusOferecidos(status)
  const salvando = desfecho.tipo === 'salvando'

  async function salvar() {
    const codigoLimpo = codigo.trim()
    const transportadoraLimpa = transportadora.trim()

    // AS DUAS CHECAGENS ABAIXO SAO COPIA DAS DA ROTA, DE PROPOSITO, e nao
    // substituem nenhuma delas — a rota continua sendo quem recusa de verdade,
    // porque um navegador nao e uma barreira. O que elas compram e a resposta
    // imediata: quem digitou so o codigo descobre o que falta sem esperar o
    // 422 voltar, no meio de uma fila de expedicao.
    if ((codigoLimpo === '') !== (transportadoraLimpa === '')) {
      setDesfecho({
        tipo: 'erro',
        mensagem: 'Informe o código de rastreio e a transportadora juntos.',
      })
      return
    }

    if (novoStatus === '' && codigoLimpo === '') {
      setDesfecho({
        tipo: 'erro',
        mensagem: 'Escolha um novo status ou informe o código de rastreio.',
      })
      return
    }

    // O corpo leva SO o que foi pedido. Campo ausente e "nao mexa nisso"; o
    // `.strict()` do schema da rota recusa qualquer chave a mais, e nenhum
    // valor monetario tem como entrar aqui — dinheiro de pedido e congelado
    // pelo trigger de imutabilidade e nao existe caminho que o reescreva.
    const corpo: {
      status?: PedidoStatus
      rastreioCodigo?: string
      rastreioTransportadora?: string
    } = {}

    if (novoStatus !== '') corpo.status = novoStatus
    if (codigoLimpo !== '') {
      corpo.rastreioCodigo = codigoLimpo
      corpo.rastreioTransportadora = transportadoraLimpa
    }

    setDesfecho({ tipo: 'salvando' })

    try {
      const resposta = await fetch(`/api/admin/pedidos/${pedidoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      })

      const dados: unknown = await resposta.json().catch(() => null)

      if (!resposta.ok) {
        setDesfecho({
          tipo: 'erro',
          mensagem: mensagemDaResposta(dados)
            ?? 'Não foi possível atualizar o pedido. Atualize a página e tente de novo.',
        })
        return
      }

      setDesfecho({ tipo: 'ok', mensagem: 'Pedido atualizado.' })

      // O status e o rastreio que a TABELA mostra sao renderizados no
      // servidor; sem este refresh a linha continuaria exibindo o estado
      // anterior ate alguem recarregar a mao — e a proxima pessoa a olhar a
      // fila postaria de novo um pedido ja postado. Os campos digitados ficam
      // como estao de proposito: eles ja sao o que foi gravado.
      router.refresh()
    } catch {
      // Falha de rede: NAO se sabe se o PATCH chegou. A frase nao pode dizer
      // "não salvou" (pode ter salvado) nem "salvou" — manda conferir, que e a
      // unica instrucao verdadeira. As duas escritas sao idempotentes, entao
      // repetir e seguro.
      setDesfecho({
        tipo: 'erro',
        mensagem: 'Falha de conexão. Atualize a página para conferir se a mudança foi gravada.',
      })
    }
  }

  return (
    // .venda__campos e o empilhador de campos que globals.css ja tem (coluna,
    // gap de 16px). O nome vem do balcao, onde nasceu, mas o que ele descreve
    // e generico — reusar e melhor do que criar uma classe nova identica.
    <form
      className="venda__campos"
      onSubmit={(evento) => { evento.preventDefault(); void salvar() }}
    >
      {alvos.length === 0 ? (
        // ESTADO VAZIO HONESTO: nao ha para onde mover este pedido pela mao da
        // operacao. Dizer isso e melhor do que um <select> vazio, e MUITO melhor
        // do que oferecer 'reembolsado' e deixar a rota recusar depois do clique.
        <p className="tabela__secundario">
          Sem mudança de status disponível a partir de{' '}
          {ROTULOS_STATUS[status].titulo.toLowerCase()}.
        </p>
      ) : (
        <div className="form__field">
          <label htmlFor={`status-${pedidoId}`}>
            Novo status do pedido nº {numero}
          </label>
          <select
            id={`status-${pedidoId}`}
            value={novoStatus}
            onChange={(evento) => setNovoStatus(evento.target.value as PedidoStatus | '')}
            disabled={salvando}
          >
            <option value="">Manter {ROTULOS_STATUS[status].titulo.toLowerCase()}</option>
            {alvos.map((alvo) => (
              <option key={alvo} value={alvo}>{ROTULOS_STATUS[alvo].titulo}</option>
            ))}
          </select>
        </div>
      )}

      <div className="form__field">
        <label htmlFor={`rastreio-${pedidoId}`}>
          Código de rastreio do pedido nº {numero}
        </label>
        <input
          id={`rastreio-${pedidoId}`}
          name="rastreioCodigo"
          type="text"
          value={codigo}
          maxLength={64}
          onChange={(evento) => setCodigo(evento.target.value)}
          disabled={salvando}
        />
      </div>

      <div className="form__field">
        <label htmlFor={`transportadora-${pedidoId}`}>
          Transportadora do pedido nº {numero}
        </label>
        <input
          id={`transportadora-${pedidoId}`}
          name="rastreioTransportadora"
          type="text"
          value={transportadora}
          maxLength={60}
          onChange={(evento) => setTransportadora(evento.target.value)}
          disabled={salvando}
        />
      </div>

      <button type="submit" className="btn btn--ghost" disabled={salvando}>
        {salvando ? 'Salvando…' : 'Salvar'}
      </button>

      {/*
        role="status" e nao "alert" nem para o erro: a mensagem aparece logo
        abaixo do botao que a pessoa acabou de clicar, e ela ja esta olhando
        para ca. O leitor de tela anuncia quando terminar a frase corrente, sem
        interromper ninguem no meio de uma leitura.
      */}
      {(desfecho.tipo === 'ok' || desfecho.tipo === 'erro') && (
        <p
          className={desfecho.tipo === 'ok' ? 'aviso aviso--sucesso' : 'aviso aviso--erro'}
          role="status"
          data-testid="mensagem-expedicao"
        >
          {desfecho.mensagem}
        </p>
      )}
    </form>
  )
}
