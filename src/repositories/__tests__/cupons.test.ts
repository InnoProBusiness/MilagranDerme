import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { resgatarCupom } from '@/repositories/cupons'
import { criarPedido } from '@/repositories/pedidos'
import { deInteiro } from '@/lib/money'

const CODIGOS = ['MARIA10', 'FIXO50', 'RUIM', 'FIXOTETO']

async function limpar() {
  const db = getDb()
  await db.deleteFrom('cupons').where('codigo', 'in', CODIGOS).execute()
}

describe('schema de cupons', () => {
  beforeEach(limpar)
  afterAll(async () => { await closeDb() })

  it('aceita cupom percentual valido', async () => {
    await getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'percentual', valor: 10 }).execute()
    const c = await getDb().selectFrom('cupons').selectAll()
      .where('codigo', '=', 'MARIA10').executeTakeFirstOrThrow()
    expect(c.limite_por_cliente).toBe(1)
    expect(c.ativo).toBe(true)
  })

  it('rejeita percentual acima de 100', async () => {
    await expect(getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'percentual', valor: 150 }).execute(),
    ).rejects.toThrow(/cupom_percentual_valido/)
  })

  it('aceita desconto fixo acima de 100 — sao centavos, nao porcentagem', async () => {
    await getDb().insertInto('cupons')
      .values({ codigo: 'FIXO50', tipo: 'fixo', valor: 5000 }).execute()
    const c = await getDb().selectFrom('cupons').select('valor')
      .where('codigo', '=', 'FIXO50').executeTakeFirstOrThrow()
    expect(c.valor).toBe(5000)
  })

  it('rejeita codigo minusculo', async () => {
    await expect(getDb().insertInto('cupons')
      .values({ codigo: 'maria10', tipo: 'percentual', valor: 10 }).execute(),
    ).rejects.toThrow(/cupom_codigo_formato/)
  })

  it('rejeita codigo duplicado', async () => {
    await getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'percentual', valor: 10 }).execute()
    await expect(getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'fixo', valor: 500 }).execute(),
    ).rejects.toThrow(/cupom_codigo_unico/)
  })

  it('rejeita janela invertida', async () => {
    await expect(getDb().insertInto('cupons').values({
      codigo: 'RUIM', tipo: 'percentual', valor: 10,
      inicia_em: new Date('2026-09-01'), expira_em: new Date('2026-08-01'),
    }).execute()).rejects.toThrow(/cupom_janela_coerente/)
  })

  it('rejeita limite por cliente zero', async () => {
    await expect(getDb().insertInto('cupons').values({
      codigo: 'RUIM', tipo: 'percentual', valor: 10, limite_por_cliente: 0,
    }).execute()).rejects.toThrow(/cupom_limites_positivos/)
  })

  // cupom_fixo_teto: limite operacional de sanidade contra erro de
  // digitacao num cupom fixo (um zero a mais cria um cupom que zera
  // qualquer pedido realista). Nao e regra de negocio — ver comentario na
  // migration. Os dois lados do teto de 10_000_000 centavos (R$ 100.000,00)
  // ficam cobertos abaixo.
  it('aceita fixo exatamente no teto de 10.000.000 centavos', async () => {
    await getDb().insertInto('cupons')
      .values({ codigo: 'FIXOTETO', tipo: 'fixo', valor: 10_000_000 }).execute()
    const c = await getDb().selectFrom('cupons').select('valor')
      .where('codigo', '=', 'FIXOTETO').executeTakeFirstOrThrow()
    expect(c.valor).toBe(10_000_000)
  })

  it('rejeita fixo um centavo acima do teto', async () => {
    await expect(getDb().insertInto('cupons').values({
      codigo: 'FIXOTETO', tipo: 'fixo', valor: 10_000_001,
    }).execute()).rejects.toThrow(/cupom_fixo_teto/)
  })

  it('cupom percentual nao e afetado pelo teto de fixo', async () => {
    // 100 e o maximo que cupom_percentual_valido permite para percentual —
    // muito abaixo de 10_000_000. Se cupom_fixo_teto estivesse mal escrito
    // (sem o "tipo <> 'fixo' OR"), este INSERT continuaria passando de
    // qualquer forma, entao o que prova a independencia entre as duas
    // constraints e a leitura da CHECK na migration, nao este teste sozinho.
    await getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'percentual', valor: 100 }).execute()
    const c = await getDb().selectFrom('cupons').select('valor')
      .where('codigo', '=', 'MARIA10').executeTakeFirstOrThrow()
    expect(c.valor).toBe(100)
  })
})

// Slugs e codigos proprios deste describe, distintos dos usados em
// representantes.test.ts ('maria'/'joao'/'ana'/'rep-carimbo') e
// pedidos.test.ts ('pedido-maria'/'pedido-outro'/'pedido-outro2') — o
// Vitest roda arquivos de teste em paralelo contra o mesmo Postgres real,
// mas dentro de UM arquivo os describes rodam em sequencia; ainda assim
// cada fixture usa um slug/codigo exclusivo para nao colidir com outro
// arquivo que rode ao mesmo tempo.
const SLUG_REP_ATIVA = 'cupom-rep-ativa'
const SLUG_REP_INATIVA = 'cupom-rep-inativa'
const SLUGS_REP_RESGATE = [SLUG_REP_ATIVA, SLUG_REP_INATIVA] as const
const SLUG_KIT_RESGATE = 'cupom-kit'
const NOME_KIT_RESGATE = 'Kit Cupom'
const PRECO_KIT_RESGATE_CENTAVOS = 100000
const EMAIL_CLIENTE_RESGATE = 'cupom-cliente@exemplo.com'
const CPF_CLIENTE_RESGATE = '11122233344'
const CODIGOS_RESGATE = ['MARIA10', 'EXPIRADO', 'DESLIGADO', 'LIMITE1'] as const

/**
 * `inicia_em` EXPLICITAMENTE NO PASSADO nos cupons que precisam estar valendo.
 *
 * O default da coluna e `now()`, que e o relogio do POSTGRES; `resgatarCupom`
 * compara com o `agora` que recebe, que e o relogio do NODE. Os dois processos
 * nao estao sincronizados: medido em 17/08/2026 nesta maquina, o Postgres do
 * container estava 11 ms adiantado. Um cupom inserido com o default nasce,
 * portanto, alguns milissegundos no futuro para quem o resgata — e o resgate
 * imediato do teste devolvia `nao_iniciado` em vez do motivo sob teste.
 *
 * Ficava verde rodando o arquivo sozinho e vermelho na suite inteira, que e o
 * pior tipo de teste: some quando voce vai investigar. Nao e defeito de
 * produto — cupom real e criado com antecedencia, nao milissegundos antes da
 * primeira venda —, e sim um fixture que dependia de dois relogios coincidirem.
 *
 * A data fixa tambem diz melhor o que o fixture quer: "este cupom ja esta
 * valendo", e nao "este cupom comeca exatamente agora".
 */
const JA_VALENDO = new Date('2026-01-01T00:00:00Z')

describe('resgate de cupom', () => {
  let idCliente: string
  let idEndereco: string
  let idCupomMaria: string
  let idPedido: string
  let idKit: string

  // Pedidos criados DENTRO de um teste (o teste de concorrencia insere um
  // pedido cru via trx, fora de criarPedido) sao rastreados aqui e apagados
  // no comeco do proximo beforeEach — mesmo raciocinio de idsPedidos em
  // pedidos.test.ts: "pedidos" nao tem coluna dona para escopar um DELETE.
  let idsPedidosCriadosNoTeste: string[] = []

  async function limparResgate() {
    const db = getDb()

    if (idsPedidosCriadosNoTeste.length > 0) {
      await db.deleteFrom('pedidos').where('id', 'in', idsPedidosCriadosNoTeste).execute()
      idsPedidosCriadosNoTeste = []
    }
    // Orfaos de uma execucao anterior interrompida antes de limpar: qualquer
    // pedido ainda preso ao kit deste describe via pedido_itens
    // (pedido_itens.kit_id e ON DELETE RESTRICT, entao precisa sumir antes
    // do DELETE do kit mais abaixo). pedidos ON DELETE CASCADE leva os
    // pedido_itens e os cupom_usos (pedido_id) junto.
    await db.deleteFrom('pedidos').where('id', 'in',
      db.selectFrom('pedido_itens').select('pedido_id').where(
        'kit_id', 'in',
        db.selectFrom('kits').select('id').where('slug', '=', SLUG_KIT_RESGATE),
      ),
    ).execute()

    // cupom_usos.cupom_id e cupom_usos.cliente_id sao ON DELETE RESTRICT:
    // tem que sumir antes de apagar os cupons e o cliente deste describe.
    await db.deleteFrom('cupom_usos').where('cupom_id', 'in',
      db.selectFrom('cupons').select('id').where('codigo', 'in', CODIGOS_RESGATE),
    ).execute()
    await db.deleteFrom('cupom_usos').where('cliente_id', 'in',
      db.selectFrom('clientes').select('id').where('email', '=', EMAIL_CLIENTE_RESGATE),
    ).execute()

    await db.deleteFrom('cupons').where('codigo', 'in', CODIGOS_RESGATE).execute()
    await db.deleteFrom('clientes').where('email', '=', EMAIL_CLIENTE_RESGATE).execute()
    // cupons.representante_id e ON DELETE RESTRICT: os cupons deste
    // describe ja sumiram acima, entao os representantes ficam livres.
    await db.deleteFrom('representantes').where('slug', 'in', SLUGS_REP_RESGATE).execute()
    await db.deleteFrom('kits').where('slug', '=', SLUG_KIT_RESGATE).execute()
  }

  beforeEach(async () => {
    await limparResgate()
    const db = getDb()

    const repAtiva = await db.insertInto('representantes').values({
      slug: SLUG_REP_ATIVA, codigo: 'CUPOMREPATIVA', nome: 'Representante Ativa',
      email: 'cupom-rep-ativa@exemplo.com', percentual_comissao: '20.00', ativo: true,
    }).returning('id').executeTakeFirstOrThrow()

    const repInativa = await db.insertInto('representantes').values({
      slug: SLUG_REP_INATIVA, codigo: 'CUPOMREPINATIVA', nome: 'Representante Desligada',
      email: 'cupom-rep-inativa@exemplo.com', percentual_comissao: '20.00', ativo: false,
    }).returning('id').executeTakeFirstOrThrow()

    const kit = await db.insertInto('kits').values({
      slug: SLUG_KIT_RESGATE, nome: NOME_KIT_RESGATE, preco_centavos: PRECO_KIT_RESGATE_CENTAVOS,
      unidades: 1, sku: 'MG-CUPOM-KIT', ordem: 99, ativo: true,
    }).returning('id').executeTakeFirstOrThrow()
    idKit = kit.id

    const cliente = await db.insertInto('clientes').values({
      nome: 'Cliente Cupom', email: EMAIL_CLIENTE_RESGATE, cpf: CPF_CLIENTE_RESGATE,
      whatsapp: '11900000001',
    }).returning('id').executeTakeFirstOrThrow()
    idCliente = cliente.id

    // Endereco passou a ser exigido pelo banco em pedido do canal online
    // (constraint pedido_online_tem_endereco, em
    // migrations/1755300100000_pedidos_canal_logistica.sql). O pedido logo
    // abaixo existe so para o teste de limite por cliente, mas continua sendo
    // um pedido online de verdade e precisa ter para onde ser despachado.
    // Nao entra em limparResgate: enderecos.cliente_id e ON DELETE CASCADE,
    // entao o DELETE do cliente ja leva esta linha junto.
    const endereco = await db.insertInto('enderecos').values({
      cliente_id: cliente.id, cep: '01310100', rua: 'Avenida Paulista',
      numero: '1000', bairro: 'Bela Vista', cidade: 'Sao Paulo', estado: 'SP',
    }).returning('id').executeTakeFirstOrThrow()
    idEndereco = endereco.id

    // representante ativo — o link do cupom para comissao continua valendo.
    const cupomMaria = await db.insertInto('cupons').values({
      codigo: 'MARIA10', tipo: 'percentual', valor: 10, representante_id: repAtiva.id,
      ativo: true, inicia_em: JA_VALENDO,
    }).returning('id').executeTakeFirstOrThrow()
    idCupomMaria = cupomMaria.id

    // janela inteiramente no passado: inicia_em < expira_em < agora.
    await db.insertInto('cupons').values({
      codigo: 'EXPIRADO', tipo: 'percentual', valor: 10,
      inicia_em: new Date('2020-01-01T00:00:00Z'), expira_em: new Date('2020-02-01T00:00:00Z'),
    }).execute()

    // o cupom em si continua ativo — e o REPRESENTANTE que saiu da operacao.
    // Se o cupom estivesse inativo, o teste nao provaria nada sobre o
    // caminho representante_inativo especificamente.
    await db.insertInto('cupons').values({
      codigo: 'DESLIGADO', tipo: 'percentual', valor: 10, representante_id: repInativa.id,
      ativo: true, inicia_em: JA_VALENDO,
    }).execute()

    await db.insertInto('cupons').values({
      codigo: 'LIMITE1', tipo: 'percentual', valor: 10, limite_total: 1, inicia_em: JA_VALENDO,
    }).execute()

    // Pedido existente para o teste de limite por cliente: precisa de ao
    // menos um item (pedido_itens_obrigatorios_trg), entao usa criarPedido
    // em vez de um INSERT cru — ver nota no topo do arquivo pedidos.test.ts.
    const pedido = await criarPedido({
      // `canal` e obrigatorio desde o Plano 4 e e um eixo INDEPENDENTE de
      // `origem`: origem e atribuicao de comissao (quem trouxe a venda),
      // canal e onde a venda aconteceu. Ver o CHECK pedido_origem_coerente em
      // migrations/1754900300000_pedidos.sql, que amarra cada valor de origem
      // a presenca ou ausencia de representante_id — e por isso que
      // 'presencial' nunca podia entrar naquele ENUM.
      canal: 'online',
      tipoEntrega: 'envio',
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: deInteiro(0), frete: deInteiro(0),
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_RESGATE_CENTAVOS) }],
      clienteId: idCliente,
      enderecoId: idEndereco,
    })
    idPedido = pedido.id
  })

  afterAll(async () => {
    await limparResgate()
    await closeDb()
  })

  it('aceita cupom valido e calcula o desconto', async () => {
    const r = await getDb().transaction().execute((trx) =>
      resgatarCupom('MARIA10', deInteiro(300000), idCliente, trx))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.cupom.desconto).toBe(30000)
  })

  it('recusa cupom inexistente', async () => {
    const r = await getDb().transaction().execute((trx) =>
      resgatarCupom('NAOEXISTE', deInteiro(100000), idCliente, trx))
    expect(r).toEqual({ ok: false, motivo: 'inexistente' })
  })

  it('recusa cupom expirado', async () => {
    const r = await getDb().transaction().execute((trx) =>
      resgatarCupom('EXPIRADO', deInteiro(100000), idCliente, trx))
    expect(r).toEqual({ ok: false, motivo: 'expirado' })
  })

  it('recusa cupom de representante DESLIGADO', async () => {
    // Restricao herdada do Plano 1: origem rep_inativo degrada o caminho do
    // link; o cupom precisa do equivalente, senao credita comissao a quem
    // nao esta mais na operacao.
    const r = await getDb().transaction().execute((trx) =>
      resgatarCupom('DESLIGADO', deInteiro(100000), idCliente, trx))
    expect(r).toEqual({ ok: false, motivo: 'representante_inativo' })
  })

  it('recusa quando o cliente ja usou o cupom', async () => {
    await getDb().insertInto('cupom_usos')
      .values({ cupom_id: idCupomMaria, pedido_id: idPedido, cliente_id: idCliente })
      .execute()
    const r = await getDb().transaction().execute((trx) =>
      resgatarCupom('MARIA10', deInteiro(100000), idCliente, trx))
    expect(r).toEqual({ ok: false, motivo: 'limite_do_cliente' })
  })

  it('DINHEIRO: dois resgates simultaneos nao estouram o limite total', async () => {
    // limite_total = 1. Sem a trava na linha do cupom, os dois leem
    // "0 usos" e os dois passam.
    const rodar = () => getDb().transaction().execute(async (trx) => {
      const r = await resgatarCupom('LIMITE1', deInteiro(100000), idCliente, trx)
      if (r.ok) {
        await new Promise((res) => setTimeout(res, 50))
        // cliente_id/endereco_id nao sao enfeite: pedido_online_tem_endereco
        // (migrations/1755300100000_pedidos_canal_logistica.sql) recusa
        // pedido do canal online — que e o DEFAULT da coluna — sem endereco
        // de entrega. Este INSERT e cru de proposito (o teste precisa da
        // linha dentro da transacao do resgate, sem passar por criarPedido),
        // entao ele carrega a mao o que o resto do arquivo ja obtem de graca.
        const pedido = await trx.insertInto('pedidos').values({
          origem: 'casa', subtotal_centavos: 100000, desconto_centavos: 0,
          frete_centavos: 0, total_centavos: 100000,
          cliente_id: idCliente, endereco_id: idEndereco,
        }).returning('id').executeTakeFirstOrThrow()
        // pedido_itens_obrigatorios_trg (Tarefa 1) exige ao menos um item no
        // COMMIT desta transacao — um INSERT INTO pedidos cru, sem item,
        // faria o COMMIT inteiro falhar mesmo para o resgate vencedor. Ver
        // nota no topo de pedidos.test.ts.
        await trx.insertInto('pedido_itens').values({
          pedido_id: pedido.id, kit_id: idKit, nome_snapshot: NOME_KIT_RESGATE,
          preco_unitario_centavos: PRECO_KIT_RESGATE_CENTAVOS, quantidade: 1,
          total_centavos: PRECO_KIT_RESGATE_CENTAVOS,
        }).execute()
        await trx.insertInto('cupom_usos').values({
          cupom_id: r.cupom.id, pedido_id: pedido.id, cliente_id: idCliente,
        }).execute()
        idsPedidosCriadosNoTeste.push(pedido.id)
      }
      return r
    })

    const [a, b] = await Promise.all([rodar(), rodar()])
    const aceitos = [a, b].filter((r) => r.ok).length
    expect(aceitos).toBe(1)
  })
})
