import { z } from 'zod'
import { exigirPapel } from '@/lib/guarda'
import {
  criarCupom, listarCupons, definirAtivoDoCupom, CupomDuplicadoError,
} from '@/repositories/cupons'
import { TAMANHO_MAXIMO_CUPOM } from '@/lib/cupom-da-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Os cupons do painel (§17): listar, criar e ligar/desligar.
 *
 * POR QUE ESTA ROTA EXISTE. Ate 19/08/2026 cupom so nascia por SQL na mao, o
 * que significa que so nascia por alguem com acesso ao banco de producao — a
 * dona da marca nao tem, e nao deve ter. Uma oferta de lancamento pedida por
 * audio numa terca de manha nao pode depender de quem esta disponivel para
 * abrir um `psql`.
 *
 * O QUE ELA DELIBERADAMENTE NAO FAZ: editar valor, tipo ou janela de um cupom
 * que ja existe, e apagar cupom. Um cupom que ja foi resgatado e um FATO
 * CONTABIL — ha pedidos pagos cujo desconto so se explica por aquela linha.
 * Trocar 'fixo 20000' por 'percentual 50' depois de trinta vendas nao corrige
 * nada: apaga a explicacao de trinta descontos ja concedidos e faz o extrato
 * de comissao deixar de fechar com o historico. Errou o cupom? Desative e crie
 * outro — dois codigos e a verdade sobre os dois, em vez de um codigo mentindo
 * sobre o passado.
 */
const SEM_CACHE = { 'Cache-Control': 'no-store' } as const

/**
 * O formato do codigo e o MESMO CHECK do banco
 * (`cupom_codigo_formato`, migrations/1755000200000_cupons.sql), escrito aqui
 * para que a tela receba 422 com mensagem em vez de 500 com stack. O teto de
 * 24 vem de TAMANHO_MAXIMO_CUPOM — a mesma constante que o link de campanha
 * usa para cortar `?cupom=`, entao um codigo criado aqui nunca pode ser longo
 * demais para o proprio link que a tela vai gerar para ele.
 */
const Codigo = z.string().trim().toUpperCase()
  .min(3).max(TAMANHO_MAXIMO_CUPOM)
  .regex(/^[A-Z0-9]+$/, 'Use apenas letras maiúsculas e números.')

/**
 * `valor` muda de significado conforme `tipo` — 1..100 no percentual, centavos
 * no fixo —, e por isso a validacao e discriminada em vez de um `valor:
 * z.number().positive()` solto. Sem isto, "50" passaria como cupom fixo de
 * R$ 0,50 quando a intencao era 50%, e o erro so apareceria no extrato.
 */
const Corpo = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('percentual'),
    codigo: Codigo,
    valor: z.number().int().min(1).max(100),
    expiraEm: z.string().datetime().nullable().default(null),
    limiteTotal: z.number().int().positive().nullable().default(null),
    limitePorCliente: z.number().int().positive().default(1),
    representanteId: z.string().uuid().nullable().default(null),
  }).strict(),
  z.object({
    tipo: z.literal('fixo'),
    codigo: Codigo,
    // Teto igual ao CHECK `cupom_fixo_teto`: R$ 100.000,00 em centavos.
    valor: z.number().int().min(1).max(10000000),
    expiraEm: z.string().datetime().nullable().default(null),
    limiteTotal: z.number().int().positive().nullable().default(null),
    limitePorCliente: z.number().int().positive().default(1),
    representanteId: z.string().uuid().nullable().default(null),
  }).strict(),
])

const Alteracao = z.object({
  id: z.string().uuid(),
  ativo: z.boolean(),
}).strict()

export async function GET(req: Request) {
  const usuario = await exigirPapel(req, ['admin'])
  if (usuario instanceof Response) return usuario

  return Response.json({ cupons: await listarCupons() }, { headers: SEM_CACHE })
}

export async function POST(req: Request) {
  // PRIMEIRA COISA DO HANDLER, pelo mesmo motivo escrito em
  // src/app/api/admin/pedidos/[id]/route.ts: a guarda antes de qualquer leitura
  // de corpo, para que um anonimo nao consiga sondar o formato aceito.
  const usuario = await exigirPapel(req, ['admin'])
  if (usuario instanceof Response) return usuario

  const parsed = Corpo.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({
      error: 'dados_invalidos',
      mensagem: parsed.error.issues[0]?.message ?? 'Confira os campos do cupom.',
    }, { status: 422, headers: SEM_CACHE })
  }
  const d = parsed.data

  try {
    const cupom = await criarCupom({
      codigo: d.codigo,
      tipo: d.tipo,
      valor: d.valor,
      expiraEm: d.expiraEm === null ? null : new Date(d.expiraEm),
      limiteTotal: d.limiteTotal,
      limitePorCliente: d.limitePorCliente,
      representanteId: d.representanteId,
    })
    return Response.json({ cupom }, { status: 201, headers: SEM_CACHE })
  } catch (erro) {
    // 409, e nao 422: o corpo esta perfeitamente valido: o conflito e com o
    // estado atual do banco. A tela usa a distincao para oferecer "esse codigo
    // ja existe, escolha outro" em vez de mandar a pessoa revisar campos que
    // estao todos corretos.
    if (erro instanceof CupomDuplicadoError) {
      return Response.json({
        error: 'codigo_em_uso',
        mensagem: `Já existe um cupom com o código ${erro.codigo}.`,
      }, { status: 409, headers: SEM_CACHE })
    }
    throw erro
  }
}

/**
 * PATCH — liga e desliga. E o freio da campanha: o link ja esta espalhado e
 * nao volta atras, entao o unico controle real sobre um desconto que precisa
 * parar AGORA e esta chave.
 */
export async function PATCH(req: Request) {
  const usuario = await exigirPapel(req, ['admin'])
  if (usuario instanceof Response) return usuario

  const parsed = Alteracao.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'dados_invalidos' }, { status: 422, headers: SEM_CACHE })
  }

  const achou = await definirAtivoDoCupom(parsed.data.id, parsed.data.ativo)
  if (!achou) {
    return Response.json({ error: 'cupom_nao_encontrado' }, { status: 404, headers: SEM_CACHE })
  }
  return Response.json({ ok: true }, { headers: SEM_CACHE })
}
