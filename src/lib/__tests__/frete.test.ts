import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { deInteiro } from '@/lib/money'
import {
  cotarFrete,
  opcaoMaisBarata,
  ClubeEnviosError,
  CotacaoIlegivelError,
  FreteNaoConfiguradoError,
  type CotacaoDeFrete,
} from '@/lib/frete'

/**
 * As variaveis do Clube Envios sao apagadas antes de cada teste e restauradas
 * depois (mesmo cuidado de src/lib/__tests__/candidatura.test.ts): um `.env`
 * local com token real faria estes testes falarem com a API de verdade se o
 * stub de fetch escapasse, e um token de producao num teste e credencial em
 * log de CI.
 */
const VARS = [
  'CLUBE_ENVIOS_TOKEN',
  'CLUBE_ENVIOS_CLIENTE_ID',
  'CLUBE_ENVIOS_BASE_URL',
  'CEP_ORIGEM_EXPEDICAO',
] as const

const TOKEN = 'token-de-teste-do-clube-envios'
let salvas: Record<string, string | undefined> = {}

beforeEach(() => {
  salvas = {}
  for (const v of VARS) {
    salvas[v] = process.env[v]
    delete process.env[v]
  }
  process.env.CLUBE_ENVIOS_TOKEN = TOKEN
  process.env.CLUBE_ENVIOS_CLIENTE_ID = '92'
  process.env.CEP_ORIGEM_EXPEDICAO = '74575070'
})

afterEach(() => {
  for (const v of VARS) {
    if (salvas[v] === undefined) delete process.env[v]
    else process.env[v] = salvas[v]
  }
  vi.unstubAllGlobals()
})

type ChamadaFetch = { url: string; init: RequestInit }

function stubarFetch(corpo: unknown, status = 200): ChamadaFetch[] {
  const chamadas: ChamadaFetch[] = []
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
    chamadas.push({ url: String(url), init })
    return new Response(JSON.stringify(corpo), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return chamadas
}

function corpoEnviado(chamadas: ChamadaFetch[]): Record<string, unknown> {
  const corpo = chamadas[0]?.init.body
  if (typeof corpo !== 'string') throw new Error('fetch foi chamado sem corpo de texto')
  return JSON.parse(corpo) as Record<string, unknown>
}

function cabecalhosEnviados(chamadas: ChamadaFetch[]): Record<string, string> {
  const h = chamadas[0]?.init.headers
  if (h === undefined) throw new Error('fetch foi chamado sem cabecalhos')
  return Object.fromEntries(new Headers(h).entries())
}

/** Devolve o valor OU o erro, para poder asseverar os dois na mesma linha. */
async function capturar(p: Promise<unknown>): Promise<unknown> {
  return p.then((v) => v, (e: unknown) => e)
}

// Exatamente o exemplo da documentacao do Clube Envios, para que o corpo
// montado possa ser comparado campo a campo com ele.
const ENTRADA = {
  cepDestino: '42702400',
  valorDeclarado: deInteiro(55625),
  volumes: [
    { alturaCm: 23, larguraCm: 36, comprimentoCm: 55, pesoGramas: 8218, quantidade: 1 },
  ],
}

const SUCESSO = {
  id_cotacao: 9876,
  servicos: [
    { id_servico: 3, id_transportadora: 7, transportadora: 'Correios', valor: 23.45, prazo: 5 },
    { id_servico: 4, id_transportadora: 9, transportadora: 'Jadlog', valor: 19.9, prazo: 8 },
  ],
}

describe('corpo enviado para POST /cotacao', () => {
  // Os nomes destes campos sao contrato com a API do Clube Envios. Renomear
  // qualquer um deles nao quebra compilacao nenhuma: quebra a cotacao em
  // producao, no dia do lancamento. Por isso a comparacao e exata.
  it('usa exatamente os campos documentados pela API', async () => {
    const chamadas = stubarFetch(SUCESSO)

    await cotarFrete(ENTRADA)

    expect(chamadas).toHaveLength(1)
    expect(chamadas[0]?.url).toBe('https://apis.clubeenvios.com.br/cotacao')
    expect(chamadas[0]?.init.method).toBe('POST')
    expect(corpoEnviado(chamadas)).toEqual({
      cliente_id: 92,
      cep_origem: '74575070',
      cep_destino: '42702400',
      seguro_correios: 'N',
      valor_declarado: 556.25,
      volumes: [
        { altura: 23, largura: 36, comprimento: 55, peso: 8218, quantidade_volumes: 1 },
      ],
    })
  })

  // DINHEIRO: o resto do sistema so conhece Centavos inteiros; a API so
  // conhece reais decimais. Converter duas vezes (5.5625) ou nenhuma (55625)
  // muda o valor declarado por um fator de 100 sem erro de compilacao.
  it('DINHEIRO: converte centavos para reais decimais exatamente uma vez', async () => {
    const chamadas = stubarFetch(SUCESSO)

    await cotarFrete({ ...ENTRADA, valorDeclarado: deInteiro(19_990) })

    const corpo = corpoEnviado(chamadas)
    expect(corpo.valor_declarado).toBe(199.9)
    expect(corpo.valor_declarado).not.toBe(19_990)
    expect(corpo.valor_declarado).not.toBe(1.999)
  })

  // DINHEIRO: 1 centavo tem que chegar como 0.01, nao como 0 nem como 1.
  it('DINHEIRO: nao perde o centavo em valores pequenos', async () => {
    const chamadas = stubarFetch(SUCESSO)

    await cotarFrete({ ...ENTRADA, valorDeclarado: deInteiro(1) })

    expect(corpoEnviado(chamadas).valor_declarado).toBe(0.01)
  })

  // A documentacao do Clube Envios usa o token CRU. Com 'Bearer' o provedor
  // devolve 401 e a loja inteira mostra "frete indisponivel".
  it('envia o token cru no Authorization, sem Bearer', async () => {
    const chamadas = stubarFetch(SUCESSO)

    await cotarFrete(ENTRADA)

    const h = cabecalhosEnviados(chamadas)
    expect(h.authorization).toBe(TOKEN)
    expect(h.authorization).not.toMatch(/bearer/i)
    expect(h['content-type']).toBe('application/json')
  })

  it('normaliza o CEP de destino para somente digitos', async () => {
    const chamadas = stubarFetch(SUCESSO)

    await cotarFrete({ ...ENTRADA, cepDestino: '42702-400' })

    expect(corpoEnviado(chamadas).cep_destino).toBe('42702400')
  })

  it('aponta para a homologacao quando CLUBE_ENVIOS_BASE_URL esta definida', async () => {
    process.env.CLUBE_ENVIOS_BASE_URL = 'https://apishmg.clubeenvios.com.br'
    const chamadas = stubarFetch(SUCESSO)

    await cotarFrete(ENTRADA)

    expect(chamadas[0]?.url).toBe('https://apishmg.clubeenvios.com.br/cotacao')
  })
})

describe('normalizacao da resposta de cotacao', () => {
  it('DINHEIRO: le valor em reais decimais e devolve Centavos inteiros', async () => {
    stubarFetch(SUCESSO)

    const cotacao = await cotarFrete(ENTRADA)

    expect(cotacao.idCotacao).toBe(9876)
    expect(cotacao.opcoes).toEqual([
      { idServico: 3, idTransportadora: 7, transportadora: 'Correios', servico: '', valor: 2345, prazoDias: 5 },
      { idServico: 4, idTransportadora: 9, transportadora: 'Jadlog', servico: '', valor: 1990, prazoDias: 8 },
    ])
    // 23.45 * 100 em ponto flutuante da 2344.9999...; o valor gravado em
    // pedidos.frete_centavos e congelado, entao tem que ser inteiro exato.
    expect(Number.isInteger(cotacao.opcoes[0]?.valor)).toBe(true)
  })

  it('aceita a lista de servicos na raiz da resposta', async () => {
    stubarFetch([{ id_servico: 3, transportadora: 'Correios', valor: 30, prazo: 4 }])

    const cotacao = await cotarFrete(ENTRADA)

    expect(cotacao.idCotacao).toBeNull()
    expect(cotacao.opcoes).toHaveLength(1)
    expect(cotacao.opcoes[0]?.valor).toBe(3000)
  })

  it('aceita a lista dentro de um container aninhado', async () => {
    stubarFetch({
      result: true,
      dados: {
        id_cotacao: 555,
        servicos: [{ id_servico: 8, transportadora: 'Loggi', valor: 12.3, prazo: 2 }],
      },
    })

    const cotacao = await cotarFrete(ENTRADA)

    expect(cotacao.idCotacao).toBe(555)
    expect(cotacao.opcoes[0]).toEqual({
      idServico: 8, idTransportadora: null, transportadora: 'Loggi', servico: '', valor: 1230, prazoDias: 2,
    })
  })

  // Os apelidos sao uma aposta enquanto a primeira chamada em homologacao nao
  // acontece (ver o cabecalho de src/lib/frete.ts). Este teste fixa o que a
  // aposta cobre hoje; quando a resposta real chegar, ele muda junto com a
  // lista de apelidos — e so ele.
  it('le valor e prazo pelos apelidos alternativos', async () => {
    stubarFetch({
      cotacao: [{ id_servico: 11, transportadora: 'Braspress', vlrFrete: 41.07, prazo_entrega: 6 }],
    })

    const cotacao = await cotarFrete(ENTRADA)

    expect(cotacao.opcoes[0]?.valor).toBe(4107)
    expect(cotacao.opcoes[0]?.prazoDias).toBe(6)
  })

  it('DINHEIRO: aceita valor em formato brasileiro com virgula', async () => {
    stubarFetch({ servicos: [{ id_servico: 2, preco: '1.234,56', prazo_dias: '3' }] })

    const cotacao = await cotarFrete(ENTRADA)

    expect(cotacao.opcoes[0]?.valor).toBe(123_456)
    expect(cotacao.opcoes[0]?.prazoDias).toBe(3)
  })

  // Prazo em faixa: ficar com o menor numero prometeria uma entrega que a
  // transportadora nao prometeu.
  it('usa o maior numero quando o prazo vem como faixa em texto', async () => {
    stubarFetch({ servicos: [{ id_servico: 2, valor: 10, prazo: '5 a 7 dias uteis' }] })

    const cotacao = await cotarFrete(ENTRADA)

    expect(cotacao.opcoes[0]?.prazoDias).toBe(7)
  })

  it('transportadora ausente nao derruba a cotacao (nome e cosmetico)', async () => {
    stubarFetch({ servicos: [{ id_servico: 2, valor: 10, prazo: 3 }] })

    const cotacao = await cotarFrete(ENTRADA)

    expect(cotacao.opcoes[0]?.transportadora).toBe('')
  })
})

/**
 * A RESPOSTA DE VERDADE, copiada de uma cotacao de producao feita em
 * 17/08/2026 (cliente 3727, origem 74693158, destino 01310100, kit de 500 g e
 * 12x16x20 cm). Nada aqui foi inventado nem simplificado.
 *
 * Ate esta data o arquivo inteiro assentava sobre um palpite — o cabecalho de
 * src/lib/frete.ts dizia, com todas as letras, que a primeira chamada real
 * confirmaria ou corrigiria os apelidos. Ela corrigiu: o envelope e `valores`,
 * que nao estava em CONTAINERS_SERVICOS, e a cotacao inteira caia em
 * CotacaoIlegivelError. O checkout online nunca teria passado do passo 3.
 *
 * Este bloco existe para que a proxima mudanca de contrato do provedor apareca
 * como teste vermelho, e nao como "frete indisponivel" no dia da venda.
 */
const RESPOSTA_REAL_DO_CLUBE_ENVIOS = {
  id_cotacao: '697040',
  valores: [
    { id_servico: '2', servico: 'PAC', transportadora: 'CLUBE ENVIOS - Correios', id_transportadora: '1', seguro_incluso: 'N', prazo: '6', valor_frete: '29,39' },
    { id_servico: '66', servico: 'LATAM CARGO', transportadora: 'CLUBE ENVIOS - Latam', id_transportadora: '8', seguro_incluso: 'S', prazo: '3', valor_frete: '31,80' },
    { id_servico: '10', servico: 'ECOMM CORP', transportadora: 'CLUBE ENVIOS - Azul', id_transportadora: '5', seguro_incluso: 'S', prazo: '3', valor_frete: '34,97' },
    { id_servico: '8', servico: 'EXPRESSO', transportadora: 'CLUBE ENVIOS - Azul', id_transportadora: '5', seguro_incluso: 'S', prazo: '2', valor_frete: '57,72' },
    { id_servico: '1', servico: 'SEDEX', transportadora: 'CLUBE ENVIOS - Correios', id_transportadora: '1', seguro_incluso: 'N', prazo: '2', valor_frete: '64,91' },
  ],
}

describe('resposta real do Clube Envios', () => {
  it('le as cinco opcoes do envelope `valores`', async () => {
    stubarFetch(RESPOSTA_REAL_DO_CLUBE_ENVIOS)

    const cotacao = await cotarFrete(ENTRADA)

    expect(cotacao.idCotacao).toBe(697040)
    expect(cotacao.opcoes).toHaveLength(5)
  })

  /**
   * DINHEIRO, e o erro que custaria 100x. O provedor devolve "29,39" — string
   * com VIRGULA decimal, o formato brasileiro. Se `decimalDe` nao tratasse a
   * virgula, `Number("29,39")` daria NaN; se o valor fosse lido como centavos
   * inteiros, R$ 29,39 viraria R$ 0,29. A coluna pedidos.frete_centavos e
   * congelada no INSERT, entao qualquer um dos dois erros seria permanente
   * pedido a pedido.
   */
  it('DINHEIRO: "29,39" vira 2939 centavos, nao NaN e nao 29', async () => {
    stubarFetch(RESPOSTA_REAL_DO_CLUBE_ENVIOS)

    const cotacao = await cotarFrete(ENTRADA)
    const pac = cotacao.opcoes[0]

    expect(pac?.valor).toBe(2939)
    expect(Number.isInteger(pac?.valor)).toBe(true)
    expect(cotacao.opcoes[4]?.valor).toBe(6491)
  })

  it('converte id e prazo que chegam como string', async () => {
    stubarFetch(RESPOSTA_REAL_DO_CLUBE_ENVIOS)

    const cotacao = await cotarFrete(ENTRADA)

    expect(cotacao.opcoes[0]).toMatchObject({
      idServico: 2, idTransportadora: 1, prazoDias: 6,
      transportadora: 'CLUBE ENVIOS - Correios', servico: 'PAC',
    })
  })

  /**
   * O motivo de `servico` existir: DUAS duplas chegam com o mesmo campo
   * `transportadora`. Sem capturar o servico, a tela mostraria
   * "CLUBE ENVIOS - Correios" duas vezes e "CLUBE ENVIOS - Azul" duas vezes,
   * e o comprador teria que deduzir a diferenca pelo preco.
   */
  it('o servico desempata opcoes da mesma transportadora', async () => {
    stubarFetch(RESPOSTA_REAL_DO_CLUBE_ENVIOS)

    const { opcoes } = await cotarFrete(ENTRADA)

    const correios = opcoes.filter((o) => o.transportadora === 'CLUBE ENVIOS - Correios')
    expect(correios).toHaveLength(2)
    expect(correios.map((o) => o.servico).sort()).toEqual(['PAC', 'SEDEX'])

    // E nenhuma das cinco fica sem nome de servico.
    expect(opcoes.every((o) => o.servico !== '')).toBe(true)
  })

  it('a mais barata das cinco e o PAC', async () => {
    stubarFetch(RESPOSTA_REAL_DO_CLUBE_ENVIOS)

    const cotacao = await cotarFrete(ENTRADA)

    expect(opcaoMaisBarata(cotacao)).toMatchObject({ servico: 'PAC', valor: 2939 })
  })
})

describe('respostas ilegiveis', () => {
  // O teste mais importante do arquivo. Um servico sem preco NAO pode virar
  // frete zero: zero e uma promessa de frete gratis ao comprador e prejuizo
  // por pedido (mesmo principio de src/components/linha-frete.tsx).
  it('DINHEIRO: servico sem preco lanca CotacaoIlegivelError e nao devolve zero', async () => {
    stubarFetch({
      id_cotacao: 1,
      servicos: [{ id_servico: 3, id_transportadora: 7, transportadora: 'Correios', prazo: 5 }],
    })

    const resultado = await capturar(cotarFrete(ENTRADA))

    expect(resultado).toBeInstanceOf(CotacaoIlegivelError)
    // Nenhuma cotacao voltou: nao ha opcao com valor 0 para nenhuma tela
    // mostrar nem para nenhuma rota gravar.
    expect(resultado).not.toHaveProperty('opcoes')
  })

  it('DINHEIRO: servico sem prazo lanca CotacaoIlegivelError e nao devolve zero', async () => {
    stubarFetch({ servicos: [{ id_servico: 3, transportadora: 'Correios', valor: 23.45 }] })

    const resultado = await capturar(cotarFrete(ENTRADA))

    expect(resultado).toBeInstanceOf(CotacaoIlegivelError)
    expect(resultado).not.toHaveProperty('opcoes')
  })

  // Zero nao e cotacao: e a ausencia de uma. Transportadora nao cota frete
  // gratis, entao um zero aqui e campo lido errado.
  it('DINHEIRO: preco zero nao vira frete gratis', async () => {
    stubarFetch({ servicos: [{ id_servico: 3, transportadora: 'Correios', valor: 0, prazo: 5 }] })

    await expect(cotarFrete(ENTRADA)).rejects.toBeInstanceOf(CotacaoIlegivelError)
  })

  // As chaves recebidas sao o que permite corrigir a lista de apelidos depois
  // da primeira chamada real em homologacao — sem elas o erro nao ensina nada.
  it('a excecao carrega as chaves que realmente chegaram', async () => {
    stubarFetch({ servicos: [{ id_servico: 3, custo_total: 33.9, tempo_estimado: 4 }] })

    const resultado = await capturar(cotarFrete(ENTRADA))

    expect(resultado).toBeInstanceOf(CotacaoIlegivelError)
    expect((resultado as CotacaoIlegivelError).chavesRecebidas).toEqual([
      'id_servico', 'custo_total', 'tempo_estimado',
    ])
  })

  it('servico sem id_servico e ilegivel: a opcao nao poderia ser escolhida no checkout', async () => {
    stubarFetch({ servicos: [{ transportadora: 'Correios', valor: 23.45, prazo: 5 }] })

    await expect(cotarFrete(ENTRADA)).rejects.toBeInstanceOf(CotacaoIlegivelError)
  })

  it('resposta sem lista de servicos em lugar nenhum e ilegivel', async () => {
    stubarFetch({ mensagem: 'ok', total: 1 })

    const resultado = await capturar(cotarFrete(ENTRADA))

    expect(resultado).toBeInstanceOf(CotacaoIlegivelError)
    expect((resultado as CotacaoIlegivelError).chavesRecebidas).toEqual(['mensagem', 'total'])
  })

  // Uma data lida como prazo viraria "2026 dias" em pedidos.prazo_dias_estimado.
  it('prazo fora de qualquer escala plausivel e ilegivel', async () => {
    stubarFetch({ servicos: [{ id_servico: 3, valor: 23.45, prazo_entrega: '2026-08-25' }] })

    await expect(cotarFrete(ENTRADA)).rejects.toBeInstanceOf(CotacaoIlegivelError)
  })
})

describe('erros do provedor', () => {
  // O envelope documentado de erro pode chegar com HTTP 200: tratar como
  // sucesso faria a normalizacao reportar "ilegivel" e esconder a mensagem
  // real do provedor de quem for diagnosticar.
  it('envelope { result: false } vira ClubeEnviosError mesmo com HTTP 200', async () => {
    stubarFetch({ result: false, messages: 'Token invalido' }, 200)

    const resultado = await capturar(cotarFrete(ENTRADA))

    expect(resultado).toBeInstanceOf(ClubeEnviosError)
    expect((resultado as ClubeEnviosError).corpo).toContain('Token invalido')
  })

  it('envelope de erro com messages em objeto tambem vira ClubeEnviosError', async () => {
    stubarFetch({ result: false, messages: { cep_destino: ['CEP invalido'] } }, 422)

    const resultado = await capturar(cotarFrete(ENTRADA))

    expect(resultado).toBeInstanceOf(ClubeEnviosError)
    expect((resultado as ClubeEnviosError).status).toBe(422)
    expect((resultado as ClubeEnviosError).corpo).toContain('CEP invalido')
  })

  it('HTTP fora de 2xx vira ClubeEnviosError com o status do provedor', async () => {
    stubarFetch({ mensagem: 'nao autorizado' }, 401)

    const resultado = await capturar(cotarFrete(ENTRADA))

    expect(resultado).toBeInstanceOf(ClubeEnviosError)
    expect((resultado as ClubeEnviosError).status).toBe(401)
  })

  // Status 0 = "nao houve resposta", que e retentavel. Sem essa distincao a
  // rota nao sabe diferenciar timeout de recusa do provedor.
  it('falha de rede vira ClubeEnviosError com status 0', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('The operation was aborted due to timeout')
    })

    const resultado = await capturar(cotarFrete(ENTRADA))

    expect(resultado).toBeInstanceOf(ClubeEnviosError)
    expect((resultado as ClubeEnviosError).status).toBe(0)
  })

  it('corpo que nao e JSON vira ClubeEnviosError, nunca cotacao vazia', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }))

    await expect(cotarFrete(ENTRADA)).rejects.toBeInstanceOf(ClubeEnviosError)
  })
})

describe('configuracao ausente', () => {
  // Sem credencial nao existe cotacao possivel — e o que NAO pode acontecer e
  // a loja seguir em frente com frete zero. A rota transforma isso em 503.
  it('sem CLUBE_ENVIOS_TOKEN lanca FreteNaoConfiguradoError', async () => {
    delete process.env.CLUBE_ENVIOS_TOKEN
    stubarFetch(SUCESSO)

    await expect(cotarFrete(ENTRADA)).rejects.toBeInstanceOf(FreteNaoConfiguradoError)
  })

  it('sem CLUBE_ENVIOS_CLIENTE_ID lanca FreteNaoConfiguradoError', async () => {
    delete process.env.CLUBE_ENVIOS_CLIENTE_ID
    stubarFetch(SUCESSO)

    await expect(cotarFrete(ENTRADA)).rejects.toBeInstanceOf(FreteNaoConfiguradoError)
  })

  it('cliente_id que nao e inteiro positivo lanca FreteNaoConfiguradoError', async () => {
    process.env.CLUBE_ENVIOS_CLIENTE_ID = 'noventa-e-dois'
    stubarFetch(SUCESSO)

    await expect(cotarFrete(ENTRADA)).rejects.toBeInstanceOf(FreteNaoConfiguradoError)
  })

  it('sem CEP_ORIGEM_EXPEDICAO lanca FreteNaoConfiguradoError', async () => {
    delete process.env.CEP_ORIGEM_EXPEDICAO
    stubarFetch(SUCESSO)

    await expect(cotarFrete(ENTRADA)).rejects.toBeInstanceOf(FreteNaoConfiguradoError)
  })

  it('nao chega a chamar a API quando falta configuracao', async () => {
    delete process.env.CLUBE_ENVIOS_TOKEN
    const chamadas = stubarFetch(SUCESSO)

    await capturar(cotarFrete(ENTRADA))

    expect(chamadas).toHaveLength(0)
  })

  // As variaveis sao lidas DENTRO da funcao: definir depois do import tem que
  // funcionar, senao `next build` quebraria sem placeholder (mesmo padrao de
  // src/lib/mercadopago.ts).
  it('le as variaveis em tempo de execucao, nao no import', async () => {
    delete process.env.CLUBE_ENVIOS_TOKEN
    stubarFetch(SUCESSO)
    await expect(cotarFrete(ENTRADA)).rejects.toBeInstanceOf(FreteNaoConfiguradoError)

    process.env.CLUBE_ENVIOS_TOKEN = TOKEN
    const cotacao = await cotarFrete(ENTRADA)

    expect(cotacao.opcoes).toHaveLength(2)
  })
})

describe('volumes invalidos', () => {
  // Peso ou dimensao zerada nao vira erro no provedor: vira cotacao barata
  // demais, descoberta so no balcao dos Correios.
  it('recusa volume com peso zerado antes de chamar a API', async () => {
    const chamadas = stubarFetch(SUCESSO)

    await expect(
      cotarFrete({
        ...ENTRADA,
        volumes: [{ alturaCm: 23, larguraCm: 36, comprimentoCm: 55, pesoGramas: 0, quantidade: 1 }],
      }),
    ).rejects.toThrow(/Volume invalido/)
    expect(chamadas).toHaveLength(0)
  })

  it('recusa cotacao sem volume nenhum', async () => {
    stubarFetch(SUCESSO)

    await expect(cotarFrete({ ...ENTRADA, volumes: [] })).rejects.toThrow(/sem volumes/)
  })
})

describe('opcaoMaisBarata', () => {
  it('DINHEIRO: devolve a opcao de menor valor', async () => {
    stubarFetch(SUCESSO)

    const cotacao = await cotarFrete(ENTRADA)

    expect(opcaoMaisBarata(cotacao)?.idServico).toBe(4)
    expect(opcaoMaisBarata(cotacao)?.valor).toBe(1990)
  })

  // Lista vazia devolve null, e quem chama trata como "sem frete disponivel".
  // Nunca existe uma opcao de valor zero para cair aqui.
  it('devolve null quando nao ha opcao nenhuma', () => {
    const vazia: CotacaoDeFrete = { idCotacao: null, opcoes: [] }

    expect(opcaoMaisBarata(vazia)).toBeNull()
  })
})
