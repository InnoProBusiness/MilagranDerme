import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CheckoutWizard } from '@/components/checkout-wizard'
import { TEXTO_FRETE_A_COTAR } from '@/components/linha-frete'
import { ROTULO_RETIRADA } from '@/lib/retirada'
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
 * As duas respostas de POST /api/cupons/validar, no formato exato da rota. As
 * DUAS sao 200: uma recusa e a RESPOSTA da pergunta, nao um erro de requisicao
 * — copiar isso errado aqui faria o teste provar que a tela lida bem com um
 * formato que a rota nunca produz.
 */
const CUPOM_VALIDO = resposta(200, { valido: true, codigo: 'PRE200', descontoCentavos: 20000 })
const CUPOM_EXPIRADO = resposta(200, {
  valido: false, motivo: 'expirado', mensagem: 'Este cupom expirou.',
})

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
function criarFetchFalso(
  roteiro: { cep?: Roteiro; frete?: Roteiro; pedidos?: Roteiro; cupom?: Roteiro } = {},
) {
  const resolver = (r: Roteiro | undefined, padrao: RespostaFalsa): RespostaFalsa => {
    if (!r) return padrao
    return typeof r === 'function' ? r() : r
  }
  return vi.fn(async (entrada: string, init?: RequestInit): Promise<RespostaFalsa> => {
    void init
    if (entrada.startsWith('/api/cep/')) return resolver(roteiro.cep, CEP_ENCONTRADO)
    if (entrada === '/api/frete') return resolver(roteiro.frete, FRETE_COTADO)
    if (entrada === '/api/pedidos') return resolver(roteiro.pedidos, PEDIDO_CRIADO)
    if (entrada === '/api/cupons/validar') return resolver(roteiro.cupom, CUPOM_VALIDO)
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
 * A mensagem de erro de UM campo, procurada pelo id que o `aria-describedby` do
 * input aponta (`erro-<campo>` em src/components/checkout-wizard.tsx).
 *
 * Pelo id, e nao pelo texto: assim o teste prova de uma vez as duas coisas que
 * importam — que a frase existe E que ela esta no lugar em que o campo promete
 * que ela esta. Uma mensagem certa com id errado nao chega a quem usa leitor de
 * tela, e um `getByText` passaria feliz.
 */
function erroDoCampo(campo: string): HTMLElement {
  const elemento = document.getElementById(`erro-${campo}`)
  if (!elemento) throw new Error(`Nenhuma mensagem de erro visivel para o campo "${campo}"`)
  return elemento
}

/**
 * Caminho feliz completo ate o passo 4, JA COM autofill e cotacao de frete.
 *
 * Repare no que ela NAO digita mais: rua, bairro, cidade e UF chegam do autofill
 * de CEP (§13). Isso e proposital — este helper e o percurso do comprador comum,
 * e o teste de digitacao manual (autofill que falha) e um caso proprio, mais
 * abaixo, exatamente porque e o caminho excepcional.
 */
/**
 * O caminho do passo 1 ate a revisao, SEM renderizar — para os testes que
 * precisam montar o wizard com props proprias (o cupom vindo do link, por
 * exemplo) antes de percorrer o fluxo.
 *
 * `preencherAteRevisao` continua existindo e chamando esta funcao: os testes
 * que nao se importam com as props seguem numa linha so.
 */
async function percorrerAteRevisao() {
  // Passo 1: produto e quantidade.
  await userEvent.click(botaoContinuar())

  // Passo 2: dados pessoais.
  await userEvent.type(screen.getByLabelText(/nome completo/i), 'Ana Souza')
  await userEvent.type(screen.getByLabelText(/e-mail/i), 'ana.wizard@exemplo.com')
  await userEvent.type(screen.getByLabelText(/cpf/i), '12345678901')
  await userEvent.type(screen.getByLabelText(/whatsapp/i), '11988887777')
  await userEvent.click(botaoContinuar())

  // Passo 3: MODALIDADE, depois endereco, depois transportadora.
  //
  // A escolha da modalidade vem primeiro desde 19/08/2026, e nao e detalhe de
  // teste: o campo de CEP so existe dentro do ramo de envio. Era essa ordem que
  // faltava na primeira versao da tela, em que a retirada aparecia sozinha e
  // quem clicasse nela ficava sem caminho de volta.
  await escolherEnvio()

  // /numero/i sozinho e ambiguo: o label do CEP e "CEP (somente numeros)" e
  // tambem contem a substring "numero" — so o anchor exato distingue o
  // campo de numero do endereco do label do CEP.
  await userEvent.type(screen.getByLabelText(/^cep \(/i), '01310100')
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

/**
 * Marca "Receber em casa" no primeiro radiogroup do passo 3.
 *
 * Funcao propria, e nao uma linha solta, porque TODO caminho de envio passa por
 * ela: se um refactor mudar o rotulo da modalidade, quebra aqui uma vez em vez
 * de em dez testes.
 */
async function escolherEnvio() {
  await userEvent.click(screen.getByRole('radio', { name: /receber em casa/i }))
}

/** A outra modalidade. */
async function escolherRetirada() {
  await userEvent.click(screen.getByRole('radio', { name: new RegExp(ROTULO_RETIRADA, 'i') }))
}

async function preencherAteRevisao() {
  render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
  await percorrerAteRevisao()
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
    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)

    const frete = screen.getByTestId('frete')
    expect(frete).toHaveTextContent(TEXTO_FRETE_A_COTAR)
    expect(frete).not.toHaveTextContent('R$ 0,00')
    expect(frete.textContent ?? '').not.toMatch(/R\$/)
  })

  // §9: o valor unitario tem linha propria e nao some quando a quantidade e 1 —
  // e a unica forma de o comprador conferir a conta de 2, 3 ou 10 kits.
  it('mostra "Valor unitário" no passo 1, mesmo com quantidade 1', async () => {
    vi.stubGlobal('fetch', criarFetchFalso())
    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)

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
      // A MODALIDADE, e nao o preco dela. `tipoEntrega` e o discriminante da
      // uniao de POST /api/pedidos: ele diz QUAL contrato este corpo cumpre, e
      // e por ele que o servidor sabe que aqui ainda tem que haver `idServico`
      // e endereco. Nao passa pelo PADRAO_DE_DINHEIRO acima porque nao e
      // dinheiro — e o nome de um caminho.
      tipoEntrega: 'envio',
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

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
    await irAtePasso3()
    await escolherEnvio()

    // Sete digitos ainda nao consultam nada: antes do oitavo nao ha CEP.
    await userEvent.type(screen.getByLabelText(/^cep \(/i), '0131010')
    expect(chamadasDe(fetchMock, '/api/cep/01310100')).toHaveLength(0)

    await userEvent.type(screen.getByLabelText(/^cep \(/i), '0')
    await waitFor(() => expect(screen.getByLabelText(/^rua$/i)).toHaveValue('Avenida Paulista'))

    expect(chamadasDe(fetchMock, '/api/cep/01310100')).toHaveLength(1)
    expect(screen.getByLabelText(/bairro/i)).toHaveValue('Bela Vista')
    expect(screen.getByLabelText(/cidade/i)).toHaveValue('São Paulo')
    expect(screen.getByLabelText(/estado/i)).toHaveValue('SP')
  })

  it('mantem os campos editaveis depois do autofill', async () => {
    vi.stubGlobal('fetch', criarFetchFalso())

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
    await irAtePasso3()
    await escolherEnvio()
    await userEvent.type(screen.getByLabelText(/^cep \(/i), '01310100')
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

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
    await irAtePasso3()
    await escolherEnvio()
    await userEvent.type(screen.getByLabelText(/^cep \(/i), '01310100')

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

  it('sem opcao de frete escolhida, o "Continuar" do passo 3 diz o que falta', async () => {
    vi.stubGlobal('fetch', criarFetchFalso())

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
    await irAtePasso3()
    await escolherEnvio()
    await userEvent.type(screen.getByLabelText(/^cep \(/i), '01310100')
    const sedex = await screen.findByRole('radio', { name: /SEDEX/ })
    await userEvent.type(screen.getByLabelText(/^numero$/i), '1000')

    // Endereco completo (o autofill preencheu o resto) e mesmo assim travado:
    // o que falta e a escolha do frete.
    //
    // ATE 21/08/2026 ESTE TESTE PEDIA `toBeDisabled()`. A trava continua
    // exatamente a mesma — o passo nao anda sem frete escolhido —, mas o botao
    // desabilitado nunca chegava a dizer o que faltava: ele nao recebe clique,
    // entao nao responde ao unico gesto que o comprador faz. Agora o clique
    // acontece e produz a frase. Ver a reclamacao registrada em
    // `describe('dados incorretos ou incompletos')`.
    await waitFor(() => expect(screen.getByLabelText(/^rua$/i)).toHaveValue('Avenida Paulista'))
    await userEvent.click(botaoContinuar())

    expect(screen.getByTestId('erros-do-passo')).toHaveTextContent(/escolha uma opção de frete/i)
    expect(screen.getByRole('heading', { name: /^entrega$/i })).toBeInTheDocument()

    // Escolhida a opcao, o aviso some sozinho e o mesmo botao passa.
    await userEvent.click(sedex)
    expect(screen.queryByTestId('erros-do-passo')).toBeNull()
    await userEvent.click(botaoContinuar())
    expect(await screen.findByRole('button', { name: /ir para o pagamento/i })).toBeInTheDocument()
  })

  it('mostra transportadora, valor e prazo de cada opcao cotada', async () => {
    vi.stubGlobal('fetch', criarFetchFalso())

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
    await irAtePasso3()
    await escolherEnvio()
    await userEvent.type(screen.getByLabelText(/^cep \(/i), '01310100')

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

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
    await irAtePasso3()
    await escolherEnvio()
    await userEvent.type(screen.getByLabelText(/^cep \(/i), '01310100')
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

  /**
   * LINK DE CAMPANHA (`/?cupom=CODIGO`): o campo ja nasce preenchido e o
   * codigo viaja no POST sem a pessoa digitar nada.
   *
   * O que este teste NAO prova, de proposito: que houve desconto. O corpo
   * leva o CODIGO, e nenhum valor monetario — quem resgata o cupom e decide o
   * preco e o servidor, sob trava de linha. A varredura de CAMPOS_PROIBIDOS
   * deste arquivo continua valendo para o corpo montado aqui.
   */
  it('cupom vindo do link ja vai preenchido e viaja no POST', async () => {
    const fetchMock = criarFetchFalso()
    vi.stubGlobal('fetch', fetchMock)

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} cupomInicial="PRE800" lancado={false} />)
    await percorrerAteRevisao()

    expect(screen.getByLabelText(/cupom/i)).toHaveValue('PRE800')
    await userEvent.click(screen.getByRole('button', { name: /ir para o pagamento/i }))

    await waitFor(() => expect(chamadasDe(fetchMock, '/api/pedidos')).toHaveLength(1))
    const corpo = corpoEnviadoPara(fetchMock, '/api/pedidos')
    expect(corpo.cupom).toBe('PRE800')
    // DINHEIRO: o link nao manda valor nenhum — so o codigo.
    for (const proibido of CAMPOS_PROIBIDOS) {
      expect(corpo).not.toHaveProperty(proibido)
    }
  })

  // O link e conveniencia, nao trava: quem tiver outro codigo digita por cima.
  it('o comprador pode trocar o cupom que veio do link', async () => {
    const fetchMock = criarFetchFalso()
    vi.stubGlobal('fetch', fetchMock)

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} cupomInicial="PRE800" lancado={false} />)
    await percorrerAteRevisao()

    const campo = screen.getByLabelText(/cupom/i)
    await userEvent.clear(campo)
    await userEvent.type(campo, 'outro10')
    expect(campo).toHaveValue('OUTRO10')
  })

  it('sem cupom no link, o campo nasce vazio', async () => {
    vi.stubGlobal('fetch', criarFetchFalso())

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
    await percorrerAteRevisao()

    expect(screen.getByLabelText(/cupom/i)).toHaveValue('')
  })

  // O caso que o cabecalho de src/components/linha-frete.tsx e o de
  // src/lib/frete.ts existem para impedir: cotacao indisponivel NAO pode virar
  // frete zero e NAO pode deixar o pedido seguir.
  /**
   * O QUE ESTE TESTE PASSOU A AFIRMAR EM 19/08/2026, e por que a mudanca e uma
   * melhora e nao um afrouxamento.
   *
   * Ele se chamava "503 frete_indisponivel TRAVA O AVANCO" e exigia zero radios
   * na tela. Isso era exato enquanto a unica forma de receber o kit dependia do
   * Clube Envios: sem cotacao nao havia compra possivel, e deixar o comprador
   * seguir teria produzido um pedido com frete desconhecido.
   *
   * Com a retirada no local existe uma forma de entrega que NAO DEPENDE DE
   * PROVEDOR NENHUM. Continuar bloqueando a tela inteira numa queda do Clube
   * Envios seria recusar a venda de quem ia buscar o kit a pe — por causa de um
   * servico que aquela compra nunca usaria.
   *
   * O que continua trancado, e e o que sempre importou: nenhuma opcao de ENVIO
   * aparece sem cotacao, e a linha de frete do resumo nunca imprime R$ 0,00 por
   * causa de uma cotacao que falhou.
   */
  it('DINHEIRO: 503 frete_indisponivel nao oferece envio nenhum, e nunca cota R$ 0,00', async () => {
    vi.stubGlobal('fetch', criarFetchFalso({ frete: FRETE_INDISPONIVEL }))

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
    await irAtePasso3()
    await escolherEnvio()
    await userEvent.type(screen.getByLabelText(/^cep \(/i), '01310100')
    await userEvent.type(screen.getByLabelText(/^numero$/i), '1000')

    const aviso = await screen.findByRole('alert')
    expect(aviso).toHaveTextContent(/não foi possível calcular o frete agora/i)

    // NENHUMA opcao de transportadora — nao houve cotacao. As duas
    // modalidades continuam na tela, que e o que da caminho de volta.
    expect(screen.queryByRole('radio', { name: /PAC|SEDEX/ })).toBeNull()

    // O passo continua sem andar — e agora DIZ isso, apontando para as duas
    // saidas que existem: cotar de novo, ou trocar para a retirada.
    await userEvent.click(botaoContinuar())
    expect(screen.getByTestId('erros-do-passo')).toHaveTextContent(/tentar calcular de novo/i)
    expect(screen.getByRole('heading', { name: /^entrega$/i })).toBeInTheDocument()

    // O alerta fala do ENVIO, e nao do pedido: com a retirada disponivel, uma
    // queda do provedor deixou de fechar a loja, e dizer que o pedido parou
    // mandaria embora quem ia buscar o kit a pe.
    expect(aviso).not.toHaveTextContent(/concluir o pedido/i)
  })

  /**
   * A CONSEQUENCIA DE PRODUTO: uma queda do Clube Envios na semana do
   * lancamento deixou de ser uma loja fechada.
   */
  it('provedor fora do ar nao impede quem vai retirar de comprar', async () => {
    vi.stubGlobal('fetch', criarFetchFalso({ frete: FRETE_INDISPONIVEL }))

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
    await irAtePasso3()
    await escolherRetirada()

    // Sem CEP, sem cotacao, sem endereco — e mesmo assim o pedido anda.
    expect(botaoContinuar()).toBeEnabled()
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

    render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
    await irAtePasso3()
    await escolherEnvio()
    await userEvent.type(screen.getByLabelText(/^cep \(/i), '01310100')
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
    await userEvent.click(botaoContinuar())
    expect(screen.getByTestId('erros-do-passo')).toHaveTextContent(/escolha uma opção de frete/i)
    expect(screen.getByRole('heading', { name: /^entrega$/i })).toBeInTheDocument()

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

    // Pelo `role="group"` E pelo nome acessivel, que desde 21/08/2026 vem de um
    // ROTULO VISIVEL (`aria-labelledby`) e nao mais de um `aria-label`
    // invisivel: se alguem voltar a esconder o titulo do bloco, o nome do grupo
    // some junto e esta busca falha.
    const formas = screen.getByRole('group', { name: /formas de pagamento/i })
    expect(screen.getByText(/formas de pagamento aceitas/i)).toBeInTheDocument()
    expect(formas).toHaveTextContent('PIX')
    expect(formas).toHaveTextContent(/cartão de crédito/i)
    expect(screen.getByText(/a cobrança acontece na próxima tela/i)).toBeInTheDocument()

    // E NENHUM DELES E CLICAVEL. O desenho de chip que os dois tinham ate
    // 21/08/2026 os fazia parecer botoes — a mesma armadilha do "Continuar"
    // travado e mudo. Nao ha o que clicar aqui: a forma de pagamento e
    // escolhida na tela seguinte.
    expect(within(formas).queryByRole('button')).toBeNull()
    expect(within(formas).queryByRole('radio')).toBeNull()
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

  /**
   * RETIRADA NO LOCAL na tela (19/08/2026). O que estes casos protegem e a
   * ORDEM: a escolha de entrega passou a vir ANTES do endereco justamente para
   * que quem vai buscar o kit nao preencha seis campos a toa. Um refactor que
   * devolvesse os campos para cima quebraria aqui.
   */
  describe('retirada no local', () => {
    async function irAteEntrega(lancado = false) {
      render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={lancado} />)
      await irAtePasso3()
    }

    it('as DUAS modalidades aparecem antes de qualquer CEP', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await irAteEntrega()

      expect(screen.getByRole('radio', { name: new RegExp(ROTULO_RETIRADA, 'i') })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /receber em casa/i })).toBeInTheDocument()
      // Nenhuma vem marcada: a retirada, que e a primeira e a mais barata,
      // viraria a escolha de quem so clicou em Continuar sem ler — e essa
      // pessoa descobriria que tem de ir a Goiania depois de pagar.
      expect(screen.getByRole('radio', { name: /receber em casa/i })).not.toBeChecked()

      // E o "Continuar" nao anda sem escolha nenhuma — dizendo por que, em vez
      // de ficar travado e mudo.
      await userEvent.click(botaoContinuar())
      expect(screen.getByTestId('erros-do-passo'))
        .toHaveTextContent(/escolha como você quer receber/i)
    })

    it('escolher retirada faz o endereco de entrega desaparecer', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await irAteEntrega()
      await escolherEnvio()

      expect(screen.getByLabelText(/^cep \(/i)).toBeInTheDocument()
      await escolherRetirada()

      // Some, e nao fica cinza: campo desabilitado ainda pergunta algo, e nao
      // ha nada a perguntar a quem vai buscar o kit na loja.
      expect(screen.queryByLabelText(/^cep \(/i)).toBeNull()
      expect(screen.queryByLabelText(/^numero$/i)).toBeNull()
    })

    /**
     * O BECO SEM SAIDA QUE ESTE TESTE FECHA (revisao de 19/08/2026).
     *
     * Na primeira versao da tela a retirada era a UNICA linha visivel antes de
     * haver CEP. Quem clicasse nela, lesse o endereco e desistisse ficava
     * preso: radio nativo nao desmarca com um segundo clique, o campo de CEP
     * tinha sido desmontado junto com o endereco, e nao havia outra opcao no
     * grupo para escolher no lugar. A unica saida era recarregar a pagina,
     * perdendo nome, e-mail, CPF e WhatsApp — nada disso e persistido.
     */
    it('clicar em retirada e mudar de ideia devolve o endereco, sem recarregar', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await irAteEntrega()

      await escolherRetirada()
      expect(screen.queryByLabelText(/^cep \(/i)).toBeNull()

      await escolherEnvio()
      expect(screen.getByLabelText(/^cep \(/i)).toBeInTheDocument()

      // E nada do que ela ja tinha digitado se perdeu — a saida antiga era
      // recarregar a pagina, que apagava os quatro campos do passo 2.
      await userEvent.click(screen.getByRole('button', { name: /voltar/i }))
      expect(screen.getByLabelText(/nome completo/i)).toHaveValue('Ana Souza')
      expect(screen.getByLabelText(/cpf/i)).toHaveValue('12345678901')
    })

    it('o endereco ja digitado volta intacto ao trocar de ideia duas vezes', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await irAteEntrega()
      await escolherEnvio()
      await userEvent.type(screen.getByLabelText(/^cep \(/i), '01310100')
      await userEvent.type(screen.getByLabelText(/^numero$/i), '1000')

      await escolherRetirada()
      await escolherEnvio()

      expect(screen.getByLabelText(/^cep \(/i)).toHaveValue('01310100')
      expect(screen.getByLabelText(/^numero$/i)).toHaveValue('1000')
      // E as opcoes ja cotadas continuam la: voltar para o envio e um clique,
      // nao uma redigitacao de CEP.
      expect(await screen.findByRole('radio', { name: /PAC/ })).toBeInTheDocument()
    })

    it('mostra onde retirar, ali mesmo na hora de decidir', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await irAteEntrega()
      await escolherRetirada()

      const caixa = screen.getByTestId('endereco-retirada')
      expect(caixa).toHaveTextContent(/Goiânia/)
      expect(caixa).toHaveTextContent(/74693-158/)
    })

    // O aviso de pre-venda cumpre o contrato escrito na propria constante: some
    // depois de 25/08. `lancado` vem do servidor justamente para que a virada
    // nao produza HTML diferente no SSR e na hidratacao.
    it('o aviso de pre-venda some depois do lancamento', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await irAteEntrega(false)
      await escolherRetirada()
      expect(screen.getByTestId('endereco-retirada')).toHaveTextContent(/25\/08\/2026/)

      cleanup()
      await irAteEntrega(true)
      await escolherRetirada()
      expect(screen.getByTestId('endereco-retirada')).not.toHaveTextContent(/25\/08\/2026/)
    })

    /**
     * O CORPO DA REQUISICAO, e o que NAO esta nele: nem idServico, nem um unico
     * campo de endereco. Os dois seriam 422 no servidor (CorpoRetirada e
     * `.strict()`), e mandar `...endereco` "porque nao custa" faria esse 422
     * acontecer para todo mundo que escolhesse retirada.
     */
    it('DINHEIRO: o corpo leva tipoEntrega e nenhum campo de envio', async () => {
      const fetchMock = criarFetchFalso()
      vi.stubGlobal('fetch', fetchMock)
      await irAteEntrega()
      await escolherRetirada()
      await userEvent.click(botaoContinuar())
      await userEvent.click(screen.getByRole('button', { name: /ir para o pagamento/i }))

      const corpo = corpoEnviadoPara(fetchMock, '/api/pedidos')
      expect(corpo).toEqual({
        kitSlug: 'kit-milagran',
        quantidade: 1,
        tipoEntrega: 'retirada',
        nome: 'Ana Souza',
        email: 'ana.wizard@exemplo.com',
        cpf: '12345678901',
        whatsapp: '11988887777',
      })

      // As tres camadas de sempre continuam valendo sobre este corpo tambem.
      for (const proibido of CAMPOS_PROIBIDOS) {
        expect(corpo).not.toHaveProperty(proibido)
      }
      for (const chave of Object.keys(corpo)) {
        expect(chave).not.toMatch(PADRAO_DE_DINHEIRO)
      }
      const enviado = JSON.stringify(corpo)
      for (const valor of VALORES_MONETARIOS) {
        expect(enviado).not.toContain(String(valor))
      }
    })

    // Quem escolhe retirada nao pode ver a tela pedir CEP: nao ha campo nenhum
    // abaixo daquela frase, e o alerta de frete falaria de um servico que essa
    // compra nunca vai usar.
    it('nenhuma copy de frete sobra na tela de quem vai retirar', async () => {
      vi.stubGlobal('fetch', criarFetchFalso({ frete: FRETE_INDISPONIVEL }))
      await irAteEntrega()
      await escolherEnvio()
      await userEvent.type(screen.getByLabelText(/^cep \(/i), '01310100')
      await screen.findByRole('alert')

      await escolherRetirada()

      expect(screen.queryByRole('alert')).toBeNull()
      expect(document.body.textContent ?? '').not.toMatch(/informe o cep/i)
    })

    it('mudar a quantidade nao descarta a retirada ja escolhida', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await irAteEntrega()
      await escolherRetirada()
      expect(botaoContinuar()).toBeEnabled()

      await userEvent.click(screen.getByRole('button', { name: /voltar/i }))
      await userEvent.click(screen.getByRole('button', { name: /voltar/i }))
      await userEvent.click(screen.getByRole('button', { name: /aumentar/i }))
      await userEvent.click(botaoContinuar())
      await userEvent.click(botaoContinuar())

      expect(screen.getByRole('radio', { name: new RegExp(ROTULO_RETIRADA, 'i') })).toBeChecked()
    })

    it('o resumo diz retirada em vez de imprimir R$ 0,00 de frete', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await irAteEntrega()
      await escolherRetirada()
      await userEvent.click(botaoContinuar())

      expect(screen.getByTestId('frete')).toHaveTextContent(/sem frete/i)
      expect(screen.getByTestId('frete')).not.toHaveTextContent('R$ 0,00')
    })

    // O passo 1 tambem: quem escolheu retirar e voltou para somar um kit leria
    // "calculado a partir do seu CEP" sobre uma compra que ja decidiu nao ter
    // frete nenhum.
    it('voltar ao passo 1 depois de escolher retirada nao promete frete', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await irAteEntrega()
      await escolherRetirada()
      await userEvent.click(screen.getByRole('button', { name: /voltar/i }))
      await userEvent.click(screen.getByRole('button', { name: /voltar/i }))

      expect(screen.getByTestId('frete')).toHaveTextContent(/sem frete/i)
    })
  })

  /**
   * O BOTAO "VALIDAR CUPOM" (19/08/2026). Antes dele o comprador digitava o
   * codigo e so descobria o resultado depois de mandar criar o pedido: um
   * digito errado virava 422 na tela de pagamento, longe do campo onde estava o
   * erro, e um desconto legitimo nao aparecia em lugar nenhum antes de fechar a
   * compra.
   */
  /**
   * A RECLAMACAO DE 21/08/2026 — e a classe inteira de defeito que ela revelou.
   *
   * Uma compradora digitou o WhatsApp com um digito a menos ("629960153", nove
   * digitos), clicou em "Continuar" e A TELA NAO FEZ NADA. Nada mesmo: o botao
   * estava `disabled`, o CSS nao tinha regra para `:disabled` — entao ele saia
   * dourado, com hover, visualmente identico ao que funciona —, nenhum campo
   * estava destacado e nenhuma mensagem existia em lugar nenhum. Quatro campos
   * preenchidos, e nenhuma pista de qual era o errado.
   *
   * O DEFEITO DE FUNDO NAO ERA A VALIDACAO. As regras sempre estiveram certas,
   * e sao as mesmas do Zod de src/app/api/pedidos/route.ts. Era o CANAL: botao
   * desabilitado nao recebe clique, logo nao tem como responder ao unico gesto
   * que a pessoa faz. Por isso os testes daqui fixam o CANAL — o passo recusa,
   * e ao recusar aponta o campo, escreve a razao e leva o cursor ate la —, e
   * nao apenas o texto das frases.
   */
  describe('dados incorretos ou incompletos', () => {
    async function irAtePasso2() {
      vi.stubGlobal('fetch', criarFetchFalso())
      render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
      await userEvent.click(botaoContinuar())
    }

    async function preencherDadosMenosOWhatsapp() {
      await userEvent.type(screen.getByLabelText(/nome completo/i), 'Ana Souza')
      await userEvent.type(screen.getByLabelText(/e-mail/i), 'ana.wizard@exemplo.com')
      await userEvent.type(screen.getByLabelText(/cpf/i), '12345678901')
    }

    it('o caso da reclamacao: WhatsApp com um digito a menos diz o que falta', async () => {
      await irAtePasso2()
      await preencherDadosMenosOWhatsapp()
      // Nove digitos: o numero exato da reclamacao, que PARECE completo para
      // quem acabou de escreve-lo.
      await userEvent.type(screen.getByLabelText(/whatsapp/i), '629960153')

      await userEvent.click(botaoContinuar())

      // 1. O passo NAO andou. Explicar nao e deixar passar: o servidor recusaria
      //    este telefone do mesmo jeito.
      expect(screen.getByRole('heading', { name: /seus dados/i })).toBeInTheDocument()

      // 2. A mensagem esta embaixo do campo errado, e CONTA OS DIGITOS — e a
      //    diferenca entre "esta errado" e "falta um".
      expect(erroDoCampo('whatsapp')).toHaveTextContent(/no mínimo 10/i)
      expect(erroDoCampo('whatsapp')).toHaveTextContent(/9 dígitos/i)

      // 3. O cursor foi para la sozinho, sem a pessoa ter que procurar entre
      //    quatro campos preenchidos.
      expect(screen.getByLabelText(/whatsapp/i)).toHaveFocus()

      // 4. E o resumo nomeia o campo — so ele, dos quatro.
      expect(screen.getByTestId('erros-do-passo')).toHaveTextContent(/whatsapp/i)
      expect(screen.getByTestId('erros-do-passo')).not.toHaveTextContent(/cpf/i)
    })

    it('corrigir o digito que faltava apaga o erro e destrava o passo', async () => {
      await irAtePasso2()
      await preencherDadosMenosOWhatsapp()
      await userEvent.type(screen.getByLabelText(/whatsapp/i), '629960153')
      await userEvent.click(botaoContinuar())
      expect(screen.getByTestId('erros-do-passo')).toBeInTheDocument()

      // O decimo digito.
      await userEvent.type(screen.getByLabelText(/whatsapp/i), '1')

      expect(document.getElementById('erro-whatsapp')).toBeNull()
      expect(screen.queryByTestId('erros-do-passo')).toBeNull()

      await userEvent.click(botaoContinuar())
      expect(screen.getByRole('heading', { name: /^entrega$/i })).toBeInTheDocument()
    })

    it('com tudo vazio, o clique nomeia os quatro campos e foca o primeiro', async () => {
      await irAtePasso2()
      await userEvent.click(botaoContinuar())

      const resumo = screen.getByTestId('erros-do-passo')
      for (const rotulo of ['Nome completo', 'E-mail', 'CPF', 'WhatsApp']) {
        expect(resumo).toHaveTextContent(rotulo)
      }
      // O foco vai para o PRIMEIRO DA TELA, e nao para um qualquer: mandar o
      // cursor para o terceiro campo faria a pessoa rolar para tras.
      expect(screen.getByLabelText(/nome completo/i)).toHaveFocus()
      expect(screen.getByRole('heading', { name: /seus dados/i })).toBeInTheDocument()
    })

    /**
     * O OUTRO LADO DA MESMA MOEDA. Formulario que critica enquanto a pessoa
     * digita ensina a ignorar vermelho — e ai a mensagem que importa passa
     * despercebida junto com as outras.
     */
    it('nao critica nada antes de a pessoa terminar o campo', async () => {
      await irAtePasso2()
      await userEvent.type(screen.getByLabelText(/nome completo/i), 'A')

      expect(document.querySelector('.form__error')).toBeNull()
      expect(screen.queryByTestId('erros-do-passo')).toBeNull()
    })

    it('sair de um campo invalido mostra o erro dele, e so dele', async () => {
      await irAtePasso2()
      await userEvent.type(screen.getByLabelText(/e-mail/i), 'ana@')
      await userEvent.tab()

      expect(erroDoCampo('email')).toHaveTextContent(/nome@provedor\.com/i)
      // Os outros continuam calados: a pessoa nem chegou neles.
      expect(document.getElementById('erro-cpf')).toBeNull()
      expect(document.getElementById('erro-whatsapp')).toBeNull()
      // E o resumo e resposta a um CLIQUE no Continuar, nao a um blur.
      expect(screen.queryByTestId('erros-do-passo')).toBeNull()
    })

    /**
     * A MENSAGEM TEM QUE CHEGAR A QUEM NAO A ENXERGA. Sem estes dois atributos
     * o campo fica vermelho para uns e mudo para outros — a mesma reclamacao,
     * num publico menor e ainda mais sem saida.
     */
    it('o campo invalido aponta para a propria mensagem', async () => {
      await irAtePasso2()
      await userEvent.click(botaoContinuar())

      const cpf = screen.getByLabelText(/cpf/i)
      expect(cpf).toHaveAttribute('aria-invalid', 'true')
      expect(cpf).toHaveAttribute('aria-describedby', 'erro-cpf')
      expect(erroDoCampo('cpf')).toHaveTextContent(/11 dígitos/i)
    })

    it('o vermelho de um passo nao vai junto para o proximo', async () => {
      await irAtePasso2()
      await userEvent.click(botaoContinuar())
      expect(screen.getByTestId('erros-do-passo')).toBeInTheDocument()

      await preencherDadosMenosOWhatsapp()
      await userEvent.type(screen.getByLabelText(/whatsapp/i), '11988887777')
      await userEvent.click(botaoContinuar())
      await escolherEnvio()

      // Passo 3 recem-aberto, com o endereco todo vazio: nada em vermelho.
      expect(document.querySelector('.form__error')).toBeNull()
      expect(screen.queryByTestId('erros-do-passo')).toBeNull()
    })

    it('endereco incompleto aponta o campo que falta e leva o cursor ate ele', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
      await irAtePasso3()
      await escolherEnvio()
      await userEvent.type(screen.getByLabelText(/^cep \(/i), '01310100')
      const pac = await screen.findByRole('radio', { name: /PAC/ })
      await waitFor(() => expect(screen.getByLabelText(/^rua$/i)).toHaveValue('Avenida Paulista'))
      await userEvent.click(pac)

      // O autofill preenche rua, bairro, cidade e UF — o numero da casa e o
      // unico que so a pessoa sabe, e o unico que fica faltando.
      await userEvent.click(botaoContinuar())

      expect(erroDoCampo('numero')).toHaveTextContent(/S\/N/i)
      expect(screen.getByLabelText(/^numero$/i)).toHaveFocus()
      expect(screen.getByTestId('erros-do-passo')).toHaveTextContent(/campos destacados do endereço/i)
      expect(screen.getByRole('heading', { name: /^entrega$/i })).toBeInTheDocument()
    })
  })

  describe('validacao do cupom', () => {
    it('aplica o desconto no total depois de o servidor confirmar', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await preencherAteRevisao()

      const totalCheio = screen.getByTestId('total').textContent ?? ''

      await userEvent.type(screen.getByLabelText(/cupom/i), 'PRE200')
      await userEvent.click(screen.getByRole('button', { name: /validar cupom/i }))

      expect(await screen.findByTestId('desconto')).toHaveTextContent('R$ 200,00')
      expect(screen.getByTestId('total')).not.toHaveTextContent(totalCheio)
      // O total ja inclui o desconto, entao a ressalva antiga ("antes do
      // cupom") viraria mentira. A que fica diz a verdade que sobra: a previa
      // nao reserva nada.
      expect(screen.getByTestId('total')).toHaveTextContent(/confirmado no pagamento/i)
    })

    it('mostra o motivo da recusa, com a mesma frase do checkout', async () => {
      vi.stubGlobal('fetch', criarFetchFalso({ cupom: CUPOM_EXPIRADO }))
      await preencherAteRevisao()

      await userEvent.type(screen.getByLabelText(/cupom/i), 'VELHO')
      await userEvent.click(screen.getByRole('button', { name: /validar cupom/i }))

      expect(await screen.findByTestId('resposta-cupom')).toHaveTextContent(/expirou/i)
      expect(screen.queryByTestId('desconto')).toBeNull()
    })

    /**
     * O DEFEITO MAIS CARO QUE ESTA TELA PODE TER: validar PRE200, ver
     * "-R$ 200,00", editar o campo para outro codigo e o desconto continuar na
     * tela — agora descrevendo um cupom que ninguem verificou. A pessoa
     * fecharia a compra achando que pagaria 800.
     */
    it('editar o codigo invalida a previa e devolve o total cheio', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await preencherAteRevisao()
      const totalCheio = screen.getByTestId('total').textContent ?? ''

      await userEvent.type(screen.getByLabelText(/cupom/i), 'PRE200')
      await userEvent.click(screen.getByRole('button', { name: /validar cupom/i }))
      expect(await screen.findByTestId('desconto')).toBeInTheDocument()

      await userEvent.type(screen.getByLabelText(/cupom/i), 'X')

      expect(screen.queryByTestId('desconto')).toBeNull()
      expect(screen.queryByTestId('resposta-cupom')).toBeNull()
      expect(screen.getByTestId('total')).toHaveTextContent(totalCheio)
    })

    // Apagar o campo inteiro tambem: sem codigo nao ha nem previa nem ressalva.
    it('limpar o campo tira a ressalva do total', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await preencherAteRevisao()

      await userEvent.type(screen.getByLabelText(/cupom/i), 'PRE200')
      expect(screen.getByTestId('total')).toHaveTextContent(/valide para ver o desconto/i)

      await userEvent.clear(screen.getByLabelText(/cupom/i))
      expect(screen.getByTestId('total')).not.toHaveTextContent(/valide|confirmado/i)
    })

    it('nao chama o servidor com codigo curto demais', async () => {
      const fetchMock = criarFetchFalso()
      vi.stubGlobal('fetch', fetchMock)
      await preencherAteRevisao()

      await userEvent.type(screen.getByLabelText(/cupom/i), 'PR')

      // 3 e o minimo do CHECK cupom_codigo_formato: pedir ao servidor uma
      // resposta que ele ja sabe ser "nao existe" so gasta a cota de quem esta
      // digitando.
      expect(screen.getByRole('button', { name: /validar cupom/i })).toBeDisabled()
      expect(chamadasDe(fetchMock, '/api/cupons/validar')).toHaveLength(0)
    })

    /**
     * ENTER NO CAMPO VALIDA — o reflexo de quem acabou de digitar um codigo.
     *
     * A metade "e nao envia o pedido" NAO e afirmada aqui de proposito: hoje o
     * passo 4 nao tem <form>, entao Enter nao submeteria nada de qualquer jeito,
     * e um `expect(pedidos).toHaveLength(0)` passaria mesmo com o
     * `preventDefault` removido — assercao que da a impressao de proteger e nao
     * protege. O `preventDefault` fica no componente como defesa para o dia em
     * que alguem envolver o passo num <form>; o que se pode provar hoje e que
     * Enter DISPARA a validacao, e e so isso que este teste afirma.
     */
    it('Enter no campo dispara a validacao', async () => {
      const fetchMock = criarFetchFalso()
      vi.stubGlobal('fetch', fetchMock)
      await preencherAteRevisao()

      await userEvent.type(screen.getByLabelText(/cupom/i), 'PRE200{Enter}')

      await waitFor(() => expect(chamadasDe(fetchMock, '/api/cupons/validar')).toHaveLength(1))
      expect(await screen.findByTestId('desconto')).toBeInTheDocument()
    })

    // O e-mail vai junto para que o servidor consiga conferir o limite POR
    // PESSOA. Sem ele a previa diria "válido" a quem a confirmacao vai recusar.
    it('DINHEIRO: manda codigo, kit, quantidade e e-mail — e nada de dinheiro', async () => {
      const fetchMock = criarFetchFalso()
      vi.stubGlobal('fetch', fetchMock)
      await preencherAteRevisao()

      await userEvent.type(screen.getByLabelText(/cupom/i), 'PRE200')
      await userEvent.click(screen.getByRole('button', { name: /validar cupom/i }))

      const corpo = corpoEnviadoPara(fetchMock, '/api/cupons/validar')
      // SEM E-MAIL: a rota e publica e nao deve responder sobre compras de
      // terceiros. A consequencia — a previa nao enxergar `limite_por_cliente` —
      // esta fixada em src/app/api/__tests__/cupons-validar-route.test.ts.
      expect(corpo).toEqual({
        codigo: 'PRE200',
        kitSlug: 'kit-milagran',
        quantidade: 1,
      })
      for (const chave of Object.keys(corpo)) {
        expect(chave).not.toMatch(PADRAO_DE_DINHEIRO)
      }
    })

    // Falha de rede nao pode virar tela muda nem desconto fantasma: a pessoa
    // precisa saber que a resposta nao chegou, e o total tem que ficar cheio.
    it('falha de conexao mostra recado e nao inventa desconto', async () => {
      // Chega ao passo 4 com a rede FUNCIONANDO — a cotacao de frete acontece
      // no caminho — e so entao a conexao cai. Derrubar tudo desde o inicio
      // testaria outra coisa: o passo 3 sem cotacao, que ja tem teste proprio.
      vi.stubGlobal('fetch', criarFetchFalso())
      await preencherAteRevisao()
      const totalCheio = screen.getByTestId('total').textContent ?? ''

      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))

      await userEvent.type(screen.getByLabelText(/cupom/i), 'PRE200')
      await userEvent.click(screen.getByRole('button', { name: /validar cupom/i }))

      expect(await screen.findByTestId('resposta-cupom')).toHaveTextContent(/conex/i)
      expect(screen.queryByTestId('desconto')).toBeNull()
      expect(screen.getByTestId('total')).toHaveTextContent(totalCheio)
    })


    /**
     * O DEFEITO QUE A REVISAO ACHOU, e o unico da leva que valia R$ 400 na tela.
     *
     * A previa era chaveada so pelo CODIGO, mas o desconto e funcao do
     * SUBTOTAL: um cupom percentual validado com tres kits continuava exibindo o
     * desconto dos tres depois de a compradora voltar ao passo 1 e baixar para
     * um. A tela anunciava um total que a confirmacao nao ia cobrar — e
     * `total_centavos` e congelado no INSERT, entao nao ha conserto depois.
     */
    it('mudar a quantidade depois de validar invalida a previa', async () => {
      vi.stubGlobal('fetch', criarFetchFalso())
      await preencherAteRevisao()

      await userEvent.type(screen.getByLabelText(/cupom/i), 'PRE200')
      await userEvent.click(screen.getByRole('button', { name: /validar cupom/i }))
      expect(await screen.findByTestId('desconto')).toBeInTheDocument()
      const totalComDesconto = screen.getByTestId('total').textContent ?? ''

      // Volta ao passo 1, muda a quantidade e retorna ao passo 4.
      await userEvent.click(screen.getByRole('button', { name: /voltar/i }))
      await userEvent.click(screen.getByRole('button', { name: /voltar/i }))
      await userEvent.click(screen.getByRole('button', { name: /voltar/i }))
      await userEvent.click(screen.getByRole('button', { name: /aumentar/i }))
      await userEvent.click(botaoContinuar())
      await userEvent.click(botaoContinuar())
      await escolherEnvio()
      await userEvent.click(await screen.findByRole('radio', { name: /PAC/ }))
      await userEvent.click(botaoContinuar())

      // O codigo continua no campo, mas a previa nao vale mais: ela respondia
      // sobre um carrinho que nao existe mais.
      expect(screen.getByLabelText(/cupom/i)).toHaveValue('PRE200')
      expect(screen.queryByTestId('desconto')).toBeNull()
      expect(screen.getByTestId('total')).not.toHaveTextContent(totalComDesconto)
      expect(screen.getByTestId('total')).toHaveTextContent(/valide para ver o desconto/i)
    })

    /**
     * CUPOM JA RECUSADO NAO PODE SEGUIR. Mandar mesmo assim derruba o pedido
     * INTEIRO (`cupom_recusado` em POST /api/pedidos), e nao so o desconto —
     * quem queria apenas comprar sem desconto perderia o clique e veria um erro
     * que nao explica o que fazer.
     */
    it('cupom recusado trava a confirmacao, e apagar o codigo destrava', async () => {
      vi.stubGlobal('fetch', criarFetchFalso({ cupom: CUPOM_EXPIRADO }))
      await preencherAteRevisao()

      await userEvent.type(screen.getByLabelText(/cupom/i), 'VELHO')
      await userEvent.click(screen.getByRole('button', { name: /validar cupom/i }))
      await screen.findByTestId('resposta-cupom')

      const irPagar = screen.getByRole('button', { name: /ir para o pagamento/i })
      expect(irPagar).toBeDisabled()
      // O impedimento diz o que fazer, e nao so que nao da.
      expect(screen.getByTestId('impedimento')).toHaveTextContent(/apague o código/i)

      await userEvent.clear(screen.getByLabelText(/cupom/i))
      expect(screen.getByRole('button', { name: /ir para o pagamento/i })).toBeEnabled()
    })

    /**
     * TOTAL ZERO NAO SEGUE. Cupom que cobre o subtotal inteiro mais retirada
     * (frete zero) fecha em R$ 0,00, e nao ha como cobrar isso — a rota recusa
     * com `pedido_sem_valor`. A tela precisa dizer antes, porque depois o cupom
     * ja foi consumido na tentativa.
     */
    it('total zerado pelo cupom trava a confirmacao com explicacao', async () => {
      const cupomTotal = resposta(200, {
        valido: true, codigo: 'TUDO', descontoCentavos: 100000,
      })
      vi.stubGlobal('fetch', criarFetchFalso({ cupom: cupomTotal }))

      render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
      await irAtePasso3()
      await escolherRetirada()
      await userEvent.click(botaoContinuar())

      await userEvent.type(screen.getByLabelText(/cupom/i), 'TUDO')
      await userEvent.click(screen.getByRole('button', { name: /validar cupom/i }))

      expect(await screen.findByTestId('impedimento')).toHaveTextContent(/R\$ 0,00/)
      expect(screen.getByRole('button', { name: /ir para o pagamento/i })).toBeDisabled()
    })

    /**
     * AS DUAS LINHAS DO RESUMO TEM QUE CONCORDAR. Um cupom fixo maior que o
     * subtotal e limitado ao subtotal por montarCarrinho; imprimir o valor bruto
     * da previa faria a linha do desconto anunciar mais do que o total abateu.
     */
    it('desconto maior que o subtotal aparece pelo valor efetivamente aplicado', async () => {
      const cupomGrande = resposta(200, {
        valido: true, codigo: 'GRANDE', descontoCentavos: 150000,
      })
      vi.stubGlobal('fetch', criarFetchFalso({ cupom: cupomGrande }))

      render(<CheckoutWizard kit={KIT} quantidadeInicial={1} lancado={false} />)
      await irAtePasso3()
      await escolherRetirada()
      await userEvent.click(botaoContinuar())

      await userEvent.type(screen.getByLabelText(/cupom/i), 'GRANDE')
      await userEvent.click(screen.getByRole('button', { name: /validar cupom/i }))

      // O kit custa R$ 1.000,00: o abatimento efetivo e ele, e nao os R$ 1.500.
      expect(await screen.findByTestId('desconto')).toHaveTextContent('R$ 1.000,00')
      expect(screen.getByTestId('desconto')).not.toHaveTextContent('1.500')
    })

    /**
     * O CUPOM CONTINUA INDO NO POST, validado ou nao. A previa nao substitui a
     * confirmacao: quem concede o desconto e `resgatarCupom`, sob trava de
     * linha, dentro da transacao do pedido. Se a tela parasse de mandar o codigo
     * por ja te-lo "validado", o pedido nasceria sem desconto nenhum.
     */
    it('o codigo validado continua sendo enviado na criacao do pedido', async () => {
      const fetchMock = criarFetchFalso()
      vi.stubGlobal('fetch', fetchMock)
      await preencherAteRevisao()

      await userEvent.type(screen.getByLabelText(/cupom/i), 'PRE200')
      await userEvent.click(screen.getByRole('button', { name: /validar cupom/i }))
      await screen.findByTestId('desconto')
      await userEvent.click(screen.getByRole('button', { name: /ir para o pagamento/i }))

      const corpo = corpoEnviadoPara(fetchMock, '/api/pedidos')
      expect(corpo.cupom).toBe('PRE200')
      // E nenhum valor de desconto viaja junto: quem calcula e o servidor.
      expect(JSON.stringify(corpo)).not.toContain('20000')
    })
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
