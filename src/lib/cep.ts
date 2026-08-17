/**
 * Consulta de CEP no ViaCEP, para o autofill do endereco no checkout (§13).
 *
 * POR QUE ESTA FUNCAO NUNCA LANCA E NUNCA BLOQUEIA
 * ------------------------------------------------
 * Autofill e conveniencia: o comprador sempre pode digitar rua, bairro e
 * cidade a mao (src/components/checkout-wizard.tsx). O ViaCEP e um servico
 * publico, gratuito e sem contrato de disponibilidade — se ele estiver fora do
 * ar no dia 25/08, isso NAO pode impedir ninguem de fechar a compra. Por isso
 * todo caminho de falha (CEP inexistente, timeout, rede, HTTP fora de 2xx,
 * corpo que nao e JSON) devolve `null`, e a tela apenas deixa os campos
 * vazios para o comprador preencher.
 *
 * Isso e o OPOSTO de src/lib/frete.ts, e a diferenca e proposital: la o que
 * esta em jogo e dinheiro (um valor errado vira prejuizo por pedido), entao
 * falha vira erro alto; aqui o que esta em jogo e digitar tres campos.
 *
 * Sem credencial: o ViaCEP nao tem token, entao nao ha variavel de ambiente
 * nenhuma para ler — este modulo funciona igual em build, em teste e em
 * producao.
 */

const BASE = 'https://viacep.com.br'

/**
 * Bem menor que o timeout de src/lib/frete.ts. O comprador esta digitando o
 * endereco e o preenchimento automatico ou acontece rapido ou nao serve para
 * nada: esperar 12s por uma conveniencia so faz a tela parecer travada.
 */
const TIMEOUT_MS = 4_000

export type EnderecoDoCep = {
  cep: string
  rua: string
  bairro: string
  cidade: string
  estado: string
}

/**
 * Busca o endereco de um CEP. Devolve null quando o CEP nao existe ou quando
 * a consulta falha por qualquer motivo — quem chama nunca precisa de
 * try/catch e nunca precisa distinguir os dois casos.
 *
 * O `cep` devolvido vem SOMENTE COM DIGITOS, mesmo que o provedor responda
 * "01310-100". Isso e contrato com o resto do sistema, nao estilo: o campo do
 * wizard valida `/^\d{8}$/` (src/components/checkout-wizard.tsx) e a coluna
 * `enderecos.cep` tem a constraint `endereco_cep_digitos`, que rejeita o
 * hifen no banco (ver src/repositories/__tests__/clientes.test.ts). Devolver o
 * CEP formatado faria o autofill preencher um campo que o proprio formulario
 * considera invalido.
 */
export async function buscarEnderecoPorCep(cep: string): Promise<EnderecoDoCep | null> {
  const digitos = cep.replace(/\D/g, '')
  // Fora do formato nao vale nem a chamada: o ViaCEP responde 400 e a resposta
  // seria descartada do mesmo jeito.
  if (digitos.length !== 8) return null

  let resposta: Response
  try {
    resposta = await fetch(`${BASE}/ws/${digitos}/json/`, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // Timeout, DNS, rede. Silencioso de proposito: ver o cabecalho do arquivo.
    return null
  }

  if (!resposta.ok) return null

  let dados: unknown
  try {
    dados = (await resposta.json()) as unknown
  } catch {
    return null
  }
  if (typeof dados !== 'object' || dados === null || Array.isArray(dados)) return null

  const d = dados as Record<string, unknown>
  // CEP inexistente vem com HTTP 200 e `{ "erro": true }`. O ViaCEP ja
  // respondeu com a string "true" nesse campo em versoes anteriores da API,
  // entao os dois formatos sao aceitos — confiar so no booleano faria um CEP
  // inexistente virar um endereco com todos os campos vazios.
  if (d.erro === true || d.erro === 'true') return null

  const cepDevolvido = texto(d.cep).replace(/\D/g, '')
  if (cepDevolvido.length !== 8) return null

  return {
    cep: cepDevolvido,
    rua: texto(d.logradouro),
    bairro: texto(d.bairro),
    cidade: texto(d.localidade),
    // `enderecos.estado` e varchar(2) maiusculo; o ViaCEP ja devolve "SP",
    // mas normalizar aqui evita que um dia a UF chegue minuscula e o INSERT
    // falhe no banco em vez de no autofill.
    estado: texto(d.uf).toUpperCase().slice(0, 2),
  }
}

function texto(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
