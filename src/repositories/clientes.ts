import { getDb } from '@/lib/db'
import { sql, type Transaction } from 'kysely'
import type { DB } from '@/lib/db-types'

/**
 * O CPF enviado nao bate com o CPF ja gravado para aquele e-mail.
 *
 * CLASSE, e nao um prefixo de string: quem trata isto (src/app/api/pedidos/route.ts)
 * distingue este caso de uma falha de infraestrutura, e a diferenca entre 422
 * e 500 nao pode depender de as duas pontas continuarem escrevendo a mesma
 * palavra. Com `mensagem.startsWith('cpf_divergente')`, reescrever a frase
 * aqui fazia a rota passar a responder 500 sem nenhum teste ficar vermelho.
 * Mesmo padrao de RecusaDeCupom, que ja usava `instanceof` na rota.
 *
 * A mensagem nao carrega digito nenhum de CPF: ela existe para o log do
 * servidor. A resposta ao cliente e deliberadamente o 422 generico (ver o
 * comentario na rota — motivo especifico aqui seria um oraculo de existencia
 * de cliente e de confirmacao de CPF, sem autenticacao nenhuma).
 */
export class CpfDivergenteError extends Error {
  constructor() {
    super('cpf_divergente: o CPF enviado nao bate com o CPF ja cadastrado para este e-mail')
    this.name = 'CpfDivergenteError'
  }
}

export type EntradaCliente = { nome: string; email: string; cpf: string; whatsapp: string }
export type EntradaEndereco = {
  cep: string; rua: string; numero: string; complemento: string
  bairro: string; cidade: string; estado: string
}

/**
 * O cliente e identificado por lower(email). Endereco NAO e atualizado: cada
 * compra grava o endereco daquela compra, porque o pedido antigo tem que
 * continuar mostrando para onde foi entregue.
 *
 * Se o e-mail ja pertence a um cliente cadastrado e o CPF enviado agora
 * diverge do CPF gravado, a funcao LANCA em vez de sobrescrever. CPF e
 * documento de identidade — uma caixa de e-mail de familia, um endereco
 * reaproveitado, uma digitacao errada ou uma tentativa de fraude nao podem
 * apagar o CPF original em silencio, do mesmo jeito que criarPedido
 * (Tarefa 1) recusa um preco que diverge do catalogo em vez de gravar o
 * numero errado. nome e whatsapp continuam atualizados livremente: esses
 * legitimamente mudam entre compras.
 *
 * ATENCAO PARA QUEM CHAMA: uma violacao de CHECK do Postgres nesta tabela
 * carrega a linha inteira — nome, e-mail, CPF, whatsapp — na propriedade
 * `detail` do erro. So `error.message` (ou `error.constraint`, quando
 * disponivel) e seguro para logar ou repassar ao cliente; nunca o objeto de
 * erro cru nem `detail`.
 *
 * Aceita uma transacao externa opcional (`trx`): quando presente, a escrita
 * entra na transacao do chamador em vez de abrir uma propria. Sem isso, um
 * pedido que falhe depois de gravar o cliente (cupom invalido, preco
 * divergente, etc.) deixaria nome, CPF, whatsapp e endereco completos
 * commitados e presos a nenhum pedido — a Tarefa 9 chama esta funcao de
 * dentro da mesma transacao que cria o pedido e resgata o cupom.
 */
export async function salvarClienteComEndereco(
  c: EntradaCliente,
  e: EntradaEndereco,
  trx?: Transaction<DB>,
): Promise<{ clienteId: string; enderecoId: string }> {
  const executar = async (t: Transaction<DB>) => {
    const existente = await t.selectFrom('clientes')
      .select(['id', 'cpf'])
      .where(sql<boolean>`lower(email) = lower(${c.email})`)
      .executeTakeFirst()

    let clienteId: string
    if (existente) {
      if (existente.cpf !== c.cpf) {
        throw new CpfDivergenteError()
      }
      clienteId = existente.id
      await t.updateTable('clientes')
        .set({ nome: c.nome, whatsapp: c.whatsapp, atualizado_em: new Date() })
        .where('id', '=', clienteId)
        .execute()
    } else {
      const novo = await t.insertInto('clientes')
        .values({ nome: c.nome, email: c.email, cpf: c.cpf, whatsapp: c.whatsapp })
        .returning('id').executeTakeFirstOrThrow()
      clienteId = novo.id
    }

    const endereco = await t.insertInto('enderecos')
      .values({ cliente_id: clienteId, ...e })
      .returning('id').executeTakeFirstOrThrow()

    return { clienteId, enderecoId: endereco.id }
  }

  if (trx) return executar(trx)
  return getDb().transaction().execute(executar)
}
