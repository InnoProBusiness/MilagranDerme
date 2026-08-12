import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { salvarClienteComEndereco } from '@/repositories/clientes'

const CLIENTE = { nome: 'Ana Souza', email: 'Ana@Exemplo.com', cpf: '12345678901', whatsapp: '11988887777' }
const ENDERECO = { cep: '01310100', rua: 'Av Paulista', numero: '1000', complemento: 'ap 51', bairro: 'Bela Vista', cidade: 'Sao Paulo', estado: 'SP' }
// CPF de um segundo cliente hipotetico, usado so no teste de divergencia.
// Nunca gravado com sucesso (a funcao lanca antes do INSERT), entao nao
// precisa de limpeza propria no beforeEach abaixo.
const CPF_DIVERGENTE = '22222222222'

describe('clientes', () => {
  beforeEach(async () => {
    await getDb().deleteFrom('clientes').where('cpf', '=', '12345678901').execute()
  })
  afterAll(async () => { await closeDb() })

  it('salva cliente e endereco juntos', async () => {
    const r = await salvarClienteComEndereco(CLIENTE, ENDERECO)
    expect(r.clienteId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.enderecoId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reconhece o mesmo cliente por e-mail, ignorando a caixa', async () => {
    const a = await salvarClienteComEndereco(CLIENTE, ENDERECO)
    const b = await salvarClienteComEndereco({ ...CLIENTE, email: 'ana@exemplo.com' }, ENDERECO)
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
        { ...CLIENTE, email: 'ana@exemplo.com', cpf: CPF_DIVERGENTE },
        ENDERECO,
      ),
    ).rejects.toThrow(/cpf_divergente/)

    const linha = await getDb().selectFrom('clientes')
      .select('cpf').where('id', '=', a.clienteId).executeTakeFirstOrThrow()
    expect(linha.cpf).toBe(CLIENTE.cpf)
  })

  it('mesmo e-mail e mesmo CPF continua atualizando nome e whatsapp livremente', async () => {
    const a = await salvarClienteComEndereco(CLIENTE, ENDERECO)
    await salvarClienteComEndereco(
      { ...CLIENTE, email: 'ana@exemplo.com', nome: 'Ana Souza Silva', whatsapp: '11999990000' },
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
      nome: 'Carimbo', email: 'carimbo-cliente@exemplo.com', cpf: CLIENTE.cpf,
      whatsapp: '11900000000', criado_em: antigo, atualizado_em: antigo,
    }).execute()

    await getDb().updateTable('clientes')
      // Tenta gravar uma data velha de proposito: o trigger tem que vencer.
      .set({ nome: 'Carimbo 2', atualizado_em: antigo })
      .where('cpf', '=', CLIENTE.cpf).execute()

    const l = await getDb().selectFrom('clientes').select(['criado_em', 'atualizado_em'])
      .where('cpf', '=', CLIENTE.cpf).executeTakeFirstOrThrow()
    expect(l.criado_em.getTime()).toBe(antigo.getTime())
    expect(l.atualizado_em.getTime()).toBeGreaterThan(antigo.getTime())
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

    it('se a transacao do chamador falhar depois, nao sobra cliente nem endereco', async () => {
      let enderecoId: string | undefined
      await expect(
        getDb().transaction().execute(async (trx) => {
          const r = await salvarClienteComEndereco(CLIENTE, ENDERECO, trx)
          enderecoId = r.enderecoId
          throw new Error('falha proposital depois de salvar o cliente')
        }),
      ).rejects.toThrow('falha proposital')

      const clientes = await getDb().selectFrom('clientes')
        .select('id').where('cpf', '=', CLIENTE.cpf).execute()
      expect(clientes).toHaveLength(0)

      expect(enderecoId).toBeDefined()
      const enderecos = await getDb().selectFrom('enderecos')
        .select('id').where('id', '=', enderecoId!).execute()
      expect(enderecos).toHaveLength(0)
    })
  })
})
