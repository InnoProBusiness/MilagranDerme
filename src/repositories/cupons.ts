import { sql, type Transaction, type Kysely } from 'kysely'
import { getDb } from '@/lib/db'
import type { DB } from '@/lib/db-types'
import { calcularDesconto, type ResultadoCupom, type TipoDesconto } from '@/lib/cupom'
import type { Centavos } from '@/lib/money'

/**
 * AS REGRAS DE VALIDADE DE UM CUPOM, num lugar so.
 *
 * Existem DOIS chamadores e eles precisam concordar palavra por palavra: o
 * resgate (`resgatarCupom`, que concede o desconto de verdade) e a previa
 * (`avaliarCupom`, que so responde a pergunta "esse codigo vale?" para a tela).
 * Se cada um tivesse a sua copia das verificacoes, a primeira regra alterada em
 * um dos dois faria o botao "Validar cupom" dizer VALIDO e a confirmacao
 * recusar — ou, pior, o contrario. E a mesma disciplina de copy unica que
 * src/components/linha-frete.tsx e src/lib/anvisa.ts aplicam a texto, aqui
 * aplicada a regra de negocio.
 *
 * `travar` e a UNICA diferenca entre os dois caminhos, e ela nao e cosmetica:
 *
 *   - RESGATE trava a linha do cupom (`FOR UPDATE`) antes de contar os usos.
 *     Sem isso, dois checkouts simultaneos leem a mesma contagem, os dois
 *     passam, e o limite estoura — o modo de falha classico de cupom, e o unico
 *     caminho pelo qual um desconto e concedido alem do autorizado.
 *   - PREVIA NAO TRAVA, de proposito. Ela roda num endpoint publico, fora de
 *     qualquer transacao de pedido: segurar um lock de linha ali deixaria
 *     qualquer visitante bloquear o cupom do lancamento inteiro so apertando um
 *     botao. A previa nao concede nada, entao nao tem o que proteger — ela pode
 *     estar desatualizada no instante seguinte, e a tela diz isso.
 *
 * `clienteId` NULO significa "ainda nao existe cliente com este e-mail", que e
 * o caso normal de quem esta comprando pela primeira vez: sem cliente nao ha
 * uso anterior, entao o limite por cliente nao pode ter sido atingido.
 */
async function validarCupom(
  codigo: string,
  subtotal: Centavos,
  clienteId: string | null,
  db: Transaction<DB> | Kysely<DB>,
  agora: Date,
  travar: boolean,
): Promise<ResultadoCupom> {
  const consulta = db.selectFrom('cupons')
    .selectAll()
    .where('codigo', '=', codigo.trim().toUpperCase())

  const cupom = await (travar ? consulta.forUpdate() : consulta).executeTakeFirst()

  if (!cupom) return { ok: false, motivo: 'inexistente' }
  if (!cupom.ativo) return { ok: false, motivo: 'inativo' }
  if (agora < cupom.inicia_em) return { ok: false, motivo: 'nao_iniciado' }
  if (cupom.expira_em && agora >= cupom.expira_em) return { ok: false, motivo: 'expirado' }

  if (cupom.representante_id) {
    const rep = await db.selectFrom('representantes')
      .select('id')
      .where('id', '=', cupom.representante_id)
      .where('ativo', '=', true)
      .executeTakeFirst()
    if (!rep) return { ok: false, motivo: 'representante_inativo' }
  }

  if (cupom.limite_total !== null) {
    const { total } = await db.selectFrom('cupom_usos')
      .select(sql<number>`count(*)::int`.as('total'))
      .where('cupom_id', '=', cupom.id)
      .executeTakeFirstOrThrow()
    if (total >= cupom.limite_total) return { ok: false, motivo: 'esgotado' }
  }

  // Sem cliente nao ha uso anterior possivel: quem nunca comprou nao gastou
  // nenhuma das unidades do limite por pessoa.
  if (clienteId !== null) {
    const { doCliente } = await db.selectFrom('cupom_usos')
      .select(sql<number>`count(*)::int`.as('doCliente'))
      .where('cupom_id', '=', cupom.id)
      .where('cliente_id', '=', clienteId)
      .executeTakeFirstOrThrow()
    if (doCliente >= cupom.limite_por_cliente) {
      return { ok: false, motivo: 'limite_do_cliente' }
    }
  }

  return {
    ok: true,
    cupom: {
      id: cupom.id,
      codigo: cupom.codigo,
      desconto: calcularDesconto(cupom.tipo, cupom.valor, subtotal),
      representanteId: cupom.representante_id,
    },
  }
}

/**
 * Resgata um cupom DENTRO da transacao que cria o pedido.
 *
 * A linha do cupom e travada com SELECT ... FOR UPDATE antes de contar os usos
 * (ver `validarCupom` acima), e o lock vive ate o COMMIT do chamador — e por
 * isso que esta funcao RECEBE a transacao em vez de abrir a propria: o resgate
 * e a criacao do pedido tem que ser atomicos. Cupom debitado sem pedido, ou
 * pedido com desconto sem uso registrado, sao os dois corrupcao de dados.
 */
export async function resgatarCupom(
  codigo: string,
  subtotal: Centavos,
  clienteId: string,
  trx: Transaction<DB>,
  agora: Date = new Date(),
): Promise<ResultadoCupom> {
  return validarCupom(codigo, subtotal, clienteId, trx, agora, true)
}

/**
 * A PREVIA do botao "Validar cupom" — le, nao concede.
 *
 * O QUE ELA NAO E: uma reserva. Nada e travado, nada e gravado, e o cupom que
 * ela aprova pode esgotar, expirar ou ser desativado no segundo seguinte. Quem
 * decide de verdade continua sendo `resgatarCupom`, sob trava de linha, dentro
 * da transacao que cria o pedido — e a tela que mostra esta previa tem que
 * dizer que o valor final e conferido na confirmacao.
 *
 * POR QUE ENTAO EXISTE: sem ela o comprador digita o codigo e so descobre se
 * valeu — e de quanto — depois de mandar criar o pedido. Um codigo com um
 * digito errado virava 422 na etapa de pagamento, longe do campo onde o erro
 * esta, e um desconto legitimo nao aparecia em lugar nenhum antes de a compra
 * fechar. Perguntar antes e barato; descobrir depois nao.
 */
export async function avaliarCupom(
  codigo: string,
  subtotal: Centavos,
  clienteId: string | null,
  agora: Date = new Date(),
): Promise<ResultadoCupom> {
  return validarCupom(codigo, subtotal, clienteId, getDb(), agora, false)
}

/**
 * Um cupom como o painel precisa ve-lo: a linha do banco mais a CONTAGEM DE
 * USOS, que nao existe como coluna — e derivada de `cupom_usos`, do mesmo jeito
 * que saldo de estoque e comissao sao derivados dos seus livros. Guardar um
 * contador em `cupons` criaria a segunda verdade classica: a linha diz 12, a
 * tabela de usos diz 13, e o limite passa a ser decidido por um numero que
 * ninguem sabe mais de onde veio.
 */
export type CupomAdmin = {
  id: string
  codigo: string
  tipo: TipoDesconto
  valor: number
  iniciaEm: Date
  expiraEm: Date | null
  limiteTotal: number | null
  limitePorCliente: number
  ativo: boolean
  representanteId: string | null
  representanteNome: string | null
  usos: number
  criadoEm: Date
}

/**
 * Todos os cupons, com quantas vezes cada um foi resgatado.
 *
 * LEFT JOIN, nunca INNER: um cupom recem-criado — o caso NORMAL na tela que
 * chama esta funcao — nao tem nenhum uso, e um INNER o esconderia justamente
 * de quem acabou de cria-lo e quer copiar o link.
 */
export async function listarCupons(): Promise<CupomAdmin[]> {
  const linhas = await getDb()
    .selectFrom('cupons as c')
    .leftJoin('representantes as r', 'r.id', 'c.representante_id')
    .select([
      'c.id', 'c.codigo', 'c.tipo', 'c.valor', 'c.inicia_em', 'c.expira_em',
      'c.limite_total', 'c.limite_por_cliente', 'c.ativo', 'c.representante_id',
      'c.criado_em', 'r.nome as representante_nome',
      (eb) => eb.selectFrom('cupom_usos')
        .select(sql<number>`count(*)::int`.as('n'))
        .whereRef('cupom_usos.cupom_id', '=', 'c.id')
        .as('usos'),
    ])
    .orderBy('c.criado_em', 'desc')
    .orderBy('c.id', 'desc')
    .execute()

  return linhas.map((l) => ({
    id: l.id,
    codigo: l.codigo,
    tipo: l.tipo,
    valor: l.valor,
    iniciaEm: l.inicia_em,
    expiraEm: l.expira_em,
    limiteTotal: l.limite_total,
    limitePorCliente: l.limite_por_cliente,
    ativo: l.ativo,
    representanteId: l.representante_id,
    representanteNome: l.representante_nome,
    // COALESCE do lado de ca: a subconsulta e `count(*)`, que nunca devolve
    // NULL, mas o tipo do Kysely para uma subconsulta e nullable e um `?? 0`
    // silencioso e mais honesto que um `!`.
    usos: l.usos ?? 0,
    criadoEm: l.criado_em,
  }))
}

export type NovoCupom = {
  codigo: string
  tipo: TipoDesconto
  valor: number
  expiraEm: Date | null
  limiteTotal: number | null
  limitePorCliente: number
  representanteId: string | null
}

/** Codigo ja existente. O `codigo` de `cupons` tem indice unico. */
export class CupomDuplicadoError extends Error {
  constructor(readonly codigo: string) {
    super(`Ja existe um cupom com o codigo ${codigo}.`)
    this.name = 'CupomDuplicadoError'
  }
}

/**
 * Cria o cupom.
 *
 * NAO REVALIDA O QUE O BANCO JA GARANTE. Percentual acima de 100, valor
 * negativo, janela invertida, codigo fora de `^[A-Z0-9]{3,24}$` e teto de
 * cupom fixo sao todos CHECKs da migration 1755000200000 — repetir cada regra
 * aqui criaria duas definicoes de "cupom valido" que divergem no dia em que
 * alguem mexer numa e esquecer a outra. O que esta camada faz e traduzir a
 * violacao de UNICIDADE, que e a unica que a tela precisa distinguir das
 * outras para dizer "esse codigo ja existe" em vez de "erro".
 *
 * `inicia_em` fica com o default `now()`: um cupom criado no painel vale a
 * partir do clique. Agendar inicio no futuro e um campo que ninguem pediu, e
 * a coluna aceita quando alguem pedir.
 */
export async function criarCupom(novo: NovoCupom): Promise<CupomAdmin> {
  try {
    const linha = await getDb()
      .insertInto('cupons')
      .values({
        codigo: novo.codigo.trim().toUpperCase(),
        tipo: novo.tipo,
        valor: novo.valor,
        expira_em: novo.expiraEm,
        limite_total: novo.limiteTotal,
        limite_por_cliente: novo.limitePorCliente,
        representante_id: novo.representanteId,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return {
      id: linha.id,
      codigo: linha.codigo,
      tipo: linha.tipo,
      valor: linha.valor,
      iniciaEm: linha.inicia_em,
      expiraEm: linha.expira_em,
      limiteTotal: linha.limite_total,
      limitePorCliente: linha.limite_por_cliente,
      ativo: linha.ativo,
      representanteId: linha.representante_id,
      representanteNome: null,
      usos: 0,
      criadoEm: linha.criado_em,
    }
  } catch (erro) {
    // 23505 = unique_violation. Comparar pelo CODIGO do Postgres, nunca pelo
    // texto da mensagem, que muda com a versao e com o idioma do servidor.
    if (erro instanceof Error && (erro as { code?: string }).code === '23505') {
      throw new CupomDuplicadoError(novo.codigo.trim().toUpperCase())
    }
    throw erro
  }
}

/**
 * Liga e desliga o cupom. Desligar e o botao de emergencia da campanha: o
 * link continua existindo no Instagram de quem o compartilhou, mas
 * `resgatarCupom` recusa com 'inativo' na proxima tentativa.
 *
 * NAO EXISTE APAGAR CUPOM nesta camada, de proposito. `cupom_usos` referencia
 * `cupons` com ON DELETE RESTRICT, entao apagar um cupom ja resgatado quebraria
 * a prestacao de contas de pedidos que ja foram pagos — o desconto teria
 * acontecido sem que nada dissesse mais por que. Desativar preserva o historico
 * e produz o mesmo efeito pratico.
 */
export async function definirAtivoDoCupom(id: string, ativo: boolean): Promise<boolean> {
  const r = await getDb()
    .updateTable('cupons')
    .set({ ativo })
    .where('id', '=', id)
    .executeTakeFirst()
  return Number(r.numUpdatedRows) > 0
}
