import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { registrarLead, listarLeads } from '@/repositories/leads'

// E-MAILS PROPRIOS deste arquivo, no mesmo espirito dos slugs de
// representantes.test.ts e dos e-mails de clientes.test.ts. O Vitest roda os
// arquivos de teste em PARALELO contra o MESMO Postgres, entao um
// `DELETE FROM leads` sem WHERE aqui apagaria as linhas que outro arquivo
// acabou de inserir — e as asseveracoes de listagem abaixo enxergariam leads
// que nao sao deste arquivo. O e-mail e a chave de limpeza porque e o unico
// campo que este arquivo controla inteiro: `tipo` e compartilhado com
// qualquer outro teste que grave lead, e `leads` nao tem indice unico por
// e-mail nenhum (de proposito — ver o comentario em
// migrations/1755300400000_leads.sql), entao o mesmo e-mail pode aparecer em
// varias linhas nossas e todas caem no mesmo DELETE.
const EMAIL_REPRESENTANTE = 'leads-repo-rep@exemplo.com'
const EMAIL_DISTRIBUIDOR = 'leads-repo-dist@exemplo.com'
const EMAIL_INTERESSADO = 'leads-repo-interessado@exemplo.com'
const EMAIL_LGPD = 'leads-repo-lgpd@exemplo.com'
const EMAIL_ORDEM = 'leads-repo-ordem@exemplo.com'
const EMAILS = [
  EMAIL_REPRESENTANTE, EMAIL_DISTRIBUIDOR, EMAIL_INTERESSADO,
  EMAIL_LGPD, EMAIL_ORDEM,
] as const

const FORMATO_UUID = /^[0-9a-f-]{36}$/

// `leads` nao e referenciada por nenhuma outra tabela (nao ha FK apontando
// para ela), entao o DELETE nao precisa de ordem nenhuma — diferente de
// clientes.test.ts, que apaga pedidos antes por causa do ON DELETE RESTRICT.
async function limpar() {
  await getDb().deleteFrom('leads').where('email', 'in', EMAILS).execute()
}

// Toda leitura sem filtro de e-mail passa por aqui. listarLeads() devolve a
// tabela inteira, que em CI tem tambem os leads dos outros arquivos e o que
// as rotas de teste gravarem; sem este recorte, uma asseveracao de contagem
// falharia por causa de um vizinho e mandaria quem investiga para o lugar
// errado.
function somenteDesteArquivo<T extends { email: string }>(linhas: T[]): T[] {
  return linhas.filter((l) => (EMAILS as readonly string[]).includes(l.email))
}

const REPRESENTANTE = {
  tipo: 'representante' as const,
  nome: 'Maria Silva',
  email: EMAIL_REPRESENTANTE,
  whatsapp: '81999998888',
  cidade: 'Recife',
  estado: 'PE',
  mensagem: 'Área de atuação: Esteticista | Já atua com estética: Sim',
  consentimentoLgpd: true,
  origem: 'Instagram',
}

describe('repositorio de leads', () => {
  beforeEach(limpar)
  afterAll(async () => { await closeDb() })

  it('registra o lead e devolve a linha gravada, campo a campo', async () => {
    const lead = await registrarLead(REPRESENTANTE)

    expect(lead.id).toMatch(FORMATO_UUID)
    expect(lead).toMatchObject({
      tipo: 'representante',
      nome: 'Maria Silva',
      email: EMAIL_REPRESENTANTE,
      whatsapp: '81999998888',
      cidade: 'Recife',
      estado: 'PE',
      mensagem: 'Área de atuação: Esteticista | Já atua com estética: Sim',
      consentimentoLgpd: true,
      origem: 'Instagram',
    })
    expect(lead.criadoEm).toBeInstanceOf(Date)
  })

  // Um lead chega por mais de um formulario e nenhum deles pede os mesmos
  // campos. O contrato e '' e nunca NULL, igual aos DEFAULTs da tabela: com
  // duas representacoes de "nao informado" a tela do painel precisaria de
  // coalesce em todo lugar e a ordenacao por cidade mudaria conforme o
  // formulario de origem.
  it('preenche com string vazia o que o formulario nao coletou, em vez de NULL', async () => {
    const lead = await registrarLead({
      tipo: 'interessado',
      nome: 'Curioso',
      email: EMAIL_INTERESSADO,
      consentimentoLgpd: false,
    })

    expect(lead.whatsapp).toBe('')
    expect(lead.cidade).toBe('')
    expect(lead.estado).toBe('')
    expect(lead.mensagem).toBe('')
    expect(lead.origem).toBe('')
  })

  // Diferente de enderecos, onde 'sp' TEM que ser recusado na cara do
  // comprador (o valor vai numa etiqueta de entrega). Aqui a recusa nao
  // chega a ninguem — quem grava lead trata a falha como best-effort — entao
  // um CHECK estourado por causa da caixa da letra seria lead PERDIDO.
  it('normaliza a UF para maiusculas em vez de perder o lead', async () => {
    const lead = await registrarLead({ ...REPRESENTANTE, estado: 'pe' })
    expect(lead.estado).toBe('PE')
  })

  it('espaco em volta do que a pessoa colou no celular nao vira parte do dado', async () => {
    const lead = await registrarLead({
      ...REPRESENTANTE,
      nome: '  Maria Silva  ',
      email: `  ${EMAIL_REPRESENTANTE}  `,
    })
    expect(lead.nome).toBe('Maria Silva')
    // Sem o trim, o proprio CHECK lead_email_formato recusaria o INSERT: o
    // regex proibe espaco em qualquer posicao.
    expect(lead.email).toBe(EMAIL_REPRESENTANTE)
  })

  describe('consentimento', () => {
    it('LGPD: consentimento marcado grava carimbo de tempo, nao so o booleano', async () => {
      const antes = Date.now()
      const lead = await registrarLead({ ...REPRESENTANTE, email: EMAIL_LGPD })
      const depois = Date.now()

      expect(lead.consentimentoLgpd).toBe(true)
      expect(lead.consentidoEm).toBeInstanceOf(Date)
      // Um "sim" sem quando nao responde ao titular que pede exclusao nem a
      // ANPD que pergunta com que base os dados foram tratados. O instante e
      // a prova, e ele tem que ser o do aceite — nao o do PDF gerado depois.
      expect(lead.consentidoEm!.getTime()).toBeGreaterThanOrEqual(antes)
      expect(lead.consentidoEm!.getTime()).toBeLessThanOrEqual(depois)
    })

    it('LGPD: aceita o instante informado pelo chamador, para importacao e reprocessamento', async () => {
      const quando = new Date('2026-08-16T12:00:00.000Z')
      const lead = await registrarLead({
        ...REPRESENTANTE, email: EMAIL_LGPD, consentidoEm: quando,
      })
      expect(lead.consentidoEm!.getTime()).toBe(quando.getTime())
    })

    // O caminho oposto (deduzir "sim" a partir de uma data qualquer) seria
    // inventar consentimento — o unico erro deste repositorio que nao da
    // para corrigir depois.
    it('LGPD: consentimento negado grava data nula, mesmo recebendo uma data', async () => {
      const lead = await registrarLead({
        ...REPRESENTANTE,
        email: EMAIL_LGPD,
        consentimentoLgpd: false,
        consentidoEm: new Date('2026-08-16T12:00:00.000Z'),
      })
      expect(lead.consentimentoLgpd).toBe(false)
      expect(lead.consentidoEm).toBeNull()
    })

    // As duas asseveracoes abaixo passam por INSERT cru de proposito: elas
    // verificam a garantia do BANCO, pelo NOME da constraint, e nao a
    // derivacao que registrarLead faz. O caminho perigoso nunca foi a rota —
    // e a importacao de planilha, o seed e o UPDATE manual no psql as 2h da
    // manha, que nao passam por funcao nenhuma desta aplicacao.
    it('LGPD: o banco recusa consentimento false com data preenchida', async () => {
      await expect(
        getDb().insertInto('leads').values({
          tipo: 'representante',
          nome: 'Registro pela metade',
          email: EMAIL_LGPD,
          consentimento_lgpd: false,
          consentido_em: new Date('2026-08-16T12:00:00.000Z'),
        }).execute(),
      ).rejects.toThrow(/lead_consentimento_coerente/)
    })

    it('LGPD: o banco recusa consentimento true sem data', async () => {
      await expect(
        getDb().insertInto('leads').values({
          tipo: 'representante',
          nome: 'Sim sem quando',
          email: EMAIL_LGPD,
          consentimento_lgpd: true,
          consentido_em: null,
        }).execute(),
      ).rejects.toThrow(/lead_consentimento_coerente/)
    })
  })

  describe('garantias do banco', () => {
    it('recusa e-mail sem formato valido, com o mesmo regex do checkout', async () => {
      await expect(
        registrarLead({ ...REPRESENTANTE, email: 'maria arroba exemplo' }),
      ).rejects.toThrow(/lead_email_formato/)
    })

    it('recusa estado que nao e UF — normalizar caixa nao e adivinhar conteudo', async () => {
      await expect(
        registrarLead({ ...REPRESENTANTE, estado: 's1' }),
      ).rejects.toThrow(/lead_uf_valida/)
    })

    it('aceita estado vazio, que e ausencia legitima e nao valor invalido', async () => {
      const lead = await registrarLead({ ...REPRESENTANTE, estado: '' })
      expect(lead.estado).toBe('')
    })
  })

  // Sem indice unico por e-mail, de proposito: a mesma pessoa pode se
  // cadastrar como interessada em agosto e como representante em setembro, e
  // cada envio e um evento de consentimento com instante proprio. Um upsert
  // sobrescreveria o consentido_em anterior e destruiria a prova que a tabela
  // existe para guardar.
  it('nao deduplica por e-mail: cada envio e um evento de consentimento proprio', async () => {
    const primeiro = await registrarLead(REPRESENTANTE)
    const segundo = await registrarLead({ ...REPRESENTANTE, tipo: 'distribuidor' })

    expect(segundo.id).not.toBe(primeiro.id)
    const meus = somenteDesteArquivo(await listarLeads())
    expect(meus.filter((l) => l.email === EMAIL_REPRESENTANTE)).toHaveLength(2)
  })

  describe('listagem do painel', () => {
    async function semearOsTresTipos() {
      await registrarLead(REPRESENTANTE)
      await registrarLead({
        ...REPRESENTANTE,
        tipo: 'distribuidor',
        nome: 'Joao Distribuidor',
        email: EMAIL_DISTRIBUIDOR,
      })
      await registrarLead({
        tipo: 'interessado',
        nome: 'Curioso',
        email: EMAIL_INTERESSADO,
        consentimentoLgpd: true,
      })
    }

    it('filtra por tipo sem misturar os outros publicos', async () => {
      await semearOsTresTipos()

      const representantes = somenteDesteArquivo(await listarLeads('representante'))
      expect(representantes).toHaveLength(1)
      expect(representantes[0].email).toBe(EMAIL_REPRESENTANTE)

      const distribuidores = somenteDesteArquivo(await listarLeads('distribuidor'))
      expect(distribuidores).toHaveLength(1)
      expect(distribuidores[0].email).toBe(EMAIL_DISTRIBUIDOR)

      const interessados = somenteDesteArquivo(await listarLeads('interessado'))
      expect(interessados).toHaveLength(1)
      expect(interessados[0].email).toBe(EMAIL_INTERESSADO)
    })

    it('sem filtro devolve os tres tipos juntos', async () => {
      await semearOsTresTipos()

      const todos = somenteDesteArquivo(await listarLeads())
      expect(todos).toHaveLength(3)
      expect(new Set(todos.map((l) => l.tipo)))
        .toEqual(new Set(['representante', 'distribuidor', 'interessado']))
    })

    // Datas semeadas a mao: dois registrarLead seguidos podem cair no mesmo
    // milissegundo e o teste passaria a depender do relogio para provar a
    // ordenacao. E a unica ordem util para quem vai ligar de volta — quem
    // acabou de se candidatar esta com a marca na cabeca agora.
    it('devolve os mais recentes primeiro', async () => {
      await getDb().insertInto('leads').values([
        {
          tipo: 'representante', nome: 'Mais antigo', email: EMAIL_ORDEM,
          criado_em: new Date('2026-08-01T10:00:00.000Z'),
        },
        {
          tipo: 'representante', nome: 'Do meio', email: EMAIL_ORDEM,
          criado_em: new Date('2026-08-10T10:00:00.000Z'),
        },
        {
          tipo: 'representante', nome: 'Mais recente', email: EMAIL_ORDEM,
          criado_em: new Date('2026-08-15T10:00:00.000Z'),
        },
      ]).execute()

      const nomes = somenteDesteArquivo(await listarLeads('representante')).map((l) => l.nome)
      expect(nomes).toEqual(['Mais recente', 'Do meio', 'Mais antigo'])
    })
  })
})
