import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'kysely'
import { getDb, closeDb } from '@/lib/db'
import { salvarClienteComEndereco, CpfDivergenteError } from '@/repositories/clientes'

// E-mails PROPRIOS deste arquivo, como slug/codigo em cupons.test.ts e em
// pedidos-route.test.ts. O Vitest roda os arquivos de teste em paralelo
// contra o MESMO Postgres real, entao cada arquivo precisa de um espaco de
// nomes que so ele escreve e so ele apaga.
//
// A chave e o E-MAIL, e nao o CPF, porque e o e-mail que `clientes` usa
// como identidade: o indice unico cliente_email_unico e sobre lower(email)
// (migrations/1755000100000_clientes.sql) e salvarClienteComEndereco procura
// o cliente existente por lower(email). CPF nao tem indice unico nenhum —
// dois clientes distintos podem legitimamente compartilhar o mesmo valor, e
// foi exatamente isso que aconteceu: este arquivo limpava por
// cpf = '12345678901', que tambem e o CPF do comprador de
// pedidos-route.test.ts. Rodando em paralelo, ou a contagem deste arquivo
// enxergava o cliente do outro, ou — pior — o DELETE do beforeEach esbarrava
// em pedidos_cliente_id_fkey (ON DELETE RESTRICT) porque o outro arquivo
// tinha um pedido commitado apontando para aquela linha, e os 11 testes
// daqui falhavam de uma vez.
const EMAIL_CLIENTE = 'Clientes-Repo-Ana@Exemplo.com' // caixa mista de proposito
const EMAIL_CLIENTE_MINUSCULO = EMAIL_CLIENTE.toLowerCase()
const EMAIL_CARIMBO = 'clientes-repo-carimbo@exemplo.com'
const EMAILS = [EMAIL_CLIENTE, EMAIL_CARIMBO] as const

// CPF tambem exclusivo deste arquivo. Ele NAO e mais chave de limpeza (ver
// acima), mas manter um valor compartilhado com outro arquivo convidaria o
// proximo `where('cpf', ...)` a reintroduzir o mesmo defeito.
const CPF = '99988877766'

const CLIENTE = { nome: 'Ana Souza', email: EMAIL_CLIENTE, cpf: CPF, whatsapp: '11988887777' }
const ENDERECO = { cep: '01310100', rua: 'Av Paulista', numero: '1000', complemento: 'ap 51', bairro: 'Bela Vista', cidade: 'Sao Paulo', estado: 'SP' }
// CPF de um segundo cliente hipotetico, usado so no teste de divergencia.
// Nunca gravado com sucesso (a funcao lanca antes do INSERT), entao nao
// precisa de limpeza propria no beforeEach abaixo.
const CPF_DIVERGENTE = '22222222222'

/**
 * Limpeza na ordem que o grafo de chaves estrangeiras exige:
 *
 *  - pedidos.cliente_id e ON DELETE RESTRICT (migrations/1754900300000_pedidos.sql):
 *    um pedido apontando para o cliente impede o DELETE dele. Apagar o
 *    pedido primeiro leva pedido_itens e cupom_usos junto (ON DELETE
 *    CASCADE). Este arquivo nao cria pedido nenhum hoje, e o espaco de nomes
 *    de e-mail acima garante que nenhum outro arquivo cria um para estes
 *    e-mails — o DELETE aqui e seguro contra orfaos de uma execucao
 *    interrompida e contra um teste futuro deste arquivo que passe a criar
 *    pedidos.
 *  - enderecos.cliente_id e ON DELETE CASCADE (migrations/1755000100000_clientes.sql):
 *    apagar o cliente ja leva os enderecos dele, sem DELETE em separado.
 */
async function limpar() {
  const db = getDb()
  for (const email of EMAILS) {
    const donos = db.selectFrom('clientes').select('id')
      .where(sql<boolean>`lower(email) = lower(${email})`)
    await db.deleteFrom('pedidos').where('cliente_id', 'in', donos).execute()
    await db.deleteFrom('cupom_usos').where('cliente_id', 'in', donos).execute()
    await db.deleteFrom('clientes')
      .where(sql<boolean>`lower(email) = lower(${email})`).execute()
  }
}

describe('clientes', () => {
  beforeEach(limpar)
  afterAll(async () => { await closeDb() })

  it('salva cliente e endereco juntos', async () => {
    const r = await salvarClienteComEndereco(CLIENTE, ENDERECO)
    expect(r.clienteId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.enderecoId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reconhece o mesmo cliente por e-mail, ignorando a caixa', async () => {
    const a = await salvarClienteComEndereco(CLIENTE, ENDERECO)
    const b = await salvarClienteComEndereco({ ...CLIENTE, email: EMAIL_CLIENTE_MINUSCULO }, ENDERECO)
    expect(b.clienteId).toBe(a.clienteId)
  })

  it('cada compra grava um endereco novo, sem sobrescrever o anterior', async () => {
    const a = await salvarClienteComEndereco(CLIENTE, ENDERECO)
    const b = await salvarClienteComEndereco(CLIENTE, { ...ENDERECO, numero: '2000' })
    expect(b.enderecoId).not.toBe(a.enderecoId)
    const enderecos = await getDb().selectFrom('enderecos')
      .selectAll().where('cliente_id', '=', a.clienteId).execute()
    expect(enderecos).toHaveLength(2)
  })

  it('o banco rejeita CPF com pontuacao', async () => {
    await expect(
      salvarClienteComEndereco({ ...CLIENTE, cpf: '123.456.789-01' }, ENDERECO),
    ).rejects.toThrow(/cliente_cpf_digitos/)
  })

  it('o banco rejeita UF minuscula', async () => {
    await expect(
      salvarClienteComEndereco(CLIENTE, { ...ENDERECO, estado: 'sp' }),
    ).rejects.toThrow(/endereco_uf_valida/)
  })

  it('o banco rejeita CEP com hifen', async () => {
    await expect(
      salvarClienteComEndereco(CLIENTE, { ...ENDERECO, cep: '01310-100' }),
    ).rejects.toThrow(/endereco_cep_digitos/)
  })

  // CPF e o documento de identidade da pessoa. Um segundo checkout com o
  // mesmo e-mail mas um CPF diferente (caixa de familia, endereco
  // reaproveitado, digitacao errada ou fraude) NAO pode apagar o CPF
  // original em silencio — a funcao tem que recusar, do mesmo jeito que
  // criarPedido (Tarefa 1) recusa um preco que diverge do catalogo.
  it('o banco rejeita CPF divergente para o mesmo e-mail, sem sobrescrever o CPF original', async () => {
    const a = await salvarClienteComEndereco(CLIENTE, ENDERECO)
    await expect(
      salvarClienteComEndereco(
        { ...CLIENTE, email: EMAIL_CLIENTE_MINUSCULO, cpf: CPF_DIVERGENTE },
        ENDERECO,
      ),
      // O contrato e o TIPO do erro, nao o texto: a rota decide o codigo
      // HTTP com `instanceof CpfDivergenteError`.
    ).rejects.toThrow(CpfDivergenteError)

    const linha = await getDb().selectFrom('clientes')
      .select('cpf').where('id', '=', a.clienteId).executeTakeFirstOrThrow()
    expect(linha.cpf).toBe(CLIENTE.cpf)
  })

  it('mesmo e-mail e mesmo CPF continua atualizando nome e whatsapp livremente', async () => {
    const a = await salvarClienteComEndereco(CLIENTE, ENDERECO)
    await salvarClienteComEndereco(
      { ...CLIENTE, email: EMAIL_CLIENTE_MINUSCULO, nome: 'Ana Souza Silva', whatsapp: '11999990000' },
      ENDERECO,
    )
    const linha = await getDb().selectFrom('clientes')
      .select(['nome', 'whatsapp']).where('id', '=', a.clienteId).executeTakeFirstOrThrow()
    expect(linha.nome).toBe('Ana Souza Silva')
    expect(linha.whatsapp).toBe('11999990000')
  })

  // Espelha o teste "atualiza atualizado_em..." de produtos.test.ts
  // (mesmo raciocinio: semear com uma data velha torna deterministico, sem
  // depender de dois now() caindo em milissegundos diferentes).
  it('atualiza atualizado_em a cada UPDATE, sem mexer em criado_em', async () => {
    const antigo = new Date('2020-01-01T00:00:00.000Z')
    await getDb().insertInto('clientes').values({
      nome: 'Carimbo', email: EMAIL_CARIMBO, cpf: CPF,
      whatsapp: '11900000000', criado_em: antigo, atualizado_em: antigo,
    }).execute()

    await getDb().updateTable('clientes')
      // Tenta gravar uma data velha de proposito: o trigger tem que vencer.
      .set({ nome: 'Carimbo 2', atualizado_em: antigo })
      .where('email', '=', EMAIL_CARIMBO).execute()

    const l = await getDb().selectFrom('clientes').select(['criado_em', 'atualizado_em'])
      .where('email', '=', EMAIL_CARIMBO).executeTakeFirstOrThrow()
    expect(l.criado_em.getTime()).toBe(antigo.getTime())
    expect(l.atualizado_em.getTime()).toBeGreaterThan(antigo.getTime())
  })

  // §10 do documento de 16/08/2026: o balcao do evento nao pede endereco de
  // entrega. O comprador paga, leva o kit na hora, e nao ha nada para
  // despachar para lugar nenhum. Ate esta mudanca o endereco era obrigatorio
  // nesta funcao e o INSERT em `enderecos` era incondicional — a venda
  // presencial teria que inventar um endereco so para conseguir gravar o
  // cliente, e esse endereco falso ficaria indistinguivel de um declarado
  // pela propria pessoa.
  describe('endereco opcional (venda presencial)', () => {
    it('LGPD: sem endereco nao grava linha nenhuma em enderecos e devolve enderecoId null', async () => {
      const r = await salvarClienteComEndereco(CLIENTE, null)
      expect(r.clienteId).toMatch(/^[0-9a-f-]{36}$/)
      // null EXPLICITO. Quem chama (src/app/api/vendas-presenciais/route.ts)
      // repassa este valor direto para criarPedido: `undefined` viraria
      // "campo ausente" e uma string vazia bateria em
      // pedidos_endereco_id_fkey em vez de dizer "nao ha endereco".
      expect(r.enderecoId).toBeNull()

      // A prova que interessa nao e o valor devolvido, e a tabela: o dado
      // pessoal que ninguem coletou nao pode existir gravado.
      const enderecos = await getDb().selectFrom('enderecos')
        .select('id').where('cliente_id', '=', r.clienteId).execute()
      expect(enderecos).toHaveLength(0)
    })

    it('o caminho COM endereco continua gravando exatamente uma linha, como antes', async () => {
      const r = await salvarClienteComEndereco(CLIENTE, ENDERECO)
      expect(r.enderecoId).toMatch(/^[0-9a-f-]{36}$/)

      const enderecos = await getDb().selectFrom('enderecos')
        .select(['id', 'cep', 'numero']).where('cliente_id', '=', r.clienteId).execute()
      expect(enderecos).toHaveLength(1)
      expect(enderecos[0].id).toBe(r.enderecoId)
      expect(enderecos[0].cep).toBe(ENDERECO.cep)
      expect(enderecos[0].numero).toBe(ENDERECO.numero)
    })

    // A mesma pessoa pode comprar online hoje e passar no balcao no dia 25.
    // O INSERT virou condicional; se alguem um dia trocar isso por um
    // "sincronizar endereco" (apagar e regravar), a compra de balcao levaria
    // junto o endereco da compra online — e o pedido antigo, que ainda vai
    // ser entregue, deixaria de mostrar para onde foi.
    it('venda presencial nao apaga o endereco que uma compra online anterior gravou', async () => {
      const online = await salvarClienteComEndereco(CLIENTE, ENDERECO)
      const presencial = await salvarClienteComEndereco(CLIENTE, null)

      expect(presencial.clienteId).toBe(online.clienteId)
      expect(presencial.enderecoId).toBeNull()

      const enderecos = await getDb().selectFrom('enderecos')
        .select('id').where('cliente_id', '=', online.clienteId).execute()
      expect(enderecos).toHaveLength(1)
      expect(enderecos[0].id).toBe(online.enderecoId)
    })

    // A recusa de CPF divergente vale igual nos dois canais, e o balcao e
    // justamente onde ela e mais necessaria: uma tela operada em pe, com
    // fila, digitando o e-mail que o comprador falou em voz alta. Se a
    // verificacao tivesse ficado no ramo "com endereco", a venda presencial
    // sobrescreveria o CPF de outra pessoa sem que nenhum teste antigo
    // ficasse vermelho.
    it('SEGURANCA: CPF divergente continua recusado tambem sem endereco', async () => {
      const a = await salvarClienteComEndereco(CLIENTE, ENDERECO)
      await expect(
        salvarClienteComEndereco(
          { ...CLIENTE, email: EMAIL_CLIENTE_MINUSCULO, cpf: CPF_DIVERGENTE },
          null,
        ),
      ).rejects.toThrow(CpfDivergenteError)

      const linha = await getDb().selectFrom('clientes')
        .select('cpf').where('id', '=', a.clienteId).executeTakeFirstOrThrow()
      expect(linha.cpf).toBe(CLIENTE.cpf)
    })
  })

  // salvarClienteComEndereco precisa poder entrar na transacao do CHAMADOR
  // (Tarefa 9 chama de dentro da transacao que tambem cria o pedido e
  // resgata o cupom) sem perder a capacidade de rodar sozinha.
  describe('transacao externa opcional', () => {
    it('continua funcionando sozinha, sem receber trx (comportamento de hoje)', async () => {
      const r = await salvarClienteComEndereco(CLIENTE, ENDERECO)
      expect(r.clienteId).toMatch(/^[0-9a-f-]{36}$/)
      expect(r.enderecoId).toMatch(/^[0-9a-f-]{36}$/)
    })

    // A forma EXATA da chamada do balcao (src/app/api/vendas-presenciais/route.ts):
    // tres argumentos, o do meio null, tudo dentro da transacao que tambem
    // baixa o estoque e cria o pedido. Vale um teste proprio porque a
    // combinacao "null no meio + trx no fim" e a unica que a producao usa e
    // seria facil quebrar mexendo so na posicao dos parametros.
    it('aceita null e transacao do chamador na mesma chamada', async () => {
      const r = await getDb().transaction().execute(
        (trx) => salvarClienteComEndereco(CLIENTE, null, trx),
      )
      expect(r.clienteId).toMatch(/^[0-9a-f-]{36}$/)
      expect(r.enderecoId).toBeNull()

      const clientes = await getDb().selectFrom('clientes').select('id')
        .where(sql<boolean>`lower(email) = lower(${EMAIL_CLIENTE})`).execute()
      expect(clientes).toHaveLength(1)
    })

    it('se a transacao do chamador falhar depois, nao sobra cliente nem endereco', async () => {
      // `string | null`, e nao `string | undefined`: desde que o endereco
      // virou opcional, salvarClienteComEndereco devolve null quando nao ha
      // endereco. Aqui HA um (o caminho online), entao a assercao continua
      // sendo "veio um id" — so mudou o tipo que consegue receber o valor.
      let enderecoId: string | null = null
      await expect(
        getDb().transaction().execute(async (trx) => {
          const r = await salvarClienteComEndereco(CLIENTE, ENDERECO, trx)
          enderecoId = r.enderecoId
          throw new Error('falha proposital depois de salvar o cliente')
        }),
      ).rejects.toThrow('falha proposital')

      // Conta pelo E-MAIL deste arquivo (a identidade real da tabela), nao
      // pelo CPF: um CPF compartilhado com outro arquivo de teste faria esta
      // contagem enxergar o cliente do vizinho e falhar sem nenhuma relacao
      // com a atomicidade que o teste alega provar.
      const clientes = await getDb().selectFrom('clientes')
        .select('id').where(sql<boolean>`lower(email) = lower(${EMAIL_CLIENTE})`).execute()
      expect(clientes).toHaveLength(0)

      expect(enderecoId).toBeDefined()
      const enderecos = await getDb().selectFrom('enderecos')
        .select('id').where('id', '=', enderecoId!).execute()
      expect(enderecos).toHaveLength(0)
    })
  })
})
