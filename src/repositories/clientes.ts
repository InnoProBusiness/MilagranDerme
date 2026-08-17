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
 * ENDERECO `null` = VENDA PRESENCIAL (§10 do documento de 16/08/2026): o
 * balcao do evento nao pede endereco de entrega porque nao ha entrega nenhuma
 * — o comprador paga e sai com o kit na mao. Nesse caso a funcao grava (ou
 * atualiza) o cliente exatamente como sempre fez, nao toca em `enderecos` e
 * devolve `enderecoId: null`. Quem chama com endereco continua com o
 * comportamento anterior, linha por linha: uma linha nova em `enderecos` por
 * compra.
 *
 * A alternativa — exigir endereco sempre e deixar a tela do vendedor inventar
 * um ("Balcao do evento", CEP 00000000) — foi recusada por dois motivos, e
 * vale escrever os dois porque o proximo a mexer aqui vai considerar de novo.
 * Primeiro, o banco recusa: endereco_cep_digitos e endereco_uf_valida
 * (migrations/1755000100000_clientes.sql) so aceitam 8 digitos e uma UF de
 * verdade, entao o preenchimento teria que ser um CEP plausivel mas falso.
 * Segundo, e o motivo que importa: um endereco forjado entra no cadastro de
 * uma pessoa REAL e nao se distingue mais de um endereco que ela declarou. A
 * tela de logistica (listarLogisticaAdmin, src/repositories/pedidos.ts) leria
 * a venda de balcao como pedido com entrega pendente para um lugar que nao
 * existe, e a expedicao gastaria tempo atras de um pacote que ninguem deve
 * despachar.
 *
 * A COERENCIA ENTRE CANAL E ENDERECO NAO E DECIDIDA AQUI. Esta funcao aceita
 * `null` de quem pedir; quem recusa a combinacao errada e o banco, pelo CHECK
 * pedido_online_tem_endereco
 * (migrations/1755300100000_pedidos_canal_logistica.sql): pedido com
 * canal = 'online' e endereco_id NULL nao entra. Ou seja, passar `null` num
 * fluxo online nao produz um pedido mudo sem entrega — produz um erro no
 * INSERT de `pedidos`, dentro da mesma transacao, e o rollback leva o cliente
 * junto. Hoje sao dois chamadores: src/app/api/pedidos/route.ts (online,
 * sempre com endereco) e src/app/api/vendas-presenciais/route.ts (balcao,
 * sempre `null`).
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
  e: EntradaEndereco | null,
  trx?: Transaction<DB>,
): Promise<{ clienteId: string; enderecoId: string | null }> {
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

    // O INSERT e CONDICIONAL, e so ele: nada acima muda por causa do canal.
    // Escrever isto como dois caminhos completos ("presencial faz X, online
    // faz Y") duplicaria a busca por lower(email), a comparacao de CPF e o
    // UPDATE de nome/whatsapp — e a proxima regra de identidade a mudar
    // entraria em um dos dois ramos. CpfDivergenteError precisa valer igual
    // no balcao e na loja: e no balcao, com fila e pressa, que alguem digita
    // o e-mail de outra pessoa.
    //
    // `executeTakeFirstOrThrow` continua no ramo com endereco. Um INSERT que
    // nao devolve linha e falha de infraestrutura, nao "cliente sem
    // endereco" — o unico jeito de nao haver endereco e o chamador ter
    // pedido `null`, explicitamente, la em cima.
    let enderecoId: string | null = null
    if (e !== null) {
      const endereco = await t.insertInto('enderecos')
        .values({ cliente_id: clienteId, ...e })
        .returning('id').executeTakeFirstOrThrow()
      enderecoId = endereco.id
    }

    return { clienteId, enderecoId }
  }

  if (trx) return executar(trx)
  return getDb().transaction().execute(executar)
}
