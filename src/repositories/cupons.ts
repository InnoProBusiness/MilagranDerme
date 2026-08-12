import { sql, type Transaction } from 'kysely'
import type { DB } from '@/lib/db-types'
import { calcularDesconto, type ResultadoCupom } from '@/lib/cupom'
import type { Centavos } from '@/lib/money'

/**
 * Resgata um cupom DENTRO da transacao que cria o pedido.
 *
 * A linha do cupom e travada com SELECT ... FOR UPDATE antes de contar os
 * usos. Sem isso, dois checkouts simultaneos leem a mesma contagem, os dois
 * passam, e o limite estoura — o modo de falha classico de cupom, e o unico
 * caminho pelo qual um desconto e concedido alem do autorizado.
 *
 * Recebe a transacao em vez de abrir a propria: o resgate e a criacao do
 * pedido tem que ser atomicos. Cupom debitado sem pedido, ou pedido com
 * desconto sem uso registrado, sao os dois corrupcao de dados.
 */
export async function resgatarCupom(
  codigo: string,
  subtotal: Centavos,
  clienteId: string,
  trx: Transaction<DB>,
  agora: Date = new Date(),
): Promise<ResultadoCupom> {
  const cupom = await trx.selectFrom('cupons')
    .selectAll()
    .where('codigo', '=', codigo.trim().toUpperCase())
    .forUpdate()
    .executeTakeFirst()

  if (!cupom) return { ok: false, motivo: 'inexistente' }
  if (!cupom.ativo) return { ok: false, motivo: 'inativo' }
  if (agora < cupom.inicia_em) return { ok: false, motivo: 'nao_iniciado' }
  if (cupom.expira_em && agora >= cupom.expira_em) return { ok: false, motivo: 'expirado' }

  if (cupom.representante_id) {
    const rep = await trx.selectFrom('representantes')
      .select('id')
      .where('id', '=', cupom.representante_id)
      .where('ativo', '=', true)
      .executeTakeFirst()
    if (!rep) return { ok: false, motivo: 'representante_inativo' }
  }

  if (cupom.limite_total !== null) {
    const { total } = await trx.selectFrom('cupom_usos')
      .select(sql<number>`count(*)::int`.as('total'))
      .where('cupom_id', '=', cupom.id)
      .executeTakeFirstOrThrow()
    if (total >= cupom.limite_total) return { ok: false, motivo: 'esgotado' }
  }

  const { doCliente } = await trx.selectFrom('cupom_usos')
    .select(sql<number>`count(*)::int`.as('doCliente'))
    .where('cupom_id', '=', cupom.id)
    .where('cliente_id', '=', clienteId)
    .executeTakeFirstOrThrow()
  if (doCliente >= cupom.limite_por_cliente) {
    return { ok: false, motivo: 'limite_do_cliente' }
  }

  return {
    ok: true,
    cupom: {
      id: cupom.id,
      codigo: cupom.codigo,
      desconto: calcularDesconto(cupom.tipo, cupom.valor, subtotal),
      representanteId: cupom.representante_id,
    },
  }
}
