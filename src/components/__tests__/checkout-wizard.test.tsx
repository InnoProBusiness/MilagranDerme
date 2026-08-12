import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CheckoutWizard } from '@/components/checkout-wizard'
import type { Kit } from '@/repositories/produtos'

// useRouter() exige um App Router montado — inexistente neste ambiente de
// teste (jsdom puro, sem servidor Next). Mockar e o padrao recomendado pela
// propria Next.js para testar Client Components isolados.
const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

const KIT: Kit = {
  id: 'k1', slug: 'kit-milagran', nome: 'Kit Milagran',
  descricao: 'Kit de limpeza de pele instantanea.',
  precoCentavos: 100000 as never, unidades: 1, sku: 'MG-KIT-001',
  anvisaRegistro: null, ativo: true, ordem: 1,
}

// Campos que NUNCA podem aparecer no corpo do POST. Se um refactor futuro
// adicionar `total`/`subtotal`/`precoUnitarioCentavos` "so para mostrar no
// backend tambem", este teste tem que quebrar — o servidor ja rejeita esses
// campos (Corpo.strict() em src/app/api/pedidos/route.ts), mas a garantia
// real e o WIZARD nunca mandar dinheiro no corpo, nao so o servidor recusar
// depois.
const CAMPOS_PROIBIDOS = [
  'preco', 'precoUnitarioCentavos', 'precoCentavos', 'total', 'subtotal', 'desconto', 'valor',
]

async function preencherAteRevisao() {
  render(<CheckoutWizard kit={KIT} quantidadeInicial={1} />)

  // Passo 1: produto e quantidade.
  await userEvent.click(screen.getByRole('button', { name: /continuar/i }))

  // Passo 2: dados pessoais.
  await userEvent.type(screen.getByLabelText(/nome completo/i), 'Ana Souza')
  await userEvent.type(screen.getByLabelText(/e-mail/i), 'ana.wizard@exemplo.com')
  await userEvent.type(screen.getByLabelText(/cpf/i), '12345678901')
  await userEvent.type(screen.getByLabelText(/whatsapp/i), '11988887777')
  await userEvent.click(screen.getByRole('button', { name: /continuar/i }))

  // Passo 3: endereco.
  // /numero/i sozinho e ambiguo: o label do CEP e "CEP (somente numeros)" e
  // tambem contem a substring "numero" — so o anchor exato distingue o
  // campo de numero do endereco do label do CEP.
  await userEvent.type(screen.getByLabelText(/cep/i), '01310100')
  await userEvent.type(screen.getByLabelText(/estado/i), 'sp')
  await userEvent.type(screen.getByLabelText(/^rua$/i), 'Av Paulista')
  await userEvent.type(screen.getByLabelText(/^numero$/i), '1000')
  await userEvent.type(screen.getByLabelText(/bairro/i), 'Bela Vista')
  await userEvent.type(screen.getByLabelText(/cidade/i), 'Sao Paulo')
  await userEvent.click(screen.getByRole('button', { name: /continuar/i }))

  // Passo 4: revisao — onde o "Confirmar pedido" dispara o POST unico.
  expect(await screen.findByRole('button', { name: /confirmar pedido/i })).toBeInTheDocument()
}

describe('CheckoutWizard', () => {
  afterEach(() => {
    push.mockReset()
    vi.unstubAllGlobals()
  })

  it('DINHEIRO: o corpo do POST nao contem nenhum campo monetario', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ numero: 42, token: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await preencherAteRevisao()
    await userEvent.click(screen.getByRole('button', { name: /confirmar pedido/i }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/pedidos')
    const corpo: Record<string, unknown> = JSON.parse(init.body as string)

    for (const campo of CAMPOS_PROIBIDOS) {
      expect(corpo).not.toHaveProperty(campo)
    }
    // O corpo inteiro, nao so a ausencia dos campos proibidos: prova que
    // NADA alem do que o Zod do servidor espera (kitSlug, quantidade e os
    // dados de comprador/endereco) e enviado.
    expect(corpo).toEqual({
      kitSlug: 'kit-milagran',
      quantidade: 1,
      nome: 'Ana Souza',
      email: 'ana.wizard@exemplo.com',
      cpf: '12345678901',
      whatsapp: '11988887777',
      cep: '01310100',
      rua: 'Av Paulista',
      numero: '1000',
      complemento: '',
      bairro: 'Bela Vista',
      cidade: 'Sao Paulo',
      estado: 'SP',
    })

    // Sucesso navega pelo TOKEN, nunca pelo numero (round de correcao 1,
    // Finding 4) — numero e previsivel e a pagina de confirmacao e publica.
    expect(push).toHaveBeenCalledWith('/pedido/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')
  })

  it('em 422, mostra a mensagem de erro e NAO navega', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'cupom_recusado', mensagem: 'Cupom nao encontrado. Confira o codigo.' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await preencherAteRevisao()
    await userEvent.click(screen.getByRole('button', { name: /confirmar pedido/i }))

    expect(await screen.findByText('Cupom nao encontrado. Confira o codigo.')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })
})
