import type { Metadata } from 'next'
import { deInteiro, formatarBRL } from '@/lib/money'
import { resumoDeVendas } from '@/repositories/pedidos'
import { EtiquetaCanal, rotuloDoMetodo } from './formato'
import { exigirSessaoDeAdmin } from './sessao-admin'

/**
 * A primeira tela do painel (§17): quanto entrou, por qual canal e em qual
 * forma de pagamento.
 *
 * SERVER COMPONENT que chama `resumoDeVendas` DIRETO, sem passar por
 * GET /api/admin/vendas. A rota existe para o que precisa ser vivo no
 * navegador; daqui ate ela haveria um salto de rede de um processo para ele
 * mesmo — com um cookie a reenviar e um JSON a serializar e desserializar —
 * para chegar na funcao que este arquivo pode chamar.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Resumo' }

export default async function PaginaResumoAdmin() {
  // ANTES DA PRIMEIRA CONSULTA. O layout tambem confere, e isso nao dispensa
  // esta linha: layout do Next e composicao de UI, nao barreira — ver o
  // comentario longo em ./sessao-admin.ts.
  await exigirSessaoDeAdmin()

  const resumo = await resumoDeVendas()

  /**
   * A SOMA DAS FORMAS DE PAGAMENTO DEVERIA BATER COM O FATURAMENTO, e quando
   * nao bate a tela diz. O doc comment de `resumoDeVendas`
   * (src/repositories/pedidos.ts) explica por que os dois numeros saem de
   * lugares diferentes: faturamento vem de `pedidos`, as formas vem de
   * `pagamentos` aprovados. Uma divergencia significa uma de duas coisas, e as
   * duas sao dinheiro de verdade — pagamento aprovado em duplicidade (o mesmo
   * comprador cobrado duas vezes) ou pedido marcado como pago sem pagamento
   * aprovado.
   *
   * Achatar os dois lados para o mesmo numero — somar `porMetodo` a partir do
   * faturamento, por exemplo — deixaria a tela bonita e esconderia exatamente
   * o caso que precisa ser visto no dia seguinte ao evento.
   */
  const somaDosMetodos = deInteiro(
    resumo.porMetodo.reduce((acc, m) => acc + m.totalCentavos, 0),
  )
  const divergencia = somaDosMetodos !== resumo.faturamentoCentavos

  return (
    <>
      <div className="admin__topo">
        <div>
          <h1 className="admin__titulo">Resumo de vendas</h1>
          <p className="admin__lede">
            Conta como venda o pedido cujo dinheiro entrou e não voltou: pago,
            em preparação, enviado, em trânsito ou entregue.
          </p>
        </div>
      </div>

      <div className="admin__cartoes">
        <div className="cartao">
          <p className="cartao__rotulo">Faturamento confirmado</p>
          <p className="cartao__valor" data-testid="faturamento">
            {formatarBRL(resumo.faturamentoCentavos)}
          </p>
          <p className="cartao__nota">
            Soma do total dos pedidos, já com frete e desconto aplicados.
          </p>
        </div>

        <div className="cartao">
          <p className="cartao__rotulo">Pedidos pagos</p>
          <p className="cartao__valor">{resumo.pedidosPagos}</p>
          <p className="cartao__nota">
            Pedidos, não unidades: um pedido pode levar mais de um kit.
          </p>
        </div>
      </div>

      {divergencia && (
        <p className="aviso aviso--atencao" role="status">
          <span className="aviso__titulo">Conferir</span>
          As formas de pagamento somam {formatarBRL(somaDosMetodos)}, e o
          faturamento dos pedidos é {formatarBRL(resumo.faturamentoCentavos)}. A
          diferença costuma ser um pagamento aprovado em duplicidade ou um
          pedido marcado como pago sem pagamento aprovado — vale conferir no
          Mercado Pago antes de fechar o caixa.
        </p>
      )}

      <h2 className="admin__titulo" id="por-canal">Vendas por canal</h2>
      <p className="admin__lede">
        Origem da venda: presencial é o balcão do evento, online é a loja.
      </p>

      <div className="tabela-rolagem">
        <table className="tabela" aria-labelledby="por-canal">
          <thead>
            <tr>
              <th scope="col">Origem</th>
              <th scope="col" className="tabela__num">Pedidos</th>
              <th scope="col" className="tabela__num">Total</th>
              <th scope="col">Detalhe</th>
            </tr>
          </thead>
          <tbody>
            {/*
              ESTADO VAZIO HONESTO: sem venda paga, a tabela diz que nao ha
              venda paga. Nao ha linha "presencial 0 / online 0" inventada para
              a tabela nao ficar vazia — um zero escrito por quem nunca vendeu
              e um zero escrito por quem vendeu e foi reembolsado sao a mesma
              celula, e so um deles e verdade sobre o estoque.
            */}
            {resumo.porCanal.length === 0 ? (
              <tr>
                <td className="tabela__vazio" colSpan={4}>
                  Nenhuma venda paga ainda. Os números aparecem aqui assim que o
                  primeiro pagamento for confirmado.
                </td>
              </tr>
            ) : (
              resumo.porCanal.map((linha) => (
                <tr key={linha.canal}>
                  <td><EtiquetaCanal canal={linha.canal} /></td>
                  <td className="tabela__num">{linha.pedidos}</td>
                  <td className="tabela__num">{formatarBRL(linha.totalCentavos)}</td>
                  <td>
                    {/*
                      .rodape__cta e o unico "link de texto" que globals.css
                      tem (dourado, caixa alta, sublinhado discreto). O nome
                      diz rodape por onde ele nasceu, nao pelo que ele e —
                      reusar e melhor do que inventar um nome de classe novo
                      para a mesma aparencia. Sem classe nenhuma, o reset
                      `a{color:inherit;text-decoration:none}` do topo do
                      arquivo deixaria este link com cara de texto comum, e
                      ninguem clicaria nele.
                    */}
                    <a className="rodape__cta" href={`/admin/vendas?canal=${linha.canal}`}>
                      Ver as vendas deste canal
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2 className="admin__titulo" id="por-metodo">Vendas por forma de pagamento</h2>
      <p className="admin__lede">
        Sai dos pagamentos aprovados pelo Mercado Pago, e não do pedido: é o que
        o provedor confirmou ter recebido.
      </p>

      <div className="tabela-rolagem">
        <table className="tabela" aria-labelledby="por-metodo">
          <thead>
            <tr>
              <th scope="col">Forma de pagamento</th>
              <th scope="col" className="tabela__num">Pedidos</th>
              <th scope="col" className="tabela__num">Total aprovado</th>
            </tr>
          </thead>
          <tbody>
            {resumo.porMetodo.length === 0 ? (
              <tr>
                <td className="tabela__vazio" colSpan={3}>
                  Nenhum pagamento aprovado ainda.
                </td>
              </tr>
            ) : (
              resumo.porMetodo.map((linha) => (
                <tr key={linha.metodo}>
                  <td>{rotuloDoMetodo(linha.metodo)}</td>
                  <td className="tabela__num">{linha.pedidos}</td>
                  <td className="tabela__num">{formatarBRL(linha.totalCentavos)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
