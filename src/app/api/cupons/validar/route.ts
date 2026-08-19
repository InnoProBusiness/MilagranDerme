import { z } from 'zod'
import { avaliarCupom } from '@/repositories/cupons'
import { buscarKitAtivoPorSlug } from '@/repositories/produtos'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { mensagemDeRecusa } from '@/lib/cupom'
import { TAMANHO_MAXIMO_CUPOM } from '@/lib/cupom-da-url'
import {
  criarLimitadorPorIp, ipDoPedido,
  JANELA_RATE_LIMIT_MS, MAX_VALIDACOES_DE_CUPOM_POR_JANELA,
} from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/cupons/validar — a PREVIA do cupom, para o botao "Validar cupom" do
 * passo de revisao.
 *
 * O QUE ELA RESPONDE: "esse codigo vale, e tira quanto deste subtotal?".
 * O QUE ELA NAO FAZ: reservar, travar ou gravar coisa nenhuma. O desconto de
 * verdade e decidido por `resgatarCupom` sob `FOR UPDATE`, dentro da transacao
 * que cria o pedido — e as duas respostas saem da MESMA funcao de regras
 * (`validarCupom`, src/repositories/cupons.ts), justamente para que nunca
 * discordem.
 *
 * POR QUE ELA EXISTE. Ate 19/08/2026 o comprador digitava o codigo e so
 * descobria o resultado depois de mandar criar o pedido: um digito errado virava
 * 422 na etapa de pagamento, longe do campo onde estava o erro, e um desconto
 * legitimo nao aparecia em lugar nenhum antes de a compra fechar. A tela dizia
 * "Total (antes do cupom, verificado na confirmação)" — honesto, e inutil para
 * quem so queria saber se ia pagar 800 ou 1.000.
 *
 * O SUBTOTAL VEM DO CATALOGO, NUNCA DO CORPO. O cliente manda `kitSlug` e
 * `quantidade`; quem multiplica e o servidor, com o preco da tabela `kits`. Um
 * `subtotal` aceito no corpo deixaria o navegador escolher a base do desconto e
 * a tela anunciar um abatimento que a confirmacao nao vai repetir — a mesma
 * razao pela qual POST /api/pedidos recota o frete em vez de aceitar o valor.
 *
 * O FRETE NAO ENTRA. Esta rota devolve o desconto sobre os PRODUTOS, e nada
 * mais: cupom desconta subtotal (ver `calcularDesconto`, src/lib/cupom.ts), e
 * quem soma o frete na tela e o resumo do wizard, que ja o tem em maos. Cotar
 * frete aqui seria uma segunda chamada de rede — e um segundo lugar de onde um
 * total poderia sair diferente.
 */
const SEM_CACHE = { 'Cache-Control': 'no-store' } as const

/**
 * Contador PROPRIO, pelo mesmo motivo escrito em src/app/api/frete/route.ts:
 * validar cupom nao pode consumir o orcamento de FECHAR o pedido, que e a
 * unica requisicao que realmente importa.
 *
 * O TETO AQUI TEM UMA SEGUNDA FUNCAO, que a cotacao nao tem: esta rota
 * responde, para qualquer visitante, se um codigo existe. Sem limite ela vira
 * um oraculo de forca bruta sobre o espaco de codigos — que e pequeno de
 * proposito (3 a 24 caracteres em [A-Z0-9], e os codigos reais sao curtos e
 * memoraveis, como PRE200). Descobrir um cupom ativo assim nao quebra o
 * sistema, mas da a estranhos um desconto que a Milagran deu a uma campanha
 * especifica.
 */
const excedeuRateLimit = criarLimitadorPorIp({
  janelaMs: JANELA_RATE_LIMIT_MS,
  maxPorJanela: MAX_VALIDACOES_DE_CUPOM_POR_JANELA,
})

/**
 * Tres campos, e nenhum deles e dinheiro. `.strict()` transforma isso em
 * resposta HTTP: mandar `subtotal`, `desconto` ou `total` junto e 422 explicito,
 * nao um campo ignorado em silencio.
 *
 * SEM E-MAIL, E ISSO E UMA DECISAO — nao um esquecimento.
 *
 * A primeira versao desta rota aceitava `email` para conferir tambem o
 * `limite_por_cliente` ("esta pessoa ja usou este cupom?"). Funcionava, e o
 * preco era alto demais: um endpoint PUBLICO passava a responder, para qualquer
 * um que soubesse um codigo valido, se um e-mail QUALQUER ja tinha comprado com
 * aquele cupom. Isso e fato de compra de terceiro num endpoint sem
 * autenticacao — o oposto do cuidado que o resto do projeto tem com dado
 * pessoal (ver o bloco de LGPD em src/app/api/admin/leads/route.ts).
 *
 * O QUE SE PERDE: para quem JA usou o cupom antes, a previa responde "válido" e
 * a confirmacao recusa com 'limite_do_cliente'. E o unico desencontro que
 * sobrou entre as duas, ele so atinge comprador repetido, e a mensagem da
 * recusa e a mesma nas duas telas. Trocar isso por um vazamento de historico de
 * compra alheio nao vale.
 *
 * Se um dia a previa precisar mesmo do limite por pessoa, o caminho nao e este
 * parametro: e a identidade ja estabelecida (sessao, ou um token do proprio
 * checkout), para que a rota so responda sobre quem esta perguntando.
 */
const Corpo = z.object({
  codigo: z.string().trim().min(3).max(TAMANHO_MAXIMO_CUPOM),
  kitSlug: z.string().min(1),
  quantidade: z.number().int().min(1).max(QUANTIDADE_MAXIMA),
}).strict()

export async function POST(req: Request) {
  if (excedeuRateLimit(ipDoPedido(req.headers))) {
    return Response.json({
      error: 'muitas_tentativas',
      mensagem: 'Muitas tentativas de validação. Aguarde alguns minutos e tente de novo.',
    }, { status: 429, headers: SEM_CACHE })
  }

  const parsed = Corpo.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'dados_invalidos' }, { status: 422, headers: SEM_CACHE })
  }
  const d = parsed.data

  const kit = await buscarKitAtivoPorSlug(d.kitSlug)
  if (!kit) {
    return Response.json({ error: 'kit_indisponivel' }, { status: 404, headers: SEM_CACHE })
  }

  // O subtotal sai do catalogo, com o preco de AGORA — o mesmo caminho que
  // POST /api/pedidos percorre. Se o preco do kit mudar entre a previa e a
  // confirmacao, as duas leem a tabela e chegam ao mesmo lugar.
  const carrinho = montarCarrinho([{
    kitId: kit.id, nome: kit.nome,
    precoUnitario: kit.precoCentavos, quantidade: d.quantidade,
  }])

  // `null` = sem cliente identificado, e portanto SEM verificacao de limite por
  // pessoa. E a unica coisa que esta previa nao confere, e o bloco de doc do
  // schema explica por que ela nao deve conferir.
  const r = await avaliarCupom(d.codigo, carrinho.subtotal, null)

  if (!r.ok) {
    // 200, e nao 422. "Este cupom expirou" nao e um erro de quem chamou: e a
    // RESPOSTA da pergunta que a tela fez. Um 4xx faria o front tratar como
    // falha de requisicao — mostrando "tente de novo" para quem precisa ler o
    // motivo e digitar outro codigo.
    return Response.json({
      valido: false,
      motivo: r.motivo,
      // A MESMA frase que o checkout mostra quando recusa na confirmacao
      // (src/lib/cupom.ts). Duas mensagens diferentes para a mesma recusa
      // fariam o comprador achar que sao dois problemas.
      mensagem: mensagemDeRecusa(r.motivo),
    }, { headers: SEM_CACHE })
  }

  return Response.json({
    valido: true,
    codigo: r.cupom.codigo,
    // Em CENTAVOS INTEIROS, como todo dinheiro deste sistema. A tela subtrai do
    // subtotal que ja tem; nao existe um "total" calculado aqui, porque o frete
    // vive do outro lado e um segundo total seria um segundo lugar de onde a
    // divergencia poderia sair.
    descontoCentavos: r.cupom.desconto,
  }, { headers: SEM_CACHE })
}
