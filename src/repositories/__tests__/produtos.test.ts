import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { listarKitsAtivos, buscarKitAtivoPorSlug } from '@/repositories/produtos'
import { formatarBRL } from '@/lib/money'

// Todo slug que este arquivo ja semeia ou cria dentro de um teste. Um
// "DELETE FROM kits" sem filtro (como este arquivo fazia antes) colide com
// pedidos.test.ts: desde que pedido_itens.kit_id referencia kits com ON
// DELETE RESTRICT, o kit que aquele arquivo semeia bloqueia a limpeza aqui
// quando os dois arquivos rodam em paralelo contra o mesmo Postgres — e o
// DELETE aqui pode apagar o kit de baixo do pedidos.test.ts no meio de uma
// insercao. Escopar por slug, como os outros arquivos ja fazem, evita as
// duas colisoes.
const SLUGS = [
  'kit-1', 'kit-3', 'kit-antigo', 'kit-carimbo', 'kit-gratis',
  'kit-empate-a', 'kit-empate-z', 'kit-dimensoes', 'kit-dimensao-invalida',
] as const

async function semear() {
  const db = getDb()
  await db.deleteFrom('kits').where('slug', 'in', SLUGS).execute()
  await db.insertInto('kits').values([
    { slug: 'kit-1', nome: 'Kit 1', preco_centavos: 19990, unidades: 1, sku: 'MG-K1', ordem: 1, ativo: true },
    {
      slug: 'kit-3', nome: 'Kit 3', descricao: 'Kit com 3 unidades do creme Milagran',
      preco_centavos: 53900, unidades: 3, sku: 'MG-K3', anvisa_registro: '25351.000123/2024-01',
      ordem: 2, ativo: true,
    },
    { slug: 'kit-antigo', nome: 'Kit descontinuado', preco_centavos: 9990, unidades: 1, sku: 'MG-OLD', ordem: 3, ativo: false },
  ]).execute()
}

describe('repositorio de produtos', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('lista apenas kits ativos, na ordem definida', async () => {
    const kits = await listarKitsAtivos()
    // listarKitsAtivos nao filtra por arquivo de teste — e producao de
    // verdade, lista TODO kit ativo da tabela. pedidos.test.ts agora tambem
    // semeia um kit ativo proprio (para os itens do pedido), entao filtrar
    // aqui para os slugs deste arquivo evita depender da ordem de execucao
    // entre os dois arquivos, que o Vitest roda em paralelo contra o mesmo
    // Postgres.
    const slugsDesteArquivo = kits.map((k) => k.slug).filter((s) => (SLUGS as readonly string[]).includes(s))
    expect(slugsDesteArquivo).toEqual(['kit-1', 'kit-3'])
  })

  it('desempata kits com mesma ordem por slug', async () => {
    // Nada no schema impede dois kits ativos com o mesmo `ordem`:
    // kits_ativos_ordem e um indice btree comum, nao unico, e nao pode
    // virar um indice unico porque pedidos.test.ts e cupons.test.ts ja
    // semeiam kits ativos em ordem = 99 cada um. Sem um desempate
    // deterministico, listarKitsAtivos() fica a merce da ordem de
    // varredura do Postgres — que nao e garantida. Insere fora de ordem
    // alfabetica (Z antes de A) de proposito, para provar que o resultado
    // vem do ORDER BY e nao da ordem de insercao.
    await getDb().insertInto('kits').values([
      { slug: 'kit-empate-z', nome: 'Empate Z', preco_centavos: 1000, unidades: 1, sku: 'MG-EZ', ordem: 50, ativo: true },
      { slug: 'kit-empate-a', nome: 'Empate A', preco_centavos: 1000, unidades: 1, sku: 'MG-EA', ordem: 50, ativo: true },
    ]).execute()

    const kits = await listarKitsAtivos()
    const empatados = kits.map((k) => k.slug).filter((s) => s.startsWith('kit-empate-'))
    expect(empatados).toEqual(['kit-empate-a', 'kit-empate-z'])
  })

  it('devolve preco como Centavos inteiro, nunca string', async () => {
    // Buscar por slug em vez de pegar o [0] da lista inteira: a semeadura
    // de producao (kit-milagran, Task 7) tambem usa ordem = 1, e uma vez
    // que a ordenacao empata em `ordem`, o Postgres nao garante qual das
    // duas linhas volta primeiro. Filtrar pelo slug deste arquivo remove a
    // dependencia de ordem entre a semeadura de producao e a de teste.
    const kits = await listarKitsAtivos()
    const kit1 = kits.find((k) => k.slug === 'kit-1')
    expect(kit1!.precoCentavos).toBe(19990)
    expect(typeof kit1!.precoCentavos).toBe('number')
  })

  it('busca por slug', async () => {
    const kit = await buscarKitAtivoPorSlug('kit-3')
    expect(kit?.nome).toBe('Kit 3')
    expect(kit?.unidades).toBe(3)
    expect(kit?.sku).toBe('MG-K3')
    expect(kit?.descricao).toBe('Kit com 3 unidades do creme Milagran')
    expect(kit?.anvisaRegistro).toBe('25351.000123/2024-01')
  })

  it('devolve null para slug inexistente', async () => {
    expect(await buscarKitAtivoPorSlug('nao-existe')).toBeNull()
  })

  it('nao devolve kit inativo na busca por slug', async () => {
    expect(await buscarKitAtivoPorSlug('kit-antigo')).toBeNull()
  })

  it('impede dois kits com o mesmo slug', async () => {
    await expect(
      getDb().insertInto('kits').values({
        slug: 'kit-1', nome: 'Duplicado', preco_centavos: 100,
        unidades: 1, sku: 'MG-DUP', ordem: 9, ativo: true,
      }).execute(),
    ).rejects.toThrow(/kits_slug_unico/)
  })

  it('atualiza atualizado_em a cada UPDATE, sem mexer em criado_em', async () => {
    // A coluna tinha DEFAULT now() e nenhum trigger: marcava a criacao e
    // ficava parada ali para sempre. Semear com data antiga torna o teste
    // deterministico — nao depende de dois now() caírem em milissegundos
    // diferentes.
    const antigo = new Date('2020-01-01T00:00:00.000Z')
    await getDb().insertInto('kits').values({
      slug: 'kit-carimbo', nome: 'Carimbo', preco_centavos: 1000, unidades: 1,
      sku: 'MG-CARIMBO', ordem: 9, ativo: true, criado_em: antigo, atualizado_em: antigo,
    }).execute()

    await getDb().updateTable('kits')
      // Tenta gravar uma data velha de proposito: o trigger tem que vencer.
      .set({ preco_centavos: 2000, atualizado_em: antigo })
      .where('slug', '=', 'kit-carimbo').execute()

    const l = await getDb().selectFrom('kits').select(['criado_em', 'atualizado_em'])
      .where('slug', '=', 'kit-carimbo').executeTakeFirstOrThrow()
    expect(l.criado_em.getTime()).toBe(antigo.getTime())
    expect(l.atualizado_em.getTime()).toBeGreaterThan(antigo.getTime())
  })

  // Peso e dimensoes existem no cadastro por causa da cotacao de frete do
  // Clube Envios (§13 do documento de 16/08/2026, src/lib/frete.ts): os
  // quatro valores vao no corpo da requisicao e NAO podem ser inventados na
  // rota. Por isso sobem por aqui, junto do preco.
  it('DINHEIRO: as quatro dimensoes chegam do banco, cada uma na sua coluna', async () => {
    // Quatro valores DIFERENTES entre si e diferentes dos DEFAULTs da
    // migration (500 / 12 / 16 / 20), de proposito. Com valores iguais, ou
    // iguais ao default, uma troca de largura com comprimento no mapeamento
    // de paraKit() passaria despercebida — e trocar duas medidas muda o peso
    // cubado, ou seja, muda o valor do frete cobrado do comprador.
    await getDb().insertInto('kits').values({
      slug: 'kit-dimensoes', nome: 'Kit com medidas', preco_centavos: 1000,
      unidades: 1, sku: 'MG-DIM', ordem: 60, ativo: true,
      peso_gramas: 1234, altura_cm: 7, largura_cm: 9, comprimento_cm: 11,
    }).execute()

    const kit = await buscarKitAtivoPorSlug('kit-dimensoes')
    expect(kit).not.toBeNull()
    expect({
      pesoGramas: kit!.pesoGramas, alturaCm: kit!.alturaCm,
      larguraCm: kit!.larguraCm, comprimentoCm: kit!.comprimentoCm,
    }).toEqual({ pesoGramas: 1234, alturaCm: 7, larguraCm: 9, comprimentoCm: 11 })

    // number, nunca string. integer e smallint chegam como number pelo
    // driver do Postgres, mas um NUMERIC chegaria como string e entraria no
    // JSON da cotacao entre aspas — mesmo cuidado do teste de precoCentavos
    // acima.
    for (const v of [kit!.pesoGramas, kit!.alturaCm, kit!.larguraCm, kit!.comprimentoCm]) {
      expect(typeof v).toBe('number')
    }

    // A vitrine e a rota de frete leem por caminhos diferentes. Hoje os dois
    // passam pelo mesmo paraKit(), mas se alguem trocar um dos `selectAll()`
    // por uma lista explicita de colunas, as dimensoes somem so de um lado —
    // e o lado que some e o que vira frete zero ou erro em producao.
    const daLista = (await listarKitsAtivos()).find((k) => k.slug === 'kit-dimensoes')
    expect(daLista).toBeDefined()
    expect({
      pesoGramas: daLista!.pesoGramas, alturaCm: daLista!.alturaCm,
      larguraCm: daLista!.larguraCm, comprimentoCm: daLista!.comprimentoCm,
    }).toEqual({ pesoGramas: 1234, alturaCm: 7, larguraCm: 9, comprimentoCm: 11 })
  })

  it('DINHEIRO: todo kit ativo chega com as quatro dimensoes positivas', async () => {
    // Sem numero fixo de proposito: os DEFAULTs de hoje sao palpite
    // declarado e vao ser corrigidos pela expedicao antes de 25/08
    // (migrations/1755300600000_kit_dimensoes.sql). Travar 500/12/16/20 aqui
    // faria o teste ficar vermelho justamente no commit que conserta o dado.
    // O que precisa continuar verdadeiro para sempre e outra coisa: nenhum
    // kit ativo chega a cotacao com dimensao ausente, zerada ou undefined —
    // inclusive o kit de producao e os kits que os outros arquivos de teste
    // semeiam sem informar dimensao nenhuma, que herdam o DEFAULT do banco.
    const kits = await listarKitsAtivos()
    expect(kits.length).toBeGreaterThan(0)
    for (const k of kits) {
      expect(k.pesoGramas, `peso do kit ${k.slug}`).toBeGreaterThan(0)
      expect(k.alturaCm, `altura do kit ${k.slug}`).toBeGreaterThan(0)
      expect(k.larguraCm, `largura do kit ${k.slug}`).toBeGreaterThan(0)
      expect(k.comprimentoCm, `comprimento do kit ${k.slug}`).toBeGreaterThan(0)
    }
  })

  it('o banco rejeita dimensao zerada em qualquer uma das quatro colunas', async () => {
    // Um caso por coluna, todos com o MESMO slug: cada INSERT falha, entao
    // nenhum deles deixa linha para o proximo esbarrar em kits_slug_unico.
    // Zero e o valor perigoso e nao o negativo — e o que sai de um campo de
    // formulario vazio, e uma dimensao zerada zera o peso cubado sem
    // levantar suspeita nenhuma na tela.
    const base = {
      slug: 'kit-dimensao-invalida', nome: 'Sem medida', preco_centavos: 1000,
      unidades: 1, sku: 'MG-DIMX', ordem: 61, ativo: true,
    }
    const casos = [
      { valores: { peso_gramas: 0 }, constraint: /kits_peso_positivo/ },
      { valores: { altura_cm: 0 }, constraint: /kits_altura_positiva/ },
      { valores: { largura_cm: 0 }, constraint: /kits_largura_positiva/ },
      { valores: { comprimento_cm: 0 }, constraint: /kits_comprimento_positivo/ },
    ]
    for (const caso of casos) {
      await expect(
        getDb().insertInto('kits').values({ ...base, ...caso.valores }).execute(),
      ).rejects.toThrow(caso.constraint)
    }
  })

  it('impede preco zero ou negativo', async () => {
    await expect(
      getDb().insertInto('kits').values({
        slug: 'kit-gratis', nome: 'Gratis', preco_centavos: 0,
        unidades: 1, sku: 'MG-FREE', ordem: 9, ativo: true,
      }).execute(),
    ).rejects.toThrow(/kits_preco_positivo/)
  })
})

describe('kit de producao', () => {
  it('existe um kit ativo a R$ 1.000,00', async () => {
    const kit = await buscarKitAtivoPorSlug('kit-milagran')
    expect(kit).not.toBeNull()
    expect(kit!.precoCentavos).toBe(100000)
    expect(formatarBRL(kit!.precoCentavos)).toBe('R$ 1.000,00')
  })

  it('o registro ANVISA ainda nao foi preenchido — divida conhecida', async () => {
    const kit = await buscarKitAtivoPorSlug('kit-milagran')
    expect(kit!.anvisaRegistro).toBeNull()
  })

  // Divida da mesma familia da de cima, e por isso vizinha dela. O kit que
  // vai ser vendido em 25/08 carrega HOJE o palpite de 16/08 (500 g,
  // 12 x 16 x 20 cm) herdado do DEFAULT de
  // migrations/1755300600000_kit_dimensoes.sql — ninguem pesou nem mediu a
  // caixa. O teste assevera que os quatro valores existem e sao usaveis pela
  // cotacao, sem congelar os numeros: quando a expedicao medir e corrigir, o
  // commit que conserta o dado nao pode deixar a suite vermelha.
  it('DINHEIRO: o kit de producao ja carrega peso e dimensoes para a cotacao de frete', async () => {
    const kit = await buscarKitAtivoPorSlug('kit-milagran')
    expect(kit!.pesoGramas).toBeGreaterThan(0)
    expect(kit!.alturaCm).toBeGreaterThan(0)
    expect(kit!.larguraCm).toBeGreaterThan(0)
    expect(kit!.comprimentoCm).toBeGreaterThan(0)
  })
})
