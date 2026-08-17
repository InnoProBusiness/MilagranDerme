import type { Metadata } from 'next'
import { ROTULOS_STATUS } from '@/lib/pedido-status'
import { formatarBRL } from '@/lib/money'
import {
  listarVendasAdmin,
  type CanalVenda,
  type PedidoStatus,
} from '@/repositories/pedidos'
import {
  dataHoraBR, EtiquetaCanal, EtiquetaStatus, ouAusente, rotuloDoMetodo, ROTULOS_CANAL,
} from '../formato'
import { exigirSessaoDeAdmin } from '../sessao-admin'

/**
 * A tabela de vendas de §17: numero do pedido, cliente, WhatsApp, e-mail,
 * produto, quantidade, valor, frete, total, forma de pagamento, ORIGEM DA
 * VENDA e status — com filtro por canal e por status.
 *
 * OS FILTROS SAO UM <form method="get">, sem uma linha de JavaScript. Nao e
 * economia de esforco: a URL vira o estado da tela, entao um recorte
 * ("presenciais ainda nao pagos") pode ser marcado nos favoritos, colado num
 * grupo e recarregado com F5 sem perder o que estava selecionado — coisas que
 * um filtro guardado em `useState` nao faz. E a tela continua Server Component,
 * o que significa que a lista de compradores nunca e serializada para o
 * navegador alem do que a propria tabela mostra.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Vendas' }

/**
 * Os dois filtros aceitos, escritos como mapa para o compilador cobrar a
 * cobertura exata dos ENUMs — o mesmo `satisfies { [K in X]: K }` de
 * src/app/api/admin/vendas/route.ts. Um valor novo em `canal_venda` ou em
 * `pedido_status` quebra a compilacao aqui em vez de virar um filtro que a
 * tela oferece e a consulta ignora, ou pior: um status que existe no banco e
 * que o painel nao consegue mais listar.
 */
const CANAIS = {
  presencial: 'presencial',
  online: 'online',
} as const satisfies { [K in CanalVenda]: K }

const STATUS = {
  pendente: 'pendente',
  aguardando_pagamento: 'aguardando_pagamento',
  pago: 'pago',
  em_preparacao: 'em_preparacao',
  enviado: 'enviado',
  em_transito: 'em_transito',
  entregue: 'entregue',
  cancelado: 'cancelado',
  reembolsado: 'reembolsado',
} as const satisfies { [K in PedidoStatus]: K }

type ValorDaBusca = string | string[] | undefined

/**
 * Um parametro repetido (`?canal=online&canal=presencial`) chega como array e
 * e tratado como AUSENTE, nunca como "o primeiro vale". A consulta aceita um
 * canal so: escolher um dos dois em silencio mostraria um recorte que ninguem
 * pediu com a URL dizendo outra coisa.
 */
function texto(bruto: ValorDaBusca): string {
  return typeof bruto === 'string' ? bruto : ''
}

/**
 * `Object.hasOwn`, e NUNCA `valor in MAPA`. O operador `in` enxerga a cadeia
 * de prototipos: `'toString' in CANAIS` e `true`, e `CANAIS['toString']`
 * devolveria uma FUNCAO — que seguiria para dentro do `where` do Kysely como
 * se fosse um canal. Uma querystring de visitante nao pode escolher o que vai
 * para a consulta, e este e o ponto exato onde ela tentaria.
 *
 * O valor devolvido sai do MAPA, nunca da URL: mesmo depois da checagem, o que
 * viaja para o repositorio e o literal do codigo, nao a string recebida.
 *
 * DUAS FUNCOES QUASE IGUAIS, e nao uma generica sobre `Record<T, T>`: a versao
 * generica compila, mas depende de inferencia de assinatura de indice para
 * amarrar T ao ENUM, e um erro ali nao aparece como erro — aparece como
 * `string` chegando ao `where` do Kysely. Duas funcoes de tres linhas com o
 * tipo escrito por extenso valem mais do que a deduplicacao.
 */
function canalDaBusca(bruto: ValorDaBusca): CanalVenda | undefined {
  const valor = texto(bruto)
  if (valor === '' || !Object.hasOwn(CANAIS, valor)) return undefined
  return CANAIS[valor as CanalVenda]
}

function statusDaBusca(bruto: ValorDaBusca): PedidoStatus | undefined {
  const valor = texto(bruto)
  if (valor === '' || !Object.hasOwn(STATUS, valor)) return undefined
  return STATUS[valor as PedidoStatus]
}

export default async function PaginaVendasAdmin({
  // Next 16: searchParams e uma Promise. Ler sem await devolve o objeto errado
  // (a propria Promise, cujas chaves sao undefined) e a tela mostraria a lista
  // inteira achando que filtrou.
  searchParams,
}: {
  searchParams: Promise<Record<string, ValorDaBusca>>
}) {
  // ANTES da primeira consulta, e apesar de o layout ja conferir. Ver
  // ../sessao-admin.ts.
  await exigirSessaoDeAdmin()

  const busca = await searchParams
  const canal = canalDaBusca(busca.canal)
  const status = statusDaBusca(busca.status)
  const filtrando = canal !== undefined || status !== undefined

  const vendas = await listarVendasAdmin({ canal, status })

  return (
    <>
      <div className="admin__topo">
        <div>
          <h1 className="admin__titulo">Vendas</h1>
          <p className="admin__lede">
            Todos os pedidos, do mais recente para o mais antigo — inclusive os
            que nunca foram pagos.
          </p>
        </div>
      </div>

      {/*
        action explicito para a mesma rota: sem ele o navegador submete para a
        URL atual COM a querystring, e um filtro limpo ("Todas") nao apagaria o
        parametro antigo em alguns navegadores.
      */}
      <form className="form__grid" method="get" action="/admin/vendas">
        <div className="form__field">
          <label htmlFor="filtro-canal">Origem da venda</label>
          {/*
            defaultValue, e nao `selected` na <option>: e o que o React pede, e
            e o que faz o filtro escolhido continuar aparecendo escolhido
            depois do recarregamento — sem isso a tela mostraria "Todas" com
            uma lista filtrada embaixo.
          */}
          <select id="filtro-canal" name="canal" defaultValue={canal ?? ''}>
            <option value="">Todas as origens</option>
            {Object.values(CANAIS).map((valor) => (
              <option key={valor} value={valor}>{ROTULOS_CANAL[valor]}</option>
            ))}
          </select>
        </div>

        <div className="form__field">
          <label htmlFor="filtro-status">Status</label>
          <select id="filtro-status" name="status" defaultValue={status ?? ''}>
            <option value="">Todos os status</option>
            {Object.values(STATUS).map((valor) => (
              <option key={valor} value={valor}>{ROTULOS_STATUS[valor].titulo}</option>
            ))}
          </select>
        </div>

        <div className="form__field form__field--wide">
          {/*
            <div> sem classe: os dois .btn ja sao inline-block e ficam lado a
            lado sozinhos. .venda__acoes (o outro agrupador de botoes do
            projeto) nao serve aqui — ele estica cada botao para 240px porque a
            tela do balcao e operada com o polegar, em pe; um "Filtrar" daquele
            tamanho no painel roubaria a atencao da tabela.
          */}
          <div>
            <button type="submit" className="btn btn--ghost">Filtrar</button>
            {filtrando && (
              <a className="btn btn--ghost" href="/admin/vendas">Limpar filtros</a>
            )}
          </div>
        </div>
      </form>

      {/*
        A CONTAGEM E DE LINHAS, NUNCA DE DINHEIRO. Somar o total das vendas
        listadas aqui daria um numero que mistura pedido pago com carrinho
        abandonado e com reembolso — e ele apareceria logo acima de uma tabela
        que nao explica a mistura. O faturamento de verdade, com o recorte certo,
        esta no Resumo.
      */}
      <p className="admin__lede" role="status" data-testid="contagem-vendas">
        {vendas.length === 1 ? '1 venda listada' : `${vendas.length} vendas listadas`}
        {filtrando ? ' com os filtros aplicados.' : '.'}
      </p>

      <div className="tabela-rolagem">
        <table className="tabela tabela--larga">
          <caption className="oculto-visual">
            Vendas registradas, com cliente, valores, forma de pagamento, origem
            e status.
          </caption>
          <thead>
            <tr>
              <th scope="col">Pedido</th>
              <th scope="col">Cliente</th>
              <th scope="col">WhatsApp</th>
              <th scope="col">E-mail</th>
              <th scope="col">Produto</th>
              <th scope="col" className="tabela__num">Qtd.</th>
              <th scope="col" className="tabela__num">Valor</th>
              <th scope="col" className="tabela__num">Frete</th>
              <th scope="col" className="tabela__num">Total</th>
              <th scope="col">Pagamento</th>
              <th scope="col">Origem</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {vendas.length === 0 ? (
              <tr>
                {/*
                  ESTADO VAZIO HONESTO, e com as duas frases separadas: "nao ha
                  venda nenhuma" e "nao ha venda COM ESTE FILTRO" sao
                  diagnosticos diferentes. Uma frase so faria quem filtrou por
                  'reembolsado' concluir que a loja nao vendeu nada.
                */}
                <td className="tabela__vazio" colSpan={12}>
                  {filtrando
                    ? 'Nenhuma venda com os filtros aplicados. Limpe os filtros para ver a lista completa.'
                    : 'Nenhuma venda registrada ainda.'}
                </td>
              </tr>
            ) : (
              vendas.map((venda) => (
                <tr key={venda.id}>
                  <td>
                    {/*
                      O numero leva a tela publica do pedido (/pedido/[token]),
                      que e exatamente o que o comprador esta vendo quando liga
                      perguntando. O token so aparece aqui porque esta pagina ja
                      exige sessao de administrador — ele e a credencial daquele
                      pedido, e vale a mesma regra de nao sair do painel.
                    */}
                    <a className="rodape__cta" href={`/pedido/${venda.token}`}>
                      Nº {venda.numero}
                    </a>
                    <span className="tabela__secundario">{dataHoraBR(venda.criadoEm)}</span>
                  </td>

                  <td>
                    {ouAusente(venda.clienteNome)}
                    {venda.vendedorNome && (
                      <span className="tabela__secundario">
                        Vendedor: {venda.vendedorNome}
                      </span>
                    )}
                    {venda.representanteNome && (
                      <span className="tabela__secundario">
                        Representante: {venda.representanteNome}
                      </span>
                    )}
                  </td>

                  <td>{ouAusente(venda.clienteWhatsapp)}</td>
                  <td>{ouAusente(venda.clienteEmail)}</td>
                  <td>{ouAusente(venda.itens)}</td>
                  <td className="tabela__num">{venda.quantidade}</td>

                  <td className="tabela__num">
                    {formatarBRL(venda.subtotalCentavos)}
                    {/*
                      O desconto so aparece quando existe, e aparece porque sem
                      ele as tres colunas de dinheiro nao fecham: valor + frete
                      seria maior que o total e a tabela pareceria errada. §17
                      nao pede a coluna, entao ela entra como linha secundaria
                      em vez de uma decima terceira coluna.
                    */}
                    {venda.descontoCentavos > 0 && (
                      <span className="tabela__secundario">
                        − {formatarBRL(venda.descontoCentavos)} de desconto
                      </span>
                    )}
                  </td>

                  <td className="tabela__num">{formatarBRL(venda.freteCentavos)}</td>
                  <td className="tabela__num">{formatarBRL(venda.totalCentavos)}</td>
                  <td>{rotuloDoMetodo(venda.metodoPagamento)}</td>
                  <td><EtiquetaCanal canal={venda.canal} /></td>
                  <td><EtiquetaStatus status={venda.status} /></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
