import { avisoDeEscassez } from '@/lib/escassez'
import { saldoDoEstoque } from '@/repositories/estoque'
import { buscarKitAtivoPorSlug, listarKitsAtivos } from '@/repositories/produtos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/estoque — o GATILHO PUBLICO DE ESCASSEZ da home (§5 e §11 do
 * documento do cliente de 16/08/2026).
 *
 * Responde quantos kits ainda ha para levar na hora no evento de 25/08, com a
 * frase pronta de src/lib/escassez.ts, e diz que o canal online nao tem teto.
 * E a unica rota publica do sistema que fala de estoque.
 *
 * ROTA DE POLLING, e isso muda o desenho inteiro. src/components/contador-estoque.tsx
 * consulta esta URL a cada 15 segundos, de TODOS os navegadores abertos na home
 * durante o evento — e a resposta e a mesma para todo mundo. Dai as tres
 * decisoes abaixo, que existem por causa disso e nao por estilo:
 *
 *   1. `Cache-Control: no-store`, sempre. Um contador de escassez guardado por
 *      proxy MENTE sobre o numero de kits: a home continuaria anunciando "restam
 *      8" depois de os oito terem saido da caixa, e a loja prometeria unidade
 *      que nao existe para quem esta na fila. Um contador errado e pior do que
 *      contador nenhum, entao a resposta nao pode ser reaproveitada por
 *      ninguem — nem no navegador, nem em cache intermediario, nem pelo cache
 *      de rota do Next (dai tambem o `force-dynamic` acima).
 *   2. CONSULTA ENXUTA. Uma leitura do kit e duas leituras de saldo, as tres por
 *      indice (`kits.slug`, `estoque_kit_canal_unico`, `estoque_movimentos_estoque`)
 *      e nenhuma delas dentro de transacao — `saldoDoEstoque`
 *      (src/repositories/estoque.ts) documenta por que uma leitura sozinha nao
 *      precisa de BEGIN/COMMIT. As duas de saldo vao em paralelo porque nao
 *      dependem uma da outra; o pool tem 5 conexoes (src/lib/db.ts) e cada
 *      requisicao que segura conexao a mais no dia do evento tira lugar de um
 *      checkout.
 *   3. SEM RATE LIMIT, de proposito. Polling legitimo de 15s sao 40 requisicoes
 *      por janela de 10 minutos, quatro vezes o teto do checkout
 *      (MAX_PEDIDOS_POR_JANELA em src/lib/rate-limit.ts) — e no evento dezenas
 *      de aparelhos ficam atras do MESMO IP (WiFi do local, CGNAT da operadora).
 *      Um freio por IP aqui derrubaria o contador da home de todo mundo antes de
 *      atrapalhar qualquer abuso. Esta rota so LE, nao gasta cota de provedor
 *      nenhum (ao contrario de POST /api/frete) e nao escreve uma linha sequer.
 *
 * SEM AUTENTICACAO, tambem de proposito: e o gatilho da vitrine, e a vitrine e
 * publica. O que sai daqui e exatamente o que a home ja imprime na tela — dois
 * numeros e uma frase. Ver o bloco de resposta para o que NAO sai.
 */

/** Ver o item 1 do bloco acima: a razao de existir desta rota nao sobrevive a um cache. */
const SEM_CACHE = { 'Cache-Control': 'no-store' } as const

/**
 * O saldo publicado NUNCA e negativo, mesmo quando o saldo real e.
 *
 * `disponivel` pode ficar abaixo de zero por um `ajuste` de inventario maior que
 * o saldo (src/repositories/estoque.ts, doc comment de `ajustarEstoque`, explica
 * por que essa correcao nao e recusada). Esse numero e informacao valiosa — para
 * o PAINEL, onde a divergencia entre a conferencia fisica e a contabilidade
 * precisa aparecer, e onde ele vai cru por GET /api/admin/estoque. Na HOME ele
 * so pode virar "-3 kits disponiveis", que nao e verdade nenhuma sobre a caixa
 * do evento: abaixo de zero e zero significam a mesma coisa para quem quer
 * comprar (nao ha kit), e e isso que a tela mostra.
 *
 * O clamp fica AQUI e nao em src/lib/escassez.ts porque la ele seria mentira
 * para o painel tambem; aqui ele e a traducao de "quantos posso prometer".
 */
function saldoPublicavel(disponivel: number): number {
  return Math.max(0, disponivel)
}

export async function GET(req: Request) {
  // `?kit=<slug>`; ausente ou vazio significa "o kit do lancamento", que e o
  // PRIMEIRO ATIVO do catalogo. A ordem de listarKitsAtivos
  // (src/repositories/produtos.ts) e deterministica de proposito — ordem, depois
  // slug —, entao "o primeiro" e sempre o mesmo kit entre duas consultas, e nao
  // o que o Postgres devolver primeiro. A home nao precisa saber o slug para
  // mostrar o contador, e e por isso que o default existe.
  const slug = new URL(req.url).searchParams.get('kit')?.trim() ?? ''

  const kit = slug === ''
    ? (await listarKitsAtivos())[0] ?? null
    : await buscarKitAtivoPorSlug(slug)

  // 404 e nao 422: o parametro nao tem formato a violar (slug e texto livre), o
  // que falta e o RECURSO. Vale para tres casos que sao um so para quem
  // pergunta — slug inexistente, kit DESATIVADO no catalogo
  // (buscarKitAtivoPorSlug filtra por ativo) e catalogo vazio. Nenhum deles
  // merece resposta diferente: distinguir "existe mas esta desligado" de "nunca
  // existiu" so contaria a um curioso o que ha no catalogo fora do ar.
  if (!kit) {
    return Response.json({ error: 'kit_nao_encontrado' }, { status: 404, headers: SEM_CACHE })
  }

  // OS DOIS CANAIS SAO SEPARADOS (§4) e por isso sao duas leituras, nunca uma
  // soma: vender online nao tira unidade da caixa do evento. `saldosPorKit()`
  // devolveria as duas linhas de uma vez, mas agregando os movimentos de TODOS
  // os kits e de todos os canais para descartar quase tudo em seguida — numa
  // rota consultada a cada 15s por todo navegador aberto, o certo e ler so o
  // que vai para a tela.
  const [presencial, online] = await Promise.all([
    saldoDoEstoque(kit.id, 'presencial'),
    saldoDoEstoque(kit.id, 'online'),
  ])

  // `null` quando NAO EXISTE linha de estoque presencial para este kit — kit que
  // simplesmente nao entra no evento. Nao e erro e nao e "esgotado": tratar a
  // ausencia de cadastro como zero faria a home anunciar "Os 0 kits disponiveis
  // para compra presencial foram esgotados", que e uma frase falsa sobre um kit
  // que nunca teve caixa nenhuma. O contrato de `null` e o mesmo que
  // src/components/vitrine.tsx ja recebe (`escassez: {...} | null`): sem
  // contagem, a tela nao imprime contador.
  //
  // Os tres numeros/frases do presencial nascem JUNTOS, do mesmo `if`, para que
  // nao exista estado intermediario em que um deles seja null e o outro nao.
  const escassez = presencial === null ? null : {
    disponivel: saldoPublicavel(presencial.disponivel),
    // Tamanho do LOTE que entrou (SUM das entradas, 50 no lancamento). Nao muda
    // quando alguem compra — e o "de 50" do contador da vitrine.
    total: presencial.total,
    // O aviso le o saldo REAL, nao o publicavel: negativo e zero caem os dois em
    // 'esgotado' (src/lib/escassez.ts diz isso por extenso), entao o clamp nao
    // muda a frase — e passar o numero cru mantem esta rota sem opiniao sobre a
    // regra de escassez, que e de la.
    aviso: avisoDeEscassez(presencial.disponivel, presencial.total),
  }

  return Response.json({
    /**
     * O slug, e SO o slug, identifica o kit desta resposta.
     *
     * Ele ja e publico (esta na URL da vitrine e no corpo de POST /api/pedidos)
     * e e necessario: sem ele, a resposta da forma DEFAULT — a que a home usa,
     * sem `?kit=` — nao diz de qual kit e o contador, e um catalogo com dois
     * kits ativos faria a tela mostrar o numero de um embaixo do nome do outro.
     *
     * O QUE NAO SAI DAQUI, e a lista e deliberada: `kits.id`, `estoques.id`,
     * qualquer id de pedido e qualquer dado de cliente. Nenhum deles tem uso na
     * tela e todos sao identificador interno — o de pedido, em especial, e
     * chave de escrita no livro-razao de estoque (estoque_movimentos.pedido_id).
     * Uma rota publica sem autenticacao nenhuma nao emprestando identificador
     * interno a ninguem e o que mantem o resto do sistema sem superficie de
     * enumeracao. Ver o teste SEGURANCA: em
     * src/app/api/__tests__/rotas-publicas.test.ts, que trava isto por diff do
     * corpo inteiro.
     */
    kitSlug: kit.slug,
    presencial: escassez === null ? null : {
      disponivel: escassez.disponivel,
      total: escassez.total,
      /**
       * Derivado do MESMO aviso, e nao de uma segunda comparacao com zero.
       *
       * A vitrine usa este booleano para trocar a CTA por "COMPRAR ONLINE" e o
       * aviso para escrever a frase; se cada um saisse de uma conta propria,
       * bastaria um saldo negativo (ou um limiar mudado em src/lib/escassez.ts)
       * para a tela dizer "Ultimos 0 kits" com o botao de compra presencial
       * ainda ligado. Uma fonte so, por construcao — e exatamente a licao que o
       * cabecalho de src/lib/escassez.ts conta sobre src/components/linha-frete.tsx.
       */
      esgotado: escassez.aviso.nivel === 'esgotado',
    },
    /** Nivel para a tela decidir aparencia; mensagem ja acentuada, pronta para exibir. */
    aviso: escassez === null ? null : escassez.aviso,
    online: {
      /**
       * Pre-venda SEM TETO (decisao do cliente em 16/08, §4): o online nunca
       * esgota, e por isso nao ha numero nenhum aqui. Publicar o `disponivel`
       * desse canal seria publicar um numero negativo — ele nunca recebe
       * entrada, entao o saldo e menos o total ja vendido, pelo mesmo motivo
       * escrito por extenso em src/app/api/admin/estoque/route.ts.
       *
       * `true` quando nao existe linha de estoque online e a leitura honesta do
       * comportamento do sistema, nao um chute otimista: sem linha,
       * `baixarEstoque` (src/repositories/estoque.ts) devolve `false` e segue —
       * nao ha teto a aplicar em lugar nenhum. Dizer `false` aqui faria a tela
       * esconder a compra online, que e o unico canal que nunca acaba, por causa
       * de um cadastro que ninguem fez.
       */
      ilimitado: online?.ilimitado ?? true,
    },
  }, { headers: SEM_CACHE })
}

/**
 * Demais verbos: 405 com `Allow`, padrao da casa (src/app/api/pedidos/route.ts).
 * O Next devolveria 405 sozinho, mas sem o cabecalho `Allow` que a RFC 9110
 * exige — e sem deixar legivel no arquivo que esta rota so le.
 *
 * Corrigir estoque e escrita de admin e nao mora aqui: quem faz e
 * `ajustarEstoque` (src/repositories/estoque.ts), atras de sessao. Um POST nesta
 * URL publica seria a forma mais curta de qualquer pessoa na internet mexer no
 * numero que decide quem leva kit no dia 25/08.
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
