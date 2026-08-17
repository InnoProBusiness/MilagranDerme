import type { Selectable } from 'kysely'
import { getDb } from '@/lib/db'
import type { Leads, TipoLead } from '@/lib/db-types'

/**
 * Captura de interesse — secao 17 do documento do cliente de 16/08/2026.
 *
 * Sao os tres publicos que ainda NAO compraram: quem so quer saber do
 * produto ('interessado'), quem quer representar a marca ('representante') e
 * quem quer distribuir ('distribuidor'). COMPRADOR nao entra nesta tabela: a
 * lista de compradores do painel e DERIVADA de clientes + pedidos
 * (listarCompradores, em src/repositories/pedidos.ts). O motivo por extenso
 * — duas verdades sobre a mesma pessoa divergindo na primeira escrita que
 * atualiza uma e esquece a outra — esta no topo de
 * migrations/1755300400000_leads.sql e nao se repete aqui.
 *
 * ATENCAO PARA QUEM CHAMA: uma violacao de CHECK do Postgres nesta tabela
 * carrega a LINHA INTEIRA — nome, e-mail, whatsapp, cidade — na propriedade
 * `detail` do erro, exatamente como ja documentado em
 * src/repositories/clientes.ts. So `error.message` (ou `error.constraint`,
 * quando disponivel) pode ir para o log ou para a resposta; nunca o objeto
 * de erro cru e nunca `detail`. Quem chama isto hoje sao o adaptador de
 * candidatura (src/lib/candidatura.ts, via injecao pelo route handler) e o
 * painel — os dois em caminhos que registram o erro em log de servidor.
 */

// kysely-codegen ja gera a uniao literal a partir do ENUM tipo_lead do banco
// (migrations/1755300400000_leads.sql): 'interessado' | 'representante' |
// 'distribuidor'. Reexportar em vez de redeclarar e o que impede o tipo do
// repositorio e o ENUM do Postgres de divergirem com o tempo — e o que da
// exaustividade de verdade a um switch sobre o tipo do lead na tela do
// painel. Mesmo padrao de OrigemAtribuicao/PedidoStatus em
// src/repositories/pedidos.ts.
export type { TipoLead }

export type Lead = {
  id: string
  tipo: TipoLead
  nome: string
  email: string
  whatsapp: string
  cidade: string
  estado: string
  mensagem: string
  consentimentoLgpd: boolean
  /**
   * Instante em que o aceite chegou. E a PROVA de consentimento: um "sim"
   * sem quando nao responde nem ao titular que pede exclusao nem a ANPD que
   * pergunta com que base os dados foram tratados. O CHECK
   * lead_consentimento_coerente amarra este campo ao booleano acima nos dois
   * sentidos, entao `consentimentoLgpd === true` implica `consentidoEm !==
   * null` em toda linha lida do banco — o `| null` aqui existe pelo caso
   * false, nao por desconfianca do banco.
   */
  consentidoEm: Date | null
  origem: string
  criadoEm: Date
}

export type EntradaLead = {
  tipo: TipoLead
  nome: string
  email: string
  /**
   * Opcionais porque um lead chega por mais de um formulario e nenhum deles
   * pede os mesmos campos: a LP de representante coleta whatsapp, cidade e
   * estado; um formulario de "quero saber mais" da home pode coletar so nome
   * e e-mail. Ausente vira '' (nunca NULL), no mesmo formato dos DEFAULTs da
   * tabela — a leitura do painel nunca precisa de coalesce e "nao informado"
   * tem uma representacao unica.
   */
  whatsapp?: string
  cidade?: string
  estado?: string
  mensagem?: string
  consentimentoLgpd: boolean
  /**
   * Opcional: quando ausente e houve consentimento, o carimbo e `new Date()`
   * — o instante em que o aceite chegou ao servidor. Existe como parametro
   * para o caso de o instante real ser conhecido de outra fonte (importacao
   * de uma base antiga, reprocessamento de fila) e para os testes poderem
   * fixar o relogio sem stub global.
   */
  consentidoEm?: Date | null
  origem?: string
}

function paraLead(l: Selectable<Leads>): Lead {
  return {
    id: l.id,
    tipo: l.tipo,
    nome: l.nome,
    email: l.email,
    whatsapp: l.whatsapp,
    cidade: l.cidade,
    estado: l.estado,
    mensagem: l.mensagem,
    consentimentoLgpd: l.consentimento_lgpd,
    consentidoEm: l.consentido_em,
    origem: l.origem,
    criadoEm: l.criado_em,
  }
}

// Ausente e null viram '' (o mesmo valor do DEFAULT da coluna); o trim
// derruba o espaco que sobra de "copiar e colar" no celular. Nao existe
// validacao de formato aqui de proposito — e-mail e UF sao asseverados pelos
// CHECKs lead_email_formato e lead_uf_valida, que valem tambem para a
// importacao de planilha e para o INSERT manual no psql, caminhos que nao
// passam por funcao nenhuma desta aplicacao.
function texto(valor?: string | null): string {
  return valor === undefined || valor === null ? '' : valor.trim()
}

/**
 * Grava um lead. Cada chamada e uma LINHA NOVA, sempre: nao ha upsert nem
 * deduplicacao por e-mail, e isso e deliberado — a mesma pessoa pode se
 * cadastrar como 'interessado' em agosto e como 'representante' em setembro,
 * e cada envio e um EVENTO DE CONSENTIMENTO com instante proprio.
 * Sobrescrever o `consentido_em` anterior destruiria exatamente a prova que
 * a tabela existe para guardar (o comentario que justifica a AUSENCIA do
 * indice unico esta em migrations/1755300400000_leads.sql). Deduplicar para
 * efeito de contato e trabalho da tela, sobre os dados intactos.
 *
 * REGRA DE CONSENTIMENTO: `consentido_em` e DERIVADO do booleano, nunca
 * copiado as cegas do chamador. Consentimento negado grava data NULL mesmo
 * que uma data tenha vindo no argumento — o caminho oposto (deduzir "sim" a
 * partir de uma data qualquer) seria inventar consentimento, que e o unico
 * erro desta funcao que nao da para corrigir depois. A garantia de verdade
 * continua sendo o CHECK lead_consentimento_coerente no banco; isto aqui so
 * evita que a aplicacao esbarre nele por descuido de quem chama.
 *
 * Sem transacao externa opcional (`trx`), ao contrario de
 * salvarClienteComEndereco e criarPedido: um lead nao e escrito junto de
 * mais nada: nao ha segunda tabela para manter atomica com ele. Quem grava
 * lead a partir da candidatura (src/lib/candidatura.ts) trata a falha como
 * best-effort e segue com o e-mail, entao amarrar esta escrita a transacao
 * de outra coisa so criaria uma forma de o lead derrubar aquilo.
 */
export async function registrarLead(e: EntradaLead): Promise<Lead> {
  const consentiu = e.consentimentoLgpd === true

  const linha = await getDb()
    .insertInto('leads')
    .values({
      tipo: e.tipo,
      nome: texto(e.nome),
      email: texto(e.email),
      whatsapp: texto(e.whatsapp),
      cidade: texto(e.cidade),
      // UF em maiusculas e a unica normalizacao de conteudo desta funcao.
      // Em enderecos o comportamento e o oposto — la o banco recusa 'sp' e o
      // checkout mostra o erro (src/repositories/__tests__/clientes.test.ts),
      // porque aquele valor vai impresso numa etiqueta de entrega e um
      // conserto silencioso poderia mandar a caixa para o estado errado.
      // Aqui o valor e so filtro de painel, o INSERT e best-effort e uma
      // recusa nao volta para ninguem: 'sp' rejeitado nao vira mensagem de
      // erro na tela, vira lead PERDIDO. O que nao e UF nenhuma continua
      // recusado pelo lead_uf_valida — normalizar caixa nao e adivinhar
      // conteudo.
      estado: texto(e.estado).toUpperCase(),
      mensagem: texto(e.mensagem),
      consentimento_lgpd: consentiu,
      consentido_em: consentiu ? (e.consentidoEm ?? new Date()) : null,
      origem: texto(e.origem),
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return paraLead(linha)
}

/**
 * Leitura do painel (GET /api/admin/leads?tipo=). Sem filtro devolve os tres
 * tipos juntos.
 *
 * A ordem e a do indice leads_tipo_data (tipo, criado_em DESC): mais
 * recentes primeiro, que e a unica ordem util para quem vai ligar de volta.
 * O desempate por `id` existe pelo mesmo motivo ja documentado em
 * buscarPedidoComItensPorToken (src/repositories/pedidos.ts): `criado_em`
 * vem de now(), que e o instante de INICIO da transacao — duas linhas
 * gravadas na mesma transacao (uma importacao, um seed) carregam timestamp
 * identico e trocariam de lugar entre uma leitura e outra sem o desempate.
 *
 * NAO ha paginacao: sao leads de um lancamento, contados em centenas. Se um
 * dia virar dezenas de milhares, o lugar de resolver isso e aqui, com LIMIT
 * e cursor por (criado_em, id) — nao na tela cortando um array gigante ja
 * trazido para a memoria do container de 512M.
 */
export async function listarLeads(tipo?: TipoLead): Promise<Lead[]> {
  let consulta = getDb()
    .selectFrom('leads')
    .selectAll()
    .orderBy('criado_em', 'desc')
    .orderBy('id', 'desc')

  if (tipo !== undefined) {
    consulta = consulta.where('tipo', '=', tipo)
  }

  return (await consulta.execute()).map(paraLead)
}
