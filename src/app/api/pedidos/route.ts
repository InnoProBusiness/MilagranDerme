import { z } from 'zod'
import { getDb } from '@/lib/db'
import { buscarKitAtivoPorSlug } from '@/repositories/produtos'
import { salvarClienteComEndereco, CpfDivergenteError } from '@/repositories/clientes'
import { resgatarCupom } from '@/repositories/cupons'
import { criarPedido, PrecoDivergenteError } from '@/repositories/pedidos'
import { resolverAtribuicaoDoPedido } from '@/lib/resolver-pedido'
import { aplicarPrioridadeDoCupom } from '@/lib/montar-pedido'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { segredoDeAtribuicao, NOME_COOKIE_ATRIBUICAO } from '@/lib/atribuicao'
import { mensagemDeRecusa, type MotivoRecusa } from '@/lib/cupom'
import { deInteiro } from '@/lib/money'
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
  const carrinho = montarCarrinho([{
    kitId: kit.id, nome: kit.nome,
    precoUnitario: kit.precoCentavos, quantidade: d.quantidade,
  }])

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
      // tambem carrega kitSlug, quantidade e cupom, e salvarClienteComEndereco
      // espalha o segundo argumento inteiro (`...e`) dentro do INSERT em
      // enderecos — passar `d` faz o Postgres recusar a coluna "kitSlug",
      // que nao existe na tabela. Objetos explicitos, so com os campos de
      // cada tipo, sao o que garante que so o que pertence a cada tabela
      // chega nela.
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
        representanteId: atribuicao.representanteId,
        percentualComissao: atribuicao.percentualComissao,
        utmSource: atribuicao.utmSource,
        utmMedium: atribuicao.utmMedium,
        utmCampaign: atribuicao.utmCampaign,
        desconto,
        // PLACEHOLDER DE POLITICA INDEFINIDA, nao "frete gratis". A coluna
        // pedidos.frete_centavos e NOT NULL e precisa de um valor; a
        // politica de frete ainda nao foi decidida, entao o pedido nasce com
        // zero e nenhuma tela mostra esse zero (ver
        // src/components/linha-frete.tsx). O ResumoCarrinho de proposito NAO
        // tem campo de frete para este ponto ler — quando o frete for real,
        // e aqui que o valor calculado entra.
        frete: deInteiro(0),
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
