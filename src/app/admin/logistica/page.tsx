import type { Metadata } from 'next'
import { ExpedicaoPedido } from '@/components/expedicao-pedido'
import { listarLogisticaAdmin, type LogisticaAdmin } from '@/repositories/pedidos'
import { AUSENTE, dataHoraBR, EtiquetaStatus, ouAusente } from '../formato'
import { exigirSessaoDeAdmin } from '../sessao-admin'

/**
 * A fila da expedicao (§17): CEP, endereco, cidade, estado, codigo de rastreio
 * e status de envio, com o formulario que informa o rastreio e avanca o status.
 *
 * O RECORTE E "TEM PARA ONDE DESPACHAR E O DINHEIRO ENTROU", e ele mora no
 * repositorio (`listarLogisticaAdmin`), nao aqui. Venda de balcao sai na mao do
 * comprador e nunca tem endereco, entao os 50 kits do evento nao aparecem nesta
 * tela como 50 linhas em branco empurrando para baixo o que precisa ser postado.
 *
 * A ORDEM E CRESCENTE por data, ao contrario da tabela de vendas: aqui a
 * pergunta nao e "o que entrou agora" e sim "o que esta parado ha mais tempo".
 * O pedido mais antigo sem rastreio e, literalmente, o comprador que espera ha
 * mais dias.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Logística' }

/**
 * Endereco em uma linha, para a etiqueta. Campo vazio some em vez de virar
 * virgula solta ("Rua X, , Centro") — e o complemento, que e legitimamente
 * opcional, nao deixa buraco nenhum quando falta.
 */
function logradouro(pedido: LogisticaAdmin): string {
  const partes = [
    [pedido.rua, pedido.numero_].filter((p) => p && p.trim() !== '').join(', '),
    pedido.complemento,
  ].filter((parte): parte is string => typeof parte === 'string' && parte.trim() !== '')

  return partes.length === 0 ? AUSENTE : partes.join(' · ')
}

function cidadeEstado(pedido: LogisticaAdmin): string {
  const cidade = pedido.cidade?.trim() ?? ''
  const estado = pedido.estado?.trim() ?? ''
  if (cidade === '' && estado === '') return AUSENTE
  return estado === '' ? cidade : `${cidade}/${estado}`
}

export default async function PaginaLogisticaAdmin() {
  // ANTES da primeira consulta, e apesar de o layout ja conferir. Ver
  // ../sessao-admin.ts.
  await exigirSessaoDeAdmin()

  const pedidos = await listarLogisticaAdmin()

  return (
    <>
      <div className="admin__topo">
        <div>
          <h1 className="admin__titulo">Logística</h1>
          <p className="admin__lede">
            Pedidos pagos que têm endereço de entrega, do mais antigo para o
            mais recente. Vendas de balcão não aparecem aqui: o kit sai em mãos.
          </p>
        </div>
      </div>

      {/*
        A EXPLICACAO QUE A TELA DEVE ao administrador, e nao um aviso decorativo:
        ele vai procurar "marcar como pago" e "marcar como reembolsado" e nao vai
        achar. Sem esta frase, a conclusao natural e "o painel esta quebrado" — e
        alguem vai tentar resolver por fora. A rota tambem recusa (422), com
        mensagem parecida, mas dizer antes do clique poupa o clique.
      */}
      <p className="aviso" role="note">
        <span className="aviso__titulo">Pagamento não se marca aqui</span>
        &ldquo;Pago&rdquo; e &ldquo;Reembolsado&rdquo; vêm da confirmação do
        Mercado Pago, porque são esses dois estados que mexem na comissão do
        representante. Para devolver um valor, faça o estorno no Mercado Pago: o
        pedido muda sozinho quando a notificação chegar.
      </p>

      <div className="tabela-rolagem">
        <table className="tabela tabela--larga">
          <caption className="oculto-visual">
            Fila de expedição, com endereço, rastreio, status e o formulário de
            atualização de cada pedido.
          </caption>
          <thead>
            <tr>
              <th scope="col">Pedido</th>
              <th scope="col">Cliente</th>
              <th scope="col">CEP</th>
              <th scope="col">Endereço</th>
              <th scope="col">Cidade / UF</th>
              <th scope="col">Rastreio</th>
              <th scope="col">Status</th>
              <th scope="col">Atualizar</th>
            </tr>
          </thead>
          <tbody>
            {pedidos.length === 0 ? (
              <tr>
                {/*
                  ESTADO VAZIO HONESTO, e explicando o recorte: "nada aqui" pode
                  significar "ninguem comprou" ou "ninguem pagou ainda", e as
                  duas leituras levam a acoes diferentes no dia do evento.
                */}
                <td className="tabela__vazio" colSpan={8}>
                  Nenhum pedido para despachar. Só entram nesta fila os pedidos
                  pagos com endereço de entrega.
                </td>
              </tr>
            ) : (
              pedidos.map((pedido) => (
                <tr key={pedido.id}>
                  <td>
                    Nº {pedido.numero}
                    <span className="tabela__secundario">
                      {dataHoraBR(pedido.criadoEm)}
                    </span>
                  </td>

                  <td>{ouAusente(pedido.clienteNome)}</td>
                  <td>{ouAusente(pedido.cep)}</td>

                  <td>
                    {logradouro(pedido)}
                    {pedido.bairro && pedido.bairro.trim() !== '' && (
                      <span className="tabela__secundario">{pedido.bairro}</span>
                    )}
                  </td>

                  <td>{cidadeEstado(pedido)}</td>

                  <td>
                    {/*
                      Sem rastreio o travessao aparece sozinho — nunca um
                      "aguardando postagem" inventado, que pareceria um estado
                      do pedido e nao a ausencia de um dado.
                    */}
                    {ouAusente(pedido.rastreioCodigo)}
                    {pedido.rastreioTransportadora && (
                      <span className="tabela__secundario">
                        {pedido.rastreioTransportadora}
                      </span>
                    )}
                  </td>

                  <td>
                    <EtiquetaStatus status={pedido.status} />
                    {pedido.enviadoEm && (
                      <span className="tabela__secundario">
                        Postado em {dataHoraBR(pedido.enviadoEm)}
                      </span>
                    )}
                    {/*
                      O prazo e o da cotacao gravada na criacao do pedido (a
                      opcao de frete que o comprador escolheu), nao uma promessa
                      recalculada agora. Ausente quando o pedido e anterior a
                      cotacao por API — e ai nao ha prazo nenhum a mostrar.
                    */}
                    {pedido.prazoDiasEstimado !== null && (
                      <span className="tabela__secundario">
                        Prazo estimado: {pedido.prazoDiasEstimado} dia(s)
                      </span>
                    )}
                  </td>

                  <td>
                    <ExpedicaoPedido
                      pedidoId={pedido.id}
                      numero={pedido.numero}
                      status={pedido.status}
                      rastreioCodigo={pedido.rastreioCodigo}
                      rastreioTransportadora={pedido.rastreioTransportadora}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
