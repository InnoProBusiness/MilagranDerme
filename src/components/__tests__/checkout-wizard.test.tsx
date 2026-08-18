import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CheckoutWizard } from '@/components/checkout-wizard'
import { TEXTO_FRETE_A_COTAR } from '@/components/linha-frete'
import type { Kit } from '@/repositories/produtos'
import { deInteiro } from '@/lib/money'

// useRouter() exige um App Router montado — inexistente neste ambiente de
// teste (jsdom puro, sem servidor Next). Mockar e o padrao recomendado pela
// propria Next.js para testar Client Components isolados.
const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

// deInteiro(), nunca `100000 as never`: `as never` desliga o construtor de
// Centavos e com ele a validacao de runtime. Este preco alimenta a assercao
// de dinheiro do resumo, entao um fixture fracionado passaria calado
// formatando o valor errado em vez de estourar na construcao.
const KIT: Kit = {
  id: 'k1', slug: 'kit-milagran', nome: 'Kit Milagran',
  descricao: 'Kit de limpeza de pele instantanea.',
  precoCentavos: deInteiro(100000), unidades: 1, sku: 'MG-KIT-001',
  anvisaRegistro: null, anvisaDispensado: false, ativo: true, ordem: 1,
  // Kit passou a carregar peso e dimensoes (src/repositories/produtos.ts):
  // a cotacao de frete le os quatro do cadastro em vez de inventa-los. O
  // wizard nao os exibe nem os envia no POST — quem cota e o servidor, a
  // partir do CEP —, mas o fixture e tipado como `Kit` de proposito e por
  // isso precisa da forma completa.
  pesoGramas: 760, alturaCm: 6, larguraCm: 18, comprimentoCm: 23,
}

const TOKEN_DO_PEDIDO = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'

/**
 * Resposta de GET /api/cep/[cep], no formato exato de `EnderecoDoCep`
 * (src/lib/cep.ts): CEP so com digitos e UF em maiusculas, ja normalizados pela
 * rota. Copiar o formato de verdade importa — um fixture com "01310-100" ou
 * "sp" faria o teste provar que o autofill funciona com um valor que o proprio
 * formulario considera invalido no submit.
 */
const ENDERECO_DO_CEP = {
  cep: '01310100',
  rua: 'Avenida Paulista',
  bairro: 'Bela Vista',
  cidade: 'São Paulo',
  estado: 'SP',
}

/**
 * Resposta de POST /api/frete: os quatro campos do contrato (§5 do plano),
 * `valorCentavos` INTEIRO EM CENTAVOS. Nenhum id de servico coincide com
 * nenhum dos valores monetarios do arquivo, de proposito — a varredura de
 * VALORES_MONETARIOS abaixo perderia o sentido se `idServico` pudesse bater
 * com um preco por coincidencia.
 */
const OPCOES_DE_FRETE = [
  { idServico: 4553, transportadora: 'Correios PAC', valorCentavos: 2350, prazoDias: 8 },
  { idServico: 4554, transportadora: 'Correios SEDEX', valorCentavos: 4990, prazoDias: 3 },
]

// Campos que NUNCA podem aparecer no corpo do POST. Se um refactor futuro
// adicionar `total`/`subtotal`/`precoUnitarioCentavos` "so para mostrar no
// backend tambem", este teste tem que quebrar — o servidor ja rejeita esses
// campos (Corpo.strict() em src/app/api/pedidos/route.ts), mas a garantia
// real e o WIZARD nunca mandar dinheiro no corpo, nao so o servidor recusar
// depois.
//
// A lista CRESCEU em 16/08/2026, junto com a cotacao de frete (§13): agora ha
// um valor a mais circulando na tela (o da opcao escolhida) e um campo novo
// legitimo no corpo (`idServico`). Trocar dinheiro por um id foi exatamente a
// decisao de contrato — o servidor RECOTA e decide o valor —, entao a garantia
// aqui tinha que ficar mais forte, nunca mais fraca. Ela agora tem tres
// camadas: esta lista nominal, o PADRAO_DE_DINHEIRO (pega o nome que ninguem
// pensou em listar) e VALORES_MONETARIOS (pega o valor enviado sob um nome
// inocente).
const CAMPOS_PROIBIDOS = [
  'preco', 'precoUnitario', 'precoUnitarioCentavos', 'precoCentavos',
  'total', 'totalCentavos', 'subtotal', 'subtotalCentavos',
  'desconto', 'descontoCentavos',
  'valor', 'valorCentavos', 'valorDeclarado', 'valorFrete', 'valorUnitario',
  'frete', 'freteCentavos', 'prazoDias', 'opcaoDeFrete',
]

/**
 * Segunda camada: qualquer NOME de campo que cheire a dinheiro e recusado, mesmo
 * que ninguem tenha pensado em lista-lo acima. Nenhum campo legitimo do contrato
 * casa com este padrao — kitSlug, quantidade, idServico, cupom, nome, email,
 * cpf, whatsapp, cep, rua, numero, complemento, bairro, cidade, estado —, e e
 * isso que o torna util: ele quebra no dia em que alguem inventar
 * `freteEscolhidoCentavos` ou `totalDaTela`.
 */
const PADRAO_DE_DINHEIRO = /pre[cç]o|valor|total|subtotal|desconto|frete|centavos|reais|brl/i

/**
 * Terceira camada, e a que pega o caso mais perigoso: o valor certo enviado sob
 * um nome que nao parece dinheiro. Sao todos os numeros monetarios que este
 * arquivo faz existir — preco unitario, subtotais, os dois fretes cotados e os
 * totais correspondentes. Nenhum deles pode estar no corpo, em campo nenhum.
 */
const VALORES_MONETARIOS = [100000, 200000, 2350, 4990, 102350, 104990, 202350]

type RespostaFalsa = { ok: boolean; status: number; json: () => Promise<unknown> }
type Roteiro = RespostaFalsa | (() => RespostaFalsa)

function resposta(status: number, corpo: unknown): RespostaFalsa {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo }
}

const CEP_ENCONTRADO = resposta(200, ENDERECO_DO_CEP)
const CEP_NAO_ENCONTRADO = resposta(404, { error: 'cep_nao_encontrado' })
const FRETE_COTADO = resposta(200, { opcoes: OPCOES_DE_FRETE })
// Corpo exato de 503 `frete_indisponivel` em src/app/api/frete/route.ts.
const FRETE_INDISPONIVEL = resposta(503, {
  error: 'frete_indisponivel',
  mensagem: 'Não foi possível calcular o frete agora. Tente novamente em instantes.',
})
const PEDIDO_CRIADO = resposta(201, { numero: 42, token: TOKEN_DO_PEDIDO })

/**
 * `fetch` unico roteando por URL. O wizard agora fala com TRES rotas — o
 * autofill (GET /api/cep/[cep]), a cotacao (POST /api/frete) e o submit (POST
 * /api/pedidos) —, entao um mock que responde a mesma coisa para todo mundo
 * esconderia justamente o que interessa: qual rota foi chamada, quantas vezes e
 * com que corpo.
 *
 * URL desconhecida LANCA, em vez de devolver algo plausivel: uma chamada de rede
 * que ninguem previu tem que aparecer como teste vermelho, nao como resposta
 * silenciosa.
 */
function criarFetchFalso(roteiro: { cep?: Roteiro; frete?: Roteiro; pedidos?: Roteiro } = {}) {
  const resolver = (r: Roteiro | undefined, padrao: RespostaFalsa): RespostaFalsa => {
    if (!r) return padrao
    return typeof r === 'function' ? r() : r
  }
  return vi.fn(async (entrada: string, init?: RequestInit): Promise<RespostaFalsa> => {
    void init
    if (entrada.startsWith('/api/cep/')) return resolver(roteiro.cep, CEP_ENCONTRADO)
    if (entrada === '/api/frete') return resolver(roteiro.frete, FRETE_COTADO)
    if (entrada === '/api/pedidos') return resolver(roteiro.pedidos, PEDIDO_CRIADO)
    throw new Error(`URL inesperada no teste: ${entrada}`)
  })
}

type FetchFalso = ReturnType<typeof criarFetchFalso>

function chamadasDe(fetchMock: FetchFalso, url: string) {
  return fetchMock.mock.calls.filter(([entrada]) => entrada === url)
}

function corpoEnviadoPara(fetchMock: FetchFalso, url: string): Record<string, unknown> {
  const chamadas = chamadasDe(fetchMock, url)
  const ultima = chamadas[chamadas.length - 1]
  if (!ultima) throw new Error(`Nenhuma chamada para ${url}`)
  return JSON.parse(String(ultima[1]?.body)) as Record<string, unknown>
}

function botaoContinuar() {
  return screen.getByRole('button', { name: /^continuar$/i })
}

/**
 * Caminho feliz completo ate o passo 4, JA COM autofill e cotacao de frete.
 *
 * Repare no que ela NAO digita mais: rua, bairro, cidade e UF chegam do autofill
 * de CEP (§13). Isso e proposital — este helper e o percurso do comprador comum,
 * e o teste de digitacao manual (autofill que falha) e um caso proprio, mais
 * abaixo, exatamente porque e o caminho excepcional.
 */
async function preencherAteRevisao() {
  render(<CheckoutWizard kit={KIT} quantidadeInicial={1} />)

  // Passo 1: produto e quantidade.
  await userEvent.click(botaoContinuar())

  // Passo 2: dados pessoais.
  await userEvent.type(screen.getByLabelText(/nome completo/i), 'Ana Souza')
  await userEvent.type(screen.getByLabelText(/e-mail/i), 'ana.wizard@exemplo.com')
  await userEvent.type(screen.getByLabelText(/cpf/i), '12345678901')
  await userEvent.type(screen.getByLabelText(/whatsapp/i), '11988887777')
  await userEvent.click(botaoContinuar())

  // Passo 3: endereco + frete.
  // /numero/i sozinho e ambiguo: o label do CEP e "CEP (somente numeros)" e
  // tambem contem a substring "numero" — so o anchor exato distingue o
  // campo de numero do endereco do label do CEP.
  await userEvent.type(screen.getByLabelText(/cep/i), '01310100')
  // Espera as DUAS chamadas disparadas pelo oitavo digito: o radio so existe
  // depois da cotacao, e o endereco so esta preenchido depois do autofill.
  const pac = await screen.findByRole('radio', { name: /PAC/ })
  await waitFor(() => expect(screen.getByLabelText(/^rua$/i)).toHaveValue('Avenida Paulista'))

  await userEvent.type(screen.getByLabelText(/^numero$/i), '1000')
  await userEvent.click(pac)
  await userEvent.click(botaoContinuar())

  // Passo 4: revisao — onde "Ir para o pagamento" dispara o POST unico que
  // cria o pedido. A cobranca acontece na proxima tela (/pedido/<token>),
  // porque o total so e definitivo depois de o servidor validar o cupom.
  expect(await screen.findByRole('button', { name: /ir para o pagamento/i })).toBeInTheDocument()
}

describe('CheckoutWizard', () => {
  afterEach(() => {
    push.mockReset()
    vi.unstubAllGlobals()
  })

  // O checkout mostra frete em dois passos, e a vitrine e a pagina de
  // confirmacao em mais dois. As quatro renderizam o MESMO componente
  // (src/components/linha-frete.tsx) — antes, tres delas tinham o texto
  // escrito na mao e so a vitrine consultava a flag do carrinho, entao virar
  // a flag deixaria as telas discordando sobre o frete da mesma compra.
  //
  // No passo 1 nao ha CEP, logo nao ha cotacao: a linha diz que o frete sera
  // calculado no checkout. A assercao forte nao e o texto — e a AUSENCIA de
  // qualquer valor em reais. "R$ 0,00" seria a promessa de frete gratis que
  // ninguem fez; qualquer outro numero ali seria um frete inventado.
  it('DINHEIRO: no passo 1 o frete e "a cotar", sem nenhum valor em reais', () => {
    vi.stubGlobal('fetch', criarFetchFalso())
    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} />)

    const frete = screen.getByTestId('frete')
    expect(frete).toHaveTextContent(TEXTO_FRETE_A_COTAR)
    expect(frete).not.toHaveTextContent('R$ 0,00')
    expect(frete.textContent ?? '').not.toMatch(/R\$/)
  })

  // §9: o valor unitario tem linha propria e nao some quando a quantidade e 1 —
  // e a unica forma de o comprador conferir a conta de 2, 3 ou 10 kits.
  it('mostra "Valor unitário" no passo 1, mesmo com quantidade 1', async () => {
    vi.stubGlobal('fetch', criarFetchFalso())
    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} />)

    expect(screen.getByTestId('valor-unitario')).toHaveTextContent('Valor unitário: R$ 1.000,00')
    expect(screen.getByTestId('subtotal')).toHaveTextContent('R$ 1.000,00')

    // O unitario NAO acompanha a quantidade; o subtotal sim. Se os dois
    // mudassem juntos, a linha nova nao estaria informando nada.
    await userEvent.click(screen.getByRole('button', { name: /aumentar/i }))
    expect(screen.getByTestId('valor-unitario')).toHaveTextContent('R$ 1.000,00')
    expect(screen.getByTestId('subtotal')).toHaveTextContent('R$ 2.000,00')
  })

  it('DINHEIRO: o corpo do POST leva idServico e nenhum campo monetario', async () => {
    const fetchMock = criarFetchFalso()
    vi.stubGlobal('fetch', fetchMock)

    await preencherAteRevisao()
    await userEvent.click(screen.getByRole('button', { name: /ir para o pagamento/i }))

    await waitFor(() => expect(chamadasDe(fetchMock, '/api/pedidos')).toHaveLength(1))
    const corpo = corpoEnviadoPara(fetchMock, '/api/pedidos')

    for (const campo of CAMPOS_PROIBIDOS) {
      expect(corpo).not.toHaveProperty(campo)
    }
    for (const chave of Object.keys(corpo)) {
      expect(chave).not.toMatch(PADRAO_DE_DINHEIRO)
    }
    // O valor certo sob um nome inocente e o unico jeito que sobrou de mandar
    // dinheiro daqui — e ele tambem nao passa.
    const valoresEnviados = Object.values(corpo).filter((v): v is number => typeof v === 'number')
    for (const valor of valoresEnviados) {
      expect(VALORES_MONETARIOS).not.toContain(valor)
    }

    // O corpo inteiro, nao so a ausencia dos campos proibidos: prova que
    // NADA alem do que o Zod do servidor espera (kitSlug, quantidade,
    // idServico e os dados de comprador/endereco) e enviado. `idServico` e a
    // unica coisa que a cotacao devolve e que volta para o servidor — o VALOR
    // daquela opcao fica na tela; POST /api/pedidos recota e decide sozinho.
    expect(corpo).toEqual({
      kitSlug: 'kit-milagran',
      quantidade: 1,
      idServico: 4553,
      nome: 'Ana Souza',
      email: 'ana.wizard@exemplo.com',
      cpf: '12345678901',
      whatsapp: '11988887777',
      cep: '01310100',
      rua: 'Avenida Paulista',
      numero: '1000',
      complemento: '',
      bairro: 'Bela Vista',
      cidade: 'São Paulo',
      estado: 'SP',
    })

    // Sucesso navega pelo TOKEN, nunca pelo numero (round de correcao 1,
    // Finding 4) — numero e previsivel e a pagina de confirmacao e publica.
    expect(push).toHaveBeenCalledWith(`/pedido/${TOKEN_DO_PEDIDO}`)
  })

  // A cotacao gasta requisicao paga na conta da Milagran a cada chamada (ver o
  // cabecalho de src/app/api/frete/route.ts). Cotar por tecla digitada seria a
  // forma mais cara possivel de preencher um campo de oito digitos.
  it('DINHEIRO: cota o frete uma vez so, sem campo monetario no corpo', async () => {
    const fetchMock = criarFetchFalso()
    vi.stubGlobal('fetch', fetchMock)

    await preencherAteRevisao()

    expect(chamadasDe(fetchMock, '/api/frete')).toHaveLength(1)
    expect(corpoEnviadoPara(fetchMock, '/api/frete')).toEqual({
      cep: '01310100',
      kitSlug: 'kit-milagran',
      quantidade: 1,
    })
  })

  it('preenche rua, bairro, cidade e UF ao completar os 8 digitos do CEP', async () => {
    const fetchMock = criarFetchFalso()
    vi.stubGlobal('fetch', fetchMock)

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} />)
    await irAtePasso3()

    // Sete digitos ainda nao consultam nada: antes do oitavo nao ha CEP.
    await userEvent.type(screen.getByLabelText(/cep/i), '0131010')
    expect(chamadasDe(fetchMock, '/api/cep/01310100')).toHaveLength(0)

    await userEvent.type(screen.getByLabelText(/cep/i), '0')
    await waitFor(() => expect(screen.getByLabelText(/^rua$/i)).toHaveValue('Avenida Paulista'))

    expect(chamadasDe(fetchMock, '/api/cep/01310100')).toHaveLength(1)
    expect(screen.getByLabelText(/bairro/i)).toHaveValue('Bela Vista')
    expect(screen.getByLabelText(/cidade/i)).toHaveValue('São Paulo')
    expect(screen.getByLabelText(/estado/i)).toHaveValue('SP')
  })

  it('mantem os campos editaveis depois do autofill', async () => {
    vi.stubGlobal('fetch', criarFetchFalso())

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} />)
    await irAtePasso3()
    await userEvent.type(screen.getByLabelText(/cep/i), '01310100')
    await waitFor(() => expect(screen.getByLabelText(/^rua$/i)).toHaveValue('Avenida Paulista'))

    // Endereco de entrega nem sempre e o do logradouro principal do CEP, e
    // autofill que nao deixa corrigir e pior do que autofill nenhum.
    const rua = screen.getByLabelText(/^rua$/i)
    await userEvent.clear(rua)
    await userEvent.type(rua, 'Rua Bela Cintra')
    expect(rua).toHaveValue('Rua Bela Cintra')

    const cidade = screen.getByLabelText(/cidade/i)
    await userEvent.clear(cidade)
    await userEvent.type(cidade, 'Sao Paulo')
    expect(cidade).toHaveValue('Sao Paulo')
  })

  // Autofill e CONVENIENCIA, nunca bloqueio: o ViaCEP e um servico publico e
  // gratuito, sem contrato de disponibilidade (src/lib/cep.ts). Falhar nao pode
  // custar uma venda no dia 25/08 nem assustar quem nao tem problema nenhum.
  it('CEP nao encontrado nao mostra erro e deixa digitar o endereco a mao', async () => {
    vi.stubGlobal('fetch', criarFetchFalso({ cep: CEP_NAO_ENCONTRADO }))

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} />)
    await irAtePasso3()
    await userEvent.type(screen.getByLabelText(/cep/i), '01310100')

    // A cotacao de frete acontece do mesmo jeito: ela depende do CEP, nao do
    // autofill.
    const pac = await screen.findByRole('radio', { name: /PAC/ })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText(/^rua$/i)).toHaveValue('')
    expect(screen.getByLabelText(/bairro/i)).toHaveValue('')

    await userEvent.type(screen.getByLabelText(/^rua$/i), 'Av Paulista')
    await userEvent.type(screen.getByLabelText(/^numero$/i), '1000')
    await userEvent.type(screen.getByLabelText(/bairro/i), 'Bela Vista')
    await userEvent.type(screen.getByLabelText(/cidade/i), 'Sao Paulo')
    await userEvent.type(screen.getByLabelText(/estado/i), 'sp')
    await userEvent.click(pac)

    expect(botaoContinuar()).not.toBeDisabled()
  })

  it('sem opcao de frete escolhida, o "Continuar" do passo 3 fica desabilitado', async () => {
    vi.stubGlobal('fetch', criarFetchFalso())

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} />)
    await irAtePasso3()
    await userEvent.type(screen.getByLabelText(/cep/i), '01310100')
    const sedex = await screen.findByRole('radio', { name: /SEDEX/ })
    await userEvent.type(screen.getByLabelText(/^numero$/i), '1000')

    // Endereco completo (o autofill preencheu o resto) e mesmo assim travado:
    // o que falta e a escolha do frete.
    await waitFor(() => expect(screen.getByLabelText(/^rua$/i)).toHaveValue('Avenida Paulista'))
    expect(botaoContinuar()).toBeDisabled()

    await userEvent.click(sedex)
    expect(botaoContinuar()).not.toBeDisabled()
  })

  it('mostra transportadora, valor e prazo de cada opcao cotada', async () => {
    vi.stubGlobal('fetch', criarFetchFalso())

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} />)
    await irAtePasso3()
    await userEvent.type(screen.getByLabelText(/cep/i), '01310100')

    const pac = await screen.findByRole('radio', { name: /PAC/ })
    expect(pac).toHaveAccessibleName(/R\$ 23,50/)
    expect(pac).toHaveAccessibleName(/8 dias úteis/)
    expect(screen.getByRole('radio', { name: /SEDEX/ })).toHaveAccessibleName(/R\$ 49,90/)
    expect(screen.getByRole('radio', { name: /SEDEX/ })).toHaveAccessibleName(/3 dias úteis/)
  })

  /**
   * DINHEIRO: opcao sem nome de transportadora continua pagavel.
   *
   * src/lib/frete.ts trata o nome como cosmetico de proposito — "some da tela,
   * nao some do bolso de ninguem". A tela era mais estrita que o servidor e
   * descartava a opcao inteira, o que importa porque a resposta de sucesso do
   * Clube Envios NAO esta documentada: se nenhum apelido de nome casar, TODA
   * opcao chega sem nome e o checkout online fica sem frete nenhum para
   * escolher — travado no dia do lancamento por causa de um rotulo.
   */
  it('DINHEIRO: cotacao sem nome de transportadora continua selecionavel', async () => {
    vi.stubGlobal('fetch', criarFetchFalso({
      frete: resposta(200, {
        opcoes: [
          { idServico: 4553, transportadora: '', valorCentavos: 2350, prazoDias: 8 },
        ],
      }),
    }))

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} />)
    await irAtePasso3()
    await userEvent.type(screen.getByLabelText(/cep/i), '01310100')
    // O autofill do CEP traz rua, bairro, cidade e UF; o numero da casa e o
    // unico campo que ele nao tem como saber, e sem ele o passo 3 nao libera.
    await userEvent.type(screen.getByLabelText(/^numero$/i), '1000')

    // Rotulo neutro, sem inventar transportadora, com preco e prazo intactos.
    const opcao = await screen.findByRole('radio', { name: /Envio/ })
    expect(opcao).toHaveAccessibleName(/R\$ 23,50/)
    expect(opcao).toHaveAccessibleName(/8 dias úteis/)

    await userEvent.click(opcao)
    expect(botaoContinuar()).not.toBeDisabled()
  })

  // O caso que o cabecalho de src/components/linha-frete.tsx e o de
  // src/lib/frete.ts existem para impedir: cotacao indisponivel NAO pode virar
  // frete zero e NAO pode deixar o pedido seguir.
  it('DINHEIRO: 503 frete_indisponivel trava o avanco e nunca mostra R$ 0,00', async () => {
    vi.stubGlobal('fetch', criarFetchFalso({ frete: FRETE_INDISPONIVEL }))

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} />)
    await irAtePasso3()
    await userEvent.type(screen.getByLabelText(/cep/i), '01310100')
    await userEvent.type(screen.getByLabelText(/^numero$/i), '1000')

    const aviso = await screen.findByRole('alert')
    // A mensagem curada pela rota, mais a consequencia — que a rota nao tem
    // como saber e a tela tem: o pedido nao segue agora.
    expect(aviso).toHaveTextContent(/não foi possível calcular o frete agora/i)
    expect(aviso).toHaveTextContent(/não é possível concluir o pedido/i)

    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(botaoContinuar()).toBeDisabled()

    // Nenhum "R$ 0,00" em lugar nenhum da tela — nem na linha de frete, nem
    // num total montado como se o frete fosse gratis.
    expect(document.body.textContent ?? '').not.toContain('R$ 0,00')
  })

  it('permite tentar a cotacao de novo sem reescrever o CEP', async () => {
    let tentativas = 0
    const fetchMock = criarFetchFalso({
      frete: () => {
        tentativas += 1
        return tentativas === 1 ? FRETE_INDISPONIVEL : FRETE_COTADO
      },
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} />)
    await irAtePasso3()
    await userEvent.type(screen.getByLabelText(/cep/i), '01310100')
    await screen.findByRole('alert')

    await userEvent.click(screen.getByRole('button', { name: /tentar calcular de novo/i }))

    expect(await screen.findByRole('radio', { name: /PAC/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(chamadasDe(fetchMock, '/api/frete')).toHaveLength(2)
  })

  // Uma opcao cotada para 1 kit nao vale para 2: o volume mudou. Manter o radio
  // marcado deixaria o "Continuar" liberado com um valor que nao corresponde
  // mais ao carrinho — e o passo 4 exibiria um Total errado.
  it('DINHEIRO: mudar a quantidade descarta a opcao de frete ja escolhida', async () => {
    const fetchMock = criarFetchFalso()
    vi.stubGlobal('fetch', fetchMock)

    await preencherAteRevisao()

    await userEvent.click(screen.getByRole('button', { name: /voltar/i })) // 4 -> 3
    await userEvent.click(screen.getByRole('button', { name: /voltar/i })) // 3 -> 2
    await userEvent.click(screen.getByRole('button', { name: /voltar/i })) // 2 -> 1
    await userEvent.click(screen.getByRole('button', { name: /aumentar/i }))
    await userEvent.click(botaoContinuar()) // 1 -> 2
    await userEvent.click(botaoContinuar()) // 2 -> 3

    const pac = await screen.findByRole('radio', { name: /PAC/ })
    expect(pac).not.toBeChecked()
    expect(botaoContinuar()).toBeDisabled()

    // E a nova cotacao saiu para a quantidade nova, nao para a antiga.
    expect(corpoEnviadoPara(fetchMock, '/api/frete')).toEqual({
      cep: '01310100',
      kitSlug: 'kit-milagran',
      quantidade: 2,
    })
  })

  // §9: o resumo completo, com o frete de verdade dentro do total.
  it('DINHEIRO: o passo 4 mostra frete real, prazo e Total = subtotal + frete', async () => {
    vi.stubGlobal('fetch', criarFetchFalso())

    await preencherAteRevisao()

    expect(screen.getByText('Produto: Kit Milagran')).toBeInTheDocument()
    expect(screen.getByText('Quantidade: 1')).toBeInTheDocument()
    expect(screen.getByTestId('valor-unitario')).toHaveTextContent('R$ 1.000,00')
    expect(screen.getByTestId('subtotal')).toHaveTextContent('R$ 1.000,00')

    const frete = screen.getByTestId('frete')
    expect(frete).toHaveTextContent('R$ 23,50')
    expect(frete).toHaveTextContent(/8 dias úteis/)
    expect(frete).not.toHaveTextContent('R$ 0,00')

    // 100000 + 2350 = 102350. O total do passo 4 e o total DE VERDADE — nao o
    // subtotal disfarcado de total, que era o que a tela mostrava enquanto o
    // frete nao existia.
    expect(screen.getByTestId('total')).toHaveTextContent('R$ 1.023,50')
    expect(document.body.textContent ?? '').not.toContain('R$ 0,00')
  })

  it('anuncia PIX e cartao de credito e diz que a cobranca e na proxima tela', async () => {
    vi.stubGlobal('fetch', criarFetchFalso())

    await preencherAteRevisao()

    const formas = screen.getByRole('group', { name: /formas de pagamento/i })
    expect(formas).toHaveTextContent('PIX')
    expect(formas).toHaveTextContent(/cartão de crédito/i)
    expect(screen.getByText(/a cobrança acontece na próxima tela/i)).toBeInTheDocument()
  })

  it('em 422, mostra a mensagem de erro e NAO navega', async () => {
    const fetchMock = criarFetchFalso({
      pedidos: resposta(422, {
        error: 'cupom_recusado',
        mensagem: 'Cupom nao encontrado. Confira o codigo.',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await preencherAteRevisao()
    await userEvent.click(screen.getByRole('button', { name: /ir para o pagamento/i }))

    expect(await screen.findByText('Cupom nao encontrado. Confira o codigo.')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })
})

/**
 * Passos 1 e 2 sem tocar em CEP nem em frete: os testes de endereco/cotacao
 * precisam CHEGAR ao passo 3 com o formulario limpo, e repetir a digitacao dos
 * dados pessoais em cada um deles esconderia o que cada teste esta realmente
 * afirmando. Diferente de `preencherAteRevisao`, que percorre o fluxo inteiro.
 */
async function irAtePasso3() {
  await userEvent.click(botaoContinuar())
  await userEvent.type(screen.getByLabelText(/nome completo/i), 'Ana Souza')
  await userEvent.type(screen.getByLabelText(/e-mail/i), 'ana.wizard@exemplo.com')
  await userEvent.type(screen.getByLabelText(/cpf/i), '12345678901')
  await userEvent.type(screen.getByLabelText(/whatsapp/i), '11988887777')
  await userEvent.click(botaoContinuar())
}
