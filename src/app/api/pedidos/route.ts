import { z } from 'zod'
import { getDb } from '@/lib/db'
import { buscarKitAtivoPorSlug } from '@/repositories/produtos'
import { salvarClienteComEndereco } from '@/repositories/clientes'
import { resgatarCupom } from '@/repositories/cupons'
import { criarPedido } from '@/repositories/pedidos'
import { resolverAtribuicaoDoPedido } from '@/lib/resolver-pedido'
import { aplicarPrioridadeDoCupom } from '@/lib/montar-pedido'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { segredoDeAtribuicao, NOME_COOKIE_ATRIBUICAO } from '@/lib/atribuicao'
import { mensagemDeRecusa, type MotivoRecusa } from '@/lib/cupom'
import { deInteiro } from '@/lib/money'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
  const cookie = req.headers.get('cookie')
    ?.split('; ').find((c) => c.startsWith(`${NOME_COOKIE_ATRIBUICAO}=`))
    ?.slice(NOME_COOKIE_ATRIBUICAO.length + 1) ?? null
  const doCookie = await resolverAtribuicaoDoPedido(cookie, segredo)

  try {
    const numero = await getDb().transaction().execute(async (trx) => {
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
        frete: carrinho.frete,
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

      return pedido.numero
    })
    return Response.json({ numero }, { status: 201 })
  } catch (e) {
    if (e instanceof RecusaDeCupom) {
      return Response.json({ error: 'cupom_recusado', mensagem: mensagemDeRecusa(e.motivo) }, { status: 422 })
    }

    const mensagem = mensagemSeguraDoErro(e)
    // cpf_divergente (salvarClienteComEndereco) e preco_divergente
    // (criarPedido) sao recusas de negocio, nao falhas de infraestrutura —
    // a mensagem que elas lancam ja e segura de expor (nunca contem CPF,
    // e-mail ou o valor divergente em si).
    if (mensagem.startsWith('cpf_divergente') || mensagem.startsWith('preco_divergente')) {
      return Response.json({ error: 'dados_invalidos', mensagem }, { status: 422 })
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
