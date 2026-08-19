import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CuponsAdmin, linkDaCampanha, linkDaRepresentante, reaisDigitados,
  valorParaApi, fimDoDiaEmSaoPaulo, ultimoDiaValido, motivoDeNaoValer,
  descricaoDoCupom,
} from '@/components/cupons-admin'
import type { CupomAdmin } from '@/repositories/cupons'
import { centavos } from '@/lib/money'

const KIT = centavos(1000)

function cupom(over: Partial<CupomAdmin> = {}): CupomAdmin {
  return {
    id: 'c1',
    codigo: 'PRE800',
    tipo: 'fixo',
    valor: 20000,
    iniciaEm: new Date('2026-08-19T12:00:00Z'),
    expiraEm: null,
    limiteTotal: null,
    limitePorCliente: 1,
    ativo: true,
    representanteId: null,
    representanteNome: null,
    usos: 0,
    criadoEm: new Date('2026-08-19T12:00:00Z'),
    ...over,
  }
}

describe('links da campanha', () => {
  it('aponta para a home, com o cupom na query', () => {
    expect(linkDaCampanha('https://milagranoficial.com.br', 'PRE800'))
      .toBe('https://milagranoficial.com.br/?cupom=PRE800')
  })

  // A barra final da urlBase nao pode virar `//?cupom=`: o Next trataria como
  // outra rota e o link nasceria quebrado.
  it('nao duplica a barra quando a base ja termina em /', () => {
    expect(linkDaCampanha('https://milagranoficial.com.br/', 'PRE800'))
      .toBe('https://milagranoficial.com.br/?cupom=PRE800')
  })

  it('monta tambem o link da vitrine da representante', () => {
    expect(linkDaRepresentante('https://milagranoficial.com.br', 'maria', 'PRE800'))
      .toBe('https://milagranoficial.com.br/r/maria?cupom=PRE800')
  })
})

describe('reaisDigitados', () => {
  it('aceita as formas que a gente digita de verdade', () => {
    expect(reaisDigitados('800')).toBe(800)
    expect(reaisDigitados('800,00')).toBe(800)
    expect(reaisDigitados('1.000,00')).toBe(1000)
    expect(reaisDigitados('R$ 800')).toBe(800)
    expect(reaisDigitados(' 800 ')).toBe(800)
  })

  it('devolve null para o que nao e numero', () => {
    expect(reaisDigitados('')).toBeNull()
    expect(reaisDigitados('abc')).toBeNull()
    expect(reaisDigitados('-50')).toBeNull()
  })
})

describe('valorParaApi', () => {
  /**
   * O CASO DO AUDIO. "O kit vai custar 800" precisa chegar na API como 20000
   * centavos de ABATIMENTO. Este teste e a tradução inteira: se ele passar a
   * devolver 80000, a loja passa a vender o kit de mil reais por duzentos.
   */
  it('preco final de 800 vira desconto de R$ 200,00 em centavos', () => {
    expect(valorParaApi('preco', '800', KIT)).toBe(20000)
  })

  it('percentual vai inteiro, do jeito que a coluna espera', () => {
    expect(valorParaApi('percentual', '20', KIT)).toBe(20)
    expect(valorParaApi('percentual', '20,4', KIT)).toBe(20)
  })

  it('percentual fora de 1..100 nao vira valor', () => {
    expect(valorParaApi('percentual', '0', KIT)).toBeNull()
    expect(valorParaApi('percentual', '101', KIT)).toBeNull()
  })

  // Preco final igual ou maior que o preco cheio nao e cupom nenhum. O banco
  // recusaria com cupom_valor_positivo; a tela nem chega a tentar.
  it('preco final que nao desconta nada nao vira valor', () => {
    expect(valorParaApi('preco', '1000', KIT)).toBeNull()
    expect(valorParaApi('preco', '1200', KIT)).toBeNull()
  })
})

describe('fimDoDiaEmSaoPaulo', () => {
  /**
   * O campo promete "vale até" o dia escolhido, e resgatarCupom recusa com
   * `agora >= expira_em`. Logo o instante certo e a meia-noite do dia SEGUINTE
   * no horario de Sao Paulo — 03:00Z enquanto o Brasil estiver em UTC-3.
   *
   * O modo de falha que este teste tranca: 'AAAA-MM-DD' lido como UTC
   * expiraria o cupom as 21h do dia ANTERIOR.
   */
  it('a data escolhida vale o dia inteiro', () => {
    expect(fimDoDiaEmSaoPaulo('2026-08-25')).toBe('2026-08-26T03:00:00.000Z')
  })

  it('vira o mes corretamente', () => {
    expect(fimDoDiaEmSaoPaulo('2026-08-31')).toBe('2026-09-01T03:00:00.000Z')
  })

  it('data mal formada nao vira instante', () => {
    expect(fimDoDiaEmSaoPaulo('')).toBeNull()
    expect(fimDoDiaEmSaoPaulo('25/08/2026')).toBeNull()
  })

  // A volta: o que a lista imprime tem que ser o dia que a pessoa escolheu, e
  // nao o dia seguinte guardado na coluna.
  it('a lista mostra de volta o dia escolhido, nao o seguinte', () => {
    const iso = fimDoDiaEmSaoPaulo('2026-08-25')!
    expect(ultimoDiaValido(new Date(iso))).toBe('25/08/2026')
  })
})

describe('motivoDeNaoValer', () => {
  const AGORA = new Date('2026-08-20T12:00:00Z')

  it('cupom em ordem nao tem impedimento', () => {
    expect(motivoDeNaoValer(cupom(), AGORA)).toBe('')
  })

  it('reconhece desativado, expirado e esgotado', () => {
    expect(motivoDeNaoValer(cupom({ ativo: false }), AGORA)).toBe('Desativado')
    expect(motivoDeNaoValer(cupom({ expiraEm: new Date('2026-08-19T03:00:00Z') }), AGORA))
      .toBe('Expirado')
    expect(motivoDeNaoValer(cupom({ limiteTotal: 5, usos: 5 }), AGORA)).toBe('Esgotado')
  })
})

describe('descricaoDoCupom', () => {
  it('diz o preco que o kit passa a ter', () => {
    expect(descricaoDoCupom(cupom(), KIT)).toContain('R$ 800,00')
    expect(descricaoDoCupom(cupom({ tipo: 'percentual', valor: 20 }), KIT))
      .toBe('20% — kit por R$ 800,00')
  })
})

// --- A tela -----------------------------------------------------------------

const fetchOriginal = globalThis.fetch

afterEach(() => {
  globalThis.fetch = fetchOriginal
  vi.restoreAllMocks()
})

function renderizar(cupons: CupomAdmin[] = []) {
  render(
    <CuponsAdmin
      cupons={cupons}
      precoDoKit={KIT}
      representantes={[{ id: 'r1', nome: 'Maria José', slug: 'maria-jose' }]}
      urlBase="https://milagranoficial.com.br"
    />,
  )
}

describe('CuponsAdmin', () => {
  it('mostra o link pronto de cada campanha', () => {
    renderizar([cupom()])
    expect(screen.getByText('https://milagranoficial.com.br/?cupom=PRE800')).toBeInTheDocument()
  })

  /**
   * A CONFERENCIA EM VOZ ALTA. O formulario tem que dizer o preco final ANTES
   * de o cupom existir — e a unica chance de a pessoa perceber que digitou o
   * numero no campo errado, porque depois o link ja esta publicado.
   */
  it('confere o preco final enquanto a pessoa digita', async () => {
    const usuario = userEvent.setup()
    renderizar()

    await usuario.type(screen.getByLabelText(/o kit vai custar/i), '800')

    expect(screen.getByText(/o kit sai por R\$ 800,00/i)).toBeInTheDocument()
  })

  it('envia o desconto em centavos, e nao o preco final', async () => {
    const usuario = userEvent.setup()
    const fetchFalso = vi.fn(async () => ({
      ok: true, status: 201,
      json: async () => ({ cupom: cupom({ codigo: 'PRE800' }) }),
    }))
    globalThis.fetch = fetchFalso as unknown as typeof fetch

    renderizar()
    await usuario.type(screen.getByLabelText(/código do cupom/i), 'pre800')
    await usuario.type(screen.getByLabelText(/o kit vai custar/i), '800')
    await usuario.click(screen.getByRole('button', { name: /criar e gerar link/i }))

    await waitFor(() => expect(fetchFalso).toHaveBeenCalled())
    const [, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit]
    const corpo = JSON.parse(String(init.body)) as Record<string, unknown>

    expect(corpo).toMatchObject({ codigo: 'PRE800', tipo: 'fixo', valor: 20000 })
    // O PRECO FINAL NAO PODE ESTAR NO CORPO em campo nenhum: quem guarda
    // dinheiro de oferta e o desconto, e 80000 ali seria um cupom de R$ 800,00
    // de abatimento — kit por R$ 200,00.
    expect(JSON.stringify(corpo)).not.toContain('80000')
  })

  it('nao deixa criar com codigo curto demais', async () => {
    const usuario = userEvent.setup()
    renderizar()

    await usuario.type(screen.getByLabelText(/código do cupom/i), 'PR')
    await usuario.type(screen.getByLabelText(/o kit vai custar/i), '800')

    expect(screen.getByRole('button', { name: /criar e gerar link/i })).toBeDisabled()
  })

  it('mostra a mensagem do servidor quando o codigo ja existe', async () => {
    const usuario = userEvent.setup()
    globalThis.fetch = (async () => ({
      ok: false, status: 409,
      json: async () => ({ error: 'codigo_em_uso', mensagem: 'Já existe um cupom com o código PRE800.' }),
    })) as unknown as typeof fetch

    renderizar()
    await usuario.type(screen.getByLabelText(/código do cupom/i), 'PRE800')
    await usuario.type(screen.getByLabelText(/o kit vai custar/i), '800')
    await usuario.click(screen.getByRole('button', { name: /criar e gerar link/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Já existe um cupom com o código PRE800.')
  })
})
