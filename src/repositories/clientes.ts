import { getDb } from '@/lib/db'
import { sql } from 'kysely'

export type EntradaCliente = { nome: string; email: string; cpf: string; whatsapp: string }
export type EntradaEndereco = {
  cep: string; rua: string; numero: string; complemento: string
  bairro: string; cidade: string; estado: string
}

/**
 * O cliente e identificado por lower(email). Endereco NAO e atualizado: cada
 * compra grava o endereco daquela compra, porque o pedido antigo tem que
 * continuar mostrando para onde foi entregue.
 */
export async function salvarClienteComEndereco(
  c: EntradaCliente,
  e: EntradaEndereco,
): Promise<{ clienteId: string; enderecoId: string }> {
  return getDb().transaction().execute(async (trx) => {
    const existente = await trx.selectFrom('clientes')
      .select('id')
      .where(sql<boolean>`lower(email) = lower(${c.email})`)
      .executeTakeFirst()

    let clienteId: string
    if (existente) {
      clienteId = existente.id
      await trx.updateTable('clientes')
        .set({ nome: c.nome, whatsapp: c.whatsapp, cpf: c.cpf, atualizado_em: new Date() })
        .where('id', '=', clienteId)
        .execute()
    } else {
      const novo = await trx.insertInto('clientes')
        .values({ nome: c.nome, email: c.email, cpf: c.cpf, whatsapp: c.whatsapp })
        .returning('id').executeTakeFirstOrThrow()
      clienteId = novo.id
    }

    const endereco = await trx.insertInto('enderecos')
      .values({ cliente_id: clienteId, ...e })
      .returning('id').executeTakeFirstOrThrow()

    return { clienteId, enderecoId: endereco.id }
  })
}
