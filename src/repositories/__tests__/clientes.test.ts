import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { salvarClienteComEndereco } from '@/repositories/clientes'

const CLIENTE = { nome: 'Ana Souza', email: 'Ana@Exemplo.com', cpf: '12345678901', whatsapp: '11988887777' }
const ENDERECO = { cep: '01310100', rua: 'Av Paulista', numero: '1000', complemento: 'ap 51', bairro: 'Bela Vista', cidade: 'Sao Paulo', estado: 'SP' }

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
})
