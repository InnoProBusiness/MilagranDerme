import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getDb, closeDb } from '@/lib/db'
import { criarPedido } from '@/repositories/pedidos'
import { conciliarPagamento } from '@/repositories/conciliacao'
import { saldoDoRepresentante, listarLancamentos } from '@/repositories/comissoes'
import { DIAS_PARA_LIBERAR_COMISSAO } from '@/lib/comissao'
import { deInteiro } from '@/lib/money'

const PRECO_KIT = 100000
const PERCENTUAL = 20

let idRep: string
let idKit: string

/**
 * ESTE ARQUIVO NAO APAGA NADA — nem entre testes, nem ao final.
 *
 * Os outros arquivos de repositorio limpam as proprias linhas por slug. Aqui
 * isso nao e possivel: comissoes tem o trigger append-only, que recusa DELETE
 * linha a linha de proposito, e comissoes.pedido_id referencia pedidos com ON
 * DELETE RESTRICT — entao nem o pedido sai. Desligar o trigger para limpar
 * seria pior em dois sentidos: `ALTER TABLE ... DISABLE TRIGGER` toma lock
 * ACCESS EXCLUSIVE e travaria os outros arquivos que o Vitest roda em
 * paralelo, e um teste que precisa desarmar a protecao para funcionar deixa
 * de provar que a protecao existe.
 *
 * A alternativa e isolamento por identidade: cada teste ganha representante e
 * kit novos, com sufixo unico. Toda asserção de saldo e de extrato e escopada
 * a esse representante, entao linha de execucao anterior nao interfere. O
 * banco local acumula linhas; o de CI nasce vazio a cada rodada.
 */
async function semear() {
  const db = getDb()
  const sufixo = randomUUID().slice(0, 8)

  const rep = await db.insertInto('representantes').values({
    slug: `conc-${sufixo}`, codigo: `CONC${sufixo.toUpperCase()}`,
    nome: 'Maria Conciliacao', email: `conc-${sufixo}@exemplo.com`,
    percentual_comissao: PERCENTUAL,
  }).returning('id').executeTakeFirstOrThrow()
  idRep = rep.id

  const kit = await db.insertInto('kits').values({
    slug: `conc-kit-${sufixo}`, nome: 'Kit Conciliacao', sku: `CONC-${sufixo}`,
    preco_centavos: PRECO_KIT, unidades: 1,
  }).returning('id').executeTakeFirstOrThrow()
  idKit = kit.id
}

async function novoPedido(comRepresentante: boolean) {
  return criarPedido({
    origem: comRepresentante ? 'link' : 'casa',
    representanteId: comRepresentante ? idRep : null,
    percentualComissao: comRepresentante ? PERCENTUAL : null,
    utmSource: null, utmMedium: null, utmCampaign: null,
    desconto: deInteiro(0),
    frete: deInteiro(0),
    itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT) }],
  })
}

describe('conciliacao de pagamento e livro-razao', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('pagamento aprovado credita comissao sobre subtotal menos desconto', async () => {
    const pedido = await novoPedido(true)
    const agora = new Date('2026-08-12T15:00:00Z')

    const r = await getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'aprovado', trx, agora))

    expect(r.mudou).toBe(true)
    expect(r.para).toBe('pago')
    // 20% de R$ 1.000,00
    expect(r.comissaoCreditada).toBe(20000)

    const lancamentos = await listarLancamentos(idRep)
    expect(lancamentos).toHaveLength(1)
    expect(lancamentos[0].tipo).toBe('credito')
    // A carencia sai de pago_em, nao da data de criacao do pedido.
    expect(lancamentos[0].disponivelEm.getTime()).toBe(
      agora.getTime() + DIAS_PARA_LIBERAR_COMISSAO * 24 * 60 * 60 * 1000,
    )
  })

  // O CASO QUE O MERCADO PAGO PRODUZ EM PRODUCAO TODO DIA: a notificacao e
  // reenviada ate receber 2xx, e reenviada de novo a cada mudanca de status.
  it('segunda notificacao de aprovado nao credita comissao de novo', async () => {
    const pedido = await novoPedido(true)

    await getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'aprovado', trx))
    const segunda = await getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'aprovado', trx))

    expect(segunda.mudou).toBe(false)
    expect(segunda.comissaoCreditada).toBeNull()

    const saldo = await saldoDoRepresentante(idRep)
    expect(saldo.totalCreditado).toBe(20000)
  })

  // A PROVA DE QUE O `FOR UPDATE` E CARGA, NAO DECORACAO.
  //
  // Um `Promise.all` com as duas transacoes NAO serve aqui: foi o que este
  // teste fazia antes, e ele continuava verde com o `.forUpdate()` removido —
  // as duas transacoes acabavam serializando por conta do escalonamento do
  // event loop, e o teste nao distinguia nada.
  //
  // Este aqui e deterministico: a transacao A le, atualiza e credita, mas fica
  // presa antes do COMMIT por uma barreira explicita. So entao B comeca. Com o
  // lock, B bloqueia no SELECT ... FOR UPDATE ate A commitar e, quando enfim
  // le, ve status 'pago' e vira no-op. SEM o lock, B le o status antigo,
  // decide transitar, e o INSERT do segundo credito viola
  // comissao_um_credito_por_pedido — `await b` rejeita e o teste falha.
  it('conciliacao concorrente bloqueia no lock e nao credita duas vezes', async () => {
    const pedido = await novoPedido(true)

    let liberarA!: () => void
    const aPodeCommitar = new Promise<void>((r) => { liberarA = r })
    let sinalizarQueALeu!: () => void
    const aJaCreditou = new Promise<void>((r) => { sinalizarQueALeu = r })

    const a = getDb().transaction().execute(async (trx) => {
      const r = await conciliarPagamento(pedido.id, 'aprovado', trx)
      sinalizarQueALeu()
      await aPodeCommitar
      return r
    })

    // A ja creditou e ainda segura o lock: e exatamente a janela em que a
    // segunda entrega do webhook chega em producao.
    await aJaCreditou
    const b = getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'aprovado', trx))

    // ESTA PAUSA E O QUE DA SENTIDO AO TESTE, e nao um contorno de
    // flakiness. `b` acima e so uma Promise criada: nada garante que a
    // transacao dela ja tenha chegado a emitir o primeiro SELECT. Sem a
    // pausa, `liberarA()` roda antes disso, A commita, e B acaba lendo
    // 'pago' de qualquer jeito — inclusive sem lock nenhum. Foi exatamente
    // assim que a primeira versao deste teste ficou verde com o
    // `.forUpdate()` removido do repositorio.
    //
    // Com a pausa, B chega ao SELECT enquanto A ainda segura a linha: com o
    // lock B bloqueia ali e so le depois do COMMIT (virando no-op); sem o
    // lock B le 'pendente', segue em frente e o INSERT do segundo credito
    // viola comissao_um_credito_por_pedido, derrubando o teste.
    await new Promise((r) => setTimeout(r, 300))

    liberarA()
    const resultadoA = await a
    const resultadoB = await b

    expect(resultadoA.comissaoCreditada).toBe(20000)
    expect(resultadoB.mudou).toBe(false)
    expect(resultadoB.comissaoCreditada).toBeNull()

    const saldo = await saldoDoRepresentante(idRep)
    expect(saldo.totalCreditado).toBe(20000)
    expect(await listarLancamentos(idRep)).toHaveLength(1)
  })

  it('venda da casa nao gera lancamento nenhum', async () => {
    const pedido = await novoPedido(false)

    const r = await getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'aprovado', trx))

    expect(r.para).toBe('pago')
    expect(r.comissaoCreditada).toBeNull()
    expect(await listarLancamentos(idRep)).toHaveLength(0)
  })

  it('reembolso estorna o credito e zera o saldo do representante', async () => {
    const pedido = await novoPedido(true)

    await getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'aprovado', trx))
    const r = await getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'estornado', trx))

    expect(r.para).toBe('reembolsado')
    expect(r.comissaoEstornada).toBe(-20000)

    const saldo = await saldoDoRepresentante(idRep)
    expect(saldo.disponivel + saldo.pendente).toBe(0)
  })

  // Se o estorno carimbasse now() em vez de copiar o disponivel_em do
  // credito, o representante ficaria com disponivel NEGATIVO e pendente
  // POSITIVO pelo mesmo valor — para uma venda que deixou de existir.
  it('estorno anula o credito dentro do mesmo balde de carencia', async () => {
    const pedido = await novoPedido(true)
    const pagoEm = new Date('2026-08-12T15:00:00Z')

    await getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'aprovado', trx, pagoEm))
    await getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'estornado', trx))

    // Instante ainda dentro da carencia: os dois lancamentos vivem no
    // pendente e se cancelam la, sem tocar no disponivel.
    const durante = new Date(pagoEm.getTime() + 5 * 24 * 60 * 60 * 1000)
    const saldo = await saldoDoRepresentante(idRep, durante)
    expect(saldo.pendente).toBe(0)
    expect(saldo.disponivel).toBe(0)
  })

  it('comissao fica pendente antes dos 30 dias e disponivel depois', async () => {
    const pedido = await novoPedido(true)
    const pagoEm = new Date('2026-08-12T15:00:00Z')

    await getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'aprovado', trx, pagoEm))

    const dia29 = new Date(pagoEm.getTime() + 29 * 24 * 60 * 60 * 1000)
    const antes = await saldoDoRepresentante(idRep, dia29)
    expect(antes.pendente).toBe(20000)
    expect(antes.disponivel).toBe(0)

    const dia31 = new Date(pagoEm.getTime() + 31 * 24 * 60 * 60 * 1000)
    const depois = await saldoDoRepresentante(idRep, dia31)
    expect(depois.pendente).toBe(0)
    expect(depois.disponivel).toBe(20000)
  })

  it('livro-razao recusa UPDATE: corrigir e lancar o oposto', async () => {
    const pedido = await novoPedido(true)
    await getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'aprovado', trx))

    await expect(
      getDb().updateTable('comissoes')
        .set({ valor_centavos: 999999 })
        .where('pedido_id', '=', pedido.id)
        .execute(),
    ).rejects.toThrow(/comissao_append_only/)
  })

  it('livro-razao recusa DELETE', async () => {
    const pedido = await novoPedido(true)
    await getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'aprovado', trx))

    await expect(
      getDb().deleteFrom('comissoes').where('pedido_id', '=', pedido.id).execute(),
    ).rejects.toThrow(/comissao_append_only/)
  })

  it('banco recusa um segundo credito para o mesmo pedido', async () => {
    const pedido = await novoPedido(true)
    await getDb().transaction().execute((trx) =>
      conciliarPagamento(pedido.id, 'aprovado', trx))

    await expect(
      getDb().insertInto('comissoes').values({
        representante_id: idRep, pedido_id: pedido.id, tipo: 'credito',
        valor_centavos: 20000, disponivel_em: new Date(),
      }).execute(),
    ).rejects.toThrow(/comissao_um_credito_por_pedido/)
  })

  it('banco recusa credito com valor negativo', async () => {
    const pedido = await novoPedido(true)
    await expect(
      getDb().insertInto('comissoes').values({
        representante_id: idRep, pedido_id: pedido.id, tipo: 'credito',
        valor_centavos: -1, disponivel_em: new Date(),
      }).execute(),
    ).rejects.toThrow(/comissao_sinal_confere/)
  })
})
