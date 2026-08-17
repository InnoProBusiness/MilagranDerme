import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getDb, closeDb } from '@/lib/db'
import {
  criarPedido, avancarStatusDoPedido, registrarRastreio,
  listarVendasAdmin, listarLogisticaAdmin, listarCompradores, resumoDeVendas,
  PrecoDivergenteError, TransicaoInvalidaError, TransicaoFinanceiraError,
  type EntradaPedido, type PedidoStatus,
} from '@/repositories/pedidos'
import { centavos, deInteiro } from '@/lib/money'
import { sql } from 'kysely'

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
// Kit proprio deste arquivo, distinto de "kit-1"/"kit-3"/"kit-antigo"/
// "kit-carimbo"/"kit-gratis" (produtos.test.ts). criarPedido agora exige
// pelo menos um item, e cada item referencia um kit real — este arquivo nao
// pode disputar nem apagar as linhas de kits que produtos.test.ts usa.
const SLUG_KIT = 'pedido-kit-milagran'
const NOME_KIT = 'Kit Milagran'
// O preco que o catalogo tem AGORA para SLUG_KIT (semeado abaixo). Os
// testes de snapshot usam esta constante — nunca um literal solto — tanto
// para semear a linha de kits quanto para montar o item de EntradaPedido e
// para as asserções, deixando explicito que o valor gravado em
// pedido_itens veio de conferir contra ESTE numero, nao de coincidencia
// entre dois literais escritos a mao.
const PRECO_KIT_CENTAVOS = 100000

// Comprador, endereco e vendedor proprios deste arquivo. Eles NAO sao enfeite
// de cenario: viraram exigencia de BANCO com o Plano 4, e sem eles nem os
// testes que nada tem a ver com canal conseguem mais criar um pedido.
//
// pedido_online_tem_endereco (migrations/1755300100000_pedidos_canal_logistica.sql)
// recusa todo pedido de canal 'online' sem endereco_id — e 'online' e o canal
// de todo pedido que este arquivo criava antes deste plano. Por isso cada
// chamada a criarPedido abaixo ganhou `canal`, `clienteId` e `enderecoId`: nao
// e ruido, e o que faz o INSERT passar.
//
// pedido_presencial_tem_vendedor (migrations/1755300300000_usuarios_sessoes.sql)
// fecha o outro lado: venda de balcao sem vendedor_id e recusada.
//
// Os e-mails levam o prefixo deste arquivo pelo mesmo motivo dos slugs acima:
// cliente_email_unico e usuario_email_unico sao indices unicos GLOBAIS, e os
// arquivos de teste rodam em paralelo contra o mesmo Postgres.
const EMAIL_COMPRADOR = 'pedido-comprador@exemplo.com'
// So digitos: cliente_cpf_digitos (migrations/1755000100000_clientes.sql) exige
// exatamente 11. Este numero existe para ser procurado nas respostas das
// leituras administrativas e NAO ser encontrado — ver os testes LGPD: la
// embaixo.
const CPF_COMPRADOR = '39053344705'
const EMAIL_VENDEDOR = 'pedido-vendedor@exemplo.com'
// Este arquivo nunca autentica ninguem: a linha de usuarios existe apenas para
// o FK de pedidos.vendedor_id ter para onde apontar. O formato de verdade
// (scrypt$N$r$p$<salt>$<hash>, src/lib/senha.ts) e asseverado em
// src/repositories/__tests__/usuarios.test.ts, que e o arquivo que testa senha.
const SENHA_HASH_INERTE = 'scrypt$16384$8$1$nao-usado$nao-usado'

let idMaria: string
let idKit: string
let idCliente: string
let idEndereco: string
let idVendedor: string

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

  // pagamentos.pedido_id e ON DELETE RESTRICT
  // (migrations/1755200000000_pagamentos.sql): as tentativas de pagamento que
  // os testes de resumoDeVendas inserem seguram o pedido e fariam TODOS os
  // DELETEs abaixo falharem na rodada seguinte. Vem antes de tudo, e escopado
  // pelos pedidos que carregam um item do kit deste arquivo — nunca um
  // "DELETE FROM pagamentos" sem filtro, que apagaria as linhas de
  // conciliacao.test.ts rodando em paralelo.
  await db
    .deleteFrom('pagamentos')
    .where(
      'pedido_id',
      'in',
      db
        .selectFrom('pedido_itens')
        .select('pedido_id')
        .where(
          'kit_id',
          'in',
          db.selectFrom('kits').select('id').where('slug', '=', SLUG_KIT),
        ),
    )
    .execute()

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
  // Mesma logica para o kit deste arquivo: pedido_itens.kit_id tem ON
  // DELETE RESTRICT, entao qualquer pedido orfao de uma execucao anterior
  // que ainda aponte (via pedido_itens) para o kit deste arquivo precisa
  // sumir antes do DELETE do kit mais abaixo. pedidos ON DELETE CASCADE
  // leva os pedido_itens junto.
  await db
    .deleteFrom('pedidos')
    .where(
      'id',
      'in',
      db
        .selectFrom('pedido_itens')
        .select('pedido_id')
        .where(
          'kit_id',
          'in',
          db.selectFrom('kits').select('id').where('slug', '=', SLUG_KIT),
        ),
    )
    .execute()
  // Depois dos pedidos, nunca antes: pedidos.vendedor_id e pedidos.cliente_id
  // sao ON DELETE RESTRICT, entao um pedido sobrevivente prenderia as duas
  // linhas aqui. enderecos sai junto do cliente por ON DELETE CASCADE
  // (migrations/1755000100000_clientes.sql).
  await db.deleteFrom('usuarios').where('email', '=', EMAIL_VENDEDOR).execute()
  await db.deleteFrom('clientes').where('email', '=', EMAIL_COMPRADOR).execute()
  await db.deleteFrom('representantes').where('slug', '=', SLUG_MARIA).execute()
  // Os coadjuvantes nunca ficam presos por ON DELETE RESTRICT: o trigger
  // rejeita a UPDATE antes que qualquer pedido chegue a apontar para eles,
  // entao um DELETE direto por slug basta.
  await db.deleteFrom('representantes').where('slug', 'in', SLUGS_COADJUVANTES).execute()
  // Apagar so pelo slug deste arquivo — nunca um "DELETE FROM kits" sem
  // filtro, que colidiria com os kits que produtos.test.ts semeia e le em
  // paralelo.
  await db.deleteFrom('kits').where('slug', '=', SLUG_KIT).execute()

  const maria = await db
    .insertInto('representantes')
    .values({
      slug: SLUG_MARIA, codigo: 'PEDIDOMARIA', nome: 'Maria',
      email: 'pedido-maria@exemplo.com', percentual_comissao: '20.00', ativo: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  idMaria = maria.id

  const kit = await db
    .insertInto('kits')
    .values({
      slug: SLUG_KIT, nome: NOME_KIT, preco_centavos: PRECO_KIT_CENTAVOS,
      unidades: 1, sku: 'MG-PEDIDO-KIT', ordem: 99, ativo: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  idKit = kit.id

  const cliente = await db
    .insertInto('clientes')
    .values({
      nome: 'Comprador Pedido', email: EMAIL_COMPRADOR,
      cpf: CPF_COMPRADOR, whatsapp: '11955554444',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  idCliente = cliente.id

  const endereco = await db
    .insertInto('enderecos')
    .values({
      cliente_id: idCliente, cep: '01310100', rua: 'Avenida Paulista',
      numero: '1000', complemento: 'conj. 12', bairro: 'Bela Vista',
      cidade: 'Sao Paulo', estado: 'SP',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  idEndereco = endereco.id

  const vendedor = await db
    .insertInto('usuarios')
    .values({
      nome: 'Vendedor Balcao', email: EMAIL_VENDEDOR,
      senha_hash: SENHA_HASH_INERTE, papel: 'vendedor', ativo: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  idVendedor = vendedor.id
}

/**
 * Molde de venda online completa para os testes NOVOS.
 *
 * Os testes antigos continuam escrevendo os doze campos a mao de proposito:
 * neles, cada campo E o assunto (atribuicao congelada, preco, subtotal). Nos
 * testes de canal e de logistica o assunto e um campo so, e repetir os outros
 * onze esconderia qual deles esta sendo provado.
 */
function vendaOnline(extra: Partial<EntradaPedido> = {}): EntradaPedido {
  return {
    origem: 'casa', canal: 'online',
    representanteId: null, percentualComissao: null,
    utmSource: null, utmMedium: null, utmCampaign: null,
    desconto: deInteiro(0), frete: deInteiro(0),
    clienteId: idCliente, enderecoId: idEndereco,
    itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
    ...extra,
  }
}

/**
 * Venda de balcao (§2): sem endereco — o comprador leva o kit na hora — e com
 * o vendedor que operou a venda. As duas coisas sao exigidas/proibidas pelas
 * constraints citadas no topo do arquivo.
 */
function vendaPresencial(extra: Partial<EntradaPedido> = {}): EntradaPedido {
  return vendaOnline({
    canal: 'presencial', vendedorId: idVendedor, enderecoId: null, ...extra,
  })
}

/** Marca o pedido como pago sem passar pelo Mercado Pago. */
async function marcarPago(id: string) {
  // UPDATE cru de proposito: conciliarPagamento gravaria uma linha em
  // `comissoes`, que e append-only e referencia o pedido com ON DELETE
  // RESTRICT — o pedido deste arquivo nunca mais poderia ser apagado no
  // semear() da rodada seguinte. Quem testa a conciliacao de verdade e
  // src/repositories/__tests__/conciliacao.test.ts, que por isso mesmo nao
  // apaga nada. Aqui interessa so o status.
  await getDb().updateTable('pedidos').set({ status: 'pago' }).where('id', '=', id).execute()
}

describe('criacao de pedido com atribuicao congelada', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('congela representante, percentual e UTM na criacao', async () => {
    // O item precisa bater com o preco do catalogo (criarPedido valida
    // isso agora — ver 'pedido com itens'), entao o subtotal fica preso em
    // PRECO_KIT_CENTAVOS. O desconto abaixo e escolhido so para chegar no
    // mesmo totalCentavos de sempre (53973): o valor esperado da asserção
    // nao mudou, so o desconto que precisa ser somado para chegar nele.
    const p = await criar({
      origem: 'link', representanteId: idMaria,
      percentualComissao: 20,
      utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
      desconto: deInteiro(PRECO_KIT_CENTAVOS - 53973), frete: centavos(0),
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
    })
    expect(p.representanteId).toBe(idMaria)
    expect(p.percentualComissaoSnapshot).toBe(20)
    expect(p.utmSource).toBe('instagram')
    expect(p.totalCentavos).toBe(53973)
    // status e tipado como PedidoStatus (o union gerado do ENUM), nao
    // string: e o que a maquina de estados do Plano 3 usa para exaustividade.
    expect(p.status).toBe('pendente')
  })

  it('alterar o percentual do representante NAO muda pedido ja criado', async () => {
    const p = await criar({
      origem: 'link', representanteId: idMaria, percentualComissao: 20,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: centavos(0), frete: centavos(0),
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
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
      desconto: centavos(0), frete: centavos(0),
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
    })
    expect(p.representanteId).toBeNull()
    expect(p.origem).toBe('casa')
  })

  it('registra rep_inativo em vez de perder o motivo', async () => {
    const p = await criar({
      origem: 'rep_inativo', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: centavos(0), frete: centavos(0),
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
    })
    expect(p.origem).toBe('rep_inativo')
  })

  it('o banco rejeita origem link sem representante', async () => {
    await expect(criar({
      origem: 'link', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: centavos(0), frete: centavos(0),
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
    })).rejects.toThrow(/pedido_origem_coerente/)
  })

  it('o banco rejeita percentual de comissao fora de [0,100]', async () => {
    // O snapshot vem da aplicacao (nao e copiado do cadastro pelo banco),
    // entao rep_percentual_valido nao alcanca esta coluna. E como o trigger
    // de imutabilidade proibe UPDATE nela, um 500.00 gravado aqui ficaria
    // incorrigivel para sempre.
    await expect(criar({
      origem: 'link', representanteId: idMaria, percentualComissao: 500,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: centavos(0), frete: centavos(0),
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
    })).rejects.toThrow(/pedido_percentual_snapshot_valido/)
  })

  it('o banco rejeita total que nao fecha com as parcelas', async () => {
    await expect(
      // endereco_id preenchido mesmo num INSERT cru que existe para violar
      // OUTRA constraint: sem ele a linha violaria DUAS
      // (pedido_online_tem_endereco tambem), e qual das duas o Postgres
      // reporta primeiro nao e garantido em lugar nenhum. A verificacao abaixo
      // travaria por sorte. Este teste continua sendo sobre o total que nao
      // fecha, e so sobre isso.
      getDb().insertInto('pedidos').values({
        origem: 'casa', subtotal_centavos: 10000, desconto_centavos: 0,
        frete_centavos: 0, total_centavos: 9999, endereco_id: idEndereco,
      }).execute(),
    ).rejects.toThrow(/pedido_total_confere/)
  })

  it('o banco rejeita desconto maior que o subtotal', async () => {
    await expect(
      getDb().insertInto('pedidos').values({
        origem: 'casa', subtotal_centavos: 1000, desconto_centavos: 2000,
        frete_centavos: 0, total_centavos: 0, endereco_id: idEndereco,
      }).execute(),
    ).rejects.toThrow(/pedido_desconto_nao_excede/)
  })

  it('impede apagar representante que ja tem pedido', async () => {
    await criar({
      origem: 'link', representanteId: idMaria, percentualComissao: 20,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: centavos(0), frete: centavos(0),
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
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
        desconto: centavos(0), frete: centavos(0),
        canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
        itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
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
        desconto: centavos(0), frete: centavos(0),
        canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
        itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
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
        desconto: centavos(0), frete: centavos(0),
        canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
        itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
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
        desconto: centavos(0), frete: centavos(0),
        canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
        itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
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
        desconto: centavos(0), frete: centavos(0),
        canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
        itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
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

describe('pedido com itens', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('deriva o subtotal da soma dos itens', async () => {
    const p = await criarPedido({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: deInteiro(0), frete: deInteiro(0),
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
      itens: [{ kitId: idKit, quantidade: 3, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
    })
    expect(p.subtotalCentavos).toBe(PRECO_KIT_CENTAVOS * 3)
    expect(p.totalCentavos).toBe(PRECO_KIT_CENTAVOS * 3)
  })

  it('grava o nome e o preco do kit como snapshot', async () => {
    // precoUnitarioCentavos aqui bate de proposito com PRECO_KIT_CENTAVOS
    // (o preco que o catalogo tem AGORA, semeado acima): criarPedido
    // confere os dois dentro da transacao e so grava o item se conferirem
    // (ver 'rejeita quando o preco enviado diverge do catalogo' logo
    // abaixo). O valor gravado no item nao e "o que o chamador mandou, sem
    // pergunta" — e o que o catalogo validou.
    const p = await criarPedido({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: deInteiro(0), frete: deInteiro(0),
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
    })
    const itens = await getDb().selectFrom('pedido_itens')
      .selectAll().where('pedido_id', '=', p.id).execute()
    expect(itens).toHaveLength(1)
    expect(itens[0]!.nome_snapshot).toBe(NOME_KIT)
    expect(itens[0]!.preco_unitario_centavos).toBe(PRECO_KIT_CENTAVOS)
  })

  it('rejeita quando o preco enviado diverge do catalogo', async () => {
    // O preco NAO e confiado ao chamador: se o carrinho (ou um cliente
    // adulterado) manda um precoUnitarioCentavos diferente do que
    // kits.preco_centavos tem AGORA, criarPedido tem que recusar em vez de
    // gravar o valor errado — e o vetor de manipulacao de preco que a
    // Finding 2 do round 1 apontou. PRECO_KIT_CENTAVOS - 1 garante uma
    // divergencia de exatamente 1 centavo, sem depender de nenhum outro
    // numero magico.
    const precoAdulterado = deInteiro(PRECO_KIT_CENTAVOS - 1)
    await expect(criarPedido({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: deInteiro(0), frete: deInteiro(0),
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: precoAdulterado }],
      // O contrato e o TIPO do erro, nao o texto: a rota decide o codigo
      // HTTP com `instanceof PrecoDivergenteError`, entao reescrever a frase
      // do throw nao pode mais quebrar o mapeamento em silencio.
    })).rejects.toThrow(PrecoDivergenteError)

    // A rejeicao precisa acontecer DENTRO da transacao, antes do COMMIT:
    // nenhum pedido pode sobrar gravado com um preco que nunca foi
    // validado.
    const pedidos = await getDb().selectFrom('pedidos')
      .select('id').where('subtotal_centavos', '=', precoAdulterado).execute()
    expect(pedidos).toHaveLength(0)
  })

  it('mudar o preco do kit depois NAO altera o pedido', async () => {
    const p = await criarPedido({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: deInteiro(0), frete: deInteiro(0),
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
    })
    await getDb().updateTable('kits')
      .set({ preco_centavos: 50000 }).where('id', '=', idKit).execute()

    const item = await getDb().selectFrom('pedido_itens')
      .select('preco_unitario_centavos').where('pedido_id', '=', p.id)
      .executeTakeFirstOrThrow()
    expect(item.preco_unitario_centavos).toBe(PRECO_KIT_CENTAVOS)
  })

  it('rejeita pedido sem itens', async () => {
    await expect(criarPedido({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: deInteiro(0), frete: deInteiro(0), itens: [],
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
    })).rejects.toThrow(/sem itens|pedido_subtotal_positivo/)
  })

  it('o banco rejeita um pedido sem nenhum item, mesmo inserindo direto', async () => {
    // Insercao crua, ignorando o repositorio e a guarda itens.length === 0
    // de criarPedido: prova que exigir ao menos um item e uma garantia do
    // BANCO (pedido_itens_obrigatorios_trg), nao so uma promessa da
    // aplicacao que um caminho de escrita diferente poderia furar — o
    // mesmo raciocinio do teste de subtotal logo abaixo, aplicado a
    // "pedido sem item nenhum" em vez de "soma errada".
    await expect(
      getDb().transaction().execute(async (trx) => {
        await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx)
        await trx.insertInto('pedidos').values({
          origem: 'casa', subtotal_centavos: 123456,
          desconto_centavos: 0, frete_centavos: 0, total_centavos: 123456,
          endereco_id: idEndereco,
        }).execute()
      }),
    ).rejects.toThrow(/pedido_itens_obrigatorios/)
  })

  it('o banco rejeita um subtotal que nao bate com os itens', async () => {
    // Insercao crua, ignorando o repositorio: prova que a garantia esta no
    // banco e nao numa soma que a aplicacao pode errar.
    await expect(
      getDb().transaction().execute(async (trx) => {
        await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx)
        const pedido = await trx.insertInto('pedidos').values({
          origem: 'casa', subtotal_centavos: 999999,
          desconto_centavos: 0, frete_centavos: 0, total_centavos: 999999,
          endereco_id: idEndereco,
        }).returning('id').executeTakeFirstOrThrow()
        await trx.insertInto('pedido_itens').values({
          pedido_id: pedido.id, kit_id: idKit, nome_snapshot: NOME_KIT,
          preco_unitario_centavos: PRECO_KIT_CENTAVOS, quantidade: 1,
          total_centavos: PRECO_KIT_CENTAVOS,
        }).execute()
      }),
    ).rejects.toThrow(/pedido_subtotal_confere/)
  })

  it('apagar o pedido leva os itens junto', async () => {
    const p = await criarPedido({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: deInteiro(0), frete: deInteiro(0),
      canal: 'online', clienteId: idCliente, enderecoId: idEndereco,
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
    })
    await getDb().deleteFrom('pedidos').where('id', '=', p.id).execute()
    const restantes = await getDb().selectFrom('pedido_itens')
      .selectAll().where('pedido_id', '=', p.id).execute()
    expect(restantes).toHaveLength(0)
  })
})

// CANAL E O EIXO NOVO DO PLANO 4 (§2, §10, §17). Ele nao substitui `origem`,
// que continua sendo atribuicao de comissao — os dois convivem na mesma linha
// e o cabecalho de migrations/1755300100000_pedidos_canal_logistica.sql explica
// por que juntar os dois num ENUM so teria quebrado a comissao.
describe('canal da venda, vendedor de balcao e colunas de logistica', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('cria venda online com endereco e sem vendedor', async () => {
    const p = await criar(vendaOnline({ prazoDiasEstimado: 7 }))

    expect(p.canal).toBe('online')
    expect(p.vendedorId).toBeNull()
    expect(p.prazoDiasEstimado).toBe(7)
    // As tres colunas de logistica nascem vazias: elas sao preenchidas depois,
    // conforme a entrega anda, e um valor nascendo aqui significaria que algum
    // caminho esta chutando dado de entrega na criacao do pedido.
    expect(p.rastreioCodigo).toBeNull()
    expect(p.rastreioTransportadora).toBeNull()
    expect(p.enviadoEm).toBeNull()
  })

  it('cria venda presencial com vendedor e sem endereco', async () => {
    const p = await criar(vendaPresencial())

    expect(p.canal).toBe('presencial')
    expect(p.vendedorId).toBe(idVendedor)

    // Relido do banco, e nao so do objeto devolvido: o que importa e a linha
    // gravada, porque e dela que sai o relatorio de §17 e a baixa do estoque
    // presencial (teto rigido de 50, §4).
    const relido = await getDb().selectFrom('pedidos')
      .select(['canal', 'endereco_id', 'vendedor_id'])
      .where('id', '=', p.id).executeTakeFirstOrThrow()
    expect(relido.canal).toBe('presencial')
    expect(relido.endereco_id).toBeNull()
    expect(relido.vendedor_id).toBe(idVendedor)
  })

  it('o banco rejeita venda presencial sem vendedor', async () => {
    await expect(criar(vendaPresencial({ vendedorId: null })))
      .rejects.toThrow(/pedido_presencial_tem_vendedor/)
  })

  it('o banco rejeita venda online sem endereco de entrega', async () => {
    await expect(criar(vendaOnline({ enderecoId: null })))
      .rejects.toThrow(/pedido_online_tem_endereco/)
  })

  it('o banco rejeita prazo de entrega zero', async () => {
    // Zero nao e "prazo desconhecido", e leitura errada da resposta da cotacao
    // (src/lib/frete.ts prefere lancar CotacaoIlegivelError a chutar). Sem esta
    // constraint, a pagina do comprador anunciaria "entrega em 0 dias".
    await expect(criar(vendaOnline({ prazoDiasEstimado: 0 })))
      .rejects.toThrow(/pedido_prazo_valido/)
  })

  // O trigger ganhou duas colunas novas no Plano 4. Os testes de
  // representante_id/percentual/total mais acima provam a versao antiga; estes
  // dois provam que a REESCRITA da funcao (migrations/1755300100000 e
  // 1755300300000, que copiam a funcao inteira em vez de estende-la) nao
  // deixou nada para tras.
  it('o trigger congela o canal contra UPDATE', async () => {
    const p = await criar(vendaOnline())
    await expect(
      getDb().updateTable('pedidos')
        .set({ canal: 'presencial' })
        .where('id', '=', p.id)
        .execute(),
    ).rejects.toThrow(/pedido_atribuicao_imutavel/)
  })

  it('o trigger congela o vendedor contra UPDATE', async () => {
    // Reatribuir a venda de um vendedor para outro reescreveria o relatorio do
    // evento depois do fato — e, como em representante_id, faria o ON DELETE
    // RESTRICT deixar de enxergar a dependencia, liberando a exclusao da conta
    // que de fato vendeu.
    const p = await criar(vendaOnline())
    await expect(
      getDb().updateTable('pedidos')
        .set({ vendedor_id: idVendedor })
        .where('id', '=', p.id)
        .execute(),
    ).rejects.toThrow(/pedido_atribuicao_imutavel/)
  })

  it('rastreio e prazo NAO sao congelados: a logistica escreve depois', async () => {
    // O contraponto obrigatorio dos dois testes acima. Se estas colunas
    // tivessem entrado na lista de congeladas por descuido, /admin/logistica
    // nao conseguiria gravar codigo de rastreio nenhum e o erro so apareceria
    // com o primeiro pedido a postar.
    const p = await criar(vendaOnline({ prazoDiasEstimado: 5 }))

    await registrarRastreio(p.id, { codigo: 'AA123456789BR', transportadora: 'Correios' })
    await getDb().updateTable('pedidos')
      .set({ prazo_dias_estimado: 9 }).where('id', '=', p.id).execute()

    const relido = await getDb().selectFrom('pedidos')
      .select(['rastreio_codigo', 'rastreio_transportadora', 'prazo_dias_estimado', 'status'])
      .where('id', '=', p.id).executeTakeFirstOrThrow()
    expect(relido.rastreio_codigo).toBe('AA123456789BR')
    expect(relido.rastreio_transportadora).toBe('Correios')
    expect(relido.prazo_dias_estimado).toBe(9)
    // registrarRastreio NAO move o status: postar e outra acao, com outra
    // garantia. Se as duas estivessem juntas, corrigir um digito do codigo
    // re-carimbaria enviado_em.
    expect(relido.status).toBe('pendente')
  })

  it('registrarRastreio recusa pedido inexistente em vez de nao fazer nada', async () => {
    // UPDATE que nao acha linha e sucesso silencioso para o Kysely, e a rota
    // do painel responderia 200 para um id que nao existe.
    await expect(
      registrarRastreio(randomUUID(), { codigo: 'AA000000000BR', transportadora: 'Correios' }),
    ).rejects.toThrow()
  })
})

describe('avancarStatusDoPedido', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  // A transacao e OBRIGATORIA na assinatura (o lock precisa viver ate o COMMIT
  // do chamador), entao todo teste abre a sua — mesmo molde de
  // conciliacao.test.ts.
  const avancar = (id: string, novo: PedidoStatus, agora?: Date) =>
    getDb().transaction().execute((trx) => avancarStatusDoPedido(id, novo, trx, agora))

  const relerPedido = (id: string) =>
    getDb().selectFrom('pedidos')
      .select(['status', 'enviado_em', 'entregue_em'])
      .where('id', '=', id).executeTakeFirstOrThrow()

  it('transicao inexistente lanca TransicaoInvalidaError e nao move o pedido', async () => {
    const p = await criar(vendaOnline())

    // 'pendente' vai para aguardando_pagamento, pago ou cancelado — nunca
    // direto para o meio da entrega. O contrato asseverado e a CLASSE, nao a
    // frase: a rota do painel despacha por instanceof e reescrever o texto do
    // throw nao pode virar 500 em silencio.
    await expect(avancar(p.id, 'em_transito')).rejects.toThrow(TransicaoInvalidaError)

    expect((await relerPedido(p.id)).status).toBe('pendente')
  })

  // §2: "comprou → pagou → levou na hora". Esta aresta era PROIBIDA ate o
  // Plano 3 e foi aberta de proposito em src/lib/pedido-status.ts.
  it('venda presencial vai de pago direto a entregue e carimba entregue_em', async () => {
    const p = await criar(vendaPresencial())
    await marcarPago(p.id)
    const balcao = new Date('2026-08-25T18:30:00Z')

    const r = await avancar(p.id, 'entregue', balcao)
    expect(r).toEqual({ mudou: true, de: 'pago', para: 'entregue' })

    const relido = await relerPedido(p.id)
    expect(relido.status).toBe('entregue')
    // ATE ESTE PLANO, entregue_em NAO TINHA ESCRITOR NENHUM em todo o codigo:
    // a coluna existe desde migrations/1754900300000_pedidos.sql e nunca
    // recebeu valor. Esta linha e a primeira verificacao de que ela e preenchida.
    expect(relido.entregue_em?.getTime()).toBe(balcao.getTime())
    // Venda de balcao nunca foi postada: enviado_em fica NULL para sempre, e e
    // isso que impede a fila da expedicao de contar os 50 kits do evento como
    // objetos a despachar.
    expect(relido.enviado_em).toBeNull()
  })

  it('avancar duas vezes para o mesmo status devolve mudou false e mantem o carimbo original', async () => {
    const p = await criar(vendaPresencial())
    await marcarPago(p.id)
    const primeiroClique = new Date('2026-08-25T18:30:00Z')
    const segundoClique = new Date('2026-08-25T19:45:00Z')

    await avancar(p.id, 'entregue', primeiroClique)
    const segunda = await avancar(p.id, 'entregue', segundoClique)

    // Clique duplo no balcao e rotina, nao erro: transformar isso em excecao
    // ensinaria a operacao a ignorar tela vermelha justamente no dia em que
    // uma tela vermelha vai importar.
    expect(segunda).toEqual({ mudou: false, de: 'entregue', para: 'entregue' })

    const relido = await relerPedido(p.id)
    // A data que vale e a da entrega de verdade, nao a do segundo clique.
    expect(relido.entregue_em?.getTime()).toBe(primeiroClique.getTime())
  })

  it('o caminho dos Correios carimba enviado_em na postagem e entregue_em na entrega', async () => {
    const p = await criar(vendaOnline())
    await marcarPago(p.id)
    const postagem = new Date('2026-08-26T12:00:00Z')
    const entrega = new Date('2026-08-29T09:00:00Z')

    await avancar(p.id, 'enviado', postagem)
    // 'em_transito' e o valor novo do ENUM
    // (migrations/1755300200000_status_em_transito.sql). Passar por ele NAO
    // pode re-carimbar enviado_em: o objeto foi postado uma vez so.
    const transito = await avancar(p.id, 'em_transito')
    expect(transito).toEqual({ mudou: true, de: 'enviado', para: 'em_transito' })
    await avancar(p.id, 'entregue', entrega)

    const relido = await relerPedido(p.id)
    expect(relido.status).toBe('entregue')
    expect(relido.enviado_em?.getTime()).toBe(postagem.getTime())
    expect(relido.entregue_em?.getTime()).toBe(entrega.getTime())
  })

  // DINHEIRO: o painel move a caixa, nunca o caixa.
  it('DINHEIRO: recusa a transicao que mexeria na comissao sem passar pela conciliacao', async () => {
    const p = await criar(vendaOnline())
    await marcarPago(p.id)

    // 'pago' -> 'reembolsado' EXISTE na maquina de estados (a conciliacao usa
    // essa aresta o tempo todo), entao isto nao e TransicaoInvalidaError. O
    // problema e outro: quem escreve no livro-razao e conciliarPagamento, e um
    // reembolso marcado aqui deixaria o credito da representante parado no
    // saldo — pior, o webhook de estorno que chegasse depois encontraria o
    // pedido JA em 'reembolsado' e viraria no-op. O clique no painel engoliria
    // a correcao automatica.
    await expect(avancar(p.id, 'reembolsado')).rejects.toThrow(TransicaoFinanceiraError)
    expect((await relerPedido(p.id)).status).toBe('pago')

    // Mesma regra pelo outro lado: marcar pago na mao e declarar venda sem
    // confirmacao do provedor, que a decisao do cliente de 16/08 proibiu por
    // escrito (§4 do plano) — e o credito de comissao tambem nao sairia.
    const outro = await criar(vendaOnline())
    await expect(avancar(outro.id, 'pago')).rejects.toThrow(TransicaoFinanceiraError)
    expect((await relerPedido(outro.id)).status).toBe('pendente')
  })

  it('cancelar pedido que nunca foi pago continua permitido', async () => {
    // O contraponto do teste acima: cancelar carrinho abandonado nao gera
    // estorno de comissao nenhum (geraEstornoDeComissao exige ter estado
    // pago), entao a recusa financeira NAO pode alcancar este caso — senao a
    // operacao ficaria sem como limpar pedido que ninguem pagou.
    const p = await criar(vendaOnline())
    const r = await avancar(p.id, 'cancelado')
    expect(r).toEqual({ mudou: true, de: 'pendente', para: 'cancelado' })
  })

  it('pedido inexistente lanca em vez de devolver mudou false', async () => {
    await expect(avancar(randomUUID(), 'cancelado')).rejects.toThrow()
  })

  // A PROVA DE QUE O `FOR UPDATE` E CARGA, NAO DECORACAO — mesmo desenho do
  // teste de concorrencia de conciliacao.test.ts, e pelo mesmo motivo: um
  // `Promise.all` continuaria verde com o `.forUpdate()` removido, porque as
  // duas transacoes acabam serializando sozinhas pelo escalonamento do event
  // loop.
  //
  // Aqui a corrida nao e do webhook, e de duas pessoas com o painel aberto no
  // dia do evento clicando "marcar como enviado" no mesmo pedido. COM o lock,
  // B bloqueia no SELECT ate A commitar, le 'enviado' e vira no-op. SEM o
  // lock, B le 'pago', enxerga enviado_em NULL (o valor velho) e grava o
  // PROPRIO carimbo por cima — a data de postagem do pedido passaria a ser a
  // do segundo clique, que e o numero de onde sai a discussao de prazo com a
  // transportadora.
  it('transicao concorrente bloqueia no lock e nao re-carimba a data de postagem', async () => {
    const p = await criar(vendaOnline())
    await marcarPago(p.id)

    const postagemDeA = new Date('2026-08-26T12:00:00Z')
    const postagemDeB = new Date('2026-08-27T12:00:00Z')

    let liberarA!: () => void
    const aPodeCommitar = new Promise<void>((r) => { liberarA = r })
    let sinalizarQueAEscreveu!: () => void
    const aJaEscreveu = new Promise<void>((r) => { sinalizarQueAEscreveu = r })

    const a = getDb().transaction().execute(async (trx) => {
      const r = await avancarStatusDoPedido(p.id, 'enviado', trx, postagemDeA)
      sinalizarQueAEscreveu()
      await aPodeCommitar
      return r
    })

    await aJaEscreveu
    const b = getDb().transaction().execute((trx) =>
      avancarStatusDoPedido(p.id, 'enviado', trx, postagemDeB))

    // ESTA PAUSA E O QUE DA SENTIDO AO TESTE. `b` acima e so uma Promise
    // criada: nada garante que a transacao dela ja tenha chegado a emitir o
    // SELECT. Sem a pausa, liberarA() rodaria antes disso, A commitaria, e B
    // leria 'enviado' de qualquer jeito — inclusive sem lock nenhum.
    await new Promise((r) => setTimeout(r, 300))

    liberarA()
    const resultadoA = await a
    const resultadoB = await b

    expect(resultadoA.mudou).toBe(true)
    expect(resultadoB.mudou).toBe(false)
    expect(resultadoB.de).toBe('enviado')

    const relido = await relerPedido(p.id)
    expect(relido.enviado_em?.getTime()).toBe(postagemDeA.getTime())
  })
})

// AS LEITURAS DO PAINEL (§17). Todas leem a tabela INTEIRA, inclusive os
// pedidos que os outros arquivos de teste estao criando em paralelo contra o
// mesmo Postgres. Por isso nenhuma verificacao aqui usa toHaveLength nem compara
// um total absoluto: cada teste localiza as PROPRIAS linhas por id ou pelo
// e-mail exclusivo deste arquivo. Onde o numero absoluto seria a coisa
// interessante (resumoDeVendas), o que da para assegurar sem corrida e a
// invariante do calculo — e o teste diz isso por extenso.
describe('leituras administrativas do painel', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('listarVendasAdmin traz itens formatados, vendedor e o metodo do pagamento aprovado', async () => {
    const p = await criar(vendaPresencial({
      itens: [{ kitId: idKit, quantidade: 2, precoUnitarioCentavos: deInteiro(PRECO_KIT_CENTAVOS) }],
    }))
    await marcarPago(p.id)

    // ORDEM DELIBERADA: o pagamento APROVADO entra PRIMEIRO e a tentativa
    // recusada depois. Se a consulta simplesmente pegasse a tentativa mais
    // recente, este teste ficaria vermelho — e e exatamente esse o erro que
    // faria a tela dizer "cartao" para uma venda recebida em Pix.
    await getDb().insertInto('pagamentos').values({
      pedido_id: p.id, metodo: 'pix',
      valor_centavos: PRECO_KIT_CENTAVOS * 2, status: 'aprovado',
    }).execute()
    await getDb().insertInto('pagamentos').values({
      pedido_id: p.id, metodo: 'cartao',
      valor_centavos: PRECO_KIT_CENTAVOS * 2, status: 'recusado',
    }).execute()

    const minha = (await listarVendasAdmin({ canal: 'presencial' })).find((v) => v.id === p.id)
    expect(minha).toBeDefined()
    expect(minha!.itens).toBe(`2x ${NOME_KIT}`)
    expect(minha!.quantidade).toBe(2)
    // DINHEIRO: o total tem que ser o do PEDIDO, nao a soma inflada por um
    // join com as duas tentativas de pagamento (seriam 4 linhas com os 2
    // itens).
    expect(minha!.totalCentavos).toBe(PRECO_KIT_CENTAVOS * 2)
    expect(minha!.metodoPagamento).toBe('pix')
    expect(minha!.vendedorNome).toBe('Vendedor Balcao')
    expect(minha!.clienteEmail).toBe(EMAIL_COMPRADOR)
    expect(minha!.canal).toBe('presencial')
  })

  it('listarVendasAdmin filtra por canal', async () => {
    const online = await criar(vendaOnline())
    const balcao = await criar(vendaPresencial())

    const presenciais = await listarVendasAdmin({ canal: 'presencial' })
    expect(presenciais.some((v) => v.id === balcao.id)).toBe(true)
    expect(presenciais.some((v) => v.id === online.id)).toBe(false)

    const onlines = await listarVendasAdmin({ canal: 'online' })
    expect(onlines.some((v) => v.id === online.id)).toBe(true)
    expect(onlines.some((v) => v.id === balcao.id)).toBe(false)
  })

  it('LGPD: nenhuma leitura do painel carrega o CPF do comprador', async () => {
    // CPF mora na MESMA linha de `clientes` que o nome e o e-mail que estas
    // telas legitimamente mostram — um `.selectAll('clientes')` traria os tres
    // de uma vez, e a resposta de /api/admin/* passaria a exportar uma base de
    // CPF. E por isso que as tres consultas nomeiam as colunas uma a uma; esta
    // verificacao e o que fica vermelho no dia em que alguem "simplificar".
    const p = await criar(vendaOnline())
    await marcarPago(p.id)

    const venda = (await listarVendasAdmin()).find((v) => v.id === p.id)
    expect(venda).toBeDefined()
    expect(Object.keys(venda!)).not.toContain('cpf')
    expect(JSON.stringify(venda)).not.toContain(CPF_COMPRADOR)

    const comprador = (await listarCompradores()).find((c) => c.email === EMAIL_COMPRADOR)
    expect(comprador).toBeDefined()
    expect(JSON.stringify(comprador)).not.toContain(CPF_COMPRADOR)

    const linha = (await listarLogisticaAdmin()).find((l) => l.id === p.id)
    expect(linha).toBeDefined()
    expect(JSON.stringify(linha)).not.toContain(CPF_COMPRADOR)
  })

  it('listarLogisticaAdmin traz o pedido a despachar e ignora a venda de balcao', async () => {
    const online = await criar(vendaOnline({ prazoDiasEstimado: 5 }))
    const balcao = await criar(vendaPresencial())
    await marcarPago(online.id)
    await marcarPago(balcao.id)
    await registrarRastreio(online.id, { codigo: 'AA123456789BR', transportadora: 'Correios' })

    const fila = await listarLogisticaAdmin()

    const linha = fila.find((l) => l.id === online.id)
    expect(linha).toBeDefined()
    expect(linha!.cep).toBe('01310100')
    // O numero do ENDERECO, que no tipo se chama numero_ para nao colidir com
    // o numero do PEDIDO. Os dois aparecem na mesma linha de uma etiqueta.
    expect(linha!.numero_).toBe('1000')
    expect(linha!.numero).toBe(online.numero)
    expect(linha!.rastreioCodigo).toBe('AA123456789BR')
    expect(linha!.rastreioTransportadora).toBe('Correios')
    expect(linha!.prazoDiasEstimado).toBe(5)

    // A venda de balcao nao tem endereco (§10) e nao ha o que despachar: se
    // ela aparecesse, os 50 kits do evento entrariam na fila da expedicao como
    // 50 linhas em branco na frente dos pedidos que precisam ser postados.
    expect(fila.some((l) => l.id === balcao.id)).toBe(false)
  })

  it('listarLogisticaAdmin ignora pedido que ainda nao foi pago', async () => {
    const p = await criar(vendaOnline())
    expect((await listarLogisticaAdmin()).some((l) => l.id === p.id)).toBe(false)
  })

  it('listarCompradores conta so o pedido pago e nao o carrinho abandonado', async () => {
    // Determinista mesmo com os outros arquivos rodando em paralelo: o e-mail
    // e exclusivo deste arquivo e o semear() apaga os pedidos dele antes de
    // cada teste, entao a linha agregada abaixo so pode ter vindo daqui.
    const pago = await criar(vendaOnline())
    await marcarPago(pago.id)
    await criar(vendaOnline()) // fica em 'pendente': ninguem pagou

    const comprador = (await listarCompradores()).find((c) => c.email === EMAIL_COMPRADOR)
    expect(comprador).toBeDefined()
    expect(comprador!.nome).toBe('Comprador Pedido')
    expect(comprador!.pedidos).toBe(1)
    expect(comprador!.totalCentavos).toBe(PRECO_KIT_CENTAVOS)
  })

  it('DINHEIRO: resumoDeVendas fecha o total do topo com a soma por canal', async () => {
    const balcao = await criar(vendaPresencial())
    await marcarPago(balcao.id)
    await getDb().insertInto('pagamentos').values({
      pedido_id: balcao.id, metodo: 'pix',
      valor_centavos: PRECO_KIT_CENTAVOS, status: 'aprovado',
    }).execute()

    const r = await resumoDeVendas()

    // A INVARIANTE, que vale com qualquer quantidade de linhas de outros
    // arquivos no banco: o numero grande do topo da tela e SOMADO das linhas
    // por canal, em JavaScript, justamente para nao poder divergir delas. Duas
    // consultas separadas rodariam em instantes diferentes e uma venda que
    // entrasse no meio faria a tela do dono da empresa nao fechar sozinha.
    expect(r.pedidosPagos).toBe(r.porCanal.reduce((acc, c) => acc + c.pedidos, 0))
    expect(r.faturamentoCentavos).toBe(r.porCanal.reduce((acc, c) => acc + c.totalCentavos, 0))

    const presencial = r.porCanal.find((c) => c.canal === 'presencial')
    expect(presencial).toBeDefined()
    expect(presencial!.pedidos).toBeGreaterThanOrEqual(1)
    expect(presencial!.totalCentavos).toBeGreaterThanOrEqual(PRECO_KIT_CENTAVOS)

    const pix = r.porMetodo.find((m) => m.metodo === 'pix')
    expect(pix).toBeDefined()
    expect(pix!.pedidos).toBeGreaterThanOrEqual(1)
  })
})
