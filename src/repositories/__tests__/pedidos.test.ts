import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { criarPedido, type EntradaPedido } from '@/repositories/pedidos'
import { centavos } from '@/lib/money'

// Slug proprio deste arquivo, distinto de "maria"/"joao"/"ana"
// (representantes.test.ts) e "proxy-maria"/"proxy-ana" (proxy.test.ts). O
// Vitest roda arquivos de teste em paralelo contra o mesmo Postgres real;
// um slug exclusivo evita que este arquivo e os outros disputem a mesma
// linha de representante.
const SLUG_MARIA = 'pedido-maria'
// Representantes "coadjuvantes" usados so pelos testes do trigger, para
// tentar reatribuir um pedido para ALGUEM (o trigger tem que rejeitar antes
// que a troca se concretize). Slugs proprios e limpos no inicio de semear()
// pela mesma razao do SLUG_MARIA: se um teste falhar entre criar e apagar
// essas linhas, a proxima rodada nao pode esbarrar num slug ja usado.
const SLUGS_COADJUVANTES = ['pedido-outro', 'pedido-outro2'] as const

let idMaria: string

// "pedidos" nao tem uma coluna dona (slug, email...) para escopar um DELETE
// como nos outros arquivos — em especial os pedidos de origem 'casa' e
// 'rep_inativo' nunca tem representante_id (a constraint
// pedido_origem_coerente proibe). Por isso rastreamos aqui os ids de todo
// pedido criado com sucesso por este arquivo e apagamos exatamente essas
// linhas, em vez de um "DELETE FROM pedidos" sem filtro que poderia colidir
// com outro arquivo de teste que um dia tambem escreva em "pedidos".
let idsPedidos: string[] = []

async function criar(entrada: EntradaPedido) {
  const pedido = await criarPedido(entrada)
  idsPedidos.push(pedido.id)
  return pedido
}

async function semear() {
  const db = getDb()

  if (idsPedidos.length > 0) {
    await db.deleteFrom('pedidos').where('id', 'in', idsPedidos).execute()
    idsPedidos = []
  }
  // Cobre tambem pedidos presos a uma linha de representante de uma
  // execucao anterior interrompida antes de limpar (o rastreamento acima e
  // em memoria, nao sobrevive a reinicio do processo) — sem isso, o DELETE
  // do representante abaixo esbarraria em ON DELETE RESTRICT.
  await db
    .deleteFrom('pedidos')
    .where(
      'representante_id',
      'in',
      db.selectFrom('representantes').select('id').where('slug', '=', SLUG_MARIA),
    )
    .execute()
  await db.deleteFrom('representantes').where('slug', '=', SLUG_MARIA).execute()
  // Os coadjuvantes nunca ficam presos por ON DELETE RESTRICT: o trigger
  // rejeita a UPDATE antes que qualquer pedido chegue a apontar para eles,
  // entao um DELETE direto por slug basta.
  await db.deleteFrom('representantes').where('slug', 'in', SLUGS_COADJUVANTES).execute()

  const maria = await db
    .insertInto('representantes')
    .values({
      slug: SLUG_MARIA, codigo: 'PEDIDOMARIA', nome: 'Maria',
      email: 'pedido-maria@exemplo.com', percentual_comissao: '20.00', ativo: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  idMaria = maria.id
}

describe('criacao de pedido com atribuicao congelada', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('congela representante, percentual e UTM na criacao', async () => {
    const p = await criar({
      origem: 'link', representanteId: idMaria,
      percentualComissao: 20,
      utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
      subtotal: centavos(599.70), desconto: centavos(59.97), frete: centavos(0),
    })
    expect(p.representanteId).toBe(idMaria)
    expect(p.percentualComissaoSnapshot).toBe(20)
    expect(p.utmSource).toBe('instagram')
    expect(p.totalCentavos).toBe(53973)
  })

  it('alterar o percentual do representante NAO muda pedido ja criado', async () => {
    const p = await criar({
      origem: 'link', representanteId: idMaria, percentualComissao: 20,
      utmSource: null, utmMedium: null, utmCampaign: null,
      subtotal: centavos(100), desconto: centavos(0), frete: centavos(0),
    })
    await getDb().updateTable('representantes')
      .set({ percentual_comissao: '5.00' }).where('id', '=', idMaria).execute()

    const relido = await getDb().selectFrom('pedidos')
      .select('percentual_comissao_snapshot')
      .where('id', '=', p.id).executeTakeFirstOrThrow()
    expect(Number(relido.percentual_comissao_snapshot)).toBe(20)
  })

  it('aceita venda da casa, sem representante', async () => {
    const p = await criar({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      subtotal: centavos(199.90), desconto: centavos(0), frete: centavos(0),
    })
    expect(p.representanteId).toBeNull()
    expect(p.origem).toBe('casa')
  })

  it('registra rep_inativo em vez de perder o motivo', async () => {
    const p = await criar({
      origem: 'rep_inativo', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      subtotal: centavos(199.90), desconto: centavos(0), frete: centavos(0),
    })
    expect(p.origem).toBe('rep_inativo')
  })

  it('o banco rejeita origem link sem representante', async () => {
    await expect(criar({
      origem: 'link', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      subtotal: centavos(100), desconto: centavos(0), frete: centavos(0),
    })).rejects.toThrow(/pedido_origem_coerente/)
  })

  it('o banco rejeita total que nao fecha com as parcelas', async () => {
    await expect(
      getDb().insertInto('pedidos').values({
        origem: 'casa', subtotal_centavos: 10000, desconto_centavos: 0,
        frete_centavos: 0, total_centavos: 9999,
      }).execute(),
    ).rejects.toThrow(/pedido_total_confere/)
  })

  it('o banco rejeita desconto maior que o subtotal', async () => {
    await expect(
      getDb().insertInto('pedidos').values({
        origem: 'casa', subtotal_centavos: 1000, desconto_centavos: 2000,
        frete_centavos: 0, total_centavos: 0,
      }).execute(),
    ).rejects.toThrow(/pedido_desconto_nao_excede/)
  })

  it('impede apagar representante que ja tem pedido', async () => {
    await criar({
      origem: 'link', representanteId: idMaria, percentualComissao: 20,
      utmSource: null, utmMedium: null, utmCampaign: null,
      subtotal: centavos(100), desconto: centavos(0), frete: centavos(0),
    })
    await expect(
      getDb().deleteFrom('representantes').where('id', '=', idMaria).execute(),
    ).rejects.toThrow(/pedidos_representante_id_fkey/)
  })

  // A atribuicao congelada era, ate aqui, uma promessa de escrita: so o
  // caminho de criacao (criarPedido) nunca reescrevia essas colunas. Nada
  // impedia um UPDATE direto na linha de fora do repositorio — e pior,
  // reatribuir representante_id fazia o ON DELETE RESTRICT parar de
  // enxergar o pedido como dependente do representante ORIGINAL, liberando
  // a exclusao dele e apagando o historico da venda. O trigger
  // pedido_atribuicao_imutavel_trg (migrations/1754900300000_pedidos.sql)
  // fecha isso no banco, nao na aplicacao.
  describe('trigger que trava a atribuicao congelada contra UPDATE', () => {
    it('rejeita alterar representante_id de um pedido existente', async () => {
      const p = await criar({
        origem: 'link', representanteId: idMaria, percentualComissao: 20,
        utmSource: null, utmMedium: null, utmCampaign: null,
        subtotal: centavos(100), desconto: centavos(0), frete: centavos(0),
      })
      const outro = await getDb().insertInto('representantes').values({
        slug: 'pedido-outro', codigo: 'PEDIDOOUTRO', nome: 'Outro',
        email: 'pedido-outro@exemplo.com', percentual_comissao: '10.00', ativo: true,
      }).returning('id').executeTakeFirstOrThrow()

      await expect(
        getDb().updateTable('pedidos')
          .set({ representante_id: outro.id })
          .where('id', '=', p.id)
          .execute(),
      ).rejects.toThrow(/pedido_atribuicao_imutavel/)

      await getDb().deleteFrom('representantes').where('id', '=', outro.id).execute()
    })

    it('rejeita alterar percentual_comissao_snapshot de um pedido existente', async () => {
      const p = await criar({
        origem: 'link', representanteId: idMaria, percentualComissao: 20,
        utmSource: null, utmMedium: null, utmCampaign: null,
        subtotal: centavos(100), desconto: centavos(0), frete: centavos(0),
      })
      await expect(
        getDb().updateTable('pedidos')
          .set({ percentual_comissao_snapshot: 99 })
          .where('id', '=', p.id)
          .execute(),
      ).rejects.toThrow(/pedido_atribuicao_imutavel/)
    })

    it('rejeita alterar total_centavos de um pedido existente', async () => {
      const p = await criar({
        origem: 'casa', representanteId: null, percentualComissao: null,
        utmSource: null, utmMedium: null, utmCampaign: null,
        subtotal: centavos(100), desconto: centavos(0), frete: centavos(0),
      })
      await expect(
        getDb().updateTable('pedidos')
          .set({ total_centavos: 1 })
          .where('id', '=', p.id)
          .execute(),
      ).rejects.toThrow(/pedido_atribuicao_imutavel/)
    })

    it('permite alterar status para pago — o trigger nao pode travar a maquina de estados', async () => {
      const p = await criar({
        origem: 'link', representanteId: idMaria, percentualComissao: 20,
        utmSource: null, utmMedium: null, utmCampaign: null,
        subtotal: centavos(100), desconto: centavos(0), frete: centavos(0),
      })
      await getDb().updateTable('pedidos')
        .set({ status: 'pago' })
        .where('id', '=', p.id)
        .execute()

      const relido = await getDb().selectFrom('pedidos')
        .select('status')
        .where('id', '=', p.id).executeTakeFirstOrThrow()
      expect(relido.status).toBe('pago')
    })

    it('apos um UPDATE rejeitado, apagar o representante original continua bloqueado pela FK', async () => {
      const p = await criar({
        origem: 'link', representanteId: idMaria, percentualComissao: 20,
        utmSource: null, utmMedium: null, utmCampaign: null,
        subtotal: centavos(100), desconto: centavos(0), frete: centavos(0),
      })
      const outro = await getDb().insertInto('representantes').values({
        slug: 'pedido-outro2', codigo: 'PEDIDOOUTRO2', nome: 'Outro 2',
        email: 'pedido-outro2@exemplo.com', percentual_comissao: '10.00', ativo: true,
      }).returning('id').executeTakeFirstOrThrow()

      // A tentativa de sequestrar a atribuicao falha...
      await expect(
        getDb().updateTable('pedidos')
          .set({ representante_id: outro.id, percentual_comissao_snapshot: 1 })
          .where('id', '=', p.id)
          .execute(),
      ).rejects.toThrow(/pedido_atribuicao_imutavel/)

      // ...e por isso o pedido continua apontando para o representante
      // original: o RESTRICT ainda o ve como dependente e bloqueia a
      // exclusao. Este e o segundo tempo da exploracao que o trigger fecha:
      // sem ele, a linha acima teria sucesso e a linha abaixo NAO lancaria.
      await expect(
        getDb().deleteFrom('representantes').where('id', '=', idMaria).execute(),
      ).rejects.toThrow(/pedidos_representante_id_fkey/)

      await getDb().deleteFrom('representantes').where('id', '=', outro.id).execute()
    })
  })
})
