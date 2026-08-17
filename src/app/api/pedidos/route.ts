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
import {
  cotarFrete, ClubeEnviosError, CotacaoIlegivelError, FreteNaoConfiguradoError,
  type OpcaoDeFrete,
} from '@/lib/frete'
import {
  criarLimitadorPorIp, ipDoPedido,
  JANELA_RATE_LIMIT_MS, MAX_PEDIDOS_POR_JANELA,
} from '@/lib/rate-limit'

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

const Corpo = z.object({
  kitSlug: z.string().min(1),
  quantidade: z.number().int().min(1).max(QUANTIDADE_MAXIMA),
  cupom: z.string().trim().min(3).max(24).optional(),
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
  nome: z.string().trim().min(3),
  email: z.string().email(),
  cpf: z.string().regex(/^\d{11}$/),
  whatsapp: z.string().regex(/^\d{10,13}$/),
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
 * Sinaliza um cupom recusado (ResultadoCupom.ok === false) sem confundir
 * esse caminho de negocio esperado com um erro de infraestrutura — o catch
 * da rota distingue os dois so verificando `instanceof`.
 */
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
    return Response.json({ error: 'nao_foi_possivel_criar_o_pedido' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  // Antes de qualquer leitura de corpo ou toque no banco: um pedido barrado
  // nao chega a abrir transacao, entao um 429 nao pode deixar cliente,
  // endereco ou pedido gravado.
  if (excedeuRateLimit(ipDoPedido(req.headers))) {
    return Response.json({ error: 'rate_limited' }, { status: 429 })
  }

  const parsed = Corpo.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'dados_invalidos' }, { status: 422 })
  }
  const d = parsed.data

  const kit = await buscarKitAtivoPorSlug(d.kitSlug)
  if (!kit) return Response.json({ error: 'kit_indisponivel' }, { status: 422 })

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
  const opcao = await opcaoDeFreteEscolhida({
    kit,
    quantidade: d.quantidade,
    cepDestino: d.cep,
    subtotal: carrinho.subtotal,
    idServico: d.idServico,
  })
  if (opcao instanceof Response) return opcao

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
      const { clienteId, enderecoId } = await salvarClienteComEndereco(
        { nome: d.nome, email: d.email, cpf: d.cpf, whatsapp: d.whatsapp },
        {
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
        frete: opcao.valor,
        // Prazo da MESMA opcao, para a tela de confirmacao e para a fila da
        // expedicao (§17). Diferente de frete e canal, esta coluna nao e
        // congelada — a logistica corrige quando a transportadora muda o prazo.
        // E ESTIMATIVA, nao promessa.
        prazoDiasEstimado: opcao.prazoDias,
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
      return Response.json({ error: 'dados_invalidos' }, { status: 422 })
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
    return Response.json({ error: 'nao_foi_possivel_criar_o_pedido' }, { status: 500 })
  }
}

export async function GET() {
  return Response.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'POST' },
  })
}
