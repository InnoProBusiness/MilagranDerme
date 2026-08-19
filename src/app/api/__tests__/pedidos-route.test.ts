import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { sql } from 'kysely'
import { getDb, closeDb } from '@/lib/db'
import { POST } from '@/app/api/pedidos/route'
import { assinarAtribuicao } from '@/lib/atribuicao'
import { MAX_PEDIDOS_POR_JANELA } from '@/lib/rate-limit'
import { deInteiro } from '@/lib/money'
import type { OpcaoDeFrete, VolumeDaCotacao } from '@/lib/frete'

// PRIMEIRO dos dois pontos mockados deste arquivo (o outro e a cotacao de
// frete, logo abaixo), e aqui so a LEITURA do catalogo: e a unica costura por
// onde da para reproduzir "o preco mudou entre a vitrine e o checkout" de
// forma deterministica. A rota le kits FORA da transacao e
// criarPedido le kits DE NOVO DENTRO dela; forcar um preco diferente na
// primeira leitura faz a segunda divergir — que e exatamente o cenario que a
// guarda de preco existe para pegar. O throw, a transacao e o mapeamento
// para HTTP continuam sendo os de producao, sem stub nenhum.
//
// Com precoForcadoCentavos em null (o padrao, restaurado no afterEach) a
// funcao real e chamada e todos os outros testes deste arquivo seguem
// intactos. vi.hoisted porque vi.mock e icado para o topo do modulo, antes
// de qualquer const deste arquivo existir.
const catalogo = vi.hoisted(() => ({ precoForcadoCentavos: null as number | null }))

vi.mock('@/repositories/produtos', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/repositories/produtos')>()
  return {
    ...real,
    buscarKitAtivoPorSlug: async (slug: string) => {
      const kit = await real.buscarKitAtivoPorSlug(slug)
      if (!kit || catalogo.precoForcadoCentavos === null) return kit
      return { ...kit, precoCentavos: deInteiro(catalogo.precoForcadoCentavos) }
    },
  }
})

/** O que a rota mandou cotar — o objeto que chegou em `cotarFrete`. */
type CotacaoPedida = {
  cepDestino: string
  valorDeclarado: number
  volumes: VolumeDaCotacao[]
}

/**
 * SEGUNDO ponto mockado, e por um motivo diferente do catalogo acima: desde
 * 16/08/2026 a rota RECOTA o frete no servidor antes de criar o pedido
 * (src/lib/frete.ts fala com a API do Clube Envios pela rede). Sem este mock,
 * cada teste deste arquivo dispararia uma chamada HTTP de verdade — com a
 * credencial que estiver no .env da maquina —, e um teste de checkout passaria
 * a depender da disponibilidade de um terceiro para ficar verde.
 *
 * O QUE CONTINUA REAL, e e a parte que importa: as CLASSES DE ERRO. O `...real`
 * reexporta ClubeEnviosError, CotacaoIlegivelError e FreteNaoConfiguradoError
 * como elas sao, entao o `instanceof` da rota compara contra exatamente as
 * classes de producao. Um mock que declarasse classes proprias com os mesmos
 * nomes deixaria estes testes verdes enquanto a rota devolvia 500 (e nao 503)
 * para todo comprador em producao — que e precisamente o defeito que despachar
 * por classe, e nao por prefixo de string, existe para impedir.
 *
 * `chamadas` guarda a entrada recebida: e por ela que se prova QUE dimensoes e
 * QUE valor declarado a rota mandou cotar, sem depender de o provedor
 * responder nada.
 */
const clube = vi.hoisted(() => ({
  opcoes: [] as OpcaoDeFrete[],
  falha: null as null | 'clube_envios' | 'ilegivel' | 'nao_configurado' | 'inesperado',
  chamadas: [] as CotacaoPedida[],
}))

vi.mock('@/lib/frete', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/frete')>()
  return {
    ...real,
    cotarFrete: async (e: CotacaoPedida) => {
      clube.chamadas.push(e)
      // Os quatro modos de falha da cotacao, cada um com o desfecho que a rota
      // precisa distinguir: os tres primeiros sao "o provedor nao entregou
      // preco" e viram 503; o ultimo e um Error comum (cadastro de kit com
      // medida invalida, por exemplo), que e defeito nosso e vira 500.
      if (clube.falha === 'clube_envios') throw new real.ClubeEnviosError(0, 'timeout de rede')
      if (clube.falha === 'ilegivel') throw new real.CotacaoIlegivelError(['id_servico', 'transportadora'])
      if (clube.falha === 'nao_configurado') throw new real.FreteNaoConfiguradoError('CLUBE_ENVIOS_TOKEN nao configurada')
      if (clube.falha === 'inesperado') throw new Error('Volume invalido na cotacao (medidas precisam ser inteiros positivos)')
      return { idCotacao: 4242, opcoes: clube.opcoes }
    },
  }
})

/**
 * Duas opcoes com valor E prazo deliberadamente diferentes, e a mais barata NAO
 * e a escolhida por padrao nos testes de frete: e a unica forma de distinguir
 * "a rota gravou a opcao que o comprador escolheu pelo idServico" de "a rota
 * chamou opcaoMaisBarata e deu certo por coincidencia".
 *
 * Valores NAO redondos (R$ 23,50 e R$ 49,90) de proposito: o kit custa
 * R$ 1.000,00, e um frete somado errado — ou nao somado — desaparece dentro de
 * um total redondo sem que nenhuma assercao pisque.
 */
const OPCAO_PAC: OpcaoDeFrete = {
  idServico: 3, idTransportadora: 1, transportadora: 'Correios', servico: 'PAC',
  valor: deInteiro(2350), prazoDias: 8,
}
const OPCAO_SEDEX: OpcaoDeFrete = {
  idServico: 4, idTransportadora: 1, transportadora: 'Correios', servico: 'SEDEX',
  valor: deInteiro(4990), prazoDias: 3,
}

/**
 * O que o wizard manda no corpo sobre frete: SO O ID da opcao escolhida.
 * Nenhum campo monetario acompanha, e o `.strict()` de `Corpo`
 * (src/app/api/pedidos/route.ts) e quem transforma isso em 422 quando alguem
 * tenta — ver os testes DINHEIRO: mais abaixo.
 */
const ESCOLHA_DE_FRETE = { idServico: OPCAO_PAC.idServico }

const SEGREDO = 'a'.repeat(64)
const COMPRADOR = {
  nome: 'Ana Souza', email: 'ana.checkout@exemplo.com',
  cpf: '12345678901', whatsapp: '11988887777',
  cep: '01310100', rua: 'Av Paulista', numero: '1000',
  complemento: '', bairro: 'Bela Vista', cidade: 'Sao Paulo', estado: 'SP',
}

// E-mail usado SO na requisicao que o rate limit barra, para que "nenhuma
// linha foi criada" possa ser afirmado sobre um e-mail que nunca teve linha
// nenhuma — em vez de tentar provar ausencia num e-mail que os testes de
// sucesso ja povoaram.
const EMAIL_BLOQUEADO = 'ana.bloqueada@exemplo.com'

// Cada requisicao sai de um IP proprio: POST /api/pedidos agora tem rate
// limit por IP (src/lib/rate-limit.ts) e o contador e estado de modulo, que
// vive por todo o arquivo. Sem isto, o teto de MAX_PEDIDOS_POR_JANELA seria
// consumido pelo conjunto dos testes e os ultimos veriam 429 sem nenhuma
// relacao com o que alegam provar. Mesma tecnica de ipUnico() em
// src/lib/__tests__/candidatura.test.ts.
let contadorIp = 0
const ipUnico = () => `10.0.0.${++contadorIp}`

function requisicao(body: unknown, cookie?: string, ip: string = ipUnico()) {
  return new Request('http://localhost/api/pedidos', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
      ...(cookie ? { cookie: `__Host-mg_attr=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

function cookieDe(slug: string, utm = { utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento' }) {
  return assinarAtribuicao({ slug, em: Date.now(), ...utm }, SEGREDO)
}

// Slugs e codigos de cupom PROPRIOS deste arquivo — nao "maria"/"MARIA10",
// que ja pertencem a representantes.test.ts e a cupons.test.ts
// respectivamente (o Vitest roda os arquivos de teste em paralelo contra o
// mesmo Postgres real; os dois outros arquivos fazem DELETE+INSERT dessas
// linhas a cada teste, e reusar o mesmo slug/codigo aqui correria contra
// eles). Mesmo raciocinio de SLUG_REP_ATIVA em cupons.test.ts e SLUG_MARIA
// em pedidos.test.ts.
const SLUG_MARIA = 'checkout-maria' // dona do cookie de last-click, 20%
const SLUG_JOANA = 'checkout-joana' // dona de um cupom, 15% — para provar que o cupom vence o cookie
const SLUG_INATIVA = 'checkout-inativa' // desligada — para o caso rep_inativo
const CODIGO_CUPOM = 'CHECKOUT10' // 10%, de Maria
const CODIGO_CUPOM_JOANA = 'CHECKOUTJOANA' // 5%, de Joana — override
const CODIGO_CUPOM_CASA = 'CHECKOUTCASA' // 5%, sem representante — nao pode roubar a venda
const CODIGO_CUPOM_TOTAL = 'CHECKOUTTUDO' // 100%: zera o pedido quando nao ha frete

/**
 * DATA FIXA NO PASSADO, e nao o DEFAULT `now()` da coluna.
 *
 * `resgatarCupom` compara `agora` — o relogio do NODE — contra `inicia_em`, que
 * o Postgres preenche com o relogio DELE. Os dois nao sao o mesmo relogio: no
 * container de desenvolvimento a diferenca medida em 19/08/2026 foi de 896 ms,
 * e nessa janela um cupom recem-semeado ainda "nao comecou" para a aplicacao.
 * O checkout responde 422 `cupom_recusado` e o teste falha — de forma
 * intermitente, conforme a deriva do relogio do container.
 *
 * Mesma solucao, e pelo mesmo motivo, de JA_VALENDO em
 * src/repositories/__tests__/cupons.test.ts. A data fixa tambem diz melhor o
 * que o fixture quer: "este cupom ja esta valendo", e nao "este cupom comeca
 * exatamente agora".
 */
const JA_VALENDO = new Date('2026-01-01T00:00:00Z')

const SLUGS = [SLUG_MARIA, SLUG_JOANA, SLUG_INATIVA] as const
const CODIGOS_CUPOM = [CODIGO_CUPOM, CODIGO_CUPOM_JOANA, CODIGO_CUPOM_CASA, CODIGO_CUPOM_TOTAL] as const

let idMaria: string
let idJoana: string

async function semear() {
  const db = getDb()

  // TODO e-mail que algum teste deste arquivo faz nascer entra nesta lista. Um
  // que fique de fora deixa cliente e pedido para tras, e o pedido segura o
  // cupom por FK — o `semear()` da rodada seguinte falha ao apagar os cupons,
  // com um erro de chave estrangeira que nao diz nada sobre a causa real.
  for (const email of [
    COMPRADOR.email, EMAIL_BLOQUEADO,
    'ana.retirada@exemplo.com', 'ana.retirada2@exemplo.com',
    'ana.contrabando@exemplo.com', 'ana.bundleantigo@exemplo.com',
    'ana.cupomtotal@exemplo.com', 'ana.cupomtotalenvio@exemplo.com',
  ]) {
    // pedidos primeiro: cliente_id/endereco_id/cupom_id sao ON DELETE
    // RESTRICT, e apagar o pedido leva pedido_itens e cupom_usos junto (ON
    // DELETE CASCADE) — ver migrations/1755000000000_pedido_itens.sql e
    // 1755000200000_cupons.sql.
    await db.deleteFrom('pedidos').where('cliente_id', 'in',
      db.selectFrom('clientes').select('id')
        .where(sql<boolean>`lower(email) = lower(${email})`),
    ).execute()
    // Orfaos de uma execucao anterior interrompida antes de limpar.
    await db.deleteFrom('cupom_usos').where('cliente_id', 'in',
      db.selectFrom('clientes').select('id')
        .where(sql<boolean>`lower(email) = lower(${email})`),
    ).execute()
    // enderecos.cliente_id e ON DELETE CASCADE (migrations/1755000100000_clientes.sql):
    // apagar o cliente abaixo leva o(s) endereco(s) dele junto, sem precisar
    // de um DELETE FROM enderecos em separado.
    await db.deleteFrom('clientes')
      .where(sql<boolean>`lower(email) = lower(${email})`).execute()
  }
  // cupons.representante_id e ON DELETE RESTRICT: os cupons deste arquivo
  // tem que sumir antes dos representantes poderem ser apagados.
  await db.deleteFrom('cupons').where('codigo', 'in', CODIGOS_CUPOM).execute()
  await db.deleteFrom('representantes').where('slug', 'in', SLUGS).execute()

  const maria = await db.insertInto('representantes').values({
    slug: SLUG_MARIA, codigo: 'CHECKOUTMARIA', nome: 'Maria (checkout)',
    email: 'checkout-maria@exemplo.com', percentual_comissao: '20.00', ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idMaria = maria.id

  const joana = await db.insertInto('representantes').values({
    slug: SLUG_JOANA, codigo: 'CHECKOUTJOANA', nome: 'Joana (checkout)',
    email: 'checkout-joana@exemplo.com', percentual_comissao: '15.00', ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idJoana = joana.id

  // Desligada de proposito: o teste de rep_inativo precisa de um slug que
  // EXISTE mas nao esta mais ativo — diferente de um slug que nunca
  // existiu (os dois caem no mesmo caminho no resolvedor, mas so este
  // prova que "existente porem desligado" tambem funciona).
  await db.insertInto('representantes').values({
    slug: SLUG_INATIVA, codigo: 'CHECKOUTINATIVA', nome: 'Inativa (checkout)',
    email: 'checkout-inativa@exemplo.com', percentual_comissao: '20.00', ativo: false,
  }).execute()

  // Cupom de 10% pertencente a Maria — usado no teste de desconto simples.
  await db.insertInto('cupons').values({
    codigo: CODIGO_CUPOM, tipo: 'percentual', valor: 10, inicia_em: JA_VALENDO,
    representante_id: idMaria, ativo: true,
  }).execute()

  await db.insertInto('cupons').values({
    codigo: CODIGO_CUPOM_TOTAL, tipo: 'percentual', valor: 100, inicia_em: JA_VALENDO,
    representante_id: null, ativo: true,
  }).execute()

  // Cupom de Joana — usado no teste de prioridade do cupom sobre o cookie.
  // Percentual da COMISSAO (15%) e percentual do DESCONTO do cupom (5%) sao
  // numeros deliberadamente diferentes, para que o teste nao possa
  // confundir "o desconto bateu" com "o percentual de comissao snapshot
  // bateu" — sao duas colunas diferentes, e o bug que este teste previne e
  // exatamente misturar as duas.
  await db.insertInto('cupons').values({
    codigo: CODIGO_CUPOM_JOANA, tipo: 'percentual', valor: 5, inicia_em: JA_VALENDO,
    representante_id: idJoana, ativo: true,
  }).execute()

  // Cupom da CASA — sem representante_id. aplicarPrioridadeDoCupom
  // (src/lib/montar-pedido.ts) so troca a atribuicao quando o cupom tem
  // dono; este existe para provar que um cupom promocional da marca nao
  // rouba a venda de quem trouxe o cliente.
  await db.insertInto('cupons').values({
    codigo: CODIGO_CUPOM_CASA, tipo: 'percentual', valor: 5, inicia_em: JA_VALENDO,
    representante_id: null, ativo: true,
  }).execute()
}

// Escopado ao cliente deste arquivo (por e-mail), NAO um "count(*) FROM
// pedidos" sem filtro: o Vitest roda os arquivos de teste em paralelo
// contra o mesmo Postgres real, e pedidos.test.ts, cupons.test.ts etc.
// criam e apagam pedidos ao mesmo tempo. Um count() global observado
// "antes" e "depois" de uma unica requisicao deste arquivo pode mudar por
// causa de QUALQUER outro arquivo rodando naquele instante — nada a ver com
// o pedido que este teste tentou criar. Contar so os pedidos deste cliente
// prova exatamente a alegacao do teste (nenhum PEDIDO NOVO DESTE
// COMPRADOR), sem depender da ordem ou do timing de arquivos que nao tem
// nada a ver com este.
async function contarPedidos(email: string = COMPRADOR.email): Promise<number> {
  const { total } = await getDb().selectFrom('pedidos')
    .select(sql<number>`count(*)::int`.as('total'))
    .where('cliente_id', 'in',
      getDb().selectFrom('clientes').select('id')
        .where(sql<boolean>`lower(email) = lower(${email})`),
    )
    .executeTakeFirstOrThrow()
  return total
}

async function pedidoPorNumero(numero: number) {
  // pedidos.numero e int8: o select type gerado e string (ver
  // src/repositories/pedidos.ts), entao um `number` cru em `.where('numero', '=', numero)`
  // nao compila. Mesma solucao sql`` usada la, sem introduzir `as` nenhum.
  return getDb().selectFrom('pedidos').selectAll()
    .where(sql<boolean>`numero = ${numero}`).executeTakeFirstOrThrow()
}

describe('POST /api/pedidos', () => {
  // A rota le o segredo de process.env.ATRIBUICAO_SECRET (segredoDeAtribuicao,
  // src/lib/atribuicao.ts) — nao um parametro que este teste pudesse
  // injetar. Mesma tecnica de src/__tests__/proxy.test.ts: sobrescreve o
  // segredo real do .env pelo SEGREDO fixo deste arquivo, so durante a vida
  // deste describe, para que os cookies assinados aqui com SEGREDO verifiquem
  // do lado do handler. Vitest isola cada arquivo de teste em seu proprio
  // worker (isolate: true, o padrao), entao esta mutacao de process.env nao
  // vaza para outros arquivos rodando em paralelo.
  beforeAll(() => {
    process.env.ATRIBUICAO_SECRET = SEGREDO
  })
  // A cotacao volta ao estado "provedor respondendo as duas opcoes" antes de
  // CADA teste: um teste que force falha ou esvazie a lista nao pode deixar o
  // proximo cotando outra coisa. `chamadas` zera junto para que cada teste
  // possa afirmar sobre a SUA cotacao, e nao sobre a soma do arquivo.
  beforeEach(async () => {
    await semear()
    clube.opcoes = [OPCAO_PAC, OPCAO_SEDEX]
    clube.falha = null
    clube.chamadas = []
  })
  afterEach(() => {
    catalogo.precoForcadoCentavos = null
    clube.falha = null
  })
  afterAll(async () => { await closeDb() })

  it('cria o pedido e devolve numero e token', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 2, ...ESCOLHA_DE_FRETE, ...COMPRADOR }))
    expect(r.status).toBe(201)
    const body = await r.json()
    expect(typeof body.numero).toBe('number')
    // token e a chave publica da URL de confirmacao (round de correcao 1,
    // Finding 4) — um uuid, nunca o numero sequencial.
    expect(body.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  // Round de correcao 1: com Corpo.strict() (src/app/api/pedidos/route.ts),
  // um campo de dinheiro no corpo nao e mais silenciosamente IGNORADO — a
  // requisicao inteira e recusada. Isto prova mais do que o teste anterior:
  // antes, so provava que o valor gravado batia com o catalogo; agora prova
  // que a tentativa de manipulacao nem chega a criar um pedido.
  it('DINHEIRO: precoUnitarioCentavos/total no corpo sao rejeitados, nao apenas ignorados', async () => {
    const antes = await contarPedidos()
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE,
      precoUnitarioCentavos: 1, total: 1, // tentativa de manipulacao
      ...COMPRADOR,
    }))
    expect(r.status).toBe(422)
    expect(await contarPedidos()).toBe(antes)
  })

  it('DINHEIRO: a venda pelo link da Maria e atribuida a ela, com o percentual dela', async () => {
    const r = await POST(requisicao(
      { kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR },
      cookieDe(SLUG_MARIA),
    ))
    expect(r.status).toBe(201)
    const { numero } = await r.json()
    const pedido = await pedidoPorNumero(numero)
    expect(pedido.origem).toBe('link')
    expect(pedido.representante_id).toBe(idMaria)
    expect(pedido.utm_source).toBe('instagram')
    // percentual_comissao_snapshot e o numero que decide quanto a
    // representante recebe: ninguem mais no sistema testava a leitura de
    // representantes.percentual_comissao no momento da criacao do pedido
    // (round de correcao 1, Finding 3).
    expect(Number(pedido.percentual_comissao_snapshot)).toBe(20)
  })

  it('sem cookie, a venda e da casa', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR }))
    expect(r.status).toBe(201)
    const { numero } = await r.json()
    const pedido = await getDb().selectFrom('pedidos').select('origem')
      .where('numero', '=', numero).executeTakeFirstOrThrow()
    expect(pedido.origem).toBe('casa')
  })

  // Representante EXISTE mas foi desligada — diferente de um slug que nunca
  // existiu. Os dois caem em 'rep_inativo' no resolvedor
  // (src/lib/resolver-pedido.ts), mas so este teste prova o caminho de
  // "existente porem inativo" especificamente, e que os UTM da campanha
  // continuam gravados mesmo sem ninguem a receber comissao (round de
  // correcao 1, Finding 3).
  it('DINHEIRO: cookie de representante desligada vira rep_inativo, com UTM preservado', async () => {
    const r = await POST(requisicao(
      { kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR },
      cookieDe(SLUG_INATIVA, { utmSource: 'facebook', utmMedium: 'ads', utmCampaign: 'inverno' }),
    ))
    expect(r.status).toBe(201)
    const { numero } = await r.json()
    const pedido = await pedidoPorNumero(numero)
    expect(pedido.origem).toBe('rep_inativo')
    expect(pedido.representante_id).toBeNull()
    expect(pedido.percentual_comissao_snapshot).toBeNull()
    expect(pedido.utm_source).toBe('facebook')
    expect(pedido.utm_campaign).toBe('inverno')
  })

  it('cupom aplicado desconta e registra o uso', async () => {
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1, cupom: CODIGO_CUPOM,
      ...ESCOLHA_DE_FRETE, ...COMPRADOR,
    }))
    expect(r.status).toBe(201)
    const { numero } = await r.json()
    const pedido = await pedidoPorNumero(numero)
    expect(pedido.desconto_centavos).toBe(10000)
    // DINHEIRO: a ORDEM das operacoes esta aqui, nao so o total. O frete e
    // somado DEPOIS do desconto e o cupom nao abate um centavo dele — quem
    // pagou 10% de desconto continua pagando a transportadora inteira. E a
    // formula da constraint pedido_total_confere
    // (migrations/1754900300000_pedidos.sql); escrita como conta, e nao como o
    // literal 92350, para que o numero errado nao possa ser "corrigido" no
    // teste sem que a conta apareca.
    expect(pedido.frete_centavos).toBe(OPCAO_PAC.valor)
    expect(pedido.total_centavos).toBe(100000 - 10000 + OPCAO_PAC.valor)
    const usos = await getDb().selectFrom('cupom_usos').selectAll()
      .where('pedido_id', '=', pedido.id).execute()
    expect(usos).toHaveLength(1)
  })

  // HIERARQUIA cupom > last click (src/lib/montar-pedido.ts): o cookie
  // atribui a venda a Maria, mas o cupom digitado no checkout pertence a
  // Joana — o cupom tem que vencer, e o percentual gravado tem que ser o
  // DELA (15%), nunca o de Maria (20%) nem um valor lido do cookie. Nenhum
  // teste cobria este caminho ponta a ponta antes (round de correcao 1,
  // Finding 3) — montar-pedido.test.ts testa aplicarPrioridadeDoCupom com
  // um stub, nao a fiacao real com o banco.
  it('DINHEIRO: cupom de outra representante tem prioridade sobre o cookie, com o percentual dela', async () => {
    const r = await POST(requisicao(
      { kitSlug: 'kit-milagran', quantidade: 1, cupom: CODIGO_CUPOM_JOANA, ...ESCOLHA_DE_FRETE, ...COMPRADOR },
      cookieDe(SLUG_MARIA),
    ))
    expect(r.status).toBe(201)
    const { numero } = await r.json()
    const pedido = await pedidoPorNumero(numero)
    expect(pedido.origem).toBe('cupom')
    expect(pedido.representante_id).toBe(idJoana)
    expect(Number(pedido.percentual_comissao_snapshot)).toBe(15)
  })

  // Um cupom da CASA (sem representante_id) e promocao da marca — nao pode
  // roubar a venda de quem trouxe o cliente por link. O desconto ainda se
  // aplica; so a atribuicao continua sendo a do cookie.
  it('cupom da casa (sem representante) nao rouba a venda do cookie', async () => {
    const r = await POST(requisicao(
      { kitSlug: 'kit-milagran', quantidade: 1, cupom: CODIGO_CUPOM_CASA, ...ESCOLHA_DE_FRETE, ...COMPRADOR },
      cookieDe(SLUG_MARIA),
    ))
    expect(r.status).toBe(201)
    const { numero } = await r.json()
    const pedido = await pedidoPorNumero(numero)
    expect(pedido.origem).toBe('link')
    expect(pedido.representante_id).toBe(idMaria)
    expect(Number(pedido.percentual_comissao_snapshot)).toBe(20)
    expect(pedido.desconto_centavos).toBeGreaterThan(0)
  })

  it('cupom invalido devolve 422 e NAO cria pedido', async () => {
    const antes = await contarPedidos()
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1, cupom: 'NAOEXISTE', ...ESCOLHA_DE_FRETE, ...COMPRADOR,
    }))
    expect(r.status).toBe(422)
    expect(await contarPedidos()).toBe(antes)
  })

  // A promessa da Tarefa 9 e mais forte do que "nenhum pedido sobra": a
  // transacao inteira (cliente, endereco, resgate do cupom, pedido, itens e
  // uso do cupom) tem que reverter junto. Sem isso, um checkout recusado
  // deixaria nome, CPF, whatsapp e endereco de um estranho commitados para
  // sempre, presos a pedido nenhum — um problema de dado pessoal, nao so um
  // pedido "quase criado". Este teste chama o endpoint de novo (o
  // beforeEach ja limpou o estado deste e-mail) e prova a atomicidade
  // olhando diretamente para clientes e enderecos, nao so para pedidos.
  //
  // NOTA (round de correcao 1): este teste NAO exercita a fiacao de
  // criarPedido(..., trx) — ele lanca RecusaDeCupom antes de criarPedido
  // ser chamado. Quem prova que criarPedido usa a transacao recebida (em
  // vez de abrir a propria) sao os testes de SUCESSO acima: se essa fiacao
  // quebrasse, o INSERT em pedidos tentaria referenciar um cliente_id que
  // ainda nao commitou numa transacao separada, e a FK falharia.
  it('DINHEIRO/LGPD: cupom invalido nao deixa cliente nem endereco orfaos', async () => {
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1, cupom: 'NAOEXISTE', ...ESCOLHA_DE_FRETE, ...COMPRADOR,
    }))
    expect(r.status).toBe(422)

    const clientes = await getDb().selectFrom('clientes').select('id')
      .where(sql<boolean>`lower(email) = lower(${COMPRADOR.email})`).execute()
    expect(clientes).toHaveLength(0)

    // enderecos nao tem coluna de e-mail: junta com clientes pelo mesmo
    // e-mail para provar que nenhum endereco ficou associado a este
    // comprador — nao so que a linha de cliente sumiu.
    const enderecos = await getDb().selectFrom('enderecos')
      .innerJoin('clientes', 'clientes.id', 'enderecos.cliente_id')
      .select('enderecos.id')
      .where(sql<boolean>`lower(clientes.email) = lower(${COMPRADOR.email})`)
      .execute()
    expect(enderecos).toHaveLength(0)
  })

  // Round de correcao 1, Finding 1: um CPF que diverge do ja cadastrado
  // para o mesmo e-mail NAO PODE virar uma mensagem distinta de qualquer
  // outro erro de validacao — isso seria um oraculo sem autenticacao (um
  // 422 "cpf_divergente" revela que o e-mail ja e de um cliente
  // cadastrado; uma segunda tentativa acertando o CPF cria um pedido de
  // verdade em nome de outra pessoa). A resposta tem que ser
  // INDISTINGUIVEL do 422 generico de qualquer outro dado invalido.
  it('SEGURANCA: CPF divergente do cadastro devolve o MESMO 422 generico, sem detalhe', async () => {
    // Primeiro checkout cadastra o cliente com o CPF de COMPRADOR.
    const primeiro = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR }))
    expect(primeiro.status).toBe(201)

    // Segundo checkout, mesmo e-mail, CPF diferente: a rota tem que
    // recusar, mas com o MESMO formato de erro de qualquer 422 de
    // validacao — sem um campo "mensagem", sem a palavra "cpf" ou
    // "divergente" em lugar nenhum do corpo.
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR, cpf: '98765432100',
    }))
    expect(r.status).toBe(422)
    const corpo = await r.json()
    expect(corpo).toEqual({ error: 'dados_invalidos' })
    expect(JSON.stringify(corpo).toLowerCase()).not.toContain('cpf')
    expect(JSON.stringify(corpo).toLowerCase()).not.toContain('divergente')
  })

  // NAO havia teste de rota para este mapeamento: pedidos.test.ts prova que
  // criarPedido lanca, e mais nada. Enquanto a rota despachava por
  // `mensagem.startsWith('preco_divergente')`, reescrever a frase do throw no
  // repositorio fazia o comprador passar a receber 500 — com a suite inteira
  // verde. Agora o despacho e por `instanceof PrecoDivergenteError` e este
  // teste fecha o buraco pelo lado do HTTP.
  it('DINHEIRO: preco divergente do catalogo vira 422 curado, sem vazar preco nem uuid', async () => {
    const antes = await contarPedidos()
    // O que a "vitrine" mostrou (1 centavo) deixou de bater com o catalogo.
    catalogo.precoForcadoCentavos = 1

    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR }))
    expect(r.status).toBe(422)

    // Corpo INTEIRO, nao so o codigo: a mensagem crua do throw carrega o
    // uuid do kit, o preco do catalogo e o preco enviado, e nenhum dos tres
    // pode aparecer aqui. Um toEqual exato quebra se alguem "so acrescentar
    // um detalhe util" na resposta.
    expect(await r.json()).toEqual({
      error: 'dados_invalidos',
      mensagem: 'O preco do produto mudou. Atualize a pagina e tente novamente.',
    })

    // E a transacao inteira reverteu: nenhum pedido e nenhum dado pessoal
    // ficou para tras (salvarClienteComEndereco roda ANTES de criarPedido).
    expect(await contarPedidos()).toBe(antes)
    const clientes = await getDb().selectFrom('clientes').select('id')
      .where(sql<boolean>`lower(email) = lower(${COMPRADOR.email})`).execute()
    expect(clientes).toHaveLength(0)
  })

  it('rejeita quantidade acima do teto', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 999, ...ESCOLHA_DE_FRETE, ...COMPRADOR }))
    expect(r.status).toBe(422)
  })

  it('rejeita corpo sem os campos do comprador', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1 }))
    expect(r.status).toBe(422)
  })

  /**
   * §13 do documento de 16/08/2026 e a secao 5 do plano: o comprador escolhe
   * uma opcao de frete na tela e envia SO o `idServico` dela. O valor cobrado
   * sai da cotacao que ESTE servidor faz, com o CEP deste corpo, no instante
   * do submit.
   *
   * POR QUE ISTO PRECISA DE TESTE PROPRIO: `pedidos.frete_centavos` e
   * `pedidos.total_centavos` sao CONGELADOS pelo trigger
   * pedido_atribuicao_imutavel_trg — depois do INSERT nao existe UPDATE de
   * correcao por caminho nenhum. Um frete errado (manipulado no corpo, lido de
   * uma cotacao velha, ou zerado por falha do provedor) nao da erro em lugar
   * nenhum: vira prejuizo silencioso de um pedido de cada vez, ate alguem
   * conferir a fatura da transportadora contra a tabela de pedidos.
   */
  describe('frete recotado no servidor', () => {
    it('DINHEIRO: grava valor e prazo da opcao ESCOLHIDA, nao os da mais barata', async () => {
      const r = await POST(requisicao({
        kitSlug: 'kit-milagran', quantidade: 1,
        // A opcao CARA, de proposito: se a rota chamasse opcaoMaisBarata em vez
        // de casar pelo idServico, este teste seria o unico a perceber — e o
        // sintoma em producao seria a loja cobrando SEDEX e postando PAC (ou o
        // contrario, que e o caro).
        idServico: OPCAO_SEDEX.idServico,
        ...COMPRADOR,
      }))
      expect(r.status).toBe(201)
      const { numero } = await r.json()
      const pedido = await pedidoPorNumero(numero)

      expect(pedido.frete_centavos).toBe(OPCAO_SEDEX.valor)
      expect(pedido.prazo_dias_estimado).toBe(OPCAO_SEDEX.prazoDias)
      // total = subtotal - desconto + frete (constraint pedido_total_confere).
      // O subtotal sai da propria linha e nao de um literal: este teste e sobre
      // o frete entrar na conta, e o preco do catalogo ja e travado por outros.
      expect(pedido.total_centavos).toBe(pedido.subtotal_centavos + OPCAO_SEDEX.valor)
      // canal e literal na rota — esta e a loja. A coluna e congelada pelo
      // mesmo trigger, entao um 'presencial' gravado aqui por engano jamais
      // poderia ser corrigido, e tiraria a venda do estoque errado (§4).
      expect(pedido.canal).toBe('online')
    })

    it('DINHEIRO: cota com o CEP submetido, o subtotal e as dimensoes do CADASTRO', async () => {
      const r = await POST(requisicao({
        kitSlug: 'kit-milagran', quantidade: 2, ...ESCOLHA_DE_FRETE, ...COMPRADOR,
      }))
      expect(r.status).toBe(201)

      // UMA cotacao por requisicao. Cotar duas vezes (uma para responder, outra
      // para gravar) seria a porta aberta para os dois valores divergirem entre
      // si dentro do mesmo pedido.
      expect(clube.chamadas).toHaveLength(1)
      const pedida = clube.chamadas[0]
      expect(pedida.cepDestino).toBe(COMPRADOR.cep)

      const kit = await getDb().selectFrom('kits')
        .select(['preco_centavos', 'peso_gramas', 'altura_cm', 'largura_cm', 'comprimento_cm'])
        .where('slug', '=', 'kit-milagran')
        .executeTakeFirstOrThrow()

      // Valor declarado e o subtotal (preco do CATALOGO x quantidade), nunca um
      // numero vindo do corpo.
      expect(pedida.valorDeclarado).toBe(kit.preco_centavos * 2)
      // Medidas e peso saem da tabela `kits`, e a quantidade comprada multiplica
      // o volume. Numero escrito na rota daria frete errado sem que nada no
      // codigo dissesse de onde ele veio (ver o doc comment de Kit em
      // src/repositories/produtos.ts).
      expect(pedida.volumes).toEqual([{
        alturaCm: kit.altura_cm,
        larguraCm: kit.largura_cm,
        comprimentoCm: kit.comprimento_cm,
        pesoGramas: kit.peso_gramas,
        quantidade: 2,
      }])
    })

    it('DINHEIRO: idServico que nao esta na cotacao vira 422 e NAO cria pedido', async () => {
      const antes = await contarPedidos()
      const r = await POST(requisicao({
        kitSlug: 'kit-milagran', quantidade: 1, idServico: 987654, ...COMPRADOR,
      }))
      expect(r.status).toBe(422)
      // Corpo inteiro: a recusa e especifica (a tela precisa saber que deve
      // recalcular o frete, e nao que digitou o CPF errado) e nao carrega nada
      // sobre a cotacao em si.
      expect(await r.json()).toEqual({
        error: 'opcao_de_frete_invalida',
        mensagem: 'A opção de frete escolhida não está mais disponível. Recalcule o frete e tente de novo.',
      })
      expect(await contarPedidos()).toBe(antes)
    })

    // O provedor respondeu, mas nao ha servico atendendo aquele CEP. A rota NAO
    // pode "seguir sem frete": zero e o unico valor que nao pode ser inventado
    // (src/components/linha-frete.tsx e o cabecalho de src/lib/frete.ts).
    it('DINHEIRO: cotacao sem opcao nenhuma vira 422, nunca frete zero', async () => {
      clube.opcoes = []
      const antes = await contarPedidos()
      const r = await POST(requisicao({
        kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR,
      }))
      expect(r.status).toBe(422)
      expect(await contarPedidos()).toBe(antes)
    })

    it('rejeita idServico ausente, zero, negativo, fracionario ou em texto', async () => {
      const antes = await contarPedidos()
      const base = { kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR }
      const corpos: unknown[] = [
        base,                          // ausente: escolher frete nao e opcional
        { ...base, idServico: 0 },
        { ...base, idServico: -3 },
        { ...base, idServico: 1.5 },
        { ...base, idServico: '3' },   // o JSON tem que trazer numero, nao texto
        { ...base, idServico: null },
      ]

      for (const corpo of corpos) {
        const r = await POST(requisicao(corpo))
        expect(r.status).toBe(422)
        // Erro achatado, sem detalhe de campo: a resposta de validacao e a
        // mesma de qualquer outro campo invalido do corpo.
        expect(await r.json()).toEqual({ error: 'dados_invalidos' })
      }
      expect(await contarPedidos()).toBe(antes)
    })

    /**
     * DINHEIRO: a tentativa de mandar o VALOR do frete (em vez de so a escolha)
     * e recusada, nao ignorada. `.strict()` derruba o corpo inteiro — e essa e
     * a diferenca que importa: um campo ignorado deixaria a tentativa de
     * manipulacao indistinguivel de um checkout normal, inclusive no log.
     *
     * `prazoDiasEstimado` esta na lista embora nao seja dinheiro: e a promessa
     * de entrega que o comprador ve, e ela tambem sai da cotacao do servidor.
     */
    it('DINHEIRO: valor de frete no corpo continua sendo 422 pelo .strict()', async () => {
      const antes = await contarPedidos()
      const tentativas = [
        { frete: 0 },
        { frete: 1 },
        { freteCentavos: 0 },
        { freteCentavos: 1 },
        { valorFrete: 1 },
        { prazoDiasEstimado: 1 },
      ]

      for (const extra of tentativas) {
        const r = await POST(requisicao({
          kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR, ...extra,
        }))
        expect(r.status).toBe(422)
        expect(await r.json()).toEqual({ error: 'dados_invalidos' })
      }
      expect(await contarPedidos()).toBe(antes)
    })

    /**
     * Os tres modos de indisponibilidade do Clube Envios (provedor recusou ou
     * nao respondeu, resposta ilegivel, credencial/CEP de origem ausentes) tem
     * o MESMO desfecho para quem esta comprando, e por isso vivem no mesmo
     * teste: 503, mensagem curada, pedido nenhum.
     *
     * A parte LGPD: como a cotacao acontece ANTES de a transacao abrir, uma
     * falha de frete nao chega a tocar o banco — nem cliente, nem endereco. Nao
     * ha rollback a torcer para funcionar, porque nao houve escrita.
     *
     * O que este teste proibe acima de tudo: cair para frete zero e criar o
     * pedido assim mesmo.
     */
    it('DINHEIRO/LGPD: cotacao indisponivel vira 503 sem criar pedido nem gravar dado pessoal', async () => {
      for (const falha of ['clube_envios', 'ilegivel', 'nao_configurado'] as const) {
        clube.falha = falha
        const r = await POST(requisicao({
          kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR,
        }))
        expect(r.status, `falha=${falha}`).toBe(503)
        expect(await r.json()).toEqual({
          error: 'frete_indisponivel',
          mensagem: 'Não foi possível calcular o frete agora. Tente novamente em instantes.',
        })
      }

      // Zero, e nao "o mesmo de antes": o beforeEach limpou os pedidos deste
      // e-mail, entao nenhum pedido deste comprador pode existir depois de tres
      // tentativas que nao conseguiram cotar.
      expect(await contarPedidos()).toBe(0)
      const clientes = await getDb().selectFrom('clientes').select('id')
        .where(sql<boolean>`lower(email) = lower(${COMPRADOR.email})`).execute()
      expect(clientes).toHaveLength(0)
    })

    // Falha que NAO e do provedor (cotarFrete tambem lanca Error comum quando um
    // volume vem com medida invalida — cadastro de kit quebrado). Vira 500, nao
    // 503: 503 diz "tente de novo em instantes" e tentar de novo com o mesmo kit
    // quebrado nao resolve nada. Distinguir os dois e o que mantem o log
    // contando a historia certa no dia do evento.
    it('falha inesperada na cotacao vira 500, e nao 503', async () => {
      clube.falha = 'inesperado'
      const antes = await contarPedidos()
      const r = await POST(requisicao({
        kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR,
      }))
      expect(r.status).toBe(500)
      expect(await r.json()).toEqual({ error: 'nao_foi_possivel_criar_o_pedido' })
      expect(await contarPedidos()).toBe(antes)
    })
  })

  // O endpoint nao tem autenticacao e escreve CPF, nome completo, telefone e
  // endereco residencial. O freio e o mesmo mecanismo por IP que o
  // formulario de candidatura ja usava (src/lib/rate-limit.ts) — em memoria
  // do processo, quebra-molas contra abuso ingenuo, nao rate limiting
  // distribuido.
  describe('rate limit por IP', () => {
    it('permite MAX_PEDIDOS_POR_JANELA pedidos do mesmo IP e barra o seguinte com 429', async () => {
      const ip = ipUnico()
      for (let i = 0; i < MAX_PEDIDOS_POR_JANELA; i++) {
        const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR }, undefined, ip))
        // O teto nao pode cortar trafego legitimo ANTES de ser atingido:
        // todas as MAX primeiras precisam passar de verdade.
        expect(r.status).toBe(201)
      }
      expect(await contarPedidos()).toBe(MAX_PEDIDOS_POR_JANELA)

      const bloqueado = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR }, undefined, ip))
      expect(bloqueado.status).toBe(429)
      expect(await bloqueado.json()).toEqual({ error: 'rate_limited' })
      expect(await contarPedidos()).toBe(MAX_PEDIDOS_POR_JANELA)
    })

    // Um IP DIFERENTE nao herda o contador do teste acima: o limite e por
    // IP, e um comprador legitimo nao pode ser barrado porque outro
    // exagerou.
    it('o teto e por IP: outro IP continua criando pedido normalmente', async () => {
      const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR }))
      expect(r.status).toBe(201)
    })

    it('RATE LIMIT/LGPD: a requisicao barrada nao cria cliente, endereco nem pedido', async () => {
      const ip = ipUnico()
      // Esgota a janela com corpos que o Zod recusa: o contador soma
      // TENTATIVAS, nao sucessos — se contasse so os 201, um bot mandando
      // lixo ficaria sem freio nenhum. Alem disso, um 422 nao escreve nada,
      // entao o estado do banco na hora do 429 e conhecido.
      for (let i = 0; i < MAX_PEDIDOS_POR_JANELA; i++) {
        const r = await POST(requisicao({ kitSlug: 'kit-milagran' }, undefined, ip))
        expect(r.status).toBe(422)
      }

      // A barrada leva um corpo COMPLETO e valido, com um e-mail que nunca
      // teve linha nenhuma: se o 429 fosse decidido depois de qualquer
      // escrita, o cliente e o endereco deste e-mail apareceriam.
      const bloqueado = await POST(requisicao({
        kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE, ...COMPRADOR, email: EMAIL_BLOQUEADO,
      }, undefined, ip))
      expect(bloqueado.status).toBe(429)

      const clientes = await getDb().selectFrom('clientes').select('id')
        .where(sql<boolean>`lower(email) = lower(${EMAIL_BLOQUEADO})`).execute()
      expect(clientes).toHaveLength(0)

      const enderecos = await getDb().selectFrom('enderecos')
        .innerJoin('clientes', 'clientes.id', 'enderecos.cliente_id')
        .select('enderecos.id')
        .where(sql<boolean>`lower(clientes.email) = lower(${EMAIL_BLOQUEADO})`)
        .execute()
      expect(enderecos).toHaveLength(0)

      expect(await contarPedidos(EMAIL_BLOQUEADO)).toBe(0)
    })
  })

  /**
   * RETIRADA NO LOCAL (19/08/2026). O bloco existe para provar as tres coisas
   * que separam este caminho do de envio, e que nenhum teste acima alcanca:
   * ele NAO fala com o Clube Envios, NAO grava endereco e NAO aceita que o
   * navegador mande campo de envio junto.
   */
  describe('retirada no local', () => {
    // So os dados pessoais. Sem cep, sem rua, sem numero: quem vem buscar nao
    // informou destino nenhum, e o schema recusa se informar.
    const QUEM_BUSCA = {
      nome: 'Ana Souza', email: 'ana.retirada@exemplo.com',
      cpf: '12345678901', whatsapp: '11988887777',
    }
    const RETIRADA = { kitSlug: 'kit-milagran', quantidade: 1, tipoEntrega: 'retirada' as const }

    it('cria o pedido sem frete, sem endereco e sem prazo de transportadora', async () => {
      const r = await POST(requisicao({ ...RETIRADA, ...QUEM_BUSCA }))
      expect(r.status).toBe(201)

      const { numero } = await r.json() as { numero: number }
      const pedido = await pedidoPorNumero(numero)

      expect(pedido.tipo_entrega).toBe('retirada')
      expect(pedido.frete_centavos).toBe(0)
      // O total e o subtotal: nao ha transporte a somar.
      expect(pedido.total_centavos).toBe(pedido.subtotal_centavos - pedido.desconto_centavos)
      // NULL, e nao um endereco guardado "porque nao custa": nao havera entrega
      // nesse endereco, e a tela de logistica passaria a exibir um destino para
      // um pedido que nunca sai daqui.
      expect(pedido.endereco_id).toBeNull()
      // NULL, e nao 7. `prazo_dias_estimado` e prazo de TRANSPORTADORA, e a
      // pagina do pedido o imprime como "dias uteis apos a postagem".
      expect(pedido.prazo_dias_estimado).toBeNull()
    })

    /**
     * NAO GASTA REQUISICAO DO PROVEDOR, e nao depende dele estar de pe. E a
     * razao de o desvio acontecer ANTES da recotacao, e nao depois: uma compra
     * sem transporte nao pode morrer porque o Clube Envios caiu.
     */
    it('nao chama o Clube Envios nem quando o provedor esta fora do ar', async () => {
      clube.chamadas.length = 0
      clube.falha = 'clube_envios'

      const r = await POST(requisicao({
        ...RETIRADA, ...QUEM_BUSCA, email: 'ana.retirada2@exemplo.com',
      }))

      expect(r.status).toBe(201)
      expect(clube.chamadas).toHaveLength(0)
      clube.falha = null
    })

    /**
     * CONTRABANDO RECUSADO. `CorpoRetirada` tambem e `.strict()`: uma retirada
     * que mandasse `idServico` ou `cep` teria os campos DESCARTADOS em silencio
     * num schema frouxo — e um cliente adulterado poderia declarar retirada
     * (frete zero) carregando o resto de um pedido de envio, com a unica
     * barreira entre isso e um kit postado de graca sendo alguem lembrar de
     * olhar a coluna certa na tela de logistica.
     */
    it('retirada mandando idServico ou endereco e 422', async () => {
      for (const contrabando of [
        { idServico: OPCAO_PAC.idServico },
        { cep: '01310100' },
        { rua: 'Av Paulista', numero: '1000' },
      ]) {
        const r = await POST(requisicao({
          ...RETIRADA, ...QUEM_BUSCA, email: 'ana.contrabando@exemplo.com', ...contrabando,
        }))
        expect(r.status).toBe(422)
      }
    })

    /**
     * PEDIDO DE R$ 0,00 NAO NASCE.
     *
     * Cupom de 100% mais retirada (frete zero) fecha o total em zero. Se o
     * pedido nascesse, nao haveria como cobra-lo — o Mercado Pago recusa uma
     * cobranca de R$ 0,00 —, ele ficaria preso em 'pendente' para sempre, com o
     * cupom JA consumido e `total_centavos` congelado pelo trigger de
     * imutabilidade. Sem UPDATE de correcao possivel.
     *
     * Com ENVIO a mesma combinacao continua valida: sobra o frete a pagar.
     */
    it('cupom que zera o total e recusado, e o uso do cupom nao fica gravado', async () => {
      const email = 'ana.cupomtotal@exemplo.com'
      const r = await POST(requisicao({
        kitSlug: 'kit-milagran', quantidade: 1, tipoEntrega: 'retirada',
        cupom: CODIGO_CUPOM_TOTAL,
        nome: 'Ana Souza', email, cpf: '12345678901', whatsapp: '11988887777',
      }))

      expect(r.status).toBe(422)
      expect(await r.json()).toMatchObject({ error: 'pedido_sem_valor' })
      expect(await contarPedidos(email)).toBe(0)

      // O ROLLBACK LEVOU O USO DO CUPOM JUNTO. Sem isso, a tentativa recusada
      // teria comido o limite por cliente e a pessoa nao conseguiria mais usar
      // o cupom em nenhuma compra.
      const { total } = await getDb().selectFrom('cupom_usos')
        .select(sql<number>`count(*)::int`.as('total'))
        .where('cupom_id', 'in',
          getDb().selectFrom('cupons').select('id').where('codigo', '=', CODIGO_CUPOM_TOTAL))
        .executeTakeFirstOrThrow()
      expect(total).toBe(0)
    })

    it('o mesmo cupom com ENVIO passa, porque sobra o frete', async () => {
      const r = await POST(requisicao({
        kitSlug: 'kit-milagran', quantidade: 1, tipoEntrega: 'envio',
        cupom: CODIGO_CUPOM_TOTAL, ...ESCOLHA_DE_FRETE,
        ...COMPRADOR, email: 'ana.cupomtotalenvio@exemplo.com',
      }))
      expect(r.status).toBe(201)

      const { numero } = await r.json() as { numero: number }
      const pedido = await pedidoPorNumero(numero)
      expect(pedido.total_centavos).toBe(pedido.frete_centavos)
      expect(pedido.total_centavos).toBeGreaterThan(0)
    })

    // O ramo de ENVIO nao afrouxou nada: as duas garantias que existiam antes
    // da uniao discriminada continuam de pe, agora dentro do ramo certo.
    it('envio sem idServico e envio sem endereco continuam 422', async () => {
      const semServico = await POST(requisicao({
        kitSlug: 'kit-milagran', quantidade: 1, tipoEntrega: 'envio', ...COMPRADOR,
      }))
      expect(semServico.status).toBe(422)

      const semEndereco = await POST(requisicao({
        kitSlug: 'kit-milagran', quantidade: 1, tipoEntrega: 'envio',
        ...ESCOLHA_DE_FRETE, ...QUEM_BUSCA,
      }))
      expect(semEndereco.status).toBe(422)
    })

    /**
     * COMPATIBILIDADE COM A ABA ABERTA ANTES DO DEPLOY. Um corpo sem
     * `tipoEntrega` e um bundle antigo — e ele tem que continuar comprando, ou
     * o deploy da semana do lancamento derruba a venda de quem estava com o
     * checkout preenchido na tela.
     */
    it('corpo sem tipoEntrega ainda vale, e vale como envio', async () => {
      const r = await POST(requisicao({
        kitSlug: 'kit-milagran', quantidade: 1, ...ESCOLHA_DE_FRETE,
        ...COMPRADOR, email: 'ana.bundleantigo@exemplo.com',
      }))
      expect(r.status).toBe(201)

      const { numero } = await r.json() as { numero: number }
      const pedido = await pedidoPorNumero(numero)
      expect(pedido.tipo_entrega).toBe('envio')
      expect(pedido.endereco_id).not.toBeNull()
    })
  })
})
