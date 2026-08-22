import { z } from 'zod'
import { getDb } from '@/lib/db'
import { buscarKitAtivoPorSlug, type Kit } from '@/repositories/produtos'
import { salvarClienteComEndereco, CpfDivergenteError } from '@/repositories/clientes'
import { resgatarCupom } from '@/repositories/cupons'
import { criarPedido, PrecoDivergenteError } from '@/repositories/pedidos'
import { resolverAtribuicaoDoPedido } from '@/lib/resolver-pedido'
import { aplicarPrioridadeDoCupom } from '@/lib/montar-pedido'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { segredoDeAtribuicao, NOME_COOKIE_ATRIBUICAO } from '@/lib/atribuicao'
import { mensagemDeRecusa, type MotivoRecusa } from '@/lib/cupom'
import { deInteiro, type Centavos } from '@/lib/money'
import { FRETE_RETIRADA } from '@/lib/retirada'
import {
  cotarFrete, ClubeEnviosError, CotacaoIlegivelError, FreteNaoConfiguradoError,
  type OpcaoDeFrete,
} from '@/lib/frete'
import {
  criarLimitadorPorIp, ipDoPedido,
  JANELA_RATE_LIMIT_MS, MAX_PEDIDOS_POR_JANELA,
} from '@/lib/rate-limit'
import { camposDoErroZod, mensagemDeCamposInvalidos } from '@/lib/campos-do-pedido'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Este endpoint nao tem autenticacao nenhuma e escreve em cinco tabelas —
 * incluindo CPF, nome completo, telefone e endereco residencial. Sem freio,
 * um script enche o banco de dado pessoal de terceiros (ou de lixo) na
 * velocidade da rede, e ainda serve para tentar cupom atras de cupom ate
 * achar um codigo valido.
 *
 * Desde a cotacao de frete (§13 do plano de 16/08/2026) o mesmo freio tem um
 * segundo trabalho: cada POST que chega ate a cotacao gasta UMA REQUISICAO NA
 * CONTA DA MILAGRAN no Clube Envios. Sem o teto por IP, um loop de checkout
 * abandonado consumiria a cota do provedor no dia do evento e o sintoma
 * apareceria como "frete indisponivel" para comprador legitimo.
 *
 * ATENCAO, honestamente: o contador e EM MEMORIA, por processo — ver o
 * cabecalho de src/lib/rate-limit.ts. Isto e um quebra-molas contra abuso
 * ingenuo, NAO rate limiting distribuido e NAO controle de acesso: com mais
 * de uma replica cada uma conta o seu pedaco, e o IP vem de um header que o
 * cliente pode forjar. Quem realmente protege o dado sao o Zod, as
 * constraints e os triggers — nao esta linha.
 *
 * Contador proprio (criarLimitadorPorIp devolve um Map novo a cada chamada):
 * o teto do checkout e independente do teto do formulario de candidatura.
 */
const excedeuRateLimit = criarLimitadorPorIp({
  janelaMs: JANELA_RATE_LIMIT_MS,
  maxPorJanela: MAX_PEDIDOS_POR_JANELA,
})

/**
 * O QUE TODO PEDIDO TEM, seja qual for a forma de entrega. Os campos de
 * ENTREGA nao estao aqui de proposito: eles sao o que muda entre os dois
 * ramos, e junta-los num objeto so com tudo opcional destruiria as garantias
 * que hoje sao 422 — envio sem idServico e envio sem endereco passariam a
 * compilar e a gravar.
 */
const CAMPOS_COMUNS = {
  kitSlug: z.string().min(1),
  quantidade: z.number().int().min(1).max(QUANTIDADE_MAXIMA),
  cupom: z.string().trim().min(3).max(24).optional(),
  nome: z.string().trim().min(3),
  email: z.string().email(),
  cpf: z.string().regex(/^\d{11}$/),
  whatsapp: z.string().regex(/^\d{10,13}$/),
} as const

/**
 * ENVIO: a forma que sempre existiu, agora declarada.
 *
 * `idServico` e o endereco continuam OBRIGATORIOS aqui, palavra por palavra
 * como eram antes da retirada existir — este ramo nao afrouxou nada.
 */
const CorpoEnvio = z.object({
  ...CAMPOS_COMUNS,
  tipoEntrega: z.literal('envio'),
  /**
   * QUAL opcao de frete o comprador escolheu na tela — e SO isso. O id vem de
   * uma cotacao que o proprio servidor fez antes (POST /api/frete, mesma
   * `cotarFrete` de src/lib/frete.ts); o VALOR daquela opcao nao acompanha o
   * id e nem poderia: dinheiro nunca entra por este corpo.
   *
   * `.strict()` logo abaixo e o que transforma essa regra em resposta HTTP —
   * mandar `frete`, `freteCentavos` ou `total` junto e 422, nao um campo
   * ignorado em silencio. E por isso que a rota RECOTA (ver
   * opcaoDeFreteEscolhida) em vez de aceitar o par id+valor que a tela ja tem
   * em maos.
   *
   * Um id que nao aparece na recotacao vira 422 `opcao_de_frete_invalida`: a
   * tabela da transportadora pode ter mudado entre a tela e o submit, e nesse
   * caso o certo e o comprador ver o valor novo, nao o servidor escolher uma
   * opcao por ele.
   */
  idServico: z.number().int().positive(),
  cep: z.string().regex(/^\d{8}$/),
  rua: z.string().trim().min(1),
  numero: z.string().trim().min(1),
  complemento: z.string().trim().default(''),
  bairro: z.string().trim().min(1),
  cidade: z.string().trim().min(1),
  estado: z.string().regex(/^[A-Z]{2}$/),
})
  // .strict() rejeita qualquer campo fora desta lista em vez de descarta-lo
  // em silencio. Sem isto, um teste que manda precoUnitarioCentavos/total
  // no corpo so provava que esses campos eram IGNORADOS — o mesmo corpo com
  // um campo desconhecido continuava valendo 200/201. Com .strict(), mandar
  // dinheiro no corpo e um 422 explicito: a API recusa a tentativa de
  // manipulacao, nao so a ignora.
  .strict()

/**
 * RETIRADA: sem transportadora, sem frete e SEM ENDERECO DE ENTREGA.
 *
 * A AUSENCIA DOS CAMPOS E A GARANTIA, e por isso este ramo tambem e `.strict()`:
 * uma retirada que mandasse `idServico` ou `cep` vira 422 em vez de ter os
 * campos descartados calados. Se fossem ignorados, um cliente adulterado
 * poderia declarar retirada (frete zero) e ainda assim carregar o resto de um
 * pedido de envio, e a unica coisa entre isso e um kit postado de graca seria
 * alguem lembrar de olhar a coluna certa na tela de logistica.
 *
 * Nao ha campo de valor nenhum aqui — nem zero. O frete de uma retirada e
 * decidido pelo servidor (FRETE_RETIRADA, abaixo) e garantido pelo banco
 * (CHECK pedido_retirada_sem_frete).
 */
const CorpoRetirada = z.object({
  ...CAMPOS_COMUNS,
  tipoEntrega: z.literal('retirada'),
}).strict()

/**
 * O DISCRIMINANTE E `tipoEntrega`, e nao um id sentinela.
 *
 * Um "idServico = 0" ou "-1" para dizer retirada morreria duas vezes — o
 * proprio schema recusa id nao-positivo, e a recotacao devolveria 422
 * `opcao_de_frete_invalida` — e, pior, seria magica espalhada por seis
 * arquivos, esperando o dia em que o Clube Envios emitisse justamente aquele
 * numero. Um campo que diz o que e nao tem esse problema.
 *
 * MESMO NOME EM TODA A PILHA: `tipoEntrega` no corpo, `tipoEntrega` em
 * EntradaPedido, `tipo_entrega` na coluna. Dois nomes para o mesmo fato e a
 * divergencia que este projeto persegue em copy, so que em identificadores.
 */
const Corpo = z.discriminatedUnion('tipoEntrega', [CorpoEnvio, CorpoRetirada])

/**
 * Corpo SEM `tipoEntrega` e um cliente ANTERIOR a retirada existir — e ele tem
 * que continuar comprando.
 *
 * O CASO E CONCRETO E ACONTECE NA SEMANA DO LANCAMENTO: alguem abre o checkout,
 * preenche os campos, o deploy entra no ar nesse meio-tempo e a pessoa clica em
 * "Finalizar". O bundle que ela carregou nao conhece o campo novo. Sem esta
 * normalizacao, `discriminatedUnion` recusa o corpo inteiro por falta do
 * discriminante e a resposta e 422 `dados_invalidos` — uma venda perdida por um
 * campo que o proprio servidor sabe deduzir.
 *
 * 'envio' E A DEDUCAO CERTA, e nao um chute: ate 19/08/2026 TODO pedido desta
 * rota era despachado. O corpo antigo, interpretado como envio, e exatamente o
 * que ele sempre significou — inclusive o `idServico` e o endereco que ele
 * carrega, que o ramo de envio continua exigindo.
 *
 * SO PREENCHE A AUSENCIA. Um corpo que declara `tipoEntrega` passa intacto,
 * incluindo um valor invalido — que continua sendo 422, como deve ser. E o
 * `.strict()` de cada ramo segue valendo: isto acrescenta um campo do contrato,
 * nunca perdoa um campo fora dele.
 */
function comEntregaPadrao(corpo: unknown): unknown {
  if (corpo === null || typeof corpo !== 'object' || Array.isArray(corpo)) return corpo
  return 'tipoEntrega' in corpo ? corpo : { ...corpo, tipoEntrega: 'envio' }
}

/**
 * O QUE A PESSOA LE QUANDO O DEFEITO E NOSSO.
 *
 * As duas unicas coisas que ela precisa saber num 500 estao aqui, e nenhuma
 * delas e o motivo tecnico: que NAO HOUVE COBRANCA — a duvida que faz alguem
 * pagar duas vezes ou abrir reclamacao — e que existe uma saida humana. O
 * motivo fica no log do servidor, onde nao vira dado vazado.
 */
const FALHA_NOSSA = 'Tivemos um problema do nosso lado ao registrar o pedido. '
  + 'Nada foi cobrado. Tente de novo em instantes e, se continuar, fale com a gente pelo WhatsApp.'

/**
 * A RECUSA QUE NAO EXPLICA POR QUE — e nao pode explicar.
 *
 * Serve ao ramo do CpfDivergenteError e a qualquer outra recusa de validacao
 * que so o banco conhece. O texto e o mesmo nos dois casos DE PROPOSITO: e a
 * unica forma de a resposta do e-mail que ja existe com outro CPF ser
 * indistinguivel da resposta de qualquer outra falha — ver o comentario longo
 * no catch do POST.
 *
 * O QUE ELE AINDA ASSIM ENTREGA: um caminho de saida. Antes desta constante o
 * ramo respondia sem `mensagem` nenhuma e a pessoa ficava com "confira os
 * dados" sobre um formulario que, para ela, estava certo — sem nem saber que
 * falar com a loja resolveria.
 *
 * O QUE ELE NAO PODE ENTREGAR, E A PRIMEIRA VERSAO DESTA CONSTANTE ENTREGAVA:
 * a frase dizia "confira o e-mail e o CPF digitados" — util, e justamente o
 * mapa do ataque. Nomear os dois campos diz a quem sondar que o e-mail existe e
 * que o CPF e o que falta acertar, que e exatamente o oraculo descrito no
 * comentario do catch. O teste de seguranca desta rota barra a palavra "cpf" no
 * corpo da resposta e pegou a versao anterior. A frase abaixo manda conferir o
 * FORMULARIO, sem dizer qual campo — e serve igual a qualquer outra recusa de
 * validacao que so o banco conhece, que e o que a mantem indistinguivel.
 */
const RECUSA_SEM_MOTIVO = 'Não foi possível concluir o pedido com os dados enviados. '
  + 'Confira o formulário e tente de novo. Se o erro continuar, '
  + 'fale com a gente pelo WhatsApp para concluir a compra.'

/**
 * Sinaliza um cupom recusado (ResultadoCupom.ok === false) sem confundir
 * esse caminho de negocio esperado com um erro de infraestrutura — o catch
 * da rota distingue os dois so verificando `instanceof`.
 */
class PedidoSemValorError extends Error {
  constructor() {
    super('pedido_sem_valor')
    this.name = 'PedidoSemValorError'
  }
}

class RecusaDeCupom extends Error {
  constructor(public readonly motivo: MotivoRecusa) {
    super(`cupom_recusado: ${motivo}`)
    this.name = 'RecusaDeCupom'
  }
}

/**
 * Unico ponto de leitura de uma mensagem de erro para logar ou devolver ao
 * cliente. So `error.message` e seguro: uma violacao de CHECK na tabela
 * clientes carrega a linha inteira — nome, e-mail, CPF, whatsapp — na
 * propriedade `detail` do erro do Postgres (ver o doc comment de
 * salvarClienteComEndereco em src/repositories/clientes.ts). Nunca logar ou
 * devolver o objeto de erro cru nem `detail`.
 */
function mensagemSeguraDoErro(e: unknown): string {
  return e instanceof Error ? e.message : 'erro_desconhecido'
}

/**
 * Recota o frete NO SERVIDOR e devolve a opcao que o comprador escolheu — ou
 * uma `Response` pronta quando nao ha o que cobrar dele.
 *
 * ```ts
 * const opcao = await opcaoDeFreteEscolhida({ ... })
 * if (opcao instanceof Response) return opcao
 * ```
 *
 * A UNIAO `OpcaoDeFrete | Response` e o molde de `exigirPapel`
 * (src/lib/guarda.ts) e vale aqui pelo mesmo motivo: enquanto o
 * `instanceof Response` nao estiver escrito, `opcao.valor` nao compila — o
 * compilador cobra o tratamento da recusa em vez de deixar a rota seguir com
 * um objeto de erro nas maos e gravar sabe-se la o que em frete_centavos.
 *
 * POR QUE RECOTAR, JA QUE A TELA ACABOU DE COTAR
 * ---------------------------------------------
 * Porque `pedidos.frete_centavos` e `pedidos.total_centavos` sao CONGELADOS
 * pelo trigger pedido_atribuicao_imutavel_trg
 * (migrations/1754900300000_pedidos.sql, lista reescrita em
 * 1755300100000_pedidos_canal_logistica.sql): depois do INSERT nao existe
 * UPDATE possivel nessas colunas por caminho nenhum do sistema. O valor tem
 * que estar certo AGORA, no INSERT — nao ha "corrige depois". E a unica fonte
 * confiavel do valor e o provedor respondendo ao CEP que este mesmo corpo
 * submeteu; o par id+valor que a tela tem em maos passou pelo navegador e
 * portanto vale tanto quanto qualquer outro numero digitado pelo comprador.
 *
 * ONDE ISTO E CHAMADO IMPORTA TANTO QUANTO O QUE ELE FAZ: FORA DA TRANSACAO.
 * Ver o comentario no POST.
 *
 * NUNCA CAI PARA FRETE ZERO. Provedor fora do ar, resposta ilegivel ou
 * credencial ausente viram 503 e o pedido NAO nasce. Um zero silencioso aqui
 * seria "R$ 0,00" na tela (src/components/linha-frete.tsx existe exatamente
 * para impedir isso), viraria `frete_centavos = 0` congelado na linha e viraria
 * prejuizo da Milagran em cada postagem. Falhar alto e barato: o comprador
 * tenta de novo em trinta segundos.
 */
async function opcaoDeFreteEscolhida(e: {
  kit: Kit
  quantidade: number
  cepDestino: string
  subtotal: Centavos
  idServico: number
}): Promise<OpcaoDeFrete | Response> {
  try {
    const cotacao = await cotarFrete({
      cepDestino: e.cepDestino,
      // Valor declarado e o SUBTOTAL dos produtos, sem desconto e sem frete: e
      // quanto vale a mercadoria dentro da caixa para efeito de transporte.
      // Descontar cupom aqui seria declarar a menor o que a transportadora
      // precisa repor se extraviar, e o desconto nem esta resolvido neste
      // ponto — o cupom so e resgatado dentro da transacao, mais abaixo.
      valorDeclarado: e.subtotal,
      // Dimensoes do CADASTRO do kit (src/repositories/produtos.ts), nunca um
      // numero escrito nesta rota: peso/medida errados sao frete errado, e o
      // erro so aparece no balcao dos Correios. `quantidade` multiplica o
      // volume porque cada unidade e uma caixa.
      volumes: [{
        alturaCm: e.kit.alturaCm,
        larguraCm: e.kit.larguraCm,
        comprimentoCm: e.kit.comprimentoCm,
        pesoGramas: e.kit.pesoGramas,
        quantidade: e.quantidade,
      }],
    })

    const opcao = cotacao.opcoes.find((o) => o.idServico === e.idServico)
    if (!opcao) {
      // A opcao sumiu entre a tela e o submit (tabela da transportadora mudou,
      // servico deixou de atender aquele CEP) ou o id foi inventado. Nos dois
      // casos NAO cabe escolher outra opcao por conta propria — nem a mais
      // barata: o comprador veria um valor no resumo e outro na cobranca. 422 e
      // a tela recalcula.
      return Response.json({
        error: 'opcao_de_frete_invalida',
        mensagem: 'A opção de frete escolhida não está mais disponível. Recalcule o frete e tente de novo.',
      }, { status: 422 })
    }

    return opcao
  } catch (erro) {
    // Despacho por CLASSE, nunca por texto de mensagem — mesma regra do catch
    // do POST. As tres sao "nao deu para cotar" por motivos diferentes
    // (provedor recusou/nao respondeu, resposta ilegivel, variavel de ambiente
    // faltando) e as tres tem o MESMO desfecho para quem comprou: 503, sem
    // pedido criado. O motivo especifico so vai para o log — a mensagem de
    // ClubeEnviosError pode ecoar o payload enviado, que carrega o CEP.
    if (
      erro instanceof ClubeEnviosError
      || erro instanceof CotacaoIlegivelError
      || erro instanceof FreteNaoConfiguradoError
    ) {
      console.error('[pedidos] frete indisponivel:', mensagemSeguraDoErro(erro))
      return Response.json({
        error: 'frete_indisponivel',
        mensagem: 'Não foi possível calcular o frete agora. Tente novamente em instantes.',
      }, { status: 503 })
    }

    // Sobra o que NAO e falha do provedor: `cotarFrete` tambem lanca Error
    // comum quando um volume vem com medida zerada ou nao inteira, e isso e
    // defeito do nosso cadastro (kits.peso_gramas e companhia), nao
    // indisponibilidade externa. 500 em vez de 503 para que o log nao conte a
    // historia errada — 503 sugere "tente de novo", e tentar de novo com o
    // mesmo kit quebrado nao resolve nada.
    console.error('[pedidos] falha inesperada ao cotar frete:', mensagemSeguraDoErro(erro))
    return Response.json({
      error: 'nao_foi_possivel_criar_o_pedido',
      mensagem: FALHA_NOSSA,
    }, { status: 500 })
  }
}

export async function POST(req: Request) {
  // Antes de qualquer leitura de corpo ou toque no banco: um pedido barrado
  // nao chega a abrir transacao, entao um 429 nao pode deixar cliente,
  // endereco ou pedido gravado.
  if (excedeuRateLimit(ipDoPedido(req.headers))) {
    // A MENSAGEM IMPORTA MAIS AQUI DO QUE EM QUALQUER OUTRO 4xx desta rota,
    // porque este e o unico erro em que a pessoa NAO FEZ NADA DE ERRADO e o
    // remedio e so esperar. Sem a frase, o checkout caia no texto generico
    // ("confira os dados") e mandava alguem reler quatro campos corretos —
    // e, pior, tentar de novo, o que so afunda mais o proprio contador.
    //
    // O TEXTO FALA DE "ESTE ACESSO", e nao "voce": o contador e por IP, e uma
    // saida de operadora movel (CGNAT) poe muitos compradores atras do mesmo
    // numero. Dizer "voce tentou demais" seria falso para quem acabou de
    // chegar — ver o cabecalho de MAX_PEDIDOS_POR_JANELA em
    // src/lib/rate-limit.ts.
    return Response.json({
      error: 'rate_limited',
      mensagem: 'Recebemos muitas tentativas de compra deste mesmo acesso à internet '
        + 'nos últimos minutos. Aguarde alguns minutos e tente de novo — '
        + 'nenhum pedido foi criado e nada foi cobrado.',
    }, { status: 429 })
  }

  const parsed = Corpo.safeParse(comEntregaPadrao(await req.json().catch(() => null)))
  if (!parsed.success) {
    // QUAL CAMPO, e nao so "dados invalidos" (21/08/2026).
    //
    // Este era o 422 mais mudo da rota e o mais provavel de acontecer com
    // comprador real, porque a tela e o servidor NAO validam pelas mesmas
    // regras — o checkout usa um regex simples de e-mail e aqui roda o
    // `z.string().email()`, que e mais estrito. Um endereco na faixa entre os
    // dois (`ana@gmail.com.`, com o ponto que o teclado do iOS acrescenta)
    // passava pela tela, era recusado aqui e voltava sem uma palavra sobre
    // onde estava o problema. A pessoa relia os quatro campos, nao achava nada
    // — nao havia nada errado PELAS REGRAS DA TELA — e desistia.
    //
    // `campos` VAI SEPARADO da frase de proposito: a frase e para ler, a lista
    // e para o checkout DESTACAR o campo e levar a pessoa ate o passo em que
    // ele mora (src/lib/campos-do-pedido.ts). Uma frase sozinha ainda deixaria
    // a busca por conta de quem esta comprando.
    //
    // NAO ECOA VALOR NENHUM — so nomes de campo. O corpo desta rota carrega
    // CPF, telefone e endereco residencial; devolve-los dentro de uma mensagem
    // de erro os espalharia para qualquer intermediario que registre resposta.
    // Pelo mesmo motivo o log abaixo tambem so leva os nomes.
    const campos = camposDoErroZod(parsed.error.issues)
    console.error('[pedidos] corpo invalido nos campos:', campos.join(',') || '(corpo inteiro)')
    return Response.json({
      error: 'dados_invalidos',
      mensagem: mensagemDeCamposInvalidos(campos),
      campos,
    }, { status: 422 })
  }
  const d = parsed.data

  const kit = await buscarKitAtivoPorSlug(d.kitSlug)
  if (!kit) {
    return Response.json({
      error: 'kit_indisponivel',
      mensagem: 'Este kit não está mais disponível para venda. '
        + 'Atualize a página para ver o catálogo atual.',
    }, { status: 422 })
  }

  // O preco vem do catalogo. Nada no corpo da requisicao influencia dinheiro:
  // precoUnitarioCentavos/total, se enviados, nem sobrevivem ao parse do Zod
  // acima porque nao fazem parte de `Corpo`.
  //
  // `montarCarrinho` aceita frete desde 16/08/2026 (src/lib/carrinho.ts) e
  // aqui ele NAO e passado — de proposito. Este resumo existe para dois usos:
  // o subtotal que o cupom desconta e as linhas que viram pedido_itens. O
  // total que vale e o que `criarPedido` calcula com a formula da constraint
  // pedido_total_confere; um `carrinho.total` montado aqui seria um segundo
  // total, calculado antes de o desconto do cupom existir, esperando para
  // divergir do primeiro.
  const carrinho = montarCarrinho([{
    kitId: kit.id, nome: kit.nome,
    precoUnitario: kit.precoCentavos, quantidade: d.quantidade,
  }])

  // A COTACAO ACONTECE AQUI, ANTES DE QUALQUER TRANSACAO — e a ordem e a
  // decisao, nao o acaso. `cotarFrete` e uma chamada de REDE com ate 12s de
  // timeout (src/lib/frete.ts); dentro de uma transacao aberta, esses 12s
  // segurariam uma conexao do pool (que tem 5) e todos os locks ja tomados
  // pelo caminho — bastam cinco compradores simultaneos com o provedor lento
  // para travar o checkout inteiro. E o mesmo motivo, escrito com as mesmas
  // palavras, pelo qual a chamada ao Mercado Pago fica fora da transacao em
  // src/app/api/pagamentos/route.ts.
  //
  // Consequencia aceita: cotar custa uma requisicao ao provedor mesmo para um
  // pedido que sera recusado logo adiante (cupom invalido, CPF divergente). O
  // preco disso e uma chamada HTTP; o preco do contrario e o checkout parado.
  //
  // RETIRADA NAO COTA NADA, e o desvio esta ANTES da chamada de rede por tres
  // razoes que valem juntas: nao gasta requisicao paga ao Clube Envios, nao faz
  // uma compra sem transporte depender do provedor estar de pe, e nao teria
  // como cotar — nao ha CEP de destino num pedido que ninguem vai enviar.
  //
  // O frete e decidido AQUI, no servidor, exatamente como o de envio: o corpo
  // da requisicao nunca carrega dinheiro (ver CorpoRetirada). Embaixo disto o
  // banco ainda tem a CHECK pedido_retirada_sem_frete.
  const entrega = d.tipoEntrega === 'retirada'
    ? { frete: FRETE_RETIRADA, prazoDiasEstimado: null }
    : await (async () => {
      const opcao = await opcaoDeFreteEscolhida({
        kit,
        quantidade: d.quantidade,
        cepDestino: d.cep,
        subtotal: carrinho.subtotal,
        idServico: d.idServico,
      })
      return opcao instanceof Response
        ? opcao
        : { frete: opcao.valor, prazoDiasEstimado: opcao.prazoDias }
    })()
  if (entrega instanceof Response) return entrega

  const segredo = segredoDeAtribuicao()
  // O header Cookie separa pares por "; " (ponto-e-virgula + um espaco) na
  // maioria dos navegadores, mas RFC 6265 so exige o ponto-e-virgula — um
  // proxy, um cliente de teste ou um navegador antigo pode mandar "cookie1;cookie2"
  // sem o espaco. Um split('; ') literal ali perderia o cookie de
  // atribuicao em silencio: a venda vira 'casa' sem erro nenhum, sem log,
  // sem 4xx — so comissao que deixa de ser paga. /;\s*/ cobre os dois casos.
  const cookie = req.headers.get('cookie')
    ?.split(/;\s*/).find((c) => c.startsWith(`${NOME_COOKIE_ATRIBUICAO}=`))
    ?.slice(NOME_COOKIE_ATRIBUICAO.length + 1) ?? null
  const doCookie = await resolverAtribuicaoDoPedido(cookie, segredo)

  try {
    const criado = await getDb().transaction().execute(async (trx) => {
      // Cliente e endereco entram na MESMA transacao que o resgate do cupom
      // e a criacao do pedido: se qualquer passo seguinte falhar, o rollback
      // tem que levar nome, CPF, telefone e endereco junto — nunca deixar
      // dado pessoal de um estranho commitado e preso a pedido nenhum.
      //
      // NUNCA passar `d` inteiro como EntradaCliente/EntradaEndereco: `d`
      // tambem carrega kitSlug, quantidade, cupom e idServico, e
      // salvarClienteComEndereco espalha o segundo argumento inteiro (`...e`)
      // dentro do INSERT em enderecos — passar `d` faz o Postgres recusar a
      // coluna "kitSlug", que nao existe na tabela. Objetos explicitos, so com
      // os campos de cada tipo, sao o que garante que so o que pertence a cada
      // tabela chega nela.
      //
      // SEM ENDERECO NA RETIRADA, e o `null` e o dado honesto. Quem vem buscar
      // o kit nao informou destino nenhum — guardar um endereco ali seria
      // inventar uma entrega que nao vai existir, e a tela de logistica
      // passaria a exibir um destino para um pedido que nunca sai daqui.
      // A constraint pedido_envio_tem_endereco continua exigindo destino de
      // todo pedido de ENVIO; e so a retirada que fica de fora.
      const { clienteId, enderecoId } = await salvarClienteComEndereco(
        { nome: d.nome, email: d.email, cpf: d.cpf, whatsapp: d.whatsapp },
        d.tipoEntrega === 'retirada' ? null : {
          cep: d.cep, rua: d.rua, numero: d.numero, complemento: d.complemento,
          bairro: d.bairro, cidade: d.cidade, estado: d.estado,
        },
        trx,
      )

      let desconto = deInteiro(0)
      let cupomId: string | null = null
      let atribuicao = doCookie

      if (d.cupom) {
        const r = await resgatarCupom(d.cupom, carrinho.subtotal, clienteId, trx)
        if (!r.ok) throw new RecusaDeCupom(r.motivo)
        desconto = r.cupom.desconto
        cupomId = r.cupom.id

        // HIERARQUIA cupom > last click > first click (src/lib/montar-pedido.ts):
        // um cupom de representante tem prioridade sobre a atribuicao do
        // cookie. O percentual vem do cadastro AGORA, lido de dentro desta
        // mesma transacao — nunca de um valor guardado em cookie ou cupom.
        atribuicao = await aplicarPrioridadeDoCupom(doCookie, r.cupom, async (representanteId) => {
          const rep = await trx.selectFrom('representantes')
            .select('percentual_comissao')
            .where('id', '=', representanteId)
            .executeTakeFirstOrThrow()
          return Number(rep.percentual_comissao)
        })
      }

      /**
       * PEDIDO DE VALOR ZERO NAO NASCE, e a recusa e explicita.
       *
       * A combinacao existe: cupom percentual de 100 e criavel pelo painel
       * (`valor: z.number().int().min(1).max(100)` em
       * src/app/api/admin/cupons/route.ts), e um cupom fixo maior que o preco
       * do kit da no mesmo — calcularDesconto devolve `Math.min(bruto,
       * subtotal)`. Com ENVIO o total ainda fica positivo porque sobra o frete;
       * com RETIRADA o frete e zero, e o total fecha em R$ 0,00.
       *
       * O ESTRAGO SE O PEDIDO NASCESSE: nao ha como cobrar zero no Mercado Pago
       * (a preferencia e recusada e o Payment Brick nao tokeniza), entao o
       * pedido ficaria preso em 'pendente' para sempre — com o cupom JA
       * CONSUMIDO em `cupom_usos` na mesma transacao, comendo o limite por
       * cliente, e com `total_centavos` congelado pelo trigger de imutabilidade,
       * ou seja, sem UPDATE de correcao possivel. A unica saida seria apagar o
       * pedido no banco.
       *
       * DENTRO DA TRANSACAO E DEPOIS DO RESGATE, de proposito: o desconto so e
       * conhecido depois de `resgatarCupom`, e lancar aqui faz o ROLLBACK levar
       * junto o uso do cupom que acabou de ser gravado. A pessoa tenta de novo
       * sem o cupom, ou com outro, e o limite dela continua intacto.
       *
       * BRINDE DE VERDADE, se um dia a Milagran quiser dar um, nao passa por
       * aqui: seria uma venda de balcao registrada pela operacao, ou um caminho
       * proprio que marque o pedido como quitado sem cobranca — decisao que
       * mexe no livro-razao de comissao e no estoque, e que ninguem tomou.
       */
      const totalDoPedido = carrinho.subtotal - desconto + entrega.frete
      if (totalDoPedido <= 0) {
        throw new PedidoSemValorError()
      }

      const pedido = await criarPedido({
        origem: atribuicao.origem,
        // ONDE a venda aconteceu, e nao quem a trouxe (`origem`, logo acima, e
        // atribuicao de comissao — os dois eixos sao ortogonais, ver
        // EntradaPedido em src/repositories/pedidos.ts). Esta rota E a loja:
        // todo pedido que nasce aqui e 'online'. O balcao do evento tem rota
        // propria (src/app/api/vendas-presenciais/route.ts) e canal proprio,
        // porque canal decide de qual estoque a unidade sai (§4) e separa o
        // relatorio de §17. Literal, nunca vindo do corpo: a coluna e
        // CONGELADA pelo trigger de imutabilidade e um canal errado no INSERT
        // nao tem conserto.
        canal: 'online',
        // COMO o kit chega. Vem do corpo — e o unico dos tres eixos que a
        // compradora escolhe — mas o que o corpo carrega e a MODALIDADE, nunca
        // o preco dela: `entrega` logo acima e quem traduz a escolha em
        // dinheiro, no servidor.
        tipoEntrega: d.tipoEntrega,
        representanteId: atribuicao.representanteId,
        percentualComissao: atribuicao.percentualComissao,
        utmSource: atribuicao.utmSource,
        utmMedium: atribuicao.utmMedium,
        utmCampaign: atribuicao.utmCampaign,
        desconto,
        // O VALOR DA COTACAO QUE O SERVIDOR ACABOU DE FAZER — nunca um numero
        // vindo do corpo, que nem sobrevive ao `.strict()` do schema. Ate
        // 16/08/2026 esta linha era `deInteiro(0)` com um comentario dizendo
        // "placeholder de politica indefinida, nao frete gratis"; a politica
        // foi decidida (Clube Envios, §13) e o zero deixou de existir neste
        // caminho: quando nao da para cotar, a rota ja devolveu 503 la em cima
        // e nao chegou ate aqui.
        //
        // O ZERO VOLTOU A EXISTIR EM 19/08/2026, e agora com dono: retirada no
        // local nao tem transporte a cobrar (FRETE_RETIRADA). A diferenca para
        // o placeholder antigo e que este zero e uma AFIRMACAO — ha uma coluna
        // dizendo que a entrega e retirada e uma CHECK no banco garantindo que
        // as duas coisas andam juntas.
        frete: entrega.frete,
        // Prazo da MESMA opcao, para a tela de confirmacao e para a fila da
        // expedicao (§17). Diferente de frete e canal, esta coluna nao e
        // congelada — a logistica corrige quando a transportadora muda o prazo.
        // E ESTIMATIVA, nao promessa.
        //
        // NULL NA RETIRADA, e nao 7. Esta coluna e prazo de TRANSPORTADORA e a
        // pagina do pedido a imprime como "dias uteis apos a postagem"; os 7
        // dias da retirada sao o contrario disso (quanto tempo a compradora tem
        // para buscar) e vivem em PRAZO_RETIRADA_DIAS, src/lib/retirada.ts. A
        // CHECK pedido_retirada_sem_prazo_de_transporte recusa a confusao.
        prazoDiasEstimado: entrega.prazoDiasEstimado,
        itens: carrinho.linhas.map((l) => ({
          kitId: l.kitId,
          quantidade: l.quantidade,
          precoUnitarioCentavos: l.precoUnitario,
        })),
        clienteId,
        enderecoId,
        cupomId,
      }, trx)

      if (cupomId) {
        await trx.insertInto('cupom_usos')
          .values({ cupom_id: cupomId, pedido_id: pedido.id, cliente_id: clienteId })
          .execute()
      }

      // numero e a referencia humana (mostrada NA pagina de confirmacao);
      // token e a chave publica da URL (/pedido/<token>) — numero sozinho
      // e um bigint sequencial previsivel e a pagina nao tem autenticacao
      // nenhuma (ver migrations/1755100000000_pedido_token.sql). O wizard
      // (src/components/checkout-wizard.tsx) navega pelo token, nunca pelo
      // numero.
      return { numero: pedido.numero, token: pedido.token }
    })
    return Response.json(criado, { status: 201 })
  } catch (e) {
    if (e instanceof RecusaDeCupom) {
      return Response.json({ error: 'cupom_recusado', mensagem: mensagemDeRecusa(e.motivo) }, { status: 422 })
    }

    // 422, e a mensagem diz o que fazer: o desconto zerou o total e nao ha como
    // cobrar R$ 0,00. Sem esta frase a pessoa tentaria de novo com o mesmo
    // cupom, achando que foi falha de rede.
    if (e instanceof PedidoSemValorError) {
      return Response.json({
        error: 'pedido_sem_valor',
        mensagem: 'Com este cupom o total do pedido fica em R$ 0,00 e não há como concluir a compra. Escolha o envio, para que reste o frete, ou fale com a gente pelo WhatsApp.',
      }, { status: 422 })
    }

    const mensagem = mensagemSeguraDoErro(e)

    // Os dois casos abaixo sao despachados por `instanceof`, nunca pelo
    // texto da mensagem. Um `mensagem.startsWith('...')` amarra o codigo de
    // status a uma string repetida em tres arquivos: reescrever a frase no
    // repositorio faria a rota devolver 500 em vez de 422, em silencio e com
    // a suite inteira verde. A classe da ao compilador o vinculo que a
    // string nao dava — mesmo padrao de RecusaDeCupom acima.

    // CpfDivergenteError (salvarClienteComEndereco): NUNCA vira uma mensagem
    // distinta de qualquer outro erro de validacao. Devolver um motivo
    // especifico aqui e um oraculo sem autenticacao — um POST com um e-mail
    // real e QUALQUER CPF ja revela, pela resposta (um 422 especifico x
    // um 201 normal), que aquele e-mail pertence a um cliente cadastrado; e
    // uma segunda tentativa acertando o CPF por tentativa e erro cria um
    // pedido de verdade em nome de outra pessoa, com o endereco de quem
    // estiver atacando. A resposta tem que ser indistinguivel de qualquer
    // outro 422 generico — sem campo `mensagem`. O motivo especifico so vai
    // para o log do servidor, via mensagemSeguraDoErro (nunca error.detail —
    // ver o doc comment de salvarClienteComEndereco).
    if (e instanceof CpfDivergenteError) {
      console.error('[pedidos] falha ao criar pedido:', mensagem)
      return Response.json({ error: 'dados_invalidos', mensagem: RECUSA_SEM_MOTIVO }, { status: 422 })
    }

    // PrecoDivergenteError (criarPedido): a mensagem CRUA do throw carrega o
    // uuid do kit e os dois precos (o do catalogo e o que o checkout
    // enviou) — nenhum dos dois e seguro de ecoar ao cliente por padrao,
    // mesmo que hoje nenhum dos dois seja segredo por si so. Mensagem
    // curada e fixa, do mesmo jeito que mensagemDeRecusa (src/lib/cupom.ts)
    // ja faz para cupom recusado; a string bruta so vai para o log.
    if (e instanceof PrecoDivergenteError) {
      console.error('[pedidos] falha ao criar pedido:', mensagem)
      return Response.json({
        error: 'dados_invalidos',
        mensagem: 'O preco do produto mudou. Atualize a pagina e tente novamente.',
      }, { status: 422 })
    }

    // Qualquer outra falha (inclusive uma violacao de CHECK do Postgres, cujo
    // `detail` carregaria a linha inteira de clientes) so loga a mensagem —
    // nunca o objeto de erro cru.
    console.error('[pedidos] falha ao criar pedido:', mensagem)
    return Response.json({
      error: 'nao_foi_possivel_criar_o_pedido',
      mensagem: FALHA_NOSSA,
    }, { status: 500 })
  }
}

export async function GET() {
  return Response.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'POST' },
  })
}
