import { exigirPapel } from '@/lib/guarda'
import { saldosPorKit } from '@/repositories/estoque'
import { reservadosPorKit } from '@/repositories/pedidos'
import { listarKitsAtivos } from '@/repositories/produtos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/estoque — a tabela de estoque do painel (§17): Total,
 * Vendido, Reservado e Disponivel, por kit e por canal.
 *
 * HANDLER FINO: as tres leituras moram em repositorio (saldosPorKit em
 * src/repositories/estoque.ts, reservadosPorKit em
 * src/repositories/pedidos.ts, listarKitsAtivos em
 * src/repositories/produtos.ts). O que este arquivo faz e junta-las por
 * (kitId, canal) e — a unica decisao de verdade daqui — traduzir o canal
 * ilimitado para um formato que nao minta. Ver o bloco de `disponivel` abaixo.
 *
 * SEM FILTRO NENHUM na querystring, ao contrario de /api/admin/vendas: sao duas
 * linhas por kit (§4: presencial e online sao estoques SEPARADOS) e o painel
 * mostra todas de uma vez. Um filtro aqui so criaria uma forma de a tela
 * esconder metade do estoque do evento.
 */

/**
 * Mesmo motivo de /api/admin/vendas: resposta que depende de quem pediu nao
 * pode ficar em cache compartilhado. Aqui nao ha dado pessoal, mas ha o numero
 * que decide se a proxima pessoa da fila leva kit — uma copia de dois minutos
 * atras servida no dia do evento faz o painel prometer unidade que ja saiu.
 */
const SEM_CACHE = { 'Cache-Control': 'no-store' } as const

/**
 * Chave de cruzamento das duas leituras. Os saldos vem de `estoques` e as
 * reservas de `pedidos`; as duas listas sao por (kit, canal) e nenhuma das
 * duas contem a outra — um kit pode ter estoque cadastrado e nenhuma reserva,
 * e pode ter reserva sem linha de estoque nenhuma (venda de um kit que ninguem
 * cadastrou no evento, caso que baixarEstoque trata devolvendo false em vez de
 * derrubar a conciliacao). Cruzar por string composta e o suficiente porque
 * kitId e uuid e canal e um dos dois literais do ENUM: nao ha separador
 * ambiguo possivel.
 */
function chave(kitId: string, canal: string): string {
  return `${kitId}:${canal}`
}

export async function GET(req: Request) {
  // Primeira coisa do handler, antes de qualquer leitura de banco — ver o
  // comentario equivalente em src/app/api/admin/vendas/route.ts e o teste
  // src/app/api/__tests__/admin-guarda.test.ts.
  const usuario = await exigirPapel(req, ['admin'])
  if (usuario instanceof Response) return usuario

  const [saldos, reservas, kits] = await Promise.all([
    saldosPorKit(),
    reservadosPorKit(),
    listarKitsAtivos(),
  ])

  const nomePorKit = new Map(kits.map((k) => [k.id, k.nome]))
  const reservadoPorEstoque = new Map(reservas.map((r) => [chave(r.kitId, r.canal), r.reservado]))

  const estoques = saldos.map((s) => ({
    kitId: s.kitId,
    /**
     * null quando o kit foi DESATIVADO no catalogo: listarKitsAtivos so
     * devolve os ativos, e o estoque de um kit desligado continua existindo
     * (e continua com unidades na caixa). Null e a resposta honesta — a tela
     * mostra o uuid e alguem descobre que ha estoque de um kit fora do ar,
     * que e exatamente a divergencia que interessa ver. Buscar o nome com uma
     * consulta a parte "para nunca faltar" esconderia isso.
     */
    kitNome: nomePorKit.get(s.kitId) ?? null,
    canal: s.canal,
    ilimitado: s.ilimitado,
    total: s.total,
    vendido: s.vendido,
    /**
     * Unidades em pedido criado e nao pago. NAO DESCONTA de `disponivel` e nao
     * segura estoque: a unidade sai do livro-razao no pagamento (§4, decisao do
     * cliente em 16/08). O doc comment de reservadosPorKit
     * (src/repositories/pedidos.ts) explica por que, no canal presencial, a
     * mesma unidade pode aparecer em `vendido` E aqui — e por que somar as duas
     * colunas conta kit que nao existe.
     *
     * Zero quando nao ha reserva: a ausencia de linha na consulta de reservas
     * significa "nenhuma unidade presa", nao "desconhecido".
     */
    reservado: reservadoPorEstoque.get(chave(s.kitId, s.canal)) ?? 0,
    /**
     * ------------------------------------------------------------------
     * `null` QUANDO O CANAL E ILIMITADO. E A DECISAO DESTE ARQUIVO.
     * ------------------------------------------------------------------
     *
     * O canal online e pre-venda SEM TETO por decisao do cliente em 16/08
     * (§4, `estoques.ilimitado = true` em
     * migrations/1755300000000_canal_e_estoque.sql). "Quantos ainda ha para
     * vender online?" nao tem resposta numerica: nao ha limite a subtrair.
     *
     * O numero que o repositorio devolve em `disponivel` para esse canal e
     * SUM(quantidade) de todos os movimentos — e como o canal online nunca
     * recebe entrada (o seed de 1755300700000_seed_estoque.sql so lanca as 50
     * unidades no presencial), esse saldo nasce em zero e so desce: e menos o
     * total ja vendido, e so um `ajuste` manual o levantaria — o que ninguem
     * tem motivo para fazer num canal sem teto. Repassa-lo como "disponivel"
     * poria "-37 kits
     * disponiveis" na tela do dono da empresa, ou — pior, se alguem
     * "arrumasse" com um Math.max(0, ...) — um "0 disponivel" para o canal que
     * na verdade nunca esgota, e a operacao pararia de vender online no dia do
     * lancamento por causa de um numero inventado.
     *
     * `null` + `ilimitado: true` obriga a tela a escrever o que e verdade
     * ("ilimitado", "pre-venda") em vez de imprimir um numero. E o mesmo
     * principio de src/components/linha-frete.tsx, que prefere "a calcular" a
     * mostrar R$ 0,00, e o de CotacaoIlegivelError em src/lib/frete.ts, que
     * prefere erro legivel a assumir zero: quando o numero nao existe, a
     * resposta certa nao e um numero.
     *
     * `total` e `vendido` continuam valendo para o canal ilimitado e por isso
     * seguem numeros: quantas entraram (zero, online) e quantas ja sairam sao
     * fatos contados, nao promessas.
     */
    disponivel: s.ilimitado ? null : s.disponivel,
  }))

  return Response.json({ estoques }, { headers: SEM_CACHE })
}

/**
 * Demais verbos: 405 com `Allow`, padrao da casa.
 *
 * Correcao de inventario (quebra, perda, contagem que nao bateu) NAO passa por
 * aqui: quem faz isso e `ajustarEstoque` (src/repositories/estoque.ts), que
 * ainda nao tem rota. Quando tiver, ela nasce como um POST proprio com motivo
 * obrigatorio no corpo — nunca como um PUT que sobrescreva saldo, porque o
 * estoque e um livro-razao append-only e nao existe saldo para sobrescrever.
 */
function metodoNaoPermitido() {
  return Response.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET' },
  })
}

export const POST = metodoNaoPermitido
export const PUT = metodoNaoPermitido
export const PATCH = metodoNaoPermitido
export const DELETE = metodoNaoPermitido
