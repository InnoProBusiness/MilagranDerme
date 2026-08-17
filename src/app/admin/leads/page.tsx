import type { Metadata } from 'next'
import { formatarBRL } from '@/lib/money'
import { listarLeads, type Lead, type TipoLead } from '@/repositories/leads'
import { listarCompradores } from '@/repositories/pedidos'
import { dataHoraBR, ouAusente } from '../formato'
import { exigirSessaoDeAdmin } from '../sessao-admin'

/**
 * Os QUATRO PUBLICOS de §17, em quatro abas separadas: compradores,
 * interessados, representantes e distribuidores.
 *
 * OS QUATRO NAO VEM DA MESMA TABELA. Interessado, representante e distribuidor
 * sao `tipo_lead` em `leads` (migrations/1755300400000_leads.sql); COMPRADOR e
 * derivado de `clientes` + `pedidos` (`listarCompradores`). Duplicar comprador
 * dentro de `leads` criaria duas verdades sobre a mesma pessoa, e elas
 * divergiriam na primeira escrita que atualizasse uma e esquecesse a outra —
 * a decisao esta na migration e a tela apenas a respeita.
 *
 * ESTA E A TELA MAIS SENSIVEL DO PAINEL SOB A LGPD: e uma lista de contato de
 * todo mundo que se cadastrou ou comprou. CPF NAO APARECE em nenhuma das
 * quatro abas, e nao aparece por construcao — `listarCompradores` nomeia as
 * colunas uma a uma justamente para que um `selectAll` futuro nao transforme
 * uma lista de contatos numa base de CPFs exportavel.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Leads' }

/**
 * 'comprador' NAO E um valor de `tipo_lead` — comprador nao e um lead, e por
 * isso a quarta aba nao filtra a mesma consulta que as outras tres. O tipo
 * uniao deixa isso explicito no compilador: quem tentar passar 'comprador'
 * para `listarLeads` nao compila.
 */
type Aba = 'comprador' | TipoLead

const ABA_PADRAO: Aba = 'comprador'

/**
 * Record<Aba, string> e nao uma lista solta: um quarto valor em `tipo_lead`
 * (a migration cita a possibilidade) quebra a compilacao aqui e obriga a
 * decisao "esta aba existe?" a ser tomada por escrito, em vez de o publico novo
 * ficar invisivel no painel.
 */
const ROTULOS_ABA: Record<Aba, string> = {
  comprador: 'Compradores',
  interessado: 'Interessados',
  representante: 'Representantes',
  distribuidor: 'Distribuidores',
}

const ABAS = Object.keys(ROTULOS_ABA) as Aba[]

/**
 * `Object.hasOwn`, nunca `valor in ROTULOS_ABA`: o operador `in` enxerga a
 * cadeia de prototipos e `'toString'` passaria por valida. Mesmo cuidado da
 * tela de vendas, e aqui o estrago seria uma aba fantasma sem tabela nenhuma.
 *
 * Valor desconhecido cai na aba padrao em vez de 404: uma URL antiga colada num
 * grupo continua abrindo a tela, so que na primeira aba.
 */
function abaDaBusca(bruto: string | string[] | undefined): Aba {
  const valor = typeof bruto === 'string' ? bruto : ''
  return Object.hasOwn(ROTULOS_ABA, valor) ? (valor as Aba) : ABA_PADRAO
}

/**
 * O aceite de LGPD, COM CARIMBO DE TEMPO. Um "sim" sem quando nao responde
 * nem ao titular que pede exclusao nem a ANPD que pergunta com que base o dado
 * foi tratado — e o CHECK lead_consentimento_coerente amarra os dois campos no
 * banco justamente para nao existir consentimento sem data.
 *
 * "Não registrado" e nao "Não": a linha pode ser anterior a coluna existir (o
 * formulario coletava o aceite e nao gravava nada, divida paga em 16/08). Dizer
 * "Não" afirmaria que a pessoa recusou, que e outra coisa.
 */
function consentimento(lead: Lead): string {
  if (!lead.consentimentoLgpd) return 'Não registrado'
  return lead.consentidoEm ? `Sim · ${dataHoraBR(lead.consentidoEm)}` : 'Sim'
}

export default async function PaginaLeadsAdmin({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // ANTES da primeira consulta, e apesar de o layout ja conferir. Ver
  // ../sessao-admin.ts.
  await exigirSessaoDeAdmin()

  const busca = await searchParams
  const aba = abaDaBusca(busca.aba)

  /**
   * AS DUAS LISTAS INTEIRAS, e o filtro por tipo acontece aqui em cima.
   * `listarLeads(tipo)` existe e seria uma consulta menor, mas as abas mostram
   * a CONTAGEM de cada publico — e uma contagem por aba exigiria as quatro
   * consultas de qualquer forma. Uma leitura so, com quatro numeros que fecham
   * entre si, vale mais do que quatro leituras em instantes diferentes.
   */
  const [leads, compradores] = await Promise.all([listarLeads(), listarCompradores()])

  const leadsDaAba = aba === 'comprador' ? [] : leads.filter((l) => l.tipo === aba)

  function contagem(alvo: Aba): number {
    return alvo === 'comprador'
      ? compradores.length
      : leads.filter((l) => l.tipo === alvo).length
  }

  return (
    <>
      <div className="admin__topo">
        <div>
          <h1 className="admin__titulo">Leads e compradores</h1>
          <p className="admin__lede">
            Quem comprou, quem pediu informação e quem se candidatou a
            representar ou distribuir a marca.
          </p>
        </div>
      </div>

      {/*
        Abas em <a> comum, com a aba atual vindo da querystring: a tela e Server
        Component e ja sabe qual publico esta aberto, entao nao ha nada aqui que
        precise de JavaScript. E a URL de cada aba pode ser marcada nos
        favoritos ou colada para outra pessoa.
      */}
      <nav className="admin__abas" aria-label="Públicos cadastrados">
        {ABAS.map((valor) => (
          <a
            key={valor}
            className="admin__aba"
            href={`/admin/leads?aba=${valor}`}
            aria-current={valor === aba ? 'page' : undefined}
          >
            {ROTULOS_ABA[valor]} ({contagem(valor)})
          </a>
        ))}
      </nav>

      {aba === 'comprador' ? (
        <div className="tabela-rolagem">
          <table className="tabela">
            <caption className="oculto-visual">
              Compradores, com contato, número de pedidos pagos e total gasto.
            </caption>
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col">E-mail</th>
                <th scope="col">WhatsApp</th>
                <th scope="col" className="tabela__num">Pedidos</th>
                <th scope="col" className="tabela__num">Total</th>
                <th scope="col">Último pedido</th>
              </tr>
            </thead>
            <tbody>
              {compradores.length === 0 ? (
                <tr>
                  {/*
                    ESTADO VAZIO HONESTO. So conta pedido PAGO: quem abandonou o
                    carrinho nao e comprador e nao entra nesta lista com total
                    zero, empurrando para baixo quem comprou de verdade.
                  */}
                  <td className="tabela__vazio" colSpan={6}>
                    Nenhuma compra paga ainda.
                  </td>
                </tr>
              ) : (
                compradores.map((comprador) => (
                  <tr key={comprador.clienteId}>
                    <td>{ouAusente(comprador.nome)}</td>
                    <td>{ouAusente(comprador.email)}</td>
                    <td>{ouAusente(comprador.whatsapp)}</td>
                    <td className="tabela__num">{comprador.pedidos}</td>
                    <td className="tabela__num">{formatarBRL(comprador.totalCentavos)}</td>
                    <td>{dataHoraBR(comprador.ultimoPedidoEm)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tabela-rolagem">
          <table className="tabela tabela--larga">
            <caption className="oculto-visual">
              Cadastros de {ROTULOS_ABA[aba].toLowerCase()}, com contato, origem
              e registro de consentimento.
            </caption>
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col">E-mail</th>
                <th scope="col">WhatsApp</th>
                <th scope="col">Cidade / UF</th>
                <th scope="col">Mensagem</th>
                <th scope="col">Origem</th>
                <th scope="col">Consentimento LGPD</th>
                <th scope="col">Cadastro</th>
              </tr>
            </thead>
            <tbody>
              {leadsDaAba.length === 0 ? (
                <tr>
                  <td className="tabela__vazio" colSpan={8}>
                    Nenhum cadastro de {ROTULOS_ABA[aba].toLowerCase()} até agora.
                  </td>
                </tr>
              ) : (
                leadsDaAba.map((lead) => (
                  <tr key={lead.id}>
                    <td>{ouAusente(lead.nome)}</td>
                    <td>{ouAusente(lead.email)}</td>
                    <td>{ouAusente(lead.whatsapp)}</td>
                    <td>
                      {lead.cidade.trim() === '' && lead.estado.trim() === ''
                        ? ouAusente(null)
                        : `${lead.cidade}${lead.estado ? `/${lead.estado}` : ''}`}
                    </td>
                    <td>{ouAusente(lead.mensagem)}</td>
                    <td>{ouAusente(lead.origem)}</td>
                    <td>{consentimento(lead)}</td>
                    <td>{dataHoraBR(lead.criadoEm)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {aba === 'representante' && (
        // Estes sao CANDIDATOS, e nao representantes cadastrados: a tabela
        // `representantes` (com slug e codigo de indicacao) e outra coisa, e
        // nenhum dos dois campos aparece aqui. Os dois sao IMUTAVEIS por trigger
        // no banco — um link de campanha ja impresso e um QR Code ja em
        // circulacao deixariam de funcionar se alguem os editasse —, entao esta
        // tela nao oferece edicao de nada. Promover um candidato a representante
        // e um cadastro proprio, ainda sem tela.
        <p className="admin__lede">
          Candidaturas recebidas. O cadastro de representante — com link de
          indicação e código — é feito à parte: o código e o endereço do link
          não podem ser alterados depois de criados, porque já circulam em
          campanha impressa.
        </p>
      )}

      <p className="admin__lede">
        Lista de contato para falar com essas pessoas. CPF não aparece em
        nenhuma aba: ele é coletado para o pagamento, não para contato.
      </p>
    </>
  )
}
