import { NoResultError } from 'kysely'
import { z } from 'zod'
import { getDb } from '@/lib/db'
import { exigirPapel } from '@/lib/guarda'
import {
  avancarStatusDoPedido, registrarRastreio, RastreioNaoAplicavelError,
  TransicaoFinanceiraError, TransicaoInvalidaError,
  type PedidoStatus,
} from '@/repositories/pedidos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * PATCH /api/admin/pedidos/[id] — a UNICA escrita do painel (§17): mover o
 * pedido pela fila da expedicao e gravar o codigo de rastreio.
 *
 * O QUE ESTA ROTA DELIBERADAMENTE NAO FAZ: marcar pedido como pago ou
 * reembolsado. Esses dois estados mexem no livro-razao de comissao, e quem
 * escreve nele e conciliarPagamento (src/repositories/conciliacao.ts), a partir
 * do webhook do Mercado Pago. A recusa nao esta escrita aqui: ela vem de
 * TransicaoFinanceiraError, lancada por avancarStatusDoPedido
 * (src/repositories/pedidos.ts), cujo doc comment explica o estrago exato que
 * um clique no painel causaria — credito parado no saldo de uma representante
 * por venda que deixou de existir, e o estorno automatico do webhook virando
 * no-op porque o pedido ja estaria no estado alvo. Este arquivo so traduz a
 * recusa para HTTP e diz ao administrador o que fazer no lugar.
 *
 * HANDLER FINO: nao ha SQL, nao ha maquina de estados e nao ha lock escritos
 * aqui. As duas escritas moram em src/repositories/pedidos.ts.
 */

/**
 * Mesmo motivo das leituras do painel: resposta que depende de quem pediu nao
 * pode ficar em cache compartilhado. Vale tambem para as recusas 4xx — um 409
 * guardado por um proxy seria servido a segunda tentativa legitima do mesmo
 * administrador, que veria a mudanca recusada sem ela ter sido tentada.
 */
const SEM_CACHE = { 'Cache-Control': 'no-store' } as const

/**
 * Cobertura exata do ENUM pedido_status cobrada pelo compilador — o mesmo
 * `satisfies { [K in X]: K }` de src/app/api/admin/vendas/route.ts, e aqui com
 * um peso a mais: esta lista e a porta de entrada da UNICA escrita de status
 * feita a mao no sistema. Um valor novo no ENUM que nao aparecesse aqui seria
 * um estado inalcancavel pelo painel; um valor escrito errado seria um 422 em
 * cima de um clique legitimo no dia do evento. As duas coisas quebram a
 * compilacao em vez de esperar a producao.
 *
 * A lista incluir 'pago' e 'reembolsado' NAO os libera: eles passam pelo Zod e
 * morrem em TransicaoFinanceiraError, no repositorio, com uma mensagem que
 * explica por que. E de proposito — a alternativa (tira-los do schema) daria
 * "dados_invalidos" ao administrador que tentasse, sem contar a ele quem move
 * aqueles estados. Validacao de formato e decisao de negocio sao camadas
 * diferentes, e a segunda tem mais a dizer.
 */
const STATUS = {
  pendente: 'pendente',
  aguardando_pagamento: 'aguardando_pagamento',
  pago: 'pago',
  em_preparacao: 'em_preparacao',
  enviado: 'enviado',
  em_transito: 'em_transito',
  entregue: 'entregue',
  cancelado: 'cancelado',
  reembolsado: 'reembolsado',
} as const satisfies { [K in PedidoStatus]: K }

/**
 * O id vem do CAMINHO da URL, que e entrada de usuario como qualquer outra.
 * Sem esta guarda, um id que nao seja uuid vira "invalid input syntax for type
 * uuid" no Postgres — um 500 — em vez do 404 que a tela espera. Mesma protecao
 * que buscarPedidoComItensPorToken e buscarUsuarioPorId ja fazem por dentro dos
 * repositorios (FORMATO_UUID la); avancarStatusDoPedido nao faz, porque o lock
 * dele precisa do id cru, entao a validacao e responsabilidade desta ponta.
 */
const Id = z.string().uuid()

/**
 * Os TRES campos sao opcionais e nenhum e dinheiro — esta rota nao toca em
 * valor nenhum, e o `.strict()` garante que uma tentativa de mandar
 * `totalCentavos` ou `freteCentavos` aqui seja 422 explicito em vez de campo
 * ignorado. Nao ha caminho nenhum no sistema que reescreva dinheiro de pedido
 * ja criado: as colunas sao congeladas pelo trigger de imutabilidade
 * (migrations/1755300100000_pedidos_canal_logistica.sql) e o UPDATE morreria no
 * banco de qualquer forma — o `.strict()` transforma o erro de servidor em uma
 * recusa legivel.
 *
 * `rastreioCodigo` NAO TEM VALIDACAO DE FORMATO, so tamanho. Nao existe formato
 * unico (Correios, transportadora regional e o motoboy do evento escrevem
 * diferente) e um regex inventado aqui recusaria rastreio legitimo no dia da
 * postagem — a decisao e do doc comment de registrarRastreio
 * (src/repositories/pedidos.ts) e este schema so cumpre a parte que cabe a
 * entrada do usuario: nao aceitar vazio. O teto de caracteres nao e formato: e
 * o freio para o texto colado por engano de outra janela nao virar uma linha de
 * banco com um paragrafo dentro.
 */
const Corpo = z.object({
  status: z.enum(STATUS).optional(),
  rastreioCodigo: z.string().trim().min(1).max(64).optional(),
  rastreioTransportadora: z.string().trim().min(1).max(60).optional(),
}).strict()

/**
 * Unico ponto de leitura de mensagem de erro deste arquivo, copiado de
 * src/app/api/pedidos/route.ts pelo mesmo motivo de la: `error.detail` do
 * Postgres carrega a LINHA INTEIRA envolvida na violacao — em `pedidos`, junto
 * com o cliente_id; em qualquer consulta que toque `clientes`, com nome, CPF e
 * whatsapp. So `error.message` pode ir para o log, e nada disso vai para a
 * resposta.
 */
function mensagemSeguraDoErro(e: unknown): string {
  return e instanceof Error ? e.message : 'erro_desconhecido'
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // PRIMEIRA COISA DO HANDLER: antes de ler params, antes de ler o corpo e
  // antes de qualquer toque no banco. Ver src/lib/guarda.ts e
  // src/app/api/__tests__/admin-guarda.test.ts, que exige 401 sem cookie e 403
  // com sessao de vendedor mesmo com id malformado e corpo vazio — se a guarda
  // descesse uma linha, o 422 do corpo apareceria antes do 401 e um anonimo
  // conseguiria sondar o formato aceito por uma rota de administrador.
  const usuario = await exigirPapel(req, ['admin'])
  if (usuario instanceof Response) return usuario

  // Em Next 16 `params` e uma Promise: ler sem await devolve o objeto errado
  // (um Promise, cujo `.id` e undefined) e a rota passaria undefined ao banco.
  const { id: idBruto } = await ctx.params
  const id = Id.safeParse(idBruto)
  // Id malformado e id inexistente sao a MESMA coisa para quem chamou: nao ha
  // pedido ali. O 404 e o mesmo dos dois casos, e a distincao nao interessa a
  // ninguem — quem digitou a URL errada nao ganha nada sabendo que o erro foi
  // de formato.
  if (!id.success) {
    return Response.json({ error: 'pedido_nao_encontrado' }, { status: 404, headers: SEM_CACHE })
  }

  const parsed = Corpo.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'dados_invalidos' }, { status: 422, headers: SEM_CACHE })
  }
  const d = parsed.data

  // PATCH sem nenhum campo e engano de quem chamou, nunca "nada a fazer com
  // sucesso": responder 200 aqui ensinaria a tela a achar que salvou. O Zod nao
  // pega isto sozinho porque os tres campos sao legitimamente opcionais — o que
  // nao e legitimo e a combinacao dos tres ausentes.
  if (d.status === undefined && d.rastreioCodigo === undefined && d.rastreioTransportadora === undefined) {
    return Response.json({
      error: 'nada_para_atualizar',
      mensagem: 'Informe o novo status ou o código de rastreio para atualizar o pedido.',
    }, { status: 422, headers: SEM_CACHE })
  }

  // OS DOIS CAMPOS DE RASTREIO ANDAM JUNTOS. registrarRastreio grava as duas
  // colunas de uma vez (src/repositories/pedidos.ts): aceitar so o codigo
  // apagaria a transportadora que estava gravada, e aceitar so a transportadora
  // apagaria o codigo — em silencio, num pedido que ja estava a caminho. A
  // recusa e explicita para que a tela mostre o que faltou preencher.
  const codigo = d.rastreioCodigo
  const transportadora = d.rastreioTransportadora
  if ((codigo === undefined) !== (transportadora === undefined)) {
    return Response.json({
      error: 'rastreio_incompleto',
      mensagem: 'Informe o código de rastreio e a transportadora juntos.',
    }, { status: 422, headers: SEM_CACHE })
  }

  let transicao: Awaited<ReturnType<typeof avancarStatusDoPedido>> | null = null
  let rastreioGravado = false

  try {
    // ORDEM DELIBERADA: o status PRIMEIRO, o rastreio depois.
    //
    // A mudanca de status e a unica das duas que pode ser RECUSADA (transicao
    // invalida, transicao financeira). Fazendo-a primeiro, um PATCH recusado
    // nao deixa nada gravado — a alternativa deixaria o codigo de rastreio no
    // pedido enquanto o status ficou onde estava, que e exatamente a metade de
    // operacao que a tela nao consegue mostrar.
    //
    // AS DUAS ESCRITAS NAO SAO ATOMICAS ENTRE SI, e isso e uma escolha
    // consciente: registrarRastreio nao aceita transacao de proposito (ver o
    // doc comment dela — nao ha decisao tomada a partir do valor lido, e duas
    // correcoes concorrentes do codigo tem que terminar com a ultima valendo).
    // Se a segunda escrita falhar depois da primeira ter commitado, o
    // administrador repete o PATCH inteiro e o resultado e o mesmo: as duas
    // operacoes sao idempotentes — avancarStatusDoPedido devolve
    // `mudou: false` quando o pedido ja esta no alvo (o clique duplo do painel)
    // e o rastreio e reescrito com o mesmo valor.
    if (d.status !== undefined) {
      const novo = d.status
      // A transacao existe por causa do `FOR UPDATE` de avancarStatusDoPedido,
      // que precisa viver ate o COMMIT: e ele que faz duas pessoas com o painel
      // aberto clicando no mesmo pedido virarem uma fila de duas em vez de dois
      // UPDATEs sobrepostos. Por isso aquela funcao nao tem versao sem `trx`.
      transicao = await getDb().transaction().execute((trx) => avancarStatusDoPedido(id.data, novo, trx))
    }

    if (codigo !== undefined && transportadora !== undefined) {
      await registrarRastreio(id.data, { codigo, transportadora })
      rastreioGravado = true
    }
  } catch (e) {
    const mensagem = mensagemSeguraDoErro(e)

    // O DESPACHO ABAIXO E POR `instanceof`, NUNCA por prefixo de string. As
    // classes vem de src/repositories/pedidos.ts e o vinculo entre elas e o
    // codigo HTTP e verificado pelo compilador; um `mensagem.startsWith(...)`
    // faria a reescrita da frase no repositorio virar 500 silencioso, com a
    // suite inteira verde. Mesmo padrao ja documentado para
    // PrecoDivergenteError em src/app/api/pedidos/route.ts.

    // NoResultError e o `executeTakeFirstOrThrow` das duas escritas nao achando
    // a linha: o pedido nao existe. 404, e nao 500 — o id veio da URL.
    if (e instanceof NoResultError) {
      return Response.json({ error: 'pedido_nao_encontrado' }, { status: 404, headers: SEM_CACHE })
    }

    // 409, e nao 422: o pedido EXISTE e o pedido MUDOU — quase sempre porque o
    // webhook do pagamento ou outra pessoa no painel andou com ele enquanto
    // esta tela estava aberta. E um conflito com o estado atual do recurso, e a
    // acao certa e recarregar e decidir de novo a partir do status de agora. A
    // mensagem diz exatamente isso; os tres campos do erro (pedido, de, para)
    // ficam so no log.
    if (e instanceof TransicaoInvalidaError) {
      console.error('[admin/pedidos] transicao recusada:', mensagem)
      return Response.json({
        error: 'transicao_invalida',
        mensagem: 'O pedido não está mais no estado que a tela mostrava. Atualize a página e refaça a mudança a partir do status atual.',
      }, { status: 409, headers: SEM_CACHE })
    }

    // 422 com mensagem propria: o pedido existe, mas nao ha rastreio a gravar
    // nele porque ninguem vai posta-lo. Sem este ramo a violacao de
    // pedido_retirada_sem_postagem cairia no 500 generico la embaixo, e quem
    // opera a expedicao veria "erro ao atualizar" sem saber que colou o codigo
    // na linha errada.
    if (e instanceof RastreioNaoAplicavelError) {
      console.error('[admin/pedidos] rastreio recusado:', mensagem)
      return Response.json({
        error: 'rastreio_nao_aplicavel',
        mensagem: 'Este pedido é retirada no local: não há postagem nem código de rastreio. Confira se o código não era de outro pedido.',
      }, { status: 422, headers: SEM_CACHE })
    }

    // 422, e nao 409: repetir NAO adianta, em nenhum estado. Nao e conflito com
    // o estado atual, e recusa de rota — 'pago' e 'reembolsado' pertencem ao
    // webhook do provedor, que e quem mexe no livro-razao de comissao. A
    // mensagem precisa dizer ao administrador o que fazer no lugar, senao ele
    // tenta de novo achando que foi falha de rede e termina abrindo um chamado
    // por um botao que nunca vai funcionar.
    if (e instanceof TransicaoFinanceiraError) {
      console.error('[admin/pedidos] transicao financeira recusada:', mensagem)
      return Response.json({
        error: 'transicao_financeira',
        mensagem: 'Pagamento e reembolso não se marcam pelo painel: quem move esses estados é a confirmação do provedor. Faça o estorno no Mercado Pago — o pedido muda sozinho quando a notificação chegar.',
      }, { status: 422, headers: SEM_CACHE })
    }

    // Qualquer outra falha (inclusive violacao de constraint do Postgres, cujo
    // `detail` carregaria a linha inteira) so loga a mensagem — nunca o objeto
    // de erro cru.
    console.error('[admin/pedidos] falha ao atualizar pedido:', mensagem)
    return Response.json({ error: 'nao_foi_possivel_atualizar_o_pedido' }, { status: 500, headers: SEM_CACHE })
  }

  // `transicao` null significa "o PATCH nao pediu status", e nao "nada mudou":
  // quem pediu status e recebeu `mudou: false` esta no caso do clique duplo, em
  // que o pedido ja estava no alvo. Sao situacoes diferentes e a tela precisa
  // distinguir as duas — por isso o objeto inteiro sobe, com `de` e `para`.
  return Response.json({
    pedidoId: id.data,
    transicao,
    rastreioGravado,
  }, { headers: SEM_CACHE })
}

/**
 * Demais verbos: 405 com `Allow`, padrao da casa
 * (src/app/api/pedidos/route.ts).
 *
 * PATCH e nao PUT de proposito: os tres campos sao uma ALTERACAO PARCIAL de um
 * pedido que ja existe. Um PUT prometeria substituir o recurso inteiro — e a
 * maior parte de um pedido (canal, vendedor, atribuicao, dinheiro) e congelada
 * pelo trigger de imutabilidade e nao pode ser substituida por ninguem.
 *
 * Nao ha GET aqui: quem le pedido para o painel e /api/admin/vendas e
 * /api/admin/logistica, e quem le para o comprador e a pagina publica
 * /pedido/[token] (pelo token inadivinhavel, nunca pelo id).
 */
function metodoNaoPermitido() {
  return Response.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'PATCH' },
  })
}

export const GET = metodoNaoPermitido
export const POST = metodoNaoPermitido
export const PUT = metodoNaoPermitido
export const DELETE = metodoNaoPermitido
