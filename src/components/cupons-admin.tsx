'use client'

/**
 * A TELA DE CAMPANHAS (§17). Nasceu em 19/08/2026 de um audio da dona da marca:
 * "tem como voce fazer um link ai com o desconto de lancamento? 800 reais, vou
 * lancar agora". A frase tem duas exigencias dentro, e a tela existe para as
 * duas:
 *
 *   1. UM LINK, nao um codigo. Ninguem quer explicar a um comprador de
 *      Instagram que ele precisa digitar PRE800 na terceira etapa do checkout.
 *      Por isso a linha mais importante de cada cupom aqui e a URL pronta para
 *      copiar, e nao o codigo.
 *   2. "800 REAIS", nao "200 de desconto". Quem faz oferta pensa no PRECO
 *      FINAL. O banco guarda o abatimento. A subtracao e feita aqui
 *      (src/lib/cupom-preco.ts) — se ficasse com a pessoa, no celular, com a
 *      live comecando, o erro inevitavel e digitar 800 no campo de desconto e
 *      vender por 200 o kit de mil.
 *
 * O FORMULARIO CONFERE EM VOZ ALTA. Antes de criar, a tela escreve "O kit sai
 * por R$ 800,00" com o numero que o checkout realmente vai cobrar. Um cupom e
 * publicado uma vez e viaja sozinho; a hora de descobrir que o desconto esta
 * errado e antes do link existir, nao depois de trinta vendas.
 */
import { useState } from 'react'
import type { CupomAdmin } from '@/repositories/cupons'
import { formatarBRL, centavos, deInteiro, type Centavos } from '@/lib/money'
import { descontoParaPrecoFinal, precoComCupom } from '@/lib/cupom-preco'
import { instanteDeCivilBR, FUSO_BR } from '@/lib/tempo'

type Representante = { id: string; nome: string; slug: string }

type Props = {
  cupons: CupomAdmin[]
  /** Preco cheio do kit — a base da conta de preco final. */
  precoDoKit: Centavos
  representantes: Representante[]
  /** Origem publica do site, para montar os links. Vem do servidor (APP_URL). */
  urlBase: string
}

/**
 * As duas formas de dizer a mesma coisa. 'preco' NAO e um terceiro tipo de
 * cupom: ele vira `fixo` na hora de enviar. E rotulo de tela, e e o default
 * porque e como as ofertas sao pensadas.
 */
type Modo = 'preco' | 'percentual'

/**
 * O link que a pessoa vai colar no Instagram.
 *
 * A HOME, e nao /checkout. Um link de campanha cai em publico frio — quem
 * clica ainda nao decidiu comprar, e jogar essa pessoa direto num formulario
 * de quatro etapas troca a pagina de venda por um formulario. A home ja monta
 * o checkout no fim dela (src/app/page.tsx), entao o desconto continua a um
 * scroll de distancia, com a oferta explicada no caminho.
 */
export function linkDaCampanha(urlBase: string, codigo: string): string {
  return `${urlBase.replace(/\/$/, '')}/?cupom=${encodeURIComponent(codigo)}`
}

/** O mesmo link, pela vitrine de uma representante — a atribuicao de comissao
 * vem do /r/<slug> e o desconto vem do parametro. Os dois convivem. */
export function linkDaRepresentante(urlBase: string, slug: string, codigo: string): string {
  return `${urlBase.replace(/\/$/, '')}/r/${slug}?cupom=${encodeURIComponent(codigo)}`
}

/**
 * Le um valor em reais digitado por gente: "800", "800,00", "1.000,00" e
 * "R$ 800" sao todos a mesma oferta. Devolve null para o que nao for numero —
 * a tela entao nao promete preco nenhum, em vez de prometer NaN.
 *
 * A VIRGULA E O SEPARADOR DECIMAL e o ponto e o de milhar, porque quem digita
 * esta num teclado brasileiro pensando em reais. Trocar os dois por engano
 * ("1.000" virando mil centavos) e como um cupom de R$ 1.000,00 vira um de
 * R$ 10,00.
 */
export function reaisDigitados(texto: string): number | null {
  const limpo = texto.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')
  if (limpo === '') return null
  const n = Number(limpo)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * O `valor` que vai para a API, no significado que o `tipo` exige: centavos de
 * abatimento no fixo, 1..100 no percentual. Devolve null quando ainda nao da
 * para calcular — campo vazio, texto invalido, ou preco final que nao produz
 * desconto nenhum (o banco recusa `valor = 0` com `cupom_valor_positivo`, e a
 * tela nao deve nem tentar).
 */
export function valorParaApi(modo: Modo, entrada: string, preco: Centavos): number | null {
  const n = reaisDigitados(entrada)
  if (n === null) return null

  if (modo === 'percentual') {
    const inteiro = Math.round(n)
    return inteiro >= 1 && inteiro <= 100 ? inteiro : null
  }

  const desconto = descontoParaPrecoFinal(preco, centavos(n))
  return desconto > 0 ? desconto : null
}

/**
 * Um `<input type="date">` devolve 'AAAA-MM-DD' sem fuso, e a API espera um
 * instante ISO. A data escolhida e o ULTIMO DIA EM QUE O CUPOM VALE — e o
 * rotulo do campo promete isso —, entao o instante de expiracao e a MEIA-NOITE
 * DO DIA SEGUINTE em Sao Paulo. `resgatarCupom` recusa com `agora >= expira_em`,
 * de modo que uma venda as 23:59 do ultimo dia ainda passa.
 *
 * SEM ISSO O CUPOM MORRE CEDO E NA HORA ERRADA. 'AAAA-MM-DD' virado em
 * instante pelo construtor de Date e meia-noite UTC, que sao 21h do dia
 * ANTERIOR no Brasil: a campanha marcada para acabar dia 25 pararia de valer as
 * nove da noite do dia 24, no meio da venda, e ninguem entenderia por que.
 *
 * instanteDeCivilBR, e nao `T03:00:00Z` escrito a mao: o offset de Sao Paulo e
 * -3 hoje porque o horario de verao acabou em 2019, e nao porque -3 seja uma
 * propriedade do fuso. Ver o comentario da funcao em src/lib/tempo.ts.
 */
export function fimDoDiaEmSaoPaulo(data: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data)
  if (!m) return null
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])]
  // Dia seguinte pelo CALENDARIO, sem somar 24h: somar milissegundos erra na
  // virada de horario de verao, que e justamente o que instanteDeCivilBR
  // resolve. Date.UTC normaliza 31 + 1 para o dia 1 do mes seguinte.
  const seguinte = new Date(Date.UTC(ano, mes - 1, dia + 1))
  return instanteDeCivilBR(
    seguinte.getUTCFullYear(), seguinte.getUTCMonth() + 1, seguinte.getUTCDate(),
  ).toISOString()
}

/**
 * A data que a lista mostra como "vale até".
 *
 * UM MILISSEGUNDO A MENOS, de proposito. `expira_em` guarda a meia-noite do dia
 * SEGUINTE ao ultimo dia valido (ver acima); imprimi-la crua diria "vale até
 * 26/08" para um cupom que morre na virada do dia 25. Recuar um instante
 * devolve o ultimo momento em que o cupom de fato vale, e e esse o dia que a
 * pessoa escolheu no formulario.
 */
const DIA_BR = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_BR, day: '2-digit', month: '2-digit', year: 'numeric',
})

export function ultimoDiaValido(expiraEm: Date): string {
  return DIA_BR.format(new Date(expiraEm.getTime() - 1))
}

/** Texto do desconto de um cupom que ja existe, no jeito que se le de relance. */
export function descricaoDoCupom(cupom: CupomAdmin, preco: Centavos): string {
  const final = formatarBRL(precoComCupom(preco, cupom.tipo, cupom.valor))
  return cupom.tipo === 'percentual'
    ? `${cupom.valor}% — kit por ${final}`
    : `${formatarBRL(deInteiro(cupom.valor))} de desconto — kit por ${final}`
}

/**
 * Por que o cupom nao esta valendo AGORA, ou string vazia se esta.
 *
 * A tela mostra isso ao lado do link porque a pergunta que a dona da marca faz
 * olhando esta lista e sempre a mesma — "esse link ainda funciona?" — e a
 * resposta depende de tres coisas que nao sao a chave liga/desliga: a janela,
 * o limite total e o representante dono do cupom. Sao os mesmos motivos que
 * resgatarCupom (src/repositories/cupons.ts) usa para recusar.
 */
export function motivoDeNaoValer(cupom: CupomAdmin, agora: Date): string {
  if (!cupom.ativo) return 'Desativado'
  if (agora < cupom.iniciaEm) return 'Ainda não começou'
  if (cupom.expiraEm && agora >= cupom.expiraEm) return 'Expirado'
  if (cupom.limiteTotal !== null && cupom.usos >= cupom.limiteTotal) return 'Esgotado'
  return ''
}

function BotaoCopiar({ texto }: { texto: string }) {
  const [copiado, setCopiado] = useState(false)

  return (
    <button
      type="button"
      className="btn btn--ghost cupom__copiar"
      onClick={async () => {
        // navigator.clipboard exige contexto seguro e nao existe em todo
        // navegador antigo. Falhar aqui nao pode derrubar a tela: o link esta
        // escrito na pagina, selecionavel, e continua copiavel a mao.
        try {
          await navigator.clipboard.writeText(texto)
          setCopiado(true)
          setTimeout(() => setCopiado(false), 2000)
        } catch {
          setCopiado(false)
        }
      }}
    >
      {copiado ? 'Copiado!' : 'Copiar link'}
    </button>
  )
}

export function CuponsAdmin({ cupons: iniciais, precoDoKit, representantes, urlBase }: Props) {
  const [cupons, setCupons] = useState(iniciais)
  const [modo, setModo] = useState<Modo>('preco')
  const [codigo, setCodigo] = useState('')
  const [entrada, setEntrada] = useState('')
  const [expira, setExpira] = useState('')
  const [limiteTotal, setLimiteTotal] = useState('')
  const [representanteId, setRepresentanteId] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState('')

  const valor = valorParaApi(modo, entrada, precoDoKit)
  const codigoLimpo = codigo.trim().toUpperCase()
  const codigoOk = /^[A-Z0-9]{3,24}$/.test(codigoLimpo)
  const podeCriar = codigoOk && valor !== null && !enviando

  // A conferencia em voz alta. So aparece quando ha numero de verdade: uma
  // previsao com o campo pela metade ("kit por R$ 0,00" enquanto a pessoa
  // digita "8") assustaria a toa.
  const previsao = valor === null
    ? ''
    : formatarBRL(precoComCupom(precoDoKit, modo === 'percentual' ? 'percentual' : 'fixo', valor))

  async function criar() {
    setEnviando(true)
    setErro('')
    try {
      const resposta = await fetch('/api/admin/cupons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codigo: codigoLimpo,
          tipo: modo === 'percentual' ? 'percentual' : 'fixo',
          valor,
          expiraEm: expira === '' ? null : fimDoDiaEmSaoPaulo(expira),
          limiteTotal: limiteTotal.trim() === '' ? null : Number(limiteTotal),
          limitePorCliente: 1,
          representanteId: representanteId === '' ? null : representanteId,
        }),
      })
      const corpo = await resposta.json().catch(() => null) as
        { cupom?: CupomAdmin; mensagem?: string } | null

      if (!resposta.ok || !corpo?.cupom) {
        setErro(corpo?.mensagem ?? 'Não foi possível criar o cupom. Tente de novo.')
        return
      }

      // As datas voltam do JSON como string. Reidratar antes de guardar no
      // estado: a lista chama motivoDeNaoValer, que COMPARA datas — com string
      // a comparacao passa calada e mente sobre a validade.
      const novo: CupomAdmin = {
        ...corpo.cupom,
        iniciaEm: new Date(corpo.cupom.iniciaEm),
        expiraEm: corpo.cupom.expiraEm === null ? null : new Date(corpo.cupom.expiraEm),
        criadoEm: new Date(corpo.cupom.criadoEm),
        representanteNome:
          representantes.find((r) => r.id === representanteId)?.nome ?? null,
      }
      setCupons([novo, ...cupons])
      setCodigo('')
      setEntrada('')
      setExpira('')
      setLimiteTotal('')
      setRepresentanteId('')
    } catch {
      setErro('Não foi possível criar o cupom. Verifique a conexão e tente de novo.')
    } finally {
      setEnviando(false)
    }
  }

  async function alternar(cupom: CupomAdmin) {
    const resposta = await fetch('/api/admin/cupons', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: cupom.id, ativo: !cupom.ativo }),
    }).catch(() => null)

    if (!resposta?.ok) {
      setErro('Não foi possível mudar o cupom. Recarregue a página.')
      return
    }
    setCupons(cupons.map((c) => (c.id === cupom.id ? { ...c, ativo: !c.ativo } : c)))
  }

  const agora = new Date()

  return (
    <>
      <section className="section--panel cupom-form">
        <h2 className="admin__titulo">Nova campanha</h2>

        <div className="form__grid">
          <label className="form__field">
            <span>Código do cupom</span>
            <input
              value={codigo}
              onChange={(e) => setCodigo(e.target.value.toUpperCase())}
              placeholder="PRE800"
              maxLength={24}
              autoCapitalize="characters"
            />
            <small>Letras maiúsculas e números, de 3 a 24 caracteres.</small>
          </label>

          <label className="form__field">
            <span>Tipo de oferta</span>
            <select value={modo} onChange={(e) => setModo(e.target.value as Modo)}>
              <option value="preco">Preço final do kit</option>
              <option value="percentual">Percentual de desconto</option>
            </select>
          </label>

          <label className="form__field">
            <span>{modo === 'preco' ? 'O kit vai custar (R$)' : 'Desconto (%)'}</span>
            <input
              value={entrada}
              onChange={(e) => setEntrada(e.target.value)}
              inputMode="decimal"
              placeholder={modo === 'preco' ? '800,00' : '20'}
            />
            <small>
              {previsao
                ? `Preço cheio ${formatarBRL(precoDoKit)} · com o cupom o kit sai por ${previsao}`
                : `Preço cheio do kit hoje: ${formatarBRL(precoDoKit)}`}
            </small>
          </label>

          <label className="form__field">
            <span>Vale até (opcional)</span>
            <input type="date" value={expira} onChange={(e) => setExpira(e.target.value)} />
            <small>O cupom vale o dia inteiro da data escolhida. Em branco, não expira.</small>
          </label>

          <label className="form__field">
            <span>Limite de usos (opcional)</span>
            <input
              value={limiteTotal}
              onChange={(e) => setLimiteTotal(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              placeholder="sem limite"
            />
            <small>Cada pessoa usa uma vez, sempre. Em branco, o total é livre.</small>
          </label>

          <label className="form__field">
            <span>Representante (opcional)</span>
            <select
              value={representanteId}
              onChange={(e) => setRepresentanteId(e.target.value)}
            >
              <option value="">Cupom da casa — sem comissão</option>
              {representantes.map((r) => (
                <option key={r.id} value={r.id}>{r.nome}</option>
              ))}
            </select>
            <small>
              Escolhendo alguém, a venda feita com este código conta como dela.
            </small>
          </label>
        </div>

        {erro && <p className="form__status form__status--error" role="alert">{erro}</p>}

        <button
          type="button"
          className="btn btn--solid form__submit"
          onClick={criar}
          disabled={!podeCriar}
        >
          {enviando ? 'Criando...' : 'Criar e gerar link'}
        </button>
      </section>

      <section className="section--panel">
        <h2 className="admin__titulo">Campanhas</h2>

        {cupons.length === 0 && (
          <p className="tabela__vazio">Nenhum cupom criado ainda.</p>
        )}

        <ul className="cupom-lista">
          {cupons.map((cupom) => {
            const impedimento = motivoDeNaoValer(cupom, agora)
            const link = linkDaCampanha(urlBase, cupom.codigo)
            const rep = representantes.find((r) => r.id === cupom.representanteId)

            return (
              <li key={cupom.id} className="cupom">
                <div className="cupom__topo">
                  <strong className="cupom__codigo">{cupom.codigo}</strong>
                  <span className={`etiqueta ${impedimento ? 'etiqueta--pendente' : 'etiqueta--pago'}`}>
                    {impedimento || 'Valendo'}
                  </span>
                </div>

                <p className="cupom__desconto">{descricaoDoCupom(cupom, precoDoKit)}</p>

                {/*
                  O LINK E A ENTREGA DESTA TELA, e por isso ele fica escrito por
                  extenso e nao escondido atras do botao: um botao de copiar que
                  falha em silencio (clipboard exige contexto seguro) deixaria a
                  pessoa com nada. Com o texto na tela ela seleciona e copia a
                  mao no pior caso.
                */}
                <div className="cupom__link">
                  <code>{link}</code>
                  <BotaoCopiar texto={link} />
                </div>

                {rep && (
                  <div className="cupom__link">
                    <code>{linkDaRepresentante(urlBase, rep.slug, cupom.codigo)}</code>
                    <BotaoCopiar texto={linkDaRepresentante(urlBase, rep.slug, cupom.codigo)} />
                  </div>
                )}

                <p className="cupom__meta">
                  {cupom.usos} {cupom.usos === 1 ? 'uso' : 'usos'}
                  {cupom.limiteTotal !== null && ` de ${cupom.limiteTotal}`}
                  {cupom.expiraEm && ` · vale até ${ultimoDiaValido(cupom.expiraEm)}`}
                  {cupom.representanteNome && ` · ${cupom.representanteNome}`}
                </p>

                <button type="button" className="btn btn--ghost" onClick={() => alternar(cupom)}>
                  {cupom.ativo ? 'Desativar' : 'Reativar'}
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    </>
  )
}
