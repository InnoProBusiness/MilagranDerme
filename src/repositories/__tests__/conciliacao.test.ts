import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getDb, closeDb } from '@/lib/db'
import { criarPedido } from '@/repositories/pedidos'
import { conciliarPagamento } from '@/repositories/conciliacao'
import { saldoDoRepresentante, listarLancamentos } from '@/repositories/comissoes'
import { baixarEstoque, saldoDoEstoque, type CanalVenda } from '@/repositories/estoque'
import { DIAS_PARA_LIBERAR_COMISSAO } from '@/lib/comissao'
import { deInteiro } from '@/lib/money'

const PRECO_KIT = 100000
const PERCENTUAL = 20
/**
 * Os 50 kits do evento (§2/§4), o mesmo numero de
 * migrations/1755300700000_seed_estoque.sql. Os testes contam a partir desta
 * constante e nunca de um literal solto: e ela que amarra as asserções ao
 * numero que existe de verdade na caixa.
 */
const ENTRADA_PRESENCIAL = 50

let idRep: string
let idKit: string
let idVendedor: string
let idCliente: string
let idEndereco: string

/**
 * ESTE ARQUIVO NAO APAGA NADA — nem entre testes, nem ao final.
 *
 * Os outros arquivos de repositorio limpam as proprias linhas por slug. Aqui
 * isso nao e possivel: comissoes tem o trigger append-only, que recusa DELETE
 * linha a linha de proposito, e comissoes.pedido_id referencia pedidos com ON
 * DELETE RESTRICT — entao nem o pedido sai. O livro-razao de estoque, que o
 * Plano 4 trouxe para dentro desta conciliacao, tem exatamente a mesma forma
 * (estoque_movimento_append_only_trg, e estoque_movimentos.pedido_id com ON
 * DELETE RESTRICT), entao o motivo agora vale em dobro. Desligar os triggers
 * para limpar seria pior em dois sentidos: `ALTER TABLE ... DISABLE TRIGGER`
 * toma lock ACCESS EXCLUSIVE e travaria os outros arquivos que o Vitest roda em
 * paralelo, e um teste que precisa desarmar a protecao para funcionar deixa
 * de provar que a protecao existe.
 *
 * A alternativa e isolamento por identidade: cada teste ganha representante,
 * kit, vendedor, cliente e AS DUAS LINHAS DE ESTOQUE novos, todos sob o
 * namespace `conc-`/`CONC` deste arquivo e com um sufixo aleatorio proprio.
 * Toda asserção de saldo, de extrato e de estoque e escopada a essas linhas,
 * entao nem execucao anterior nem arquivo vizinho rodando em paralelo
 * interferem. O banco local acumula linhas; o de CI nasce vazio a cada rodada.
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

  const vendedor = await db.insertInto('usuarios').values({
    nome: 'Vendedor da Conciliacao', email: `conc-vendedor-${sufixo}@exemplo.com`,
    // SEGURANCA: nao e senha de ninguem e nao autentica nada — o banco nao
    // valida o formato de senha_hash (quem produz e confere e src/lib/senha.ts).
    // Esta linha existe so para satisfazer pedido_presencial_tem_vendedor.
    senha_hash: 'scrypt$16384$8$1$naoexiste$naoexiste', papel: 'vendedor', ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idVendedor = vendedor.id

  const cliente = await db.insertInto('clientes').values({
    nome: 'Cliente Conciliacao', email: `conc-cliente-${sufixo}@exemplo.com`,
    cpf: '11122233344', whatsapp: '11900000001',
  }).returning('id').executeTakeFirstOrThrow()
  idCliente = cliente.id

  const endereco = await db.insertInto('enderecos').values({
    cliente_id: idCliente, cep: '01310100', rua: 'Avenida Paulista',
    numero: '1000', bairro: 'Bela Vista', cidade: 'Sao Paulo', estado: 'SP',
  }).returning('id').executeTakeFirstOrThrow()
  idEndereco = endereco.id

  // Reproduz, para um kit descartavel, o desenho exato do seed de producao
  // (migrations/1755300700000_seed_estoque.sql): duas linhas de estoque para o
  // mesmo kit, com politicas OPOSTAS, e a carga do presencial como MOVIMENTO —
  // nao existe coluna de saldo em lugar nenhum. O canal online nasce sem
  // entrada nenhuma porque `ilimitado = true` faz o saldo deixar de ser teto, e
  // uma entrada la seria um numero sem significado.
  const presencial = await db.insertInto('estoques')
    .values({ kit_id: idKit, canal: 'presencial', ilimitado: false })
    .returning('id').executeTakeFirstOrThrow()

  await db.insertInto('estoques')
    .values({ kit_id: idKit, canal: 'online', ilimitado: true })
    .execute()

  await db.insertInto('estoque_movimentos').values({
    estoque_id: presencial.id, tipo: 'entrada', quantidade: ENTRADA_PRESENCIAL,
    motivo: 'Estoque de lancamento presencial 25/08/2026',
  }).execute()
}

/**
 * `canal` tem DEFAULT 'online' aqui porque conciliacao e, no fluxo normal, o
 * caminho do webhook de uma compra da loja: os testes de comissao que existiam
 * antes do Plano 4 nao falam de canal nenhum e continuam descrevendo esse
 * fluxo. Cada canal traz consigo a exigencia do BANCO, nao da rota:
 * pedido_online_tem_endereco (migrations/1755300100000) exige endereco na venda
 * online, e pedido_presencial_tem_vendedor (migrations/1755300300000) exige
 * vendedor na de balcao — que nao tem endereco nenhum, porque o comprador sai
 * com o kit na mao (§2/§10).
 */
async function novoPedido(comRepresentante: boolean, canal: CanalVenda = 'online') {
  return criarPedido({
    origem: comRepresentante ? 'link' : 'casa',
    canal,
    representanteId: comRepresentante ? idRep : null,
    percentualComissao: comRepresentante ? PERCENTUAL : null,
    utmSource: null, utmMedium: null, utmCampaign: null,
    desconto: deInteiro(0),
    frete: deInteiro(0),
    itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT) }],
    clienteId: idCliente,
    enderecoId: canal === 'online' ? idEndereco : null,
    vendedorId: canal === 'presencial' ? idVendedor : null,
  })
}

/** Conciliacao numa transacao propria, como as duas rotas fazem. */
function conciliar(pedidoId: string, statusPagamento: 'aprovado' | 'estornado' | 'cancelado') {
  return getDb().transaction().execute((trx) =>
    conciliarPagamento(pedidoId, statusPagamento, trx))
}

/**
 * A baixa que a venda de balcao faz NA CRIACAO do pedido
 * (src/app/api/vendas-presenciais/route.ts, §10) — antes de qualquer
 * confirmacao do provedor, porque o comprador esta na frente do vendedor. Os
 * testes que a usam sao os que provam que a conciliacao do pagamento NAO tira
 * uma segunda unidade da mesma caixa.
 */
function baixarNaCriacao(pedidoId: string) {
  return getDb().transaction().execute((trx) =>
    baixarEstoque(
      { kitId: idKit, canal: 'presencial', pedidoId, quantidade: 1, motivo: 'Venda no balcao' },
      trx,
    ))
}

async function movimentosDoPedido(pedidoId: string, tipo: 'baixa' | 'estorno') {
  return getDb().selectFrom('estoque_movimentos')
    .select(['quantidade', 'motivo'])
    .where('pedido_id', '=', pedidoId)
    .where('tipo', '=', tipo)
    .execute()
}

async function statusNoBanco(pedidoId: string) {
  const linha = await getDb().selectFrom('pedidos').select('status')
    .where('id', '=', pedidoId)
    .executeTakeFirstOrThrow()
  return linha.status
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

/**
 * Leva o presencial de ENTRADA_PRESENCIAL a zero com um movimento 'ajuste' cru
 * — a caixa do evento esvaziada, que e o cenario do ultimo teste deste arquivo.
 *
 * A quantidade sai da CONSTANTE, e nao de uma leitura de saldo: se o fixture
 * perguntasse ao proprio `saldoDoEstoque` quanto falta tirar, um defeito naquela
 * funcao produziria um estoque semeado errado e o teste passaria a nao provar
 * nada — ficaria verde sobre um estoque que na verdade ainda tinha unidade.
 * Mesmo cuidado de `deixarPresencialCom` em estoque.test.ts.
 */
async function zerarPresencial() {
  const estoque = await getDb().selectFrom('estoques').select('id')
    .where('kit_id', '=', idKit)
    .where('canal', '=', 'presencial')
    .executeTakeFirstOrThrow()

  await getDb().insertInto('estoque_movimentos').values({
    estoque_id: estoque.id, tipo: 'ajuste', quantidade: -ENTRADA_PRESENCIAL,
    motivo: 'Fixture de teste: esvaziar a caixa do evento',
  }).execute()
}

describe('conciliacao de pagamento e livro-razao de estoque', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('DINHEIRO: pagamento aprovado baixa o estoque do canal do pedido', async () => {
    // Venda de balcao atribuida a uma representante: canal 'presencial' e
    // origem 'link' ao mesmo tempo. Os dois eixos sao ORTOGONAIS e a migration
    // 1755300100000_pedidos_canal_logistica.sql explica por que — este pedido e
    // a prova de que eles convivem na mesma linha.
    const pedido = await novoPedido(true, 'presencial')

    const r = await conciliar(pedido.id, 'aprovado')

    expect(r.para).toBe('pago')
    expect(r.estoqueBaixado).toBe(true)
    expect(r.estoqueEstornado).toBe(false)
    // A comissao continua sendo creditada na mesma transacao: estoque entrou
    // ao lado do livro-razao de comissao, nao no lugar dele.
    expect(r.comissaoCreditada).toBe(20000)

    const presencial = await saldoDoEstoque(idKit, 'presencial')
    expect(presencial!.disponivel).toBe(ENTRADA_PRESENCIAL - 1)
    expect(presencial!.vendido).toBe(1)

    // §4: os dois estoques sao SEPARADOS. Uma venda de balcao nao pode tirar
    // unidade da pre-venda online, nem o contrario — a baixa vai para o canal
    // gravado no pedido, nunca para os dois.
    const online = await saldoDoEstoque(idKit, 'online')
    expect(online!.vendido).toBe(0)

    // O extrato do painel (§17) precisa dizer de qual venda saiu a unidade. O
    // vinculo forte e pedido_id; o motivo e o texto legivel ao lado dele.
    const baixas = await movimentosDoPedido(pedido.id, 'baixa')
    expect(baixas).toHaveLength(1)
    expect(baixas[0].quantidade).toBe(-1)
    expect(baixas[0].motivo).toBe(`Pedido #${pedido.numero}`)
  })

  // O TESTE MAIS IMPORTANTE DESTE ARQUIVO: e o que impede vender o mesmo kit
  // duas vezes. O Mercado Pago reenvia a mesma notificacao ate receber 2xx, e
  // reenvia de novo a cada mudanca de status — em producao isto acontece todo
  // dia. Sem esta garantia, cada reentrega de um "approved" tiraria mais uma
  // unidade da caixa: 50 kits fisicos virariam 40 no painel e o evento fecharia
  // as vendas com kit sobrando.
  it('DINHEIRO: reenvio do webhook aprovado nao baixa a mesma unidade duas vezes', async () => {
    const pedido = await novoPedido(false, 'presencial')

    const primeira = await conciliar(pedido.id, 'aprovado')
    const segunda = await conciliar(pedido.id, 'aprovado')

    expect(primeira.estoqueBaixado).toBe(true)
    // A segunda entrega para em pedidoAposPagamento (o pedido ja esta 'pago') e
    // nem chega a baixarEstoque. `estoqueBaixado` diz "esta chamada mexeu no
    // estoque", e ela nao mexeu.
    expect(segunda.mudou).toBe(false)
    expect(segunda.estoqueBaixado).toBe(false)

    // A prova de que o `false` nao foi um lancamento compensatorio silencioso:
    // existe UMA linha de baixa, nao duas que se anulam.
    expect(await movimentosDoPedido(pedido.id, 'baixa')).toHaveLength(1)
    expect((await saldoDoEstoque(idKit, 'presencial'))!.disponivel)
      .toBe(ENTRADA_PRESENCIAL - 1)
  })

  // A MESMA GARANTIA PELO OUTRO LADO, e o caminho que o evento vai percorrer 50
  // vezes: a venda de balcao baixa o estoque NA CRIACAO do pedido (§10), e o
  // pagamento so e confirmado depois. Se a conciliacao baixasse de novo ao
  // marcar 'pago', cada venda presencial consumiria DUAS unidades e a caixa
  // acabaria na metade da fila.
  it('DINHEIRO: venda presencial ja baixada na criacao nao baixa de novo ao ser paga', async () => {
    const pedido = await novoPedido(false, 'presencial')
    expect(await baixarNaCriacao(pedido.id)).toBe(true)

    const r = await conciliar(pedido.id, 'aprovado')

    // O pedido FICA PAGO: a idempotencia do estoque nao pode atrapalhar o
    // dinheiro que entrou.
    expect(r.mudou).toBe(true)
    expect(r.para).toBe('pago')
    expect(r.estoqueBaixado).toBe(false)

    expect(await movimentosDoPedido(pedido.id, 'baixa')).toHaveLength(1)
    expect((await saldoDoEstoque(idKit, 'presencial'))!.disponivel)
      .toBe(ENTRADA_PRESENCIAL - 1)
  })

  it('reembolso devolve a unidade a prateleira', async () => {
    const pedido = await novoPedido(true, 'presencial')
    await conciliar(pedido.id, 'aprovado')

    const r = await conciliar(pedido.id, 'estornado')

    expect(r.para).toBe('reembolsado')
    expect(r.estoqueEstornado).toBe(true)
    // O estorno de comissao e o de estoque acontecem na MESMA transacao: a
    // venda caiu inteira, nao pela metade.
    expect(r.comissaoEstornada).toBe(-20000)

    const saldo = await saldoDoEstoque(idKit, 'presencial')
    expect(saldo!.disponivel).toBe(ENTRADA_PRESENCIAL)
    // A baixa NAO some do extrato — o estorno soma por cima. "vendido" continua
    // 1 porque a venda existiu de verdade e depois caiu, e e essa a leitura que
    // o painel precisa dar a operacao no fim do dia.
    expect(saldo!.vendido).toBe(1)
    expect(await movimentosDoPedido(pedido.id, 'estorno')).toHaveLength(1)
  })

  it('reembolso reentregue nao devolve a mesma unidade duas vezes', async () => {
    const pedido = await novoPedido(false, 'presencial')
    await conciliar(pedido.id, 'aprovado')

    expect((await conciliar(pedido.id, 'estornado')).estoqueEstornado).toBe(true)
    expect((await conciliar(pedido.id, 'estornado')).estoqueEstornado).toBe(false)

    expect(await movimentosDoPedido(pedido.id, 'estorno')).toHaveLength(1)
    expect((await saldoDoEstoque(idKit, 'presencial'))!.disponivel)
      .toBe(ENTRADA_PRESENCIAL)
  })

  // O CASO QUE O PREDICADO DA COMISSAO NAO PEGARIA. geraEstornoDeComissao
  // (src/lib/pedido-status.ts) exige que o pedido ESTIVESSE pago, porque so
  // pedido pago gerou credito. Estoque nao segue essa regra: a venda de balcao
  // baixa na criacao, e um pagamento cancelado leva o pedido de 'pendente'
  // direto a 'cancelado' sem nunca passar por 'pago'. Se a conciliacao reusasse
  // aquele predicado, o kit ficaria sumido do sistema para sempre — parado na
  // caixa, invisivel para a proxima pessoa da fila.
  it('DINHEIRO: cancelamento devolve a unidade que a venda presencial baixou na criacao', async () => {
    const pedido = await novoPedido(false, 'presencial')
    await baixarNaCriacao(pedido.id)
    expect((await saldoDoEstoque(idKit, 'presencial'))!.disponivel)
      .toBe(ENTRADA_PRESENCIAL - 1)

    const r = await conciliar(pedido.id, 'cancelado')

    expect(r.de).toBe('pendente')
    expect(r.para).toBe('cancelado')
    expect(r.estoqueEstornado).toBe(true)
    // Nunca chegou a ser pago, entao nao havia comissao a estornar.
    expect(r.comissaoEstornada).toBeNull()

    expect((await saldoDoEstoque(idKit, 'presencial'))!.disponivel)
      .toBe(ENTRADA_PRESENCIAL)
  })

  it('cancelamento de pedido que nunca baixou estoque nao inventa estorno', async () => {
    // Caso normal do carrinho abandonado no online: o pedido existiu, nunca foi
    // pago, nunca tirou unidade nenhuma. `false` aqui e "nada a fazer".
    const pedido = await novoPedido(false)

    const r = await conciliar(pedido.id, 'cancelado')

    expect(r.para).toBe('cancelado')
    expect(r.estoqueEstornado).toBe(false)
    expect(await movimentosDoPedido(pedido.id, 'estorno')).toHaveLength(0)
  })

  // A DECISAO CRITICA DESTE ARQUIVO, POSTA A PROVA: o dinheiro JA ENTROU. Um
  // estoque insuficiente nao pode desfazer a conciliacao — se a excecao subisse,
  // o COMMIT inteiro cairia e o comprador ficaria com a cobranca no cartao e o
  // pedido em 'pendente'. Pior: a rota devolveria 5xx, o Mercado Pago
  // reentregaria, e a reentrega falharia igual, em laco.
  //
  // O preco da escolha e vender mais do que ha na caixa. Ele e pago de olhos
  // abertos e fica VISIVEL: uma linha de log aqui e um saldo que nao fecha no
  // painel de §17.
  it('DINHEIRO: estoque insuficiente NAO impede o pedido de ficar pago', async () => {
    await zerarPresencial()
    const pedido = await novoPedido(true, 'presencial')

    // O log e parte da garantia, nao ruido: e por ele que a operacao descobre a
    // divergencia. O spy tambem mantem a saida da suite limpa.
    const registros = vi.spyOn(console, 'error').mockImplementation(() => {})

    const r = await conciliar(pedido.id, 'aprovado')

    expect(r.mudou).toBe(true)
    expect(r.para).toBe('pago')
    expect(r.estoqueBaixado).toBe(false)
    // A comissao da representante e creditada do mesmo jeito: a venda
    // aconteceu, o dinheiro entrou, e nada disso depende do estoque fechar.
    expect(r.comissaoCreditada).toBe(20000)

    // A PROVA DE QUE A TRANSACAO COMMITOU, e nao so de que a funcao devolveu um
    // objeto bonito: o status esta gravado no banco. Se o EstoqueInsuficiente
    // tivesse subido, esta leitura devolveria 'pendente'.
    expect(await statusNoBanco(pedido.id)).toBe('pago')
    expect(await listarLancamentos(idRep)).toHaveLength(1)

    // Nenhum movimento gravado, e o saldo fica em ZERO — nunca em -1. Um teto
    // rigido que aceita negativo nao e teto.
    expect(await movimentosDoPedido(pedido.id, 'baixa')).toHaveLength(0)
    expect((await saldoDoEstoque(idKit, 'presencial'))!.disponivel).toBe(0)

    expect(registros).toHaveBeenCalledTimes(1)
    // SEGURANCA: so `error.message` vai para o log. Nunca o objeto de erro cru
    // e nunca `error.detail` do Postgres, que carrega a linha inteira — nome,
    // CPF e whatsapp do comprador iriam para o stdout do container e dali para
    // o log agregado do Swarm.
    expect(String(registros.mock.calls[0][1])).toContain('estoque_insuficiente')
    expect(String(registros.mock.calls[0][1])).not.toContain('11122233344')

    registros.mockRestore()
  })
})
