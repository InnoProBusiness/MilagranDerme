'use client'

/**
 * O PRIMEIRO PADRAO DE POLLING DO PROJETO. Ate 16/08/2026 toda tela daqui era
 * render de servidor: a pagina lia o banco uma vez, imprimia o numero e ficava
 * parada ate alguem recarregar. Isso serve para preco e catalogo, que mudam em
 * dia de deploy. NAO serve para o contador de kits do evento de 25/08 (§11 do
 * documento do cliente: "em tempo real"), onde o numero muda a cada venda no
 * balcao enquanto a home continua aberta na mao de quem esta na fila. Uma home
 * anunciando "restam 8" depois de os oito terem saido da caixa manda gente
 * para uma fila atras de kit que nao existe mais.
 *
 * POR QUE 'use client': estado (`saldo`) + efeito com temporizador. Nao ha
 * como um Server Component reconsultar sozinho. E o unico motivo — nao ha
 * evento de clique nenhum aqui.
 *
 * O QUE ESTE COMPONENTE NAO FAZ, de proposito:
 *   - nao decide texto: a copy sai inteira de src/lib/escassez.ts, a mesma
 *     funcao que a vitrine, a rota GET /api/estoque e o balcao usam. Quatro
 *     superficies falando do MESMO saldo com uma frase so;
 *   - nao conhece o kit do lancamento: o slug entra por prop (ausente = o kit
 *     default da rota). E o que permite o painel administrativo (§17) montar
 *     um contador por kit sem tocar neste arquivo;
 *   - nao renderiza CTA nem botao: quem decide o que fazer com o numero e a
 *     tela que o embute.
 *
 * API GENERICA DE PROPOSITO (home §5/§11 e painel §17 usam o mesmo
 * componente): entra saldo inicial + de qual kit + de quanto em quanto tempo;
 * sai o bloco `.escassez` pronto.
 */

import { useEffect, useState } from 'react'
import { avisoDeEscassez } from '@/lib/escassez'

/**
 * §11. Quinze segundos e o intervalo do documento do cliente, e ele e
 * defensavel dos dois lados: mais curto multiplica consultas ao banco por cada
 * navegador aberto no evento (a rota le tres indices por chamada); mais longo
 * deixa o numero velho o bastante para a home discordar do balcao com o
 * comprador olhando as duas telas.
 */
export const INTERVALO_POLLING_MS = 15_000

/**
 * O par de numeros que o contador exibe. `total` e o tamanho do lote que
 * entrou (nao muda quando alguem compra) e `disponivel` e o saldo vivo — os
 * mesmos dois campos de `presencial` em GET /api/estoque, com os mesmos nomes,
 * para nao existir traducao no meio do caminho.
 */
export type SaldoContador = {
  disponivel: number
  total: number
}

type Props = {
  /**
   * Saldo lido NO SERVIDOR, no mesmo request que renderizou a pagina. Existe
   * para a primeira pintura ja trazer o numero certo: sem ele, a tela abriria
   * com um vazio (ou pior, com um zero) e so encheria 15 segundos depois — e
   * "0 kits" por meio segundo e a loja anunciando esgotado sem estar.
   *
   * Depois do mount quem manda e o polling: uma mudanca desta prop numa
   * re-renderizacao do servidor NAO reinicia o estado, de proposito. O numero
   * mais fresco e sempre o da ultima resposta da API, nunca o do HTML que
   * chegou antes.
   */
  inicial: SaldoContador
  /** Ausente = o kit default da rota (o primeiro ativo do catalogo). */
  kitSlug?: string
  /** 0 (ou negativo) desliga o polling e deixa o bloco estatico. */
  intervaloMs?: number
}

/**
 * Le a resposta de GET /api/estoque sem confiar nela.
 *
 * Exportada para ter teste proprio: esta funcao e a fronteira entre a rede e o
 * que a loja anuncia, e o caso que ela existe para barrar (`presencial: null`,
 * campo ausente, NaN vindo de um SUM() vazio) nao aparece em nenhum teste de
 * clique. Devolver `null` significa "nao ha numero utilizavel aqui" e o
 * chamador MANTEM o ultimo valor bom — ver o efeito abaixo.
 *
 * `presencial: null` e resposta legitima da rota (kit sem linha de estoque
 * presencial) e cai no mesmo `null` daqui: quem nao tem caixa no evento nao
 * tem contador, e inventar zero faria a home dizer que um lote que nunca
 * existiu acabou.
 */
export function lerSaldo(dados: unknown): SaldoContador | null {
  if (typeof dados !== 'object' || dados === null) return null

  const { presencial } = dados as { presencial?: unknown }
  if (typeof presencial !== 'object' || presencial === null) return null

  const { disponivel, total } = presencial as { disponivel?: unknown; total?: unknown }
  if (typeof disponivel !== 'number' || !Number.isFinite(disponivel)) return null
  if (typeof total !== 'number' || !Number.isFinite(total)) return null

  // O clamp em zero repete o `saldoPublicavel` de src/app/api/estoque/route.ts
  // pelo mesmo motivo dele: saldo negativo (ajuste de inventario maior que o
  // saldo) e informacao do painel, nunca da vitrine — "-3 kits" nao e verdade
  // nenhuma sobre a caixa do evento. Repetido AQUI porque este componente le
  // uma resposta de rede, e uma tela que so esta correta enquanto o servidor
  // estiver correto nao esta protegida.
  return {
    disponivel: Math.max(0, Math.trunc(disponivel)),
    total: Math.max(0, Math.trunc(total)),
  }
}

export function ContadorEstoque({
  inicial,
  kitSlug,
  intervaloMs = INTERVALO_POLLING_MS,
}: Props) {
  const [saldo, setSaldo] = useState<SaldoContador>(inicial)
  const [consultando, setConsultando] = useState(false)

  useEffect(() => {
    if (!Number.isFinite(intervaloMs) || intervaloMs <= 0) return

    const url = kitSlug
      ? `/api/estoque?kit=${encodeURIComponent(kitSlug)}`
      : '/api/estoque'

    const controle = new AbortController()
    let vivo = true
    // ORDEM DAS RESPOSTAS. `pedida` e o carimbo da requisicao que saiu;
    // `aplicada` e o da ultima que virou numero na tela. Sem os dois, uma
    // consulta que ficou presa 20 segundos num WiFi ruim voltaria DEPOIS da
    // seguinte e reescreveria a tela com o saldo mais velho — o contador
    // andaria para tras na frente do comprador, e no dia do evento essa e a
    // diferenca entre "restam 2" e "restam 7" no mesmo instante.
    let pedida = 0
    let aplicada = 0

    async function consultar() {
      const sequencia = ++pedida
      setConsultando(true)
      try {
        const resposta = await fetch(url, { signal: controle.signal, cache: 'no-store' })
        // 404/500 nao zeram nada: a rota respondeu, mas nao com um numero.
        if (!resposta.ok) return

        const novo = lerSaldo(await resposta.json())
        if (!vivo || novo === null) return
        if (sequencia <= aplicada) return

        aplicada = sequencia
        setSaldo(novo)
      } catch {
        // FALHA DE REDE MANTEM O ULTIMO VALOR BOM, e isso e a regra mais
        // importante deste arquivo. Um `setSaldo({disponivel: 0, ...})` aqui
        // faria a loja anunciar ESGOTADO por causa do WiFi do visitante:
        // 'esgotado' e o unico nivel que muda o que o comprador PODE fazer (a
        // CTA vira "COMPRAR ONLINE"), entao um zero inventado nao seria um
        // numero errado, seria a loja fechando o balcao sozinha. O bloco fica
        // com o numero de 15s atras e a proxima batida tenta de novo — nao ha
        // desistencia, nem contador de falhas, nem mensagem de erro: o
        // visitante nao tem nada a fazer com "falha ao atualizar o estoque".
        //
        // Cai aqui tambem o abort do unmount, que nao e erro nenhum.
      } finally {
        // So a requisicao MAIS NOVA desliga o "ocupado". Uma atrasada que
        // termina depois da seguinte apagaria o aviso de que ainda ha consulta
        // em voo.
        if (vivo && sequencia === pedida) setConsultando(false)
      }
    }

    // A PRIMEIRA CONSULTA E O PROXIMO TIQUE, nao o mount: o numero que veio do
    // servidor tem a idade do proprio HTML. Consultar no mount so somaria uma
    // rajada de requisicoes no instante em que todo mundo abre a pagina (o QR
    // Code do evento faz exatamente isso) para reconfirmar o que acabou de ser
    // lido.
    //
    // O TIQUE NAO ESPERA a requisicao anterior terminar. Pular a batida
    // enquanto ha uma em voo parece economia, mas uma requisicao que nunca
    // resolve (conexao pendurada, o caso comum de WiFi lotado) congelaria o
    // contador para sempre. Duas consultas simultaneas sao inofensivas — quem
    // garante que a tela mostra a mais nova e o carimbo `sequencia`, nao a
    // ordem de chegada.
    const temporizador = window.setInterval(() => { void consultar() }, intervaloMs)

    return () => {
      vivo = false
      window.clearInterval(temporizador)
      // Cancela o que estiver em voo: sem isto, um `setSaldo` chegaria depois
      // de a tela ter sumido (a home e force-dynamic e o visitante navega para
      // /comprar no meio da consulta).
      controle.abort()
    }
  }, [kitSlug, intervaloMs])

  // A LEITURA EDITORIAL DO SALDO NAO E DAQUI. Recalcular o aviso a cada
  // renderizacao, com a mesma funcao que o servidor usou, e o que garante que
  // o numero e a frase nunca discordem — e evita que este componente confie no
  // campo `aviso` da resposta, que e texto livre vindo da rede e viraria nome
  // de classe CSS (`escassez--${nivel}`) sem ninguem conferir.
  const aviso = avisoDeEscassez(saldo.disponivel, saldo.total)
  const esgotado = aviso.nivel === 'esgotado'

  return (
    <div
      className={`escassez escassez--${aviso.nivel}`}
      // Assincrono e nao urgente: o leitor de tela anuncia o numero novo
      // quando terminar o que estava lendo, sem interromper ninguem no meio de
      // uma frase.
      role="status"
      aria-busy={consultando}
      data-testid="contador-estoque"
    >
      <span className="escassez__pulso" aria-hidden="true" />

      {/*
        O numero grande e o selo sao AMPLIFICACAO VISUAL do que a frase ja diz
        ("Últimos 3 kits disponíveis para compra presencial."), entao ficam
        aria-hidden: sem isso o leitor de tela anunciaria "3, últimos 3 kits
        disponíveis...". Quem enxerga le o numero a metros de distancia; quem
        ouve recebe a frase inteira, uma vez so.
      */}
      {esgotado ? (
        <span className="escassez__selo" aria-hidden="true">Esgotado</span>
      ) : (
        <span
          className="escassez__numero"
          aria-hidden="true"
          data-testid="kits-disponiveis"
        >
          {saldo.disponivel}
        </span>
      )}

      <p className="escassez__mensagem">{aviso.mensagem}</p>
    </div>
  )
}
