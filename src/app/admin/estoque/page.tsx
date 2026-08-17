import type { Metadata } from 'next'
import { ContadorEstoque } from '@/components/contador-estoque'
import { saldosPorKit, type SaldoEstoque } from '@/repositories/estoque'
import { reservadosPorKit } from '@/repositories/pedidos'
import { listarKitsAtivos } from '@/repositories/produtos'
import { exigirSessaoDeAdmin } from '../sessao-admin'

/**
 * O estoque do lancamento (§17), nos DOIS canais — que sao estoques separados
 * por decisao de §4: vender online nao tira kit da caixa do evento, e vender no
 * balcao nao consome a pre-venda.
 *
 * A DIFERENCA QUE MANDA NESTA TELA: o canal presencial tem teto rigido (50
 * unidades, migrations/1755300700000_seed_estoque.sql) e o canal online e
 * ILIMITADO por decisao do cliente em 16/08. Para o online, `disponivel` nao e
 * um numero pequeno — ele NAO EXISTE, e a tela escreve "Ilimitado". Ver o
 * comentario da coluna la embaixo.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Estoque' }

/**
 * Chave de cruzamento entre `estoques` e as reservas de `pedidos`, no mesmo
 * molde de src/app/api/admin/estoque/route.ts: kitId e uuid e canal e um dos
 * dois literais do ENUM, entao nao ha separador ambiguo possivel.
 */
function chave(kitId: string, canal: string): string {
  return `${kitId}:${canal}`
}

/**
 * O texto da coluna "Disponível".
 *
 * ILIMITADO NAO IMPRIME NUMERO NENHUM. O saldo que o repositorio devolve para
 * o canal online e SUM() de movimentos de um estoque que nunca recebeu entrada
 * — ele nasce em zero e so desce conforme as vendas online sao pagas. Escrever
 * "-37" na tela do dono da empresa seria absurdo; "arrumar" com Math.max(0,…)
 * seria pior, porque anunciaria ESGOTADO o canal que por decisao do cliente
 * nunca esgota, e a operacao pararia de vender online no dia do lancamento por
 * causa de um numero inventado. Mesmo raciocinio, palavra por palavra, do
 * `disponivel: null` de GET /api/admin/estoque.
 *
 * A decisao segue `ilimitado`, e nao o canal: se um dia o presencial virar
 * ilimitado (ou o online ganhar teto), a tela acompanha a linha do banco sem
 * ninguem lembrar de mexer aqui.
 */
function textoDisponivel(saldo: SaldoEstoque): string {
  return saldo.ilimitado ? 'Ilimitado' : String(saldo.disponivel)
}

export default async function PaginaEstoqueAdmin() {
  // ANTES da primeira consulta, e apesar de o layout ja conferir. Ver
  // ../sessao-admin.ts.
  await exigirSessaoDeAdmin()

  const [saldos, reservas, kits] = await Promise.all([
    saldosPorKit(),
    reservadosPorKit(),
    listarKitsAtivos(),
  ])

  const kitPorId = new Map(kits.map((k) => [k.id, k]))
  const reservadoPorEstoque = new Map(reservas.map((r) => [chave(r.kitId, r.canal), r.reservado]))

  const presenciais = saldos.filter((s) => s.canal === 'presencial')
  const onlines = saldos.filter((s) => s.canal === 'online')

  return (
    <>
      <div className="admin__topo">
        <div>
          <h1 className="admin__titulo">Estoque</h1>
          <p className="admin__lede">
            Presencial e online são estoques separados: a venda de um não
            consome o outro.
          </p>
        </div>
      </div>

      <h2 className="admin__titulo" id="ao-vivo">Ao vivo no evento</h2>
      <p className="admin__lede">
        Atualiza sozinho a cada 15 segundos, sem recarregar a página.
      </p>

      <div className="admin__cartoes">
        {/*
          O CONTADOR VIVO E SO DO PRESENCIAL, e §11 pede exatamente isso: o
          numero que muda a cada venda no balcao enquanto esta tela fica aberta
          no telao do escritorio. O online nao tem contador porque nao tem
          numero — ver textoDisponivel acima.

          <ContadorEstoque> e o mesmo componente da home; ele so aparece para
          kit ATIVO porque precisa do slug para consultar GET /api/estoque, e
          quem tem slug e o catalogo. Kit desativado com estoque na caixa
          continua aparecendo na tabela abaixo, que e onde essa divergencia
          precisa ser vista.
        */}
        {presenciais.filter((s) => !s.ilimitado && kitPorId.has(s.kitId)).map((saldo) => {
          const kit = kitPorId.get(saldo.kitId)
          if (!kit) return null
          return (
            <div className="cartao" key={saldo.estoqueId}>
              <p className="cartao__rotulo">{kit.nome} · presencial</p>
              <ContadorEstoque
                inicial={{ disponivel: saldo.disponivel, total: saldo.total }}
                kitSlug={kit.slug}
              />
              <p className="cartao__nota">
                {saldo.vendido} de {saldo.total} já saíram da caixa.
              </p>
            </div>
          )
        })}

        {presenciais.length === 0 && (
          // ESTADO VAZIO HONESTO: sem linha de estoque presencial nao ha lote
          // nenhum reservado para o evento, e a tela diz isso em vez de mostrar
          // um contador zerado — que seria indistinguivel de "os 50 acabaram".
          <p className="aviso aviso--atencao">
            <span className="aviso__titulo">Sem estoque presencial</span>
            Nenhum kit tem estoque cadastrado para o balcão do evento. Enquanto
            isso, nenhuma venda presencial pode ser concluída.
          </p>
        )}
      </div>

      <h2 className="admin__titulo" id="presencial">Presencial (teto rígido)</h2>
      <p className="admin__lede">
        Lote do evento. Cada venda de balcão baixa a unidade na hora da compra,
        porque o comprador leva o kit em mãos.
      </p>

      <div className="tabela-rolagem">
        <table className="tabela" aria-labelledby="presencial">
          <thead>
            <tr>
              <th scope="col">Kit</th>
              <th scope="col" className="tabela__num">Total</th>
              <th scope="col" className="tabela__num">Vendido</th>
              <th scope="col" className="tabela__num">Disponível</th>
            </tr>
          </thead>
          <tbody>
            {presenciais.length === 0 ? (
              <tr>
                <td className="tabela__vazio" colSpan={4}>
                  Nenhum estoque presencial cadastrado.
                </td>
              </tr>
            ) : (
              presenciais.map((saldo) => (
                <tr key={saldo.estoqueId}>
                  <td>
                    {/*
                      Kit desativado no catalogo continua tendo estoque — e
                      unidades de verdade na caixa. Mostrar o uuid e a resposta
                      honesta: e assim que alguem descobre que ha kit fora do ar
                      com lote aberto. Inventar um nome aqui esconderia
                      exatamente essa divergencia.
                    */}
                    {kitPorId.get(saldo.kitId)?.nome ?? (
                      <>
                        {saldo.kitId}
                        <span className="tabela__secundario">
                          Kit desativado no catálogo
                        </span>
                      </>
                    )}
                  </td>
                  <td className="tabela__num">{saldo.total}</td>
                  <td className="tabela__num">{saldo.vendido}</td>
                  <td className="tabela__num" data-testid="disponivel-presencial">
                    {textoDisponivel(saldo)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/*
        POR QUE NAO HA COLUNA "RESERVADO" AQUI. No balcao a unidade sai do
        livro-razao na CRIACAO do pedido (§10) e o pedido so deixa de estar
        "reservado" quando o webhook confirma o pagamento — nessa janela a mesma
        unidade e contada em "Vendido" E em "Reservado". Ter as duas colunas
        lado a lado convidaria a soma-las, e a soma conta kit que nao existe.
        §17 pede "Reservado" na tabela do online, e e la que ela esta.
      */}
      <p className="admin__lede">
        Unidades de vendas presenciais aguardando confirmação do pagamento já
        estão contadas em &ldquo;Vendido&rdquo;: no balcão a baixa acontece na
        hora da compra.
      </p>

      <h2 className="admin__titulo" id="online">Online (pré-venda sem teto)</h2>
      <p className="admin__lede">
        Decisão do cliente em 16/08: a loja não tem limite de unidades. A baixa
        acontece no pagamento, então carrinho abandonado não segura kit.
      </p>

      <div className="tabela-rolagem">
        <table className="tabela" aria-labelledby="online">
          <thead>
            <tr>
              <th scope="col">Kit</th>
              <th scope="col" className="tabela__num">Total</th>
              <th scope="col" className="tabela__num">Vendido</th>
              <th scope="col" className="tabela__num">Reservado</th>
              <th scope="col" className="tabela__num">Disponível</th>
            </tr>
          </thead>
          <tbody>
            {onlines.length === 0 ? (
              <tr>
                <td className="tabela__vazio" colSpan={5}>
                  Nenhum estoque online cadastrado.
                </td>
              </tr>
            ) : (
              onlines.map((saldo) => (
                <tr key={saldo.estoqueId}>
                  <td>
                    {kitPorId.get(saldo.kitId)?.nome ?? (
                      <>
                        {saldo.kitId}
                        <span className="tabela__secundario">
                          Kit desativado no catálogo
                        </span>
                      </>
                    )}
                  </td>
                  <td className="tabela__num">{saldo.total}</td>
                  <td className="tabela__num">{saldo.vendido}</td>
                  <td className="tabela__num">
                    {/*
                      Ausencia de linha na consulta de reservas significa
                      "nenhuma unidade presa", nao "desconhecido" — por isso
                      zero aqui e um numero contado, e nao um valor inventado.
                    */}
                    {reservadoPorEstoque.get(chave(saldo.kitId, saldo.canal)) ?? 0}
                  </td>
                  <td className="tabela__num" data-testid="disponivel-online">
                    {textoDisponivel(saldo)}
                    {saldo.ilimitado && (
                      <span className="tabela__secundario">pré-venda sem teto</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="admin__lede">
        &ldquo;Reservado&rdquo; é o que está em pedido criado e ainda não pago.
        Não desconta do disponível e não segura estoque: existe para a operação
        enxergar o que está em curso.
      </p>
    </>
  )
}
