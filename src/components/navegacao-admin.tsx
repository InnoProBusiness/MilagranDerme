'use client'

/**
 * O CHROME DO PAINEL (§17): as abas entre as cinco secoes e o botao de sair.
 *
 * POR QUE 'use client' — as duas razoes, uma por componente:
 *
 *  - `AbasAdmin` precisa saber QUAL rota esta aberta para marcar a aba com
 *    `aria-current="page"`, e um layout de Server Component nao recebe o
 *    caminho da requisicao: o Next nao entrega pathname a layouts de
 *    proposito, porque eles nao re-renderizam a cada navegacao. `usePathname`
 *    e a unica leitura possivel, e ela e um hook de cliente. A alternativa
 *    seria cada page.tsx renderizar as proprias abas dizendo qual e a sua —
 *    cinco copias da mesma lista, e a quinta esqueceria uma secao nova;
 *  - `SairDoPainel` tem estado (`estado`) e evento (clique), e precisa do
 *    verbo DELETE, que formulario HTML nao emite.
 *
 * O RESTO DO PAINEL CONTINUA SENDO SERVER COMPONENT. Este arquivo nao le dado
 * nenhum do banco e nao recebe nada alem do nome de quem esta logado: nenhum
 * numero de venda, nenhum contato de comprador atravessa a fronteira do
 * cliente por aqui.
 */

import { usePathname } from 'next/navigation'
import { useState } from 'react'

/**
 * As cinco secoes de §17, na ordem em que se le o painel: primeiro o resumo
 * ("como estamos?"), depois o detalhe da venda, o que ha na caixa, o que falta
 * despachar e, por fim, com quem falar.
 *
 * LISTA UNICA. Este e o indice do painel inteiro: uma secao nova nasce com uma
 * linha aqui e aparece em todas as telas de uma vez. Um menu escrito a mao em
 * cada pagina teria a tela nova invisivel a partir de quatro das cinco.
 */
const SECOES: ReadonlyArray<{ href: string; rotulo: string }> = [
  { href: '/admin', rotulo: 'Resumo' },
  { href: '/admin/vendas', rotulo: 'Vendas' },
  { href: '/admin/estoque', rotulo: 'Estoque' },
  { href: '/admin/logistica', rotulo: 'Logística' },
  { href: '/admin/cupons', rotulo: 'Campanhas' },
  { href: '/admin/leads', rotulo: 'Leads' },
]

/**
 * Qual das abas esta aberta, dado o caminho atual: a MAIS ESPECIFICA que casa.
 *
 * O caso que obriga esta funcao a existir e `/admin`. Um `startsWith` aplicado
 * a cada aba isoladamente marcaria "Resumo" como aberta em TODAS as telas,
 * porque toda rota do painel comeca por `/admin` — e duas abas com
 * `aria-current="page"` ao mesmo tempo nao sao um detalhe visual: sao dois
 * "lugar atual" anunciados no mesmo documento para quem usa leitor de tela. A
 * primeira versao deste arquivo tinha exatamente esse defeito, e foi o teste
 * abaixo que o pegou.
 *
 * Escolher a mais LONGA resolve os dois lados de uma vez: `/admin/vendas` casa
 * com `/admin` e com `/admin/vendas`, e vence a segunda; `/admin` casa so com a
 * primeira. E continua valendo para uma subrota futura (`/admin/vendas/1042`
 * mantem "Vendas" marcada) sem ninguem precisar declarar hierarquia.
 *
 * A barra no `startsWith` nao e enfeite: sem ela `/admin/vendas-antigas` seria
 * lido como parte de `/admin/vendas`.
 *
 * Exportada para ter teste proprio: e uma regra de string cujo erro (duas abas
 * atuais, ou nenhuma) so aparece olhando a tela.
 */
export function hrefDaAbaAtual(pathname: string, hrefs: readonly string[]): string | null {
  return hrefs.reduce<string | null>((escolhido, href) => {
    const casa = pathname === href || pathname.startsWith(`${href}/`)
    if (!casa) return escolhido
    return escolhido === null || href.length > escolhido.length ? href : escolhido
  }, null)
}

/**
 * <a> CRU, e nao next/link, pelo mesmo motivo que vale para todo este painel:
 * as cinco telas sao `force-dynamic` e existem para mostrar o numero de AGORA.
 * A navegacao client-side do <Link> mantem em cache o payload da tela anterior
 * e reaproveita o que puder — exatamente o que nao se quer de um contador de
 * kits e de uma fila de expedicao no dia do evento. Navegacao inteira custa um
 * request e devolve dado fresco, que e o contrato que estas telas prometem.
 */
export function AbasAdmin() {
  const pathname = usePathname()
  const aberta = hrefDaAbaAtual(pathname, SECOES.map((secao) => secao.href))

  return (
    <nav className="admin__abas" aria-label="Seções do painel">
      {SECOES.map((secao) => (
        <a
          key={secao.href}
          className="admin__aba"
          href={secao.href}
          // `undefined` remove o atributo; "false" como string seria um
          // valor valido de aria-current e marcaria a aba errada.
          aria-current={secao.href === aberta ? 'page' : undefined}
        >
          {secao.rotulo}
        </a>
      ))}
    </nav>
  )
}

type EstadoSaida = 'parado' | 'saindo' | 'falhou'

/**
 * Sair do painel. Chama DELETE /api/sessao, que REVOGA a sessao no banco — e
 * essa e a metade que vale: apagar o cookie so tira o token deste navegador,
 * enquanto o UPDATE em `sessoes` mata o token para quem quer que o tenha
 * copiado. O doc comment daquela rota explica o resto.
 *
 * O painel e aberto em maquina compartilhada (o notebook do escritorio, o
 * tablet do evento) e a sessao dura 12 horas: sem esta porta, "fechei a aba"
 * seria a unica forma de sair, e ela nao encerra nada.
 */
export function SairDoPainel() {
  const [estado, setEstado] = useState<EstadoSaida>('parado')

  async function sair() {
    setEstado('saindo')
    try {
      const resposta = await fetch('/api/sessao', { method: 'DELETE' })

      // A rota responde 204 para todo caso em que nao havia nada a fazer
      // (sem cookie, token desconhecido, sessao ja revogada) e so devolve erro
      // quando a revogacao REALMENTE nao aconteceu — Postgres fora do ar. Por
      // isso um !ok aqui nao pode virar "saiu" otimista.
      if (!resposta.ok) {
        setEstado('falhou')
        return
      }

      // location.assign, e nao router.push: a navegacao client-side do Next
      // reaproveitaria o cache de rota do App Router, e as telas ja
      // renderizadas do painel (faturamento, lista de compradores) continuariam
      // no cliente depois de a sessao ter sido encerrada. Um carregamento
      // inteiro joga fora tudo o que estava em memoria, que e o unico desfecho
      // aceitavel para "sair".
      window.location.assign('/entrar')
    } catch {
      // Falha de rede: a sessao pode ou nao ter sido revogada, e a tela nao
      // tem como saber. Dizer "saiu" aqui seria a mentira com consequencia que
      // a propria rota descreve — quem esta entregando o tablet para outra
      // pessoa precisa saber que a duvida existe.
      setEstado('falhou')
    }
  }

  return (
    <div>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => { void sair() }}
        disabled={estado === 'saindo'}
      >
        {estado === 'saindo' ? 'Saindo…' : 'Sair'}
      </button>

      {estado === 'falhou' && (
        // role="status" e nao "alert": a pessoa acabou de clicar e esta
        // olhando para o botao. Interromper a leitura de tela com um alerta
        // nao acrescenta nada, e a frase precisa ser lida inteira.
        <p className="aviso aviso--erro" role="status">
          Não foi possível encerrar a sessão. Ela pode continuar ativa neste
          navegador — tente de novo em instantes.
        </p>
      )}
    </div>
  )
}
