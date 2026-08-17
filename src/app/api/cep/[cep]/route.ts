import { buscarEnderecoPorCep } from '@/lib/cep'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/cep/[cep] — o preenchimento automatico do endereco no checkout (§13
 * do documento do cliente de 16/08/2026).
 *
 * O passo 3 do wizard (src/components/checkout-wizard.tsx) chama esta rota
 * assim que o comprador termina de digitar o CEP e usa a resposta para
 * preencher rua, bairro, cidade e UF.
 *
 * AUTOFILL E CONVENIENCIA, NUNCA BLOQUEIO — e esta e a regra que decide todo o
 * resto do arquivo. O comprador SEMPRE pode digitar os quatro campos a mao, e o
 * formulario nao depende de nenhuma resposta daqui para submeter. O ViaCEP e um
 * servico publico, gratuito e sem contrato de disponibilidade: se ele estiver
 * fora do ar no dia 25/08, isso nao pode impedir uma unica venda. Por isso todo
 * caminho que nao termina em endereco vira o MESMO 404 — CEP inexistente,
 * timeout, DNS, HTTP fora de 2xx, corpo que nao e JSON, CEP fora de formato — e
 * a tela trata 404 como "deixa os campos vazios e segue".
 *
 * Isso e o OPOSTO de src/app/api/frete/route.ts, e a diferenca e proposital:
 * la o que esta em jogo e dinheiro (valor errado vira prejuizo por pedido),
 * entao falha vira erro alto e o checkout para; aqui o que esta em jogo e
 * digitar tres campos. O raciocinio completo esta no cabecalho de
 * src/lib/cep.ts, que ja devolve `null` em vez de lancar por esse mesmo motivo —
 * este handler so traduz aquele `null` para HTTP.
 *
 * SEM RATE LIMIT, ao contrario de POST /api/frete. Esta rota nao escreve no
 * banco e nao gasta cota paga: o ViaCEP nao tem credencial nem plano, e a
 * consulta que ela faz qualquer pessoa faz direto, de graca, sem passar por
 * aqui — nao ha nada a ganhar usando a Milagran de proxy. Do outro lado, um
 * freio por IP atrapalharia uso legitimo no evento: dezenas de compradores atras
 * do mesmo WiFi, cada um corrigindo o CEP duas ou tres vezes, e o autofill
 * morreria para todos. Se um dia aparecer abuso de verdade, o freio entra aqui
 * com teto generoso — nunca com o teto do checkout.
 */

/**
 * O MESMO formato de POST /api/frete, de POST /api/pedidos e da coluna
 * `enderecos.cep` (CHECK endereco_cep_digitos): oito digitos, sem hifen. Aceitar
 * "01310-100" aqui e so aqui faria o autofill funcionar com um valor que o
 * proprio formulario considera invalido no submit.
 */
const CEP_DE_OITO_DIGITOS = /^\d{8}$/

/**
 * Resposta encontrada pode ser guardada; resposta NAO encontrada, jamais.
 *
 * A rua de um CEP nao muda no dia do lancamento, e cada acerto guardado por um
 * dia e uma consulta a menos num servico publico e gratuito que a Milagran usa
 * sem pagar nada — no evento, com muita gente digitando CEPs da mesma cidade, a
 * diferenca e real. Nao ha dado pessoal envolvido: e o diretorio postal, e o
 * proprio CEP ja esta na URL.
 *
 * O 404 leva `no-store` pelo motivo oposto, e ele e o que importa: um 404 daqui
 * pode significar "o ViaCEP nao respondeu agora" (ver o cabecalho acima). Se
 * essa resposta ficasse guardada, uma indisponibilidade de trinta segundos
 * viraria um dia inteiro de autofill morto para aquele CEP, com o servico ja de
 * volta ao ar. Cachear acerto e economia; cachear falha e transformar um problema
 * passageiro em permanente.
 */
const CACHE_DE_UM_DIA = { 'Cache-Control': 'public, max-age=86400' } as const
const SEM_CACHE = { 'Cache-Control': 'no-store' } as const

export async function GET(_req: Request, ctx: { params: Promise<{ cep: string }> }) {
  // Em Next 16 `params` e uma Promise: ler sem `await` devolve o objeto errado
  // (a propria Promise, cujo `.cep` e undefined) e a consulta sairia com
  // "undefined" no lugar do CEP. Mesma armadilha ja anotada em
  // src/app/api/admin/pedidos/[id]/route.ts.
  const { cep } = await ctx.params

  // CEP fora de formato responde o MESMO 404 de CEP inexistente, e nao um 422.
  // Sao a mesma coisa para quem chamou: nao ha endereco ali. Mesma decisao (e
  // mesmo motivo) do id malformado em src/app/api/admin/pedidos/[id]/route.ts.
  //
  // Aqui isso diverge de POST /api/frete, que devolve 422 `cep_invalido` para o
  // mesmo formato errado — e a divergencia e deliberada: la o CEP e um CAMPO que
  // a pessoa esta digitando e a tela precisa apontar para ele; aqui o CEP vem do
  // CAMINHO da URL, montado pelo proprio wizard, que so chama quando ja tem oito
  // digitos. Um 422 neste ponto nao ensinaria nada a ninguem — e este handler
  // nao e o validador do formulario.
  //
  // A checagem tambem evita uma chamada de rede inutil: `buscarEnderecoPorCep`
  // ja devolveria null para qualquer coisa fora de oito digitos, mas so depois
  // de montar a URL.
  if (!CEP_DE_OITO_DIGITOS.test(cep)) {
    return Response.json({ error: 'cep_nao_encontrado' }, { status: 404, headers: SEM_CACHE })
  }

  // SEM try/catch, e a ausencia e a garantia: `buscarEnderecoPorCep`
  // (src/lib/cep.ts) nunca lanca — timeout, rede, JSON quebrado e `{erro:true}`
  // ja viram `null` la dentro, num unico lugar. Um catch aqui so poderia
  // esconder um defeito futuro daquele modulo atras do mesmo 404.
  const endereco = await buscarEnderecoPorCep(cep)

  if (!endereco) {
    return Response.json({ error: 'cep_nao_encontrado' }, { status: 404, headers: SEM_CACHE })
  }

  // O objeto de `EnderecoDoCep` inteiro e cru — cep, rua, bairro, cidade,
  // estado —, sem envelope. Sao exatamente os cinco campos que o formulario
  // preenche, ja normalizados por src/lib/cep.ts (CEP so com digitos, UF em
  // maiusculas), e nao ha o que acrescentar: nenhum id, nenhum dado nosso.
  return Response.json(endereco, { headers: CACHE_DE_UM_DIA })
}

/**
 * Demais verbos: 405 com `Allow`, padrao da casa (src/app/api/pedidos/route.ts).
 * Consulta de CEP e leitura pura de um diretorio publico; nao ha nada a escrever
 * nesta URL, nem hoje nem depois.
 */
function metodoNaoPermitido() {
  return Response.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET' },
  })
}

export const POST = metodoNaoPermitido
export const PUT = metodoNaoPermitido
export const PATCH = metodoNaoPermitido
export const DELETE = metodoNaoPermitido
