'use client'

// 'use client' porque este wizard e quatro telas com ESTADO (passo atual,
// quantidade, dados, endereco, opcao de frete) e, desde 16/08/2026, com duas
// chamadas assincronas disparadas pelo que o comprador digita: o autofill de
// CEP e a COTACAO DE FRETE do passo 3 (§13). Nada disso existe em Server
// Component — sem estado nao ha passo, e sem efeito nao ha cotacao.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Kit } from '@/repositories/produtos'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { deInteiro, formatarBRL, type Centavos } from '@/lib/money'
import { LinhaFrete } from '@/components/linha-frete'

type Props = {
  kit: Kit
  quantidadeInicial: number
}

type DadosPessoais = { nome: string; email: string; cpf: string; whatsapp: string }
type Endereco = {
  cep: string; rua: string; numero: string; complemento: string
  bairro: string; cidade: string; estado: string
}

/**
 * Uma opcao de frete como a TELA precisa dela: o que o comprador le
 * (transportadora, valor, prazo) mais o unico dado que volta ao servidor no
 * submit (`idServico`).
 *
 * `valor` e `Centavos` — o tipo branded de src/lib/money.ts — e nao um number
 * cru, porque este numero e somado ao subtotal em `montarCarrinho`. O JSON de
 * POST /api/frete traz `valorCentavos` como number (tipo nao sobrevive ao
 * transporte); a reconstrucao acontece em `lerOpcoesDeFrete`, num lugar so.
 *
 * ELE NAO VOLTA PARA O SERVIDOR. O corpo de POST /api/pedidos leva apenas
 * `idServico`: a rota RECOTA pelo CEP submetido e usa o valor que o provedor
 * devolver naquele instante. Ver o comentario de `confirmar`.
 */
type OpcaoDeFreteNaTela = {
  idServico: number
  transportadora: string
  valor: Centavos
  prazoDias: number
}

const DADOS_VAZIOS: DadosPessoais = { nome: '', email: '', cpf: '', whatsapp: '' }
const ENDERECO_VAZIO: Endereco = {
  cep: '', rua: '', numero: '', complemento: '', bairro: '', cidade: '', estado: '',
}

// Mesmas regras do Zod em src/app/api/pedidos/route.ts, verificadas aqui so
// para habilitar/desabilitar o "Continuar" mais cedo. A validacao que
// realmente decide se o pedido e criado e sempre a do servidor — isto e so
// UX, nunca a fonte de verdade.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * O MESMO formato de POST /api/frete, de GET /api/cep/[cep], de POST
 * /api/pedidos e da coluna `enderecos.cep` (CHECK endereco_cep_digitos): oito
 * digitos, sem hifen. E ele que decide QUANDO o autofill e a cotacao disparam —
 * antes do oitavo digito nao ha o que consultar, e cada disparo a mais gasta uma
 * requisicao paga no Clube Envios.
 */
const CEP_COMPLETO = /^\d{8}$/

/**
 * Mensagens da tela quando a cotacao nao acontece.
 *
 * `FRETE_BLOQUEIA_O_PEDIDO` e a parte que NAO pode faltar em nenhum caminho de
 * erro: o comprador precisa entender que o pedido nao segue agora, e nao ficar
 * procurando o botao que sumiu. Este e o mesmo principio do cabecalho de
 * src/components/linha-frete.tsx — quando nao ha valor, a resposta certa e
 * dizer que nao ha valor, jamais seguir com R$ 0,00. Frete zero gravado vira
 * prejuizo por pedido e `pedidos.frete_centavos` e congelada pelo trigger de
 * imutabilidade: nao existe UPDATE de correcao depois.
 */
const FRETE_BLOQUEIA_O_PEDIDO =
  'Sem o valor do frete não é possível concluir o pedido agora. Tente novamente em instantes ou confira o CEP digitado.'
const FALHA_GENERICA_DE_FRETE = 'Não foi possível calcular o frete agora.'
const FALHA_DE_CONEXAO_NO_FRETE = 'Não conseguimos falar com o cálculo de frete. Verifique sua conexão.'
const COTACAO_SEM_OPCAO_LEGIVEL =
  'A cotação voltou sem nenhuma opção de entrega que possamos exibir com valor e prazo.'

function somenteDigitos(v: string): string {
  return v.replace(/\D/g, '')
}

function texto(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function dadosPessoaisValidos(d: DadosPessoais): boolean {
  return d.nome.trim().length >= 3
    && EMAIL_REGEX.test(d.email)
    && /^\d{11}$/.test(d.cpf)
    && /^\d{10,13}$/.test(d.whatsapp)
}

function enderecoValido(e: Endereco): boolean {
  return CEP_COMPLETO.test(e.cep)
    && e.rua.trim().length > 0
    && e.numero.trim().length > 0
    && e.bairro.trim().length > 0
    && e.cidade.trim().length > 0
    && /^[A-Z]{2}$/.test(e.estado)
}

/**
 * Le a `mensagem` curada que as rotas devolvem junto do `error` snake_case.
 * Unico ponto de leitura, usado tanto pela cotacao quanto pelo submit: exibir
 * `error` cru ("frete_indisponivel") na tela e mostrar nome de codigo a quem
 * esta comprando.
 */
function mensagemDaResposta(corpo: unknown): string | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const m = (corpo as { mensagem?: unknown }).mensagem
  return typeof m === 'string' && m.trim() !== '' ? m : null
}

/**
 * Traduz a resposta de GET /api/cep/[cep] nos campos que o formulario preenche.
 *
 * DEVOLVE SO O QUE VEIO PREENCHIDO. CEP geral de cidade responde com
 * `logradouro` e `bairro` vazios; sobrescrever com string vazia apagaria o que o
 * comprador ja tivesse digitado a mao — o autofill viraria um apagador. Campo
 * vazio na resposta e simplesmente campo que o autofill nao sabe.
 */
function lerEnderecoDoCep(corpo: unknown): Partial<Endereco> | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const d = corpo as Record<string, unknown>

  const encontrado: Partial<Endereco> = {}
  if (texto(d.rua)) encontrado.rua = texto(d.rua)
  if (texto(d.bairro)) encontrado.bairro = texto(d.bairro)
  if (texto(d.cidade)) encontrado.cidade = texto(d.cidade)
  // A UF entra pelo mesmo funil do campo digitado (maiuscula, so letras): o
  // input tem `maxLength={2}` e a rota valida `/^[A-Z]{2}$/`, entao um "sp"
  // preenchido pelo autofill seria invalido no submit sem nada na tela
  // explicando por que.
  const uf = texto(d.estado).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2)
  if (uf.length === 2) encontrado.estado = uf

  return Object.keys(encontrado).length > 0 ? encontrado : null
}

/**
 * Traduz a resposta de POST /api/frete na lista que a tela desenha.
 *
 * OPCAO ILEGIVEL E DESCARTADA, NUNCA CORRIGIDA. Se um item vier sem valor, sem
 * prazo ou com valor fracionado, ele nao entra na lista — em vez de virar
 * "R$ 0,00" ou "prazo 0". E a mesma regra de `CotacaoIlegivelError` em
 * src/lib/frete.ts, um degrau adiante: la o servidor recusa a resposta inteira,
 * aqui a tela recusa a linha que nao da para exibir. Se sobrarem zero opcoes,
 * quem chama trata como cotacao indisponivel e o "Continuar" continua travado.
 *
 * `valorCentavos === 0` E ACEITO, e a diferenca importa: zero vindo do provedor
 * e um frete que ele cotou como gratuito — um FATO. O que o projeto proibe e
 * zero INVENTADO por ausencia de valor, que e exatamente o caso descartado
 * acima. Ver o cabecalho de src/components/linha-frete.tsx.
 */
function lerOpcoesDeFrete(corpo: unknown): OpcaoDeFreteNaTela[] {
  if (typeof corpo !== 'object' || corpo === null) return []
  const lista = (corpo as { opcoes?: unknown }).opcoes
  if (!Array.isArray(lista)) return []

  const opcoes: OpcaoDeFreteNaTela[] = []
  for (const item of lista) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>

    const idServico = o.idServico
    const transportadora = texto(o.transportadora)
    const valorCentavos = o.valorCentavos
    const prazoDias = o.prazoDias

    if (typeof idServico !== 'number' || !Number.isInteger(idServico) || idServico <= 0) continue
    if (transportadora === '') continue
    if (typeof valorCentavos !== 'number' || !Number.isInteger(valorCentavos) || valorCentavos < 0) continue
    if (typeof prazoDias !== 'number' || !Number.isInteger(prazoDias) || prazoDias <= 0) continue

    opcoes.push({
      idServico,
      transportadora,
      valor: deInteiro(valorCentavos),
      prazoDias,
    })
  }
  return opcoes
}

function textoDePrazo(dias: number): string {
  return dias === 1 ? 'Prazo estimado: 1 dia útil' : `Prazo estimado: ${dias} dias úteis`
}

export function CheckoutWizard({ kit, quantidadeInicial }: Props) {
  const router = useRouter()
  const [passo, setPasso] = useState(1)
  const [quantidade, setQuantidade] = useState(quantidadeInicial)
  const [dados, setDados] = useState<DadosPessoais>(DADOS_VAZIOS)
  const [endereco, setEndereco] = useState<Endereco>(ENDERECO_VAZIO)
  const [cupom, setCupom] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  // Estado da cotacao de frete (§13). `idServicoEscolhido` guarda so o ID:
  // a opcao inteira e derivada da lista abaixo, para nao existirem duas
  // copias do mesmo valor podendo divergir.
  const [opcoesFrete, setOpcoesFrete] = useState<OpcaoDeFreteNaTela[]>([])
  const [idServicoEscolhido, setIdServicoEscolhido] = useState<number | null>(null)
  const [cotandoFrete, setCotandoFrete] = useState(false)
  const [erroFrete, setErroFrete] = useState<string | null>(null)
  // Contador de "tentar de novo". Nao guarda informacao nenhuma: existe so para
  // entrar nas dependencias do efeito de cotacao e refaze-la sem que o
  // comprador precise reescrever o CEP para forcar a mudanca.
  const [tentativaDeFrete, setTentativaDeFrete] = useState(0)

  const cepCompleto = CEP_COMPLETO.test(endereco.cep) ? endereco.cep : ''
  const opcaoEscolhida = opcoesFrete.find((o) => o.idServico === idServicoEscolhido) ?? null

  /**
   * AUTOFILL DE ENDERECO — CONVENIENCIA, NUNCA BLOQUEIO.
   *
   * Dispara quando o CEP completa oito digitos e preenche rua, bairro, cidade e
   * UF. Os campos continuam EDITAVEIS depois: sao inputs controlados comuns, e
   * este efeito so roda de novo quando o proprio CEP muda — corrigir o
   * complemento ou o nome da rua nao devolve o valor antigo.
   *
   * FALHA E SILENCIO DE PROPOSITO. CEP inexistente, ViaCEP fora do ar, timeout,
   * JSON quebrado: todos terminam sem mensagem nenhuma na tela, e o comprador
   * digita os quatro campos a mao como sempre pode. Um erro vermelho aqui
   * assustaria alguem que nao tem problema nenhum — o formulario segue valido —
   * e o ViaCEP e um servico publico gratuito, sem contrato de disponibilidade
   * (ver o cabecalho de src/lib/cep.ts e de src/app/api/cep/[cep]/route.ts).
   * Isso e o OPOSTO do efeito de frete logo abaixo, onde o que esta em jogo e
   * dinheiro e a falha PRECISA parar o checkout.
   */
  useEffect(() => {
    if (!cepCompleto) return

    let cancelado = false
    void (async () => {
      let encontrado: Partial<Endereco> | null = null
      try {
        const resposta = await fetch(`/api/cep/${cepCompleto}`)
        if (resposta.ok) {
          encontrado = lerEnderecoDoCep(await resposta.json().catch(() => null))
        }
      } catch {
        encontrado = null
      }
      if (cancelado || !encontrado) return
      // Aplicado por atualizacao funcional, e com uma segunda checagem do CEP:
      // duas respostas em voo (o comprador corrigiu o ultimo digito) nao podem
      // deixar o endereco de um CEP no formulario de outro.
      setEndereco((atual) => (atual.cep === cepCompleto ? { ...atual, ...encontrado } : atual))
    })()

    return () => { cancelado = true }
  }, [cepCompleto])

  /**
   * COTACAO DE FRETE (§13) — aqui a falha PRECISA aparecer e PRECISA travar.
   *
   * Roda quando muda qualquer coisa que altera o preco do transporte: o CEP, a
   * quantidade (cada unidade e um volume) ou o kit. E a PRIMEIRA COISA que ele
   * faz e apagar a escolha anterior: uma opcao escolhida para dois kits nao vale
   * para tres, e manter o radio marcado deixaria o "Continuar" liberado com um
   * valor que nao corresponde mais ao carrinho. Escolha apagada = "Continuar"
   * desabilitado ate o comprador escolher de novo, por construcao.
   *
   * O QUE ESTA ROTA DEVOLVE NAO VIRA DINHEIRO NO PEDIDO. POST /api/pedidos
   * recota no servidor e usa o valor de la; o que sai daqui e informacao para o
   * comprador decidir (e o `idServico` da decisao dele).
   */
  useEffect(() => {
    setIdServicoEscolhido(null)
    setOpcoesFrete([])
    setErroFrete(null)

    if (!cepCompleto) {
      setCotandoFrete(false)
      return
    }

    let cancelado = false
    setCotandoFrete(true)

    void (async () => {
      try {
        const resposta = await fetch('/api/frete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Tres campos, nenhum deles dinheiro: o schema da rota e .strict() e
          // o preco/dimensoes saem do catalogo no servidor.
          body: JSON.stringify({ cep: cepCompleto, kitSlug: kit.slug, quantidade }),
        })
        const corpo: unknown = await resposta.json().catch(() => null)
        if (cancelado) return

        if (!resposta.ok) {
          // 503 `frete_indisponivel`, 422 `cep_invalido` e 422
          // `frete_sem_atendimento` pedem coisas diferentes do comprador, e
          // cada um ja vem com a `mensagem` curada pela rota. O fallback so
          // cobre resposta sem mensagem (429, 500).
          setErroFrete(mensagemDaResposta(corpo) ?? FALHA_GENERICA_DE_FRETE)
          setCotandoFrete(false)
          return
        }

        const opcoes = lerOpcoesDeFrete(corpo)
        if (opcoes.length === 0) {
          // 200 com lista vazia ou so com itens ilegiveis. Nao e sucesso: nao
          // ha frete para cobrar, entao nao ha pedido para fechar.
          setErroFrete(COTACAO_SEM_OPCAO_LEGIVEL)
        } else {
          setOpcoesFrete(opcoes)
        }
        setCotandoFrete(false)
      } catch {
        if (cancelado) return
        setErroFrete(FALHA_DE_CONEXAO_NO_FRETE)
        setCotandoFrete(false)
      }
    })()

    return () => { cancelado = true }
  }, [cepCompleto, quantidade, kit.slug, tentativaDeFrete])

  // So para exibir Produto/Quantidade/Valor unitario/Subtotal/Frete/Total aqui
  // (§9) — o preco que decide o pedido de verdade e lido do catalogo de novo, no
  // servidor, dentro da transacao (buscarKitAtivoPorSlug em
  // src/app/api/pedidos/route.ts), e o frete e RECOTADO la a partir do CEP
  // submetido. Nada calculado neste componente e enviado como valor monetario:
  // o corpo do POST manda kitSlug, quantidade, `idServico` (qual opcao de frete
  // o comprador escolheu — o ID, nunca o valor dela) e os dados de
  // comprador/endereco.
  //
  // O terceiro argumento e o que faz o Total do passo 4 ser o total DE VERDADE
  // e nao so o subtotal: `montarCarrinho` soma frete depois do desconto, com a
  // mesma formula da constraint pedido_total_confere. Enquanto nao ha opcao
  // escolhida ele e zero — e nesse estado a tela nao mostra Total nenhum como
  // definitivo, porque o passo 4 so e alcancavel com uma opcao escolhida.
  const resumo = montarCarrinho(
    [{ kitId: kit.id, nome: kit.nome, precoUnitario: kit.precoCentavos, quantidade }],
    deInteiro(0),
    opcaoEscolhida ? opcaoEscolhida.valor : deInteiro(0),
  )

  async function confirmar() {
    // Guarda de ultimo metro: sem opcao de frete nao existe pedido a criar. O
    // botao ja vem desabilitado neste estado — esta linha existe para que
    // NENHUM caminho futuro (um atalho de teclado, um passo novo, um estado
    // restaurado) consiga postar um pedido sem frete escolhido.
    if (!opcaoEscolhida) return

    setEnviando(true)
    setErro(null)
    try {
      const resposta = await fetch('/api/pedidos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kitSlug: kit.slug,
          quantidade,
          // SO O ID DA OPCAO, jamais o valor dela. A rota recota o frete no
          // servidor a partir do CEP submetido e usa o valor que o provedor
          // devolver naquele instante — se a tabela da transportadora mudou
          // entre a tela e este clique, quem manda e a cotacao nova. Mandar
          // `valorCentavos` junto seria oferecer ao navegador a chance de
          // escolher quanto custa o frete; o `.strict()` de
          // src/app/api/pedidos/route.ts responderia 422, mas a garantia de
          // verdade e esta linha nao existir.
          idServico: opcaoEscolhida.idServico,
          ...(cupom.trim() ? { cupom: cupom.trim() } : {}),
          ...dados,
          ...endereco,
        }),
      })
      const corpo: unknown = await resposta.json().catch(() => null)

      if (!resposta.ok) {
        setErro(
          mensagemDaResposta(corpo)
          ?? 'Nao foi possivel concluir o pedido. Confira os dados e tente novamente.',
        )
        setEnviando(false)
        return
      }

      // Navega pelo TOKEN, nunca pelo numero: numero e um bigint
      // sequencial e a pagina de confirmacao e publica sem autenticacao —
      // uma URL previsivel deixaria qualquer visitante andar /pedido/1,
      // /pedido/2... (ver migrations/1755100000000_pedido_token.sql e
      // src/app/pedido/[token]/page.tsx).
      const token = corpo && typeof corpo === 'object' && 'token' in corpo
        ? (corpo as { token: unknown }).token
        : null
      if (typeof token !== 'string') {
        setErro('Pedido criado, mas a confirmacao veio incompleta. Entre em contato com o suporte.')
        setEnviando(false)
        return
      }
      router.push(`/pedido/${token}`)
    } catch {
      setErro('Falha de conexao. Tente novamente.')
      setEnviando(false)
    }
  }

  return (
    <section className="section checkout">
      <p className="kicker">Checkout — passo {passo} de 4</p>

      {passo === 1 && (
        <div className="checkout__passo">
          <h1>{kit.nome}</h1>
          <p className="vitrine__preco">{formatarBRL(kit.precoCentavos)}</p>

          <div className="vitrine__stepper" role="group" aria-label="Quantidade">
            <button
              type="button"
              className="vitrine__stepper-btn"
              aria-label="Diminuir quantidade"
              disabled={quantidade <= 1}
              onClick={() => setQuantidade((q) => Math.max(1, q - 1))}
            >
              −
            </button>
            <span className="vitrine__stepper-valor" data-testid="quantidade">{quantidade}</span>
            <button
              type="button"
              className="vitrine__stepper-btn"
              aria-label="Aumentar quantidade"
              disabled={quantidade >= QUANTIDADE_MAXIMA}
              onClick={() => setQuantidade((q) => Math.min(QUANTIDADE_MAXIMA, q + 1))}
            >
              +
            </button>
          </div>

          <div className="vitrine__resumo">
            {/*
              §9: "Valor unitário" tem linha propria e nao some quando a
              quantidade e 1. E a unica forma de o comprador conferir a conta de
              2, 3 ou 10 kits — sem ela, o Subtotal e um numero que ele tem que
              aceitar de boa fe.
            */}
            <p className="vitrine__linha" data-testid="valor-unitario">
              Valor unitário: {formatarBRL(kit.precoCentavos)}
            </p>
            {/* data-testid porque "Subtotal:" contem "total:": uma busca por
                texto pegaria as duas linhas. */}
            <p className="vitrine__linha" data-testid="subtotal">
              Subtotal: {formatarBRL(resumo.subtotal)}
            </p>
            {/*
              `valor={null}` = AINDA NAO COTADO, que e um estado diferente de
              zero: neste passo o CEP nem foi pedido. LinhaFrete imprime o texto
              de "a cotar" e nunca R$ 0,00 — ver o cabecalho do componente.
            */}
            <LinhaFrete valor={null} />
          </div>

          <div className="checkout__nav">
            <button type="button" className="btn btn--solid" onClick={() => setPasso(2)}>
              Continuar
            </button>
          </div>
        </div>
      )}

      {passo === 2 && (
        <div className="checkout__passo form">
          <h2>Seus dados</h2>
          <div className="form__grid">
            <div className="form__field form__field--wide">
              <label htmlFor="nome">Nome completo</label>
              <input
                id="nome" autoComplete="name" value={dados.nome}
                onChange={(e) => setDados({ ...dados, nome: e.target.value })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="email">E-mail</label>
              <input
                id="email" type="email" autoComplete="email" value={dados.email}
                onChange={(e) => setDados({ ...dados, email: e.target.value })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="cpf">CPF (somente numeros)</label>
              <input
                id="cpf" inputMode="numeric" maxLength={11} value={dados.cpf}
                onChange={(e) => setDados({ ...dados, cpf: somenteDigitos(e.target.value) })}
              />
            </div>
            <div className="form__field form__field--wide">
              <label htmlFor="whatsapp">WhatsApp (DDD + numero)</label>
              <input
                id="whatsapp" inputMode="numeric" maxLength={13} value={dados.whatsapp}
                onChange={(e) => setDados({ ...dados, whatsapp: somenteDigitos(e.target.value) })}
              />
            </div>
          </div>
          <div className="checkout__nav">
            <button type="button" className="btn btn--ghost" onClick={() => setPasso(1)}>Voltar</button>
            <button
              type="button" className="btn btn--solid"
              disabled={!dadosPessoaisValidos(dados)}
              onClick={() => setPasso(3)}
            >
              Continuar
            </button>
          </div>
        </div>
      )}

      {passo === 3 && (
        <div className="checkout__passo form">
          <h2>Endereço de entrega</h2>
          <div className="form__grid">
            <div className="form__field">
              <label htmlFor="cep">CEP (somente numeros)</label>
              <input
                id="cep" inputMode="numeric" maxLength={8} value={endereco.cep}
                onChange={(e) => setEndereco({ ...endereco, cep: somenteDigitos(e.target.value) })}
              />
              {/*
                Texto fixo, sempre visivel, e nao um aviso que aparece quando o
                autofill falha: a promessa e modesta ("quando encontramos") e ja
                diz que dava para corrigir tudo. Assim o caminho de falha do
                autofill nao precisa de mensagem nenhuma — ver o efeito.
              */}
              <p className="form__status">
                Preenchemos rua, bairro, cidade e UF quando encontramos o CEP. Você pode corrigir qualquer campo.
              </p>
            </div>
            <div className="form__field">
              <label htmlFor="estado">Estado (UF)</label>
              <input
                id="estado" maxLength={2} value={endereco.estado}
                onChange={(e) => setEndereco({
                  ...endereco, estado: e.target.value.toUpperCase().replace(/[^A-Z]/g, ''),
                })}
              />
            </div>
            <div className="form__field form__field--wide">
              <label htmlFor="rua">Rua</label>
              <input
                id="rua" value={endereco.rua}
                onChange={(e) => setEndereco({ ...endereco, rua: e.target.value })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="numero">Numero</label>
              <input
                id="numero" value={endereco.numero}
                onChange={(e) => setEndereco({ ...endereco, numero: e.target.value })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="complemento">Complemento</label>
              <input
                id="complemento" value={endereco.complemento}
                onChange={(e) => setEndereco({ ...endereco, complemento: e.target.value })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="bairro">Bairro</label>
              <input
                id="bairro" value={endereco.bairro}
                onChange={(e) => setEndereco({ ...endereco, bairro: e.target.value })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="cidade">Cidade</label>
              <input
                id="cidade" value={endereco.cidade}
                onChange={(e) => setEndereco({ ...endereco, cidade: e.target.value })}
              />
            </div>
          </div>

          {/* `.eyebrow` (globals.css) e nao um estilo novo: e o rotulo de secao
              que ja existe no design system, e h1..h4 tem `margin:0` no reset —
              um <h3> cru ficaria colado no campo de cima. */}
          <h3 className="eyebrow">Entrega</h3>

          {/* role="status": chegou sozinho, sem clique, e nao e urgente. */}
          {cotandoFrete && (
            <p className="form__status" role="status">Calculando o frete para o seu CEP…</p>
          )}

          {/*
            ESTADO VAZIO HONESTO: enquanto nao ha CEP nao ha o que cotar, e a
            tela diz isso em vez de mostrar uma lista vazia ou — pior — uma
            opcao "Padrão" com valor inventado.
          */}
          {!cotandoFrete && !cepCompleto && !erroFrete && (
            <p className="form__status">
              Informe o CEP acima para calcular o frete e o prazo de entrega.
            </p>
          )}

          {/*
            role="alert" e nao role="status" porque este erro BLOQUEIA a compra:
            sem cotacao o "Continuar" fica desabilitado e o comprador precisa
            saber disso agora, nao quando terminar de ler a tela. A distincao
            esta documentada no bloco .aviso de src/app/globals.css.
          */}
          {erroFrete && (
            <div className="aviso aviso--erro" role="alert">
              <strong className="aviso__titulo">Frete não calculado</strong>
              <p>{erroFrete}</p>
              <p>{FRETE_BLOQUEIA_O_PEDIDO}</p>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setTentativaDeFrete((t) => t + 1)}
              >
                Tentar calcular de novo
              </button>
            </div>
          )}

          {opcoesFrete.length > 0 && (
            <div className="frete-opcoes" role="radiogroup" aria-label="Opções de frete">
              {opcoesFrete.map((o) => {
                const idInput = `frete-${o.idServico}`
                const escolhida = o.idServico === idServicoEscolhido
                return (
                  <label
                    key={o.idServico}
                    htmlFor={idInput}
                    className={`frete-opcao${escolhida ? ' frete-opcao--escolhida' : ''}`}
                  >
                    <input
                      id={idInput}
                      type="radio"
                      name="opcao-de-frete"
                      value={String(o.idServico)}
                      checked={escolhida}
                      onChange={() => setIdServicoEscolhido(o.idServico)}
                    />
                    <span className="frete-opcao__nome">
                      {o.transportadora}
                      <span className="frete-opcao__prazo">{textoDePrazo(o.prazoDias)}</span>
                    </span>
                    <span className="frete-opcao__valor">{formatarBRL(o.valor)}</span>
                  </label>
                )
              })}
            </div>
          )}

          <div className="checkout__nav">
            <button type="button" className="btn btn--ghost" onClick={() => setPasso(2)}>Voltar</button>
            {/*
              Duas condicoes independentes, as duas obrigatorias: endereco
              completo E opcao de frete escolhida. A segunda e o que impede o
              checkout de andar com frete desconhecido — e, por tabela, de o
              passo 4 exibir um Total que nao inclui o transporte.
            */}
            <button
              type="button" className="btn btn--solid"
              disabled={!enderecoValido(endereco) || opcaoEscolhida === null}
              onClick={() => setPasso(4)}
            >
              Continuar
            </button>
          </div>
        </div>
      )}

      {passo === 4 && (
        <div className="checkout__passo form">
          <h2>Revisão</h2>
          {/* O resumo completo de §9: Produto, Quantidade, Valor unitário,
              Subtotal, Frete (valor real + prazo) e Total. */}
          <div className="vitrine__resumo">
            <p className="vitrine__linha">Produto: {kit.nome}</p>
            <p className="vitrine__linha">Quantidade: {quantidade}</p>
            <p className="vitrine__linha" data-testid="valor-unitario">
              Valor unitário: {formatarBRL(kit.precoCentavos)}
            </p>
            <p className="vitrine__linha" data-testid="subtotal">
              Subtotal: {formatarBRL(resumo.subtotal)}
            </p>
            {/*
              Nenhum desconto e mostrado aqui: o cupom so e validado no
              servidor, sob trava de linha, no momento da confirmacao (ver
              src/repositories/cupons.ts). Mostrar um valor calculado no
              cliente para um cupom ainda nao verificado seria inventar um
              desconto que pode nao existir.
            */}
            {/*
              Agora com VALOR REAL e PRAZO — a opcao que o comprador escolheu no
              passo 3. `?? null` nao e formalidade: se por qualquer caminho a
              escolha se perder, a linha volta a dizer "a cotar" em vez de
              imprimir R$ 0,00, e o botao de pagamento abaixo fica desabilitado.
            */}
            <LinhaFrete
              valor={opcaoEscolhida?.valor ?? null}
              prazoDias={opcaoEscolhida?.prazoDias ?? null}
            />
            <p className="vitrine__linha vitrine__linha--total" data-testid="total">
              Total: {formatarBRL(resumo.total)}
              {cupom.trim() && ' (antes do cupom, verificado na confirmação)'}
            </p>
          </div>

          <div className="form__field">
            <label htmlFor="cupom">Cupom de desconto (opcional)</label>
            <input
              id="cupom" value={cupom}
              onChange={(e) => setCupom(e.target.value.toUpperCase())}
            />
          </div>

          {/*
            §9: as formas de pagamento sao anunciadas AQUI, antes de o comprador
            confirmar, e cobradas na proxima tela. Anunciar so depois de criar o
            pedido faria alguem sem cartao e sem Pix descobrir isso com o pedido
            ja registrado em seu nome.
          */}
          <div className="pagamentos-aceitos" role="group" aria-label="Formas de pagamento aceitas">
            <span className="pagamento-chip">PIX</span>
            <span className="pagamento-chip">Cartão de crédito</span>
          </div>
          <p className="vitrine__linha">
            A cobrança acontece na próxima tela, depois que o pedido for criado.
          </p>

          {erro && <p className="form__status form__status--error" role="status">{erro}</p>}

          <div className="checkout__nav">
            <button type="button" className="btn btn--ghost" onClick={() => setPasso(3)} disabled={enviando}>
              Voltar
            </button>
            {/*
              O pedido e criado AQUI, mas a cobranca acontece na proxima tela
              (/pedido/<token>). A ordem nao e arbitraria: o total so e
              definitivo depois de o servidor validar o cupom sob trava de
              linha, e cobrar exige esse valor. Alem disso, uma pagina propria
              com URL estavel e o que faz o QR do Pix sobreviver a recarregar,
              fechar e voltar depois — coisa que um passo de wizard em memoria
              nao faria.

              Desde 16/08/2026 ha uma segunda razao, do mesmo tipo: o FRETE
              tambem so e definitivo depois que o servidor recota (POST
              /api/pedidos usa o CEP submetido, nao o valor que esta tela
              mostrou). Cobrar antes de gravar o pedido exigiria cobrar um total
              montado no navegador.
            */}
            <button
              type="button" className="btn btn--solid" onClick={confirmar}
              disabled={enviando || opcaoEscolhida === null}
            >
              {enviando ? 'Enviando...' : 'Ir para o pagamento'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
