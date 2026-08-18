import { centavos, type Centavos } from '@/lib/money'

/**
 * Cliente da API de frete do Clube Envios (§13 do plano de 16/08/2026).
 *
 * Molde: src/lib/mercadopago.ts. Mesmas regras — constantes de base e timeout
 * no topo, AbortSignal.timeout, classe de erro propria com status 0 para
 * "nao houve resposta", variaveis de ambiente lidas DENTRO da funcao e uma
 * unica conversao de centavos para decimal no arquivo inteiro.
 *
 * O CONTRATO REAL, CONFIRMADO EM 17/08/2026
 * ------------------------------------------------------------------
 * A documentacao publica descreve o CORPO DA REQUISICAO de POST /cotacao e o
 * envelope de ERRO (`{ result: false, messages }`), mas NAO o corpo de
 * sucesso. Ele foi obtido de uma cotacao real de producao e esta congelado em
 * RESPOSTA_REAL_DO_CLUBE_ENVIOS (src/lib/__tests__/frete.test.ts):
 *
 *   { "id_cotacao": "697040",
 *     "valores": [ { "id_servico": "2", "servico": "PAC",
 *                    "transportadora": "CLUBE ENVIOS - Correios",
 *                    "id_transportadora": "1", "seguro_incluso": "N",
 *                    "prazo": "6", "valor_frete": "29,39" }, ... ] }
 *
 * TRES FATOS QUE ESSA CHAMADA ESTABELECEU, e que valem mais que qualquer
 * suposicao anterior:
 *   1. O envelope e `valores`. Ele NAO estava em CONTAINERS_SERVICOS, entao
 *      toda cotacao caia em CotacaoIlegivelError e o checkout online travava
 *      no passo 3.
 *   2. Tudo chega como STRING, inclusive numeros: `id_servico: "2"`,
 *      `prazo: "6"`.
 *   3. O preco vem em REAIS COM VIRGULA decimal ("29,39"), nao em centavos
 *      inteiros nem com ponto. `decimalDe` trata a virgula e `centavos()`
 *      multiplica por 100 — a leitura estava certa, agora por evidencia.
 *
 * A leitura por lista de APELIDOS continua, e agora como REDE e nao como
 * aposta: se o provedor renomear um campo, os apelidos absorvem a mudanca em
 * vez de derrubar a venda. Este arquivo segue sendo o UNICO lugar do sistema
 * que muda se o contrato mudar — rotas, componentes e repositorios so conhecem
 * `OpcaoDeFrete`, ja em `Centavos` e dias inteiros.
 *
 * A REGRA QUE NAO PODE SER RELAXADA: quando um servico chega sem preco ou sem
 * prazo reconheciveis, este modulo lanca `CotacaoIlegivelError` com as chaves
 * que realmente chegaram — nunca devolve zero, nunca "assume frete gratis" e
 * nunca descarta o servico em silencio. Um zero silencioso aqui vira "Frete:
 * R$ 0,00" na tela do comprador (src/components/linha-frete.tsx existe
 * exatamente para impedir isso), vira `pedidos.frete_centavos = 0` — coluna
 * CONGELADA pelo trigger de imutabilidade, ou seja, sem UPDATE possivel
 * depois — e vira prejuizo da Milagran em cada pedido enviado. Falhar alto e
 * barato: a rota devolve 503 `frete_indisponivel` e o comprador tenta de novo.
 *
 * UNIDADES — RESOLVIDO POR EVIDENCIA, nao mais por suposicao. Enviamos
 * `valor_declarado` em reais decimais e o provedor devolve `valor_frete` na
 * MESMA unidade, com virgula ("29,39" = R$ 29,39 = 2939 centavos).
 * `precoEmCentavos` usa `centavos()`, que multiplica por 100, e esta correto.
 * NAO trocar por `deInteiro()`: a troca nao e erro de compilacao (ver
 * src/lib/money.ts) e produziria um frete 100x menor sem nenhum aviso. O teste
 * "DINHEIRO: '29,39' vira 2939 centavos" existe para travar exatamente isso.
 */

/**
 * Producao. Homologacao e https://apishmg.clubeenvios.com.br, apontada por
 * CLUBE_ENVIOS_BASE_URL. Ao contrario de `BASE` em src/lib/mercadopago.ts,
 * esta constante e so o PADRAO: a base efetiva depende de uma variavel de
 * ambiente e por isso e resolvida dentro da funcao, nunca no import.
 */
const BASE_PADRAO = 'https://apis.clubeenvios.com.br'

/**
 * Menor que os 15s de src/lib/mercadopago.ts de proposito. Cotacao e
 * repetivel e acontece com o comprador parado na tela do checkout esperando o
 * valor; cobranca nao e repetivel e vale a pena esperar mais. Timeout aqui
 * vira 503 `frete_indisponivel`, nao pedido perdido.
 */
const TIMEOUT_MS = 12_000

/**
 * Teto de sanidade do prazo. Nenhum servico de entrega nacional passa disso, e
 * o palpite de apelidos torna possivel ler por engano um campo que nao e
 * prazo em dias (uma data "2026-08-25" viraria "2026 dias"). Acima do teto a
 * leitura e tratada como ilegivel — erro visivel em vez de prazo absurdo
 * gravado em pedidos.prazo_dias_estimado.
 */
const PRAZO_MAXIMO_DIAS = 180

/**
 * 'valores' PRIMEIRO porque e o container REAL, confirmado na primeira cotacao
 * de producao em 17/08/2026: a resposta e `{ id_cotacao, valores: [...] }`.
 *
 * Ate aqui a lista era um palpite declarado — o cabecalho deste arquivo dizia
 * que a primeira chamada real confirmaria ou corrigiria os apelidos, e foi o
 * que aconteceu: sem 'valores' a cotacao inteira caia em CotacaoIlegivelError
 * e o checkout online nunca passava do passo 3. Os outros quatro ficam como
 * rede para uma mudanca de envelope do provedor.
 */
const CONTAINERS_SERVICOS = ['valores', 'cotacao', 'servicos', 'dados', 'result'] as const

const APELIDOS_ID_COTACAO = ['id_cotacao', 'idCotacao', 'cotacao_id'] as const
const APELIDOS_ID_SERVICO = ['id_servico', 'idServico', 'servico_id'] as const
const APELIDOS_ID_TRANSPORTADORA = [
  'id_transportadora', 'idTransportadora', 'transportadora_id',
] as const
const APELIDOS_TRANSPORTADORA = [
  'transportadora', 'nome_transportadora', 'transportadora_nome', 'nome',
] as const
/**
 * NOME DO SERVICO — "PAC", "SEDEX", "EXPRESSO". E o que distingue duas opcoes
 * da MESMA transportadora, e sem ele a tela repete rotulo.
 *
 * A cotacao real de 17/08/2026 devolveu cinco opcoes e DUAS duplas com o mesmo
 * campo `transportadora`: "CLUBE ENVIOS - Correios" para PAC (R$ 29,39, 6
 * dias) e para SEDEX (R$ 64,91, 2 dias), e "CLUBE ENVIOS - Azul" para ECOMM
 * CORP e EXPRESSO. O comprador via duas linhas de nome identico e precisava
 * deduzir a diferenca pelo preco.
 */
const APELIDOS_SERVICO = ['servico', 'nome_servico', 'servico_nome', 'descricao'] as const
const APELIDOS_VALOR = [
  'valor', 'valor_frete', 'vlrFrete', 'vlr_frete', 'preco', 'preco_frete', 'valorFrete',
] as const
const APELIDOS_PRAZO = [
  'prazo', 'prazo_entrega', 'prazo_dias', 'prazoEntrega', 'prazo_entrega_dias', 'dias',
] as const

/**
 * Falha do provedor: HTTP fora de 2xx OU o envelope documentado
 * `{ result: false, messages }`, que pode chegar com HTTP 200.
 * `status` 0 significa "nao houve resposta" (timeout, DNS, rede) — o chamador
 * precisa distinguir isso de uma recusa para decidir se pode tentar de novo.
 */
export class ClubeEnviosError extends Error {
  constructor(
    readonly status: number,
    readonly corpo: string,
  ) {
    super(`clube_envios_${status}: ${corpo}`)
    this.name = 'ClubeEnviosError'
  }
}

/**
 * A resposta chegou, foi aceita pelo provedor, e mesmo assim nao da para
 * extrair preco ou prazo dela. `chavesRecebidas` traz as chaves que de fato
 * vieram: e com essa lista que se corrige a lista de apelidos deste arquivo
 * depois da primeira chamada em homologacao. E a alternativa a inventar zero.
 */
export class CotacaoIlegivelError extends Error {
  constructor(readonly chavesRecebidas: string[]) {
    super(
      'Resposta de cotacao do Clube Envios sem preco ou prazo reconheciveis. ' +
      `Chaves recebidas: ${chavesRecebidas.length > 0 ? chavesRecebidas.join(', ') : '(nenhuma)'}. ` +
      'Ajustar a lista de apelidos em src/lib/frete.ts.',
    )
    this.name = 'CotacaoIlegivelError'
  }
}

/** Falta credencial, cliente_id ou CEP de origem: nao da nem para tentar cotar. */
export class FreteNaoConfiguradoError extends Error {
  constructor(mensagem = 'Cotacao de frete nao configurada') {
    super(mensagem)
    this.name = 'FreteNaoConfiguradoError'
  }
}

export type OpcaoDeFrete = {
  idServico: number
  idTransportadora: number | null
  transportadora: string
  /**
   * "PAC", "SEDEX", "EXPRESSO". Vazio quando o provedor nao informa.
   *
   * COSMETICO como `transportadora`, e pela mesma razao nao derruba a cotacao
   * — mas e ele que separa duas opcoes da mesma transportadora na tela. Quem
   * decide como exibir e src/components/checkout-wizard.tsx; aqui so chega o
   * dado cru.
   */
  servico: string
  valor: Centavos
  prazoDias: number
}

export type CotacaoDeFrete = {
  idCotacao: number | null
  opcoes: OpcaoDeFrete[]
}

export type VolumeDaCotacao = {
  alturaCm: number
  larguraCm: number
  comprimentoCm: number
  pesoGramas: number
  quantidade: number
}

type ConfiguracaoDoClube = {
  base: string
  token: string
  clienteId: number
  cepOrigem: string
}

/**
 * Unico ponto de leitura das variaveis do Clube Envios, e sempre em tempo de
 * execucao. Ler no import quebraria `next build` em qualquer ambiente sem as
 * variaveis (o build nao tem segredo nenhum) — padrao ja documentado em
 * src/lib/mercadopago.ts. Nenhum valor lido e ecoado na mensagem de erro.
 */
function configuracao(): ConfiguracaoDoClube {
  const token = process.env.CLUBE_ENVIOS_TOKEN ?? ''
  if (!token) {
    throw new FreteNaoConfiguradoError('CLUBE_ENVIOS_TOKEN nao configurada')
  }

  const clienteIdCru = process.env.CLUBE_ENVIOS_CLIENTE_ID ?? ''
  const clienteId = Number(clienteIdCru)
  if (!clienteIdCru || !Number.isInteger(clienteId) || clienteId <= 0) {
    throw new FreteNaoConfiguradoError(
      'CLUBE_ENVIOS_CLIENTE_ID ausente ou nao e um inteiro positivo',
    )
  }

  // CEP de origem e da expedicao, nao do comprador: sem ele o provedor nao
  // tem de onde calcular distancia. Erro legivel aqui, nunca frete zero.
  const cepOrigem = somenteDigitos(process.env.CEP_ORIGEM_EXPEDICAO ?? '')
  if (cepOrigem.length !== 8) {
    throw new FreteNaoConfiguradoError(
      'CEP_ORIGEM_EXPEDICAO ausente ou fora do formato de 8 digitos',
    )
  }

  const base = (process.env.CLUBE_ENVIOS_BASE_URL ?? BASE_PADRAO).replace(/\/$/, '')

  return { base, token, clienteId, cepOrigem }
}

/**
 * Cota o frete para um destino.
 *
 * Os nomes dos campos do corpo sao os EXATOS da documentacao do Clube Envios
 * e estao travados por teste (src/lib/__tests__/frete.test.ts): renomear
 * qualquer um deles quebra a cotacao em producao sem erro de compilacao.
 *
 * `peso` vai em GRAMAS e altura/largura/comprimento em CENTIMETROS — as
 * mesmas unidades das colunas de `kits` (migrations/1755300600000_kit_dimensoes.sql).
 * Nenhuma conversao de unidade acontece no caminho, de proposito: converter
 * escondido e como um valor de dimensao se perde.
 */
export async function cotarFrete(e: {
  cepDestino: string
  valorDeclarado: Centavos
  volumes: VolumeDaCotacao[]
}): Promise<CotacaoDeFrete> {
  const cfg = configuracao()

  if (e.volumes.length === 0) {
    throw new Error('Cotacao de frete sem volumes: nao ha o que enviar')
  }
  for (const v of e.volumes) {
    // Peso ou dimensao zerada NAO vira erro no provedor: vira cotacao barata
    // demais, que so aparece como prejuizo no dia da postagem. As colunas de
    // `kits` ja tem CHECK de positividade; esta e a segunda barreira, do lado
    // da aplicacao, para o caso de o valor vir de outro lugar amanha.
    const medidas = [v.alturaCm, v.larguraCm, v.comprimentoCm, v.pesoGramas, v.quantidade]
    if (medidas.some((m) => !Number.isInteger(m) || m <= 0)) {
      throw new Error(
        `Volume invalido na cotacao (medidas precisam ser inteiros positivos): ${JSON.stringify(v)}`,
      )
    }
  }

  const corpo = {
    cliente_id: cfg.clienteId,
    cep_origem: cfg.cepOrigem,
    // O comprador digita o CEP; a validacao de formato e da rota
    // (POST /api/frete devolve 422 `cep_invalido`). Aqui so normalizamos para
    // digitos, que e o formato do exemplo da documentacao.
    cep_destino: somenteDigitos(e.cepDestino),
    // 'N': o seguro dos Correios encarece a etiqueta e o valor declarado ja
    // segue no corpo. Virar para 'S' muda o preco de TODA cotacao da loja.
    seguro_correios: 'N',
    // UNICA conversao centavos -> decimal deste arquivo, no molde de
    // `transaction_amount` em src/lib/mercadopago.ts. Toda a aplicacao trabalha
    // em `Centavos` inteiros; a fronteira com o provedor e o unico lugar onde
    // dinheiro vira ponto flutuante, e ela cabe em uma linha so.
    valor_declarado: Number((e.valorDeclarado / 100).toFixed(2)),
    volumes: e.volumes.map((v) => ({
      altura: v.alturaCm,
      largura: v.larguraCm,
      comprimento: v.comprimentoCm,
      peso: v.pesoGramas,
      quantidade_volumes: v.quantidade,
    })),
  }

  return normalizarCotacao(await chamar(cfg, '/cotacao', corpo))
}

/**
 * Opcao mais barata da cotacao, ou null quando nao ha nenhuma.
 *
 * Empate mantem a PRIMEIRA opcao devolvida pelo provedor: o resultado precisa
 * ser deterministico porque `pedidos.frete_centavos` e congelado no INSERT e
 * nao pode ser corrigido depois.
 *
 * Lista vazia devolve null, e quem chama tem que tratar isso como "sem frete
 * disponivel para este CEP" — jamais como frete zero.
 */
export function opcaoMaisBarata(c: CotacaoDeFrete): OpcaoDeFrete | null {
  return c.opcoes.reduce<OpcaoDeFrete | null>(
    (melhor, o) => (melhor === null || o.valor < melhor.valor ? o : melhor),
    null,
  )
}

async function chamar(
  cfg: ConfiguracaoDoClube,
  caminho: string,
  corpo: unknown,
): Promise<unknown> {
  let resposta: Response
  try {
    resposta = await fetch(`${cfg.base}${caminho}`, {
      method: 'POST',
      headers: {
        // Token CRU, sem 'Bearer'. A documentacao do Clube Envios manda
        // exatamente assim; acrescentar o prefixo devolve 401 em toda
        // cotacao — e o sintoma seria "frete indisponivel", nao "credencial
        // errada", entao vale a pena estar escrito aqui.
        Authorization: cfg.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (causa) {
    // Timeout e falha de DNS/rede chegam aqui. Status 0 sinaliza "nao houve
    // resposta", que e retentavel — diferente de uma recusa do provedor.
    throw new ClubeEnviosError(0, causa instanceof Error ? causa.message : 'falha de rede')
  }

  const texto = await resposta.text()
  let dados: unknown = null
  try {
    dados = texto ? (JSON.parse(texto) as unknown) : null
  } catch {
    throw new ClubeEnviosError(resposta.status, 'corpo nao e JSON')
  }

  // O envelope de erro documentado e `{ result: false, messages }` e nao ha
  // garantia de que ele venha acompanhado de HTTP fora de 2xx — por isso a
  // checagem vem ANTES de `resposta.ok`. Tratar um `result:false` com HTTP 200
  // como sucesso levaria a normalizacao a nao achar servico nenhum e reportar
  // "ilegivel" no lugar da mensagem real do provedor.
  if (ehObjeto(dados) && dados.result === false) {
    throw new ClubeEnviosError(resposta.status, mensagemDoProvedor(dados.messages))
  }

  if (!resposta.ok) {
    // So `messages` entra na excecao quando existe. O corpo cru so e usado na
    // falta dele, e truncado: uma resposta de erro pode ecoar o payload
    // enviado, que carrega o CEP do comprador, e isso acabaria no log inteiro
    // do servidor.
    const detalhe = ehObjeto(dados) && dados.messages !== undefined
      ? mensagemDoProvedor(dados.messages)
      : recortar(texto)
    throw new ClubeEnviosError(resposta.status, detalhe)
  }

  if (dados === null) {
    throw new ClubeEnviosError(resposta.status, 'resposta vazia')
  }

  return dados
}

function normalizarCotacao(dados: unknown): CotacaoDeFrete {
  const achado = localizarServicos(dados)
  if (achado === null) {
    // Nem lista na raiz, nem em nenhum container conhecido: nao ha como saber
    // o que veio. As chaves da raiz sao o que o operador precisa para corrigir
    // CONTAINERS_SERVICOS.
    throw new CotacaoIlegivelError(chavesDe(dados))
  }

  const idCotacao = inteiroDe(
    primeiroApelido(ehObjeto(dados) ? dados : null, APELIDOS_ID_COTACAO)
    ?? primeiroApelido(achado.escopo, APELIDOS_ID_COTACAO),
  )

  return {
    // id_cotacao e rastro de suporte, nao dinheiro: nao achar so vira null.
    idCotacao,
    opcoes: achado.lista.map(normalizarServico),
  }
}

/**
 * Procura a lista de servicos nos formatos plausiveis: array na raiz, array em
 * um dos containers conhecidos, ou array um nivel abaixo de um deles
 * (`{ cotacao: { id_cotacao, servicos: [...] } }` e tao provavel quanto
 * `{ servicos: [...] }`). `escopo` e o objeto que contem a lista — e nele que
 * `id_cotacao` costuma morar quando nao esta na raiz.
 */
function localizarServicos(
  dados: unknown,
): { lista: unknown[]; escopo: Record<string, unknown> | null } | null {
  if (Array.isArray(dados)) return { lista: dados, escopo: null }
  if (!ehObjeto(dados)) return null

  for (const chave of CONTAINERS_SERVICOS) {
    const valor = dados[chave]
    if (Array.isArray(valor)) return { lista: valor, escopo: dados }
    if (ehObjeto(valor)) {
      for (const interna of CONTAINERS_SERVICOS) {
        const lista = valor[interna]
        if (Array.isArray(lista)) return { lista, escopo: valor }
      }
    }
  }

  return null
}

function normalizarServico(item: unknown): OpcaoDeFrete {
  if (!ehObjeto(item)) throw new CotacaoIlegivelError(chavesDe(item))

  const idServico = inteiroDe(primeiroApelido(item, APELIDOS_ID_SERVICO))
  const valor = precoEmCentavos(primeiroApelido(item, APELIDOS_VALOR))
  const prazoDias = prazoEmDias(primeiroApelido(item, APELIDOS_PRAZO))

  // Os tres sao obrigatorios e por motivos diferentes. Sem preco ou prazo nao
  // ha o que mostrar nem o que gravar. Sem id_servico a opcao existe mas e
  // inutilizavel: POST /api/pedidos escolhe a opcao pelo `idServico` e
  // recota no servidor, entao uma opcao sem id nao pode virar pedido.
  // Nos tres casos o certo e falhar alto, nunca devolver a opcao pela metade.
  if (idServico === null || valor === null || prazoDias === null) {
    throw new CotacaoIlegivelError(Object.keys(item))
  }

  return {
    idServico,
    idTransportadora: inteiroDe(primeiroApelido(item, APELIDOS_ID_TRANSPORTADORA)),
    // Nome da transportadora e cosmetico: some da tela, nao some do bolso de
    // ninguem. Diferente de preco e prazo, nao derruba a cotacao.
    transportadora: textoDe(primeiroApelido(item, APELIDOS_TRANSPORTADORA)),
    servico: textoDe(primeiroApelido(item, APELIDOS_SERVICO)),
    valor,
    prazoDias,
  }
}

/**
 * Preco do servico, assumido em REAIS DECIMAIS (mesma unidade de
 * `valor_declarado`, ver o cabecalho do arquivo), convertido para `Centavos`.
 *
 * `centavos()` MULTIPLICA por 100; `deInteiro()` so atesta um inteiro que ja
 * esta em centavos. Este e o unico lugar do arquivo onde essa escolha e feita
 * e trocar uma pela outra nao quebra a compilacao — ver src/lib/money.ts.
 *
 * Zero e tratado como ilegivel, nao como valor: cotacao de transportadora nao
 * devolve frete gratis, entao um zero aqui e quase certamente um campo que
 * lemos errado. Se a homologacao mostrar um servico promocional legitimamente
 * zerado, e aqui que a regra muda — e a mudanca tem que ser consciente,
 * porque zero e exatamente o valor que este modulo existe para nao inventar.
 */
function precoEmCentavos(v: unknown): Centavos | null {
  const reais = decimalDe(v)
  if (reais === null || reais <= 0) return null
  // Tabela de transportadora as vezes traz uma terceira casa. Arredondar para
  // o centavo mais proximo altera menos de um centavo — enquanto deixar
  // `centavos()` lancar por "mais de duas casas" viraria um Error generico
  // atravessando a fronteira e um 500 no lugar de um 503 legivel.
  return centavos(Number(reais.toFixed(2)))
}

/**
 * Prazo em dias inteiros. Aceita numero ou string numerica; quando a string
 * tem texto junto ("5 a 7 dias uteis"), fica com o MAIOR numero encontrado —
 * prometer o prazo curto de uma faixa gera reclamacao de atraso que nao
 * existe. Fracao arredonda para cima pelo mesmo motivo.
 */
function prazoEmDias(v: unknown): number | null {
  let bruto = decimalDe(v)
  if (bruto === null && typeof v === 'string') {
    const numeros = v.match(/\d+(?:[.,]\d+)?/g)
    if (numeros !== null) {
      bruto = numeros.reduce<number>((maior, n) => Math.max(maior, Number(n.replace(',', '.'))), 0)
    }
  }
  if (bruto === null || !Number.isFinite(bruto)) return null

  const dias = Math.ceil(bruto)
  if (dias <= 0 || dias > PRAZO_MAXIMO_DIAS) return null
  return dias
}

/**
 * Numero a partir de number ou string. Aceita o formato JSON ("23.45") e o
 * formato brasileiro ("23,45", "1.234,56") — a API e nacional e o corpo de
 * sucesso e desconhecido, entao os dois sao plausiveis. Quando existe virgula,
 * ela e o separador decimal e o ponto so pode ser separador de milhar.
 *
 * Qualquer outra coisa ("R$ 23,45", null, objeto) devolve null e vira
 * CotacaoIlegivelError la em cima. Adivinhar mais formatos aqui seria trocar
 * "nao entendi" por "entendi errado", que e o modo caro de falhar.
 */
function decimalDe(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null

  const t = v.trim()
  if (t === '') return null
  const normalizado = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t
  if (!/^-?\d+(\.\d+)?$/.test(normalizado)) return null

  const n = Number(normalizado)
  return Number.isFinite(n) ? n : null
}

function inteiroDe(v: unknown): number | null {
  const n = decimalDe(v)
  return n !== null && Number.isInteger(n) ? n : null
}

function textoDe(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function primeiroApelido(
  o: Record<string, unknown> | null,
  apelidos: readonly string[],
): unknown {
  if (o === null) return undefined
  for (const apelido of apelidos) {
    const v = o[apelido]
    // null e '' contam como ausencia: um campo presente e vazio nao e valor.
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** O que dizer ao operador sobre o que chegou, sem despejar o corpo inteiro. */
function chavesDe(v: unknown): string[] {
  if (Array.isArray(v)) return [`array[${v.length}]`]
  if (ehObjeto(v)) return Object.keys(v)
  return [typeof v]
}

function mensagemDoProvedor(messages: unknown): string {
  if (typeof messages === 'string') return recortar(messages)
  if (messages === undefined || messages === null) return 'erro sem mensagem'
  try {
    return recortar(JSON.stringify(messages))
  } catch {
    return 'erro sem mensagem legivel'
  }
}

function recortar(texto: string): string {
  return texto.length > 300 ? `${texto.slice(0, 300)}...` : texto
}

function somenteDigitos(v: string): string {
  return v.replace(/\D/g, '')
}
