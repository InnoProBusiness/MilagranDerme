import { sql, type Selectable, type Transaction } from 'kysely'
import { getDb } from '@/lib/db'
import type { DB, Pedidos, PedidoItens, OrigemAtribuicao, PedidoStatus } from '@/lib/db-types'
import { deInteiro, type Centavos } from '@/lib/money'

// kysely-codegen ja gera unions literais a partir dos ENUMs do Postgres
// (ver migrations/1754900300000_pedidos.sql): origem_atribuicao vira
// 'link' | 'cupom' | 'casa' | 'rep_inativo' e pedido_status vira os oito
// estados. Reexportar em vez de redeclarar evita que o tipo do repositorio
// e o ENUM do banco divirjam com o tempo — e e o que da a maquina de
// estados do Plano 3 uma checagem de exaustividade de verdade no switch.
export type { OrigemAtribuicao, PedidoStatus }

export type ItemDoPedido = {
  kitId: string
  quantidade: number
  precoUnitarioCentavos: Centavos
}

export type EntradaPedido = {
  origem: OrigemAtribuicao
  representanteId: string | null
  percentualComissao: number | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  desconto: Centavos
  frete: Centavos
  itens: ItemDoPedido[]
  /**
   * Opcionais e sempre null quando ausentes: os testes existentes (Tarefas
   * 1 e 5) chamam criarPedido sem cliente, endereco ou cupom nenhum, e
   * continuam validos. A Tarefa 9 (checkout) e quem sempre preenche os
   * tres — sao o elo entre o pedido e quem comprou, e entre o pedido e o
   * cupom_usos gravado na mesma transacao.
   */
  clienteId?: string | null
  enderecoId?: string | null
  cupomId?: string | null
}

export type Pedido = {
  id: string
  numero: number
  status: PedidoStatus
  origem: OrigemAtribuicao
  representanteId: string | null
  percentualComissaoSnapshot: number | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  subtotalCentavos: Centavos
  descontoCentavos: Centavos
  freteCentavos: Centavos
  totalCentavos: Centavos
  criadoEm: Date
}

function paraPedido(l: Selectable<Pedidos>): Pedido {
  return {
    id: l.id,
    numero: Number(l.numero),
    status: l.status,
    origem: l.origem,
    representanteId: l.representante_id,
    percentualComissaoSnapshot:
      l.percentual_comissao_snapshot === null ? null : Number(l.percentual_comissao_snapshot),
    utmSource: l.utm_source,
    utmMedium: l.utm_medium,
    utmCampaign: l.utm_campaign,
    // As colunas de dinheiro ja estao em centavos inteiros no banco:
    // deInteiro apenas atesta o tipo, sem multiplicar por 100. Usar
    // centavos() aqui multiplicaria de novo, silenciosamente, porque as
    // duas funcoes devolvem o mesmo tipo Centavos e o erro nao apareceria
    // na compilacao.
    subtotalCentavos: deInteiro(l.subtotal_centavos),
    descontoCentavos: deInteiro(l.desconto_centavos),
    freteCentavos: deInteiro(l.frete_centavos),
    totalCentavos: deInteiro(l.total_centavos),
    criadoEm: l.criado_em,
  }
}

/**
 * Congela a atribuicao da venda no momento da criacao. representante_id,
 * percentual_comissao_snapshot e os UTM nunca sao recalculados depois: se o
 * cadastro do representante mudar amanha, o pedido de hoje continua valendo
 * o que valia hoje. As constraints do banco (pedido_atribuicao_coerente,
 * pedido_origem_coerente, pedido_total_confere, pedido_desconto_nao_excede)
 * sao a linha de defesa real — este repositorio nao reimplementa nenhuma
 * delas em JavaScript.
 *
 * O subtotal NAO vem da aplicacao: e a soma dos itens, e quem garante isso
 * e o trigger CONSTRAINT DEFERRABLE pedido_subtotal_confere_trg (migrations/
 * 1755000000000_pedido_itens.sql), que roda no COMMIT desta transacao — nao
 * a cada INSERT. A soma calculada aqui em JS e so o valor a gravar em
 * subtotal_centavos; se ela nao bater com a soma real dos itens que o banco
 * ve, o COMMIT falha. A comissao do representante incide sobre esse valor
 * amarrado ao banco, nao sobre uma soma que a aplicacao poderia errar. Um
 * segundo trigger deferido, pedido_itens_obrigatorios_trg, garante que todo
 * pedido tem ao menos um item — o guard de itens.length abaixo e so uma
 * mensagem melhor antes do round trip, nao a garantia de verdade.
 *
 * O preco de cada item TAMBEM nao e confiado ao chamador: precoUnitarioCentavos
 * e validado contra kits.preco_centavos dentro desta mesma transacao antes de
 * gravar o item, e uma divergencia lanca em vez de gravar em silencio — ver o
 * comentario no loop abaixo.
 *
 * Aceita uma transacao externa opcional (`trx`), no mesmo formato de
 * salvarClienteComEndereco (src/repositories/clientes.ts): quando presente,
 * a escrita entra na transacao do chamador em vez de abrir uma propria. O
 * checkout (Tarefa 9) chama esta funcao de dentro da mesma transacao que
 * salva cliente/endereco e resgata o cupom — sem isso, o resgate do cupom e
 * a criacao do pedido ficariam em transacoes diferentes, e um dos dois
 * podia commitar sem o outro.
 */
export async function criarPedido(e: EntradaPedido, trx?: Transaction<DB>): Promise<Pedido> {
  if (e.itens.length === 0) {
    throw new Error('Pedido sem itens nao pode ser criado')
  }

  const subtotal = e.itens.reduce(
    (acc, i) => acc + i.precoUnitarioCentavos * i.quantidade,
    0,
  ) as Centavos
  const total = (subtotal - e.desconto + e.frete) as Centavos

  const executar = async (t: Transaction<DB>) => {
    const linha = await t
      .insertInto('pedidos')
      .values({
        origem: e.origem,
        representante_id: e.representanteId,
        percentual_comissao_snapshot: e.percentualComissao,
        utm_source: e.utmSource,
        utm_medium: e.utmMedium,
        utm_campaign: e.utmCampaign,
        subtotal_centavos: subtotal,
        desconto_centavos: e.desconto,
        frete_centavos: e.frete,
        total_centavos: total,
        cliente_id: e.clienteId ?? null,
        endereco_id: e.enderecoId ?? null,
        cupom_id: e.cupomId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    // Nome e preco vem do catalogo AGORA e viram snapshot na linha do item:
    // se o preco do kit mudar amanha, o pedido de hoje continua valendo o
    // que valia hoje — mesmo principio do percentual_comissao_snapshot.
    for (const item of e.itens) {
      const kit = await t
        .selectFrom('kits')
        .select(['nome', 'preco_centavos'])
        .where('id', '=', item.kitId)
        .executeTakeFirstOrThrow()

      // O preco vem do CHAMADOR (o carrinho, que leu a vitrine em algum
      // momento antes do checkout) mas nunca e confiado as cegas: se
      // divergir do catalogo agora, o preco mudou entre a vitrine e o
      // checkout — cobrar um valor diferente do que foi mostrado e um
      // defeito por si so, entao isto lanca em vez de sobrescrever em
      // silencio com o valor do catalogo ou com o valor do chamador.
      if (item.precoUnitarioCentavos !== kit.preco_centavos) {
        throw new Error(
          `preco_divergente: catalogo do kit ${item.kitId} tem ${kit.preco_centavos} ` +
            `centavos, mas o checkout enviou ${item.precoUnitarioCentavos}`,
        )
      }

      await t
        .insertInto('pedido_itens')
        .values({
          pedido_id: linha.id,
          kit_id: item.kitId,
          nome_snapshot: kit.nome,
          preco_unitario_centavos: item.precoUnitarioCentavos,
          quantidade: item.quantidade,
          total_centavos: item.precoUnitarioCentavos * item.quantidade,
        })
        .execute()
    }

    return paraPedido(linha)
  }

  if (trx) return executar(trx)
  return getDb().transaction().execute(executar)
}

export type ItemPedido = {
  id: string
  kitId: string
  nomeSnapshot: string
  precoUnitarioCentavos: Centavos
  quantidade: number
  totalCentavos: Centavos
}

export type PedidoComItens = Pedido & { itens: ItemPedido[] }

function paraItemPedido(l: Selectable<PedidoItens>): ItemPedido {
  return {
    id: l.id,
    kitId: l.kit_id,
    nomeSnapshot: l.nome_snapshot,
    precoUnitarioCentavos: deInteiro(l.preco_unitario_centavos),
    quantidade: l.quantidade,
    totalCentavos: deInteiro(l.total_centavos),
  }
}

/**
 * Le um pedido pelo numero publico (o que aparece na URL de confirmacao,
 * /pedido/<numero>) junto dos seus itens. Usada pela pagina de confirmacao
 * (Tarefa 9) — nunca pelo fluxo de criacao, que ja tem a linha inteira em
 * maos a partir de criarPedido.
 */
export async function buscarPedidoComItensPorNumero(numero: number): Promise<PedidoComItens | null> {
  const linha = await getDb()
    .selectFrom('pedidos')
    .selectAll()
    // pedidos.numero e int8: o tipo gerado (Int8 = ColumnType<string, ...>)
    // torna `.where('numero', '=', numero)` com um `number` cru um erro de
    // tipo — o select type e string mesmo o driver devolvendo number em
    // runtime (ver o setTypeParser de INT8 em src/lib/db.ts). sql`` evita a
    // fricao sem introduzir `as` nenhum.
    .where(sql<boolean>`numero = ${numero}`)
    .executeTakeFirst()
  if (!linha) return null

  const itens = await getDb()
    .selectFrom('pedido_itens')
    .selectAll()
    .where('pedido_id', '=', linha.id)
    .orderBy('criado_em', 'asc')
    .execute()

  return { ...paraPedido(linha), itens: itens.map(paraItemPedido) }
}
