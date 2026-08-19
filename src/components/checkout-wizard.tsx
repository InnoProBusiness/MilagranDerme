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
import type { TipoEntrega } from '@/lib/pedido-status'
import { TAMANHO_MAXIMO_CUPOM } from '@/lib/cupom-da-url'
import {
  FRETE_RETIRADA, ROTULO_RETIRADA, TEXTO_PRAZO_RETIRADA,
  AVISO_RETIRADA_PRE_VENDA, enderecoRetiradaEmLinha,
} from '@/lib/retirada'

type Props = {
  kit: Kit
  quantidadeInicial: number
  /**
   * Codigo de cupom vindo da URL (`?cupom=CODIGO`), para links de campanha
   * em que a oferta ja esta combinada e o comprador nao deveria ter que
   * digitar nada. Opcional: quem chega pela home normal nao passa nada.
   */
  cupomInicial?: string
  /**
   * O lancamento de 25/08/2026 ja ocorreu? Decide se o aviso de pre-venda da
   * retirada aparece.
   *
   * VEM DO SERVIDOR, e nao de `lancamentoJaOcorreu()` chamado aqui dentro. Este
   * e um Client Component: a funcao rodaria uma vez no SSR e outra na
   * hidratacao, e uma compra feita na virada da meia-noite de 25/08 renderizaria
   * HTML diferente nos dois lados — o erro de hidratacao classico. A pagina que
   * monta o wizard ja decide isso uma vez para a tela inteira
   * (src/app/page.tsx), e passa a resposta pronta.
   *
   * OBRIGATORIA, pelo mesmo motivo de `valor` em src/components/linha-frete.tsx:
   * opcional com default, a pagina esquecida continuaria prometendo pre-venda
   * meses depois do lancamento, em silencio.
   */
  lancado: boolean
}

/**
 * O que o botao "Validar cupom" trouxe de volta, amarrado a PERGUNTA INTEIRA que
 * o produziu — e nao so ao codigo.
 *
 * A pergunta e "quanto este cupom tira DESTE carrinho", e o carrinho e
 * (kit, quantidade). Guardar so o codigo foi o defeito da primeira versao: um
 * cupom percentual validado com 3 kits continuava mostrando o desconto dos 3
 * depois de a pessoa voltar ao passo 1 e baixar para 1 — a tela anunciava um
 * total que a confirmacao nao ia cobrar, e `total_centavos` e congelado no
 * INSERT, entao nao havia conserto depois.
 */
type PerguntaDoCupom = { codigo: string; kitSlug: string; quantidade: number }

type PreviaDeCupom = PerguntaDoCupom & (
  | { valido: true; descontoCentavos: Centavos }
  | { valido: false; mensagem: string }
)

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
  /** "PAC", "SEDEX". Vazio quando o provedor nao informa. */
  servico: string
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
 * `FRETE_BLOQUEIA_O_ENVIO` e a parte que NAO pode faltar em nenhum caminho de
 * erro: o comprador precisa entender que o ENVIO nao segue agora, e nao ficar
 * procurando o botao que sumiu. Este e o mesmo principio do cabecalho de
 * src/components/linha-frete.tsx — quando nao ha valor, a resposta certa e
 * dizer que nao ha valor, jamais seguir com R$ 0,00. Frete zero gravado vira
 * prejuizo por pedido e `pedidos.frete_centavos` e congelada pelo trigger de
 * imutabilidade: nao existe UPDATE de correcao depois.
 *
 * "O ENVIO", E NAO "O PEDIDO" (19/08/2026). A frase dizia "não é possível
 * concluir o pedido agora", exata enquanto toda entrega dependia do Clube
 * Envios. Com a retirada no local existe uma forma de receber que nao depende
 * de provedor nenhum: dizer que o PEDIDO parou mandaria embora quem ia buscar o
 * kit a pe, por causa de um servico que aquela compra nunca usaria. O alerta
 * tambem so e renderizado dentro do ramo de envio, entao quem escolheu retirada
 * nunca o le.
 */
const FRETE_BLOQUEIA_O_ENVIO =
  'Sem o valor do frete não é possível seguir com o envio agora. Tente novamente em instantes, confira o CEP digitado — ou escolha a retirada no local, que não depende do cálculo de frete.'
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
    const servico = texto(o.servico)
    const valorCentavos = o.valorCentavos
    const prazoDias = o.prazoDias

    if (typeof idServico !== 'number' || !Number.isInteger(idServico) || idServico <= 0) continue
    if (typeof valorCentavos !== 'number' || !Number.isInteger(valorCentavos) || valorCentavos < 0) continue
    if (typeof prazoDias !== 'number' || !Number.isInteger(prazoDias) || prazoDias <= 0) continue

    // NOME VAZIO NAO DESCARTA A OPCAO. src/lib/frete.ts diz, no ponto em que
    // monta a cotacao: "Nome da transportadora e cosmetico: some da tela, nao
    // some do bolso de ninguem. Diferente de preco e prazo, nao derruba a
    // cotacao." A tela era mais estrita que o servidor e sumia com opcoes
    // pagaveis.
    //
    // O RISCO CONCRETO: a resposta de sucesso do POST /cotacao do Clube Envios
    // nao esta na documentacao publica, e o servidor le o nome por uma lista
    // de apelidos. Se nenhum apelido casar — plausivel, e o risco ja
    // registrado no handoff —, TODA opcao vinha com nome vazio, este `continue`
    // esvaziava a lista, e o comprador via "nenhuma opcao de frete" com preco e
    // prazo perfeitamente legiveis do outro lado. Checkout online travado no
    // dia do lancamento por um rotulo.
    //
    // O que nao pode faltar continua sendo barrado acima: sem idServico o
    // servidor nao recota, e sem preco ou prazo nao ha o que mostrar nem cobrar.
    opcoes.push({
      idServico,
      transportadora,
      servico,
      valor: deInteiro(valorCentavos),
      prazoDias,
    })
  }
  return opcoes
}

/**
 * Como a opcao de frete se apresenta no radio.
 *
 * Funcao pura e exportada porque e a regra que decide o que o comprador le ao
 * escolher entre cinco linhas parecidas — merece teste direto, sem passar por
 * clique nenhum.
 *
 * Ordem "Transportadora · Servico": o nome de quem entrega vem primeiro porque
 * e o que a pessoa reconhece; o servico desempata. Quando so um dos dois
 * existe, ele aparece sozinho, sem separador orfao.
 */
export function rotuloDaOpcao(o: { transportadora: string; servico: string }): string {
  const partes = [o.transportadora.trim(), o.servico.trim()].filter((p) => p !== '')
  return partes.length === 0 ? 'Envio' : partes.join(' · ')
}

function textoDePrazo(dias: number): string {
  return dias === 1 ? 'Prazo estimado: 1 dia útil' : `Prazo estimado: ${dias} dias úteis`
}

/**
 * COMO a compradora quer receber. E o MESMO vocabulario da coluna
 * `pedidos.tipo_entrega` e do discriminante de POST /api/pedidos, de proposito:
 * o valor que sai deste radiogroup viaja ate o banco sem tradutor no meio.
 */
export type Modalidade = TipoEntrega

/**
 * As duas linhas fixas do primeiro radiogroup. Uma lista, e nao dois <label>
 * escritos a mao, para que as duas nasçam com a mesma forma — e para que a
 * ordem e o texto de cada uma tenham um lugar so.
 *
 * RETIRADA PRIMEIRO: e a mais barata e a que a tela quer deixar visivel de
 * relance para quem e de Goiania.
 */
export const MODALIDADES: ReadonlyArray<{ chave: Modalidade; nome: string; apoio: string }> = [
  { chave: 'retirada', nome: ROTULO_RETIRADA, apoio: TEXTO_PRAZO_RETIRADA },
  { chave: 'envio', nome: 'Receber em casa', apoio: 'Frete e prazo calculados pelo seu CEP' },
]

export function CheckoutWizard({ kit, quantidadeInicial, cupomInicial = '', lancado }: Props) {
  const router = useRouter()
  const [passo, setPasso] = useState(1)
  const [quantidade, setQuantidade] = useState(quantidadeInicial)
  const [dados, setDados] = useState<DadosPessoais>(DADOS_VAZIOS)
  const [endereco, setEndereco] = useState<Endereco>(ENDERECO_VAZIO)
  /**
   * Comeca preenchido quando a pessoa chegou por um link de campanha
   * (`?cupom=CODIGO`). O campo continua EDITAVEL: quem trocar de ideia, ou
   * tiver outro codigo, digita por cima — o link e conveniencia, nao trava.
   *
   * VALE REPETIR PORQUE E DINHEIRO: isto preenche um CAMPO DE TEXTO, nao
   * concede desconto. O valor continua sendo decidido no servidor, que
   * resgata o cupom sob trava de linha dentro da transacao do pedido
   * (src/repositories/cupons.ts). Uma URL com `?cupom=QUALQUERCOISA` nao
   * desconta nada se o codigo nao existir, tiver expirado ou ja ter estourado
   * o limite — cai no mesmo 422 de quem digitou errado.
   */
  const [cupom, setCupom] = useState(cupomInicial)

  /**
   * O RESULTADO DA PREVIA, e o CODIGO EXATO que o produziu.
   *
   * Guardar o codigo junto nao e redundancia — e o que impede o pior defeito
   * possivel desta tela: validar PRE200, ver "-R$ 200,00", editar o campo para
   * PRE300 e o desconto continuar na tela, agora descrevendo um cupom que
   * ninguem verificou. Com o codigo dentro do proprio estado, a previa so vale
   * enquanto o campo bater com ele; qualquer letra digitada a invalida sozinha,
   * sem depender de alguem lembrar de chamar um `limpar()`.
   */
  const [previaCupom, setPreviaCupom] = useState<PreviaDeCupom | null>(null)
  const [validandoCupom, setValidandoCupom] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  // DOIS ESTADOS PARA DUAS PERGUNTAS, e nao um so tentando responder as duas.
  //
  // `modalidade` e "receber ou buscar"; `idServicoEscolhido` e "por qual
  // transportadora", que so faz sentido dentro de "receber". A primeira versao
  // desta tela juntou as duas num `chaveEscolhida: string | null` unico, e foi
  // exatamente essa juncao que produziu o beco sem saida descrito no comentario
  // do radiogroup de modalidade la embaixo.
  //
  // `modalidade` comeca NULL de proposito: nenhuma das duas vem pre-selecionada.
  // A retirada, que e a primeira e a mais barata, viraria a escolha de quem so
  // clicou em Continuar sem ler — e essa pessoa descobriria que tem de ir a
  // Goiania depois de pagar.
  const [modalidade, setModalidade] = useState<Modalidade | null>(null)
  const [opcoesFrete, setOpcoesFrete] = useState<OpcaoDeFreteNaTela[]>([])
  const [idServicoEscolhido, setIdServicoEscolhido] = useState<number | null>(null)
  const [cotandoFrete, setCotandoFrete] = useState(false)
  const [erroFrete, setErroFrete] = useState<string | null>(null)
  // Contador de "tentar de novo". Nao guarda informacao nenhuma: existe so para
  // entrar nas dependencias do efeito de cotacao e refaze-la sem que o
  // comprador precise reescrever o CEP para forcar a mudanca.
  const [tentativaDeFrete, setTentativaDeFrete] = useState(0)

  const cepCompleto = CEP_COMPLETO.test(endereco.cep) ? endereco.cep : ''

  const vaiRetirar = modalidade === 'retirada'
  const vaiEnviar = modalidade === 'envio'

  /**
   * A opcao de frete escolhida, DERIVADA da lista — nunca uma segunda copia do
   * objeto guardada em estado, que divergiria da lista na primeira recotacao.
   *
   * `null` quando a modalidade e retirada: nao ha servico de transportadora
   * envolvido, e e por isso que quem le esta variavel tem que olhar
   * `modalidade` antes de concluir qualquer coisa a partir do null.
   */
  const opcaoDeFrete = vaiEnviar
    ? opcoesFrete.find((o) => o.idServico === idServicoEscolhido) ?? null
    : null

  /**
   * A ENTREGA ESTA RESOLVIDA? E a unica pergunta que o passo 3 precisa
   * responder para liberar o Continuar, e ela tem duas respostas certas:
   * retirada nao pede mais nada, e envio pede endereco completo mais uma opcao
   * cotada. Escrever as duas condicoes soltas no `disabled` do botao faria a
   * regra existir em dois lugares — o botao e a guarda do submit.
   */
  const entregaResolvida = vaiRetirar
    || (vaiEnviar && enderecoValido(endereco) && opcaoDeFrete !== null)

  const cupomLimpo = cupom.trim()

  /**
   * A previa so conta se ela for sobre a PERGUNTA que esta na tela agora — o
   * mesmo codigo, o mesmo kit e a mesma quantidade.
   *
   * COMPARAR AQUI, e nao limpar o estado em cada `onChange`, e deliberado: sao
   * duas formas de acertar o mesmo caso, e esta nao tem como ser esquecida. O
   * `onChange` do campo cobriria a digitacao, mas nao o botao de quantidade do
   * passo 1, nem um `?cupom=` novo, nem colar, nem o autofill do navegador —
   * cada um desses precisaria lembrar de chamar um `limpar()`. A comparacao
   * vale para todos de graca, inclusive para os que ainda nao existem.
   *
   * A quantidade importa porque o desconto DEPENDE dela: um cupom percentual
   * validado sobre tres kits nao descreve mais nada depois que a pessoa volta e
   * compra um. O kit tambem entra, para o dia em que a loja tiver mais de um.
   */
  const previa = previaCupom
    && previaCupom.codigo === cupomLimpo
    && previaCupom.kitSlug === kit.slug
    && previaCupom.quantidade === quantidade
    ? previaCupom
    : null
  const descontoPrevisto = previa?.valido ? previa.descontoCentavos : deInteiro(0)

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
    // So a SUB-ESCOLHA e descartada: quando o CEP ou a quantidade mudam, o
    // volume e o destino mudaram e o preco cotado antes deixou de valer. A
    // MODALIDADE nao se toca — ela nao depende de cotacao nenhuma, e limpa-la
    // aqui faria a escolha da compradora sumir sozinha porque ela corrigiu um
    // digito do CEP.
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
    // O DESCONTO DA PREVIA entra no resumo, e so ele: um cupom digitado e nao
    // validado continua valendo zero aqui. O numero que a tela mostra e sempre
    // um que o servidor confirmou — nunca um que o navegador calculou a partir
    // de um codigo que ninguem conferiu.
    descontoPrevisto,
    opcaoDeFrete ? opcaoDeFrete.valor : deInteiro(0),
  )

  /**
   * POR QUE A TELA NAO DEIXA CONFIRMAR, quando nao deixa.
   *
   * Sao dois casos, e nos dois a tela JA SABE que POST /api/pedidos vai
   * recusar. Deixar o botao ativo mandaria a pessoa esperar a viagem de rede
   * para receber um 422 que podia ter sido dito na hora — e, no primeiro caso,
   * com o agravante de o erro aparecer longe do campo que o causou.
   *
   *   1. O SERVIDOR JA RECUSOU ESTE CUPOM. Mandar mesmo assim derruba o pedido
   *      INTEIRO (`cupom_recusado`, src/app/api/pedidos/route.ts), e nao apenas
   *      o desconto: quem so queria comprar sem desconto perderia o clique.
   *      A saida esta escrita ao lado do campo — apagar o codigo.
   *   2. O TOTAL FICOU ZERO. Cupom que cobre o subtotal inteiro mais retirada
   *      (frete zero) fecha em R$ 0,00, e nao ha como cobrar isso: a rota
   *      recusa com `pedido_sem_valor`. A tela diz o que fazer em vez de deixar
   *      a pessoa descobrir depois.
   *
   * `motivoParaNaoConfirmar` devolve a FRASE, e nao um booleano, porque o botao
   * e a explicacao tem que sair do mesmo lugar: um `disabled` sem texto ao lado
   * e a forma mais rapida de alguem achar que a loja quebrou.
   */
  const motivoParaNaoConfirmar = (() => {
    if (previa && !previa.valido) {
      return 'Este cupom não foi aceito. Apague o código para seguir sem o desconto.'
    }
    if (resumo.total <= 0) {
      return 'Com este cupom o total fica em R$ 0,00 e não há como concluir a compra. '
        + 'Escolha o envio, para que reste o frete, ou fale com a gente.'
    }
    return null
  })()

  async function validarCupom() {
    const pergunta: PerguntaDoCupom = {
      codigo: cupomLimpo, kitSlug: kit.slug, quantidade,
    }
    setValidandoCupom(true)
    try {
      const resposta = await fetch('/api/cupons/validar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pergunta),
      })

      const corpo = await resposta.json().catch(() => null) as
        { valido?: boolean; descontoCentavos?: number; mensagem?: string } | null

      if (!resposta.ok || typeof corpo?.valido !== 'boolean') {
        setPreviaCupom({
          ...pergunta, valido: false,
          mensagem: corpo?.mensagem
            ?? 'Não foi possível validar o cupom agora. Tente de novo em instantes.',
        })
        return
      }

      setPreviaCupom(corpo.valido && typeof corpo.descontoCentavos === 'number'
        // deInteiro() e nao um cast: e o construtor de Centavos que recusa
        // fracionario. Um desconto quebrado vindo de uma resposta corrompida
        // estoura aqui, e nao la na frente formatando R$ NaN no total.
        ? { ...pergunta, valido: true, descontoCentavos: deInteiro(corpo.descontoCentavos) }
        : { ...pergunta, valido: false, mensagem: corpo.mensagem ?? 'Cupom não aplicado.' })
    } catch {
      setPreviaCupom({
        ...pergunta, valido: false,
        mensagem: 'Não conseguimos validar o cupom. Verifique sua conexão e tente de novo.',
      })
    } finally {
      setValidandoCupom(false)
    }
  }

  async function confirmar() {
    // Guarda de ultimo metro: sem forma de entrega escolhida nao existe pedido
    // a criar. O botao ja vem desabilitado neste estado — esta linha existe
    // para que NENHUM caminho futuro (um atalho de teclado, um passo novo, um
    // estado restaurado) consiga postar um pedido sem entrega definida.
    if (!entregaResolvida) return

    setEnviando(true)
    setErro(null)
    try {
      const resposta = await fetch('/api/pedidos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kitSlug: kit.slug,
          quantidade,
          // A MODALIDADE, e o que ela exige — nada alem disso.
          //
          // SO O ID DA OPCAO no envio, jamais o valor dela. A rota recota o
          // frete no servidor a partir do CEP submetido e usa o valor que o
          // provedor devolver naquele instante — se a tabela da transportadora
          // mudou entre a tela e este clique, quem manda e a cotacao nova.
          // Mandar `valorCentavos` junto seria oferecer ao navegador a chance
          // de escolher quanto custa o frete; o `.strict()` de
          // src/app/api/pedidos/route.ts responderia 422, mas a garantia de
          // verdade e esta linha nao existir.
          //
          // NA RETIRADA NAO VAI ID NEM ENDERECO, e a ausencia e deliberada:
          // CorpoRetirada tambem e `.strict()`, entao mandar `idServico` ou
          // `cep` numa retirada e 422. Espalhar `...endereco` aqui "porque nao
          // custa" faria justamente esse 422 acontecer para todo mundo — e, se
          // um dia o schema afrouxasse, gravaria um endereco de entrega num
          // pedido que ninguem vai entregar.
          ...(vaiRetirar || !opcaoDeFrete
            ? { tipoEntrega: 'retirada' as const }
            : { tipoEntrega: 'envio' as const, idServico: opcaoDeFrete.idServico, ...endereco }),
          ...(cupom.trim() ? { cupom: cupom.trim() } : {}),
          ...dados,
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

              `retirada` NAO e fixo em false: quem escolheu retirar e voltou ao
              passo 1 para somar um kit leria aqui "calculado a partir do seu
              CEP" sobre uma compra que ja decidiu nao ter frete nenhum.
            */}
            <LinhaFrete valor={null} retirada={vaiRetirar} />
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
          <h2>Entrega</h2>

          {/*
            DUAS MODALIDADES, SEMPRE AS DUAS NA TELA — e este radiogroup nao
            depende de cotacao nenhuma.

            A primeira versao desta tela (19/08/2026) listava a retirada junto
            com as opcoes de transportadora, num radiogroup so. Sem CEP nao ha
            cotacao, entao a retirada aparecia SOZINHA: quem clicasse nela — a
            unica linha da lista, exatamente o que a tela convidava a fazer — e
            depois lesse o endereco e desistisse ficava PRESO. Radio nativo nao
            desmarca com um segundo clique, o campo de CEP tinha sido desmontado
            junto com o resto do endereco, e nao havia outra opcao no grupo para
            escolher no lugar. A unica saida era recarregar a pagina e perder
            nome, e-mail, CPF e WhatsApp.

            A MODALIDADE E A SUB-ESCOLHA SAO PERGUNTAS DIFERENTES, e agora sao
            dois grupos diferentes: aqui se decide "receber ou buscar", e so
            dentro de "receber" e que se escolhe transportadora. Trocar de ideia
            e sempre um clique, em qualquer ordem, com ou sem CEP digitado.
          */}
          <div className="frete-opcoes" role="radiogroup" aria-label="Como você quer receber">
            {MODALIDADES.map((m) => (
              <label
                key={m.chave}
                htmlFor={`modalidade-${m.chave}`}
                className={`frete-opcao${modalidade === m.chave ? ' frete-opcao--escolhida' : ''}`}
              >
                <input
                  id={`modalidade-${m.chave}`}
                  type="radio"
                  name="modalidade-de-entrega"
                  value={m.chave}
                  checked={modalidade === m.chave}
                  onChange={() => setModalidade(m.chave)}
                />
                <span className="frete-opcao__nome">
                  {m.nome}
                  <span className="frete-opcao__prazo">{m.apoio}</span>
                </span>
                {/*
                  So a retirada anuncia preco AQUI: o dela e conhecido e e zero.
                  O do envio depende do CEP e da transportadora, e escrever
                  qualquer coisa nesta coluna antes de cotar seria a promessa que
                  src/components/linha-frete.tsx existe para impedir.
                */}
                {m.chave === 'retirada' && (
                  <span className="frete-opcao__valor">{formatarBRL(FRETE_RETIRADA)}</span>
                )}
              </label>
            ))}
          </div>

          {/*
            ONDE RETIRAR, ali mesmo na hora de decidir — e nao so na confirmacao.
            Descobrir depois de comprar que o ponto fica do outro lado da cidade
            e o arrependimento que vira pedido de reembolso.
          */}
          {vaiRetirar && (
            <div className="aviso" data-testid="endereco-retirada">
              <strong className="aviso__titulo">Onde retirar</strong>
              <p>{enderecoRetiradaEmLinha()}</p>
              {/*
                O aviso de pre-venda SOME depois de 25/08, cumprindo o contrato
                escrito na propria constante (src/lib/retirada.ts). `lancado` vem
                do servidor por prop: decidir a data aqui dentro faria o HTML do
                SSR e o da hidratacao discordarem na virada do dia.
              */}
              {!lancado && <p>{AVISO_RETIRADA_PRE_VENDA}</p>}
            </div>
          )}

          {/*
            TUDO O QUE SO EXISTE NO ENVIO mora dentro deste ramo: o endereco, a
            cotacao, o estado vazio e o alerta de falha. Fora dele, cada um
            desses blocos ja apareceu na tela de quem escolheu retirada dizendo
            coisa falsa — "informe o CEP abaixo" sem nenhum campo abaixo, e "nao
            e possivel concluir o pedido agora" ao lado de um Continuar
            habilitado.
          */}
          {vaiEnviar && (
            <>
              <h3 className="eyebrow">Endereço de entrega</h3>

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

              {/* role="status": chegou sozinho, sem clique, e nao e urgente. */}
              {cotandoFrete && (
                <p className="form__status" role="status">Calculando o frete para o seu CEP…</p>
              )}

              {/*
                ESTADO VAZIO HONESTO: enquanto nao ha CEP nao ha o que cotar, e a
                tela diz isso em vez de mostrar lista vazia ou — pior — uma opcao
                "Padrão" com valor inventado.
              */}
              {!cotandoFrete && !cepCompleto && !erroFrete && (
                <p className="form__status">
                  Informe o CEP acima para calcular o frete e o prazo de entrega.
                </p>
              )}

              {/*
                role="alert" e nao role="status" porque este erro BLOQUEIA o
                envio: sem cotacao o "Continuar" fica desabilitado e o comprador
                precisa saber disso agora, nao quando terminar de ler a tela.

                A FRASE FALA DO ENVIO, E NAO DO PEDIDO INTEIRO. Ate 19/08/2026
                dizia "nao e possivel concluir o pedido agora", o que era exato
                quando a unica forma de receber dependia do Clube Envios. Com a
                retirada, uma queda do provedor deixou de fechar a loja — e
                manter a frase antiga mandaria embora quem ia buscar o kit a pe.
              */}
              {erroFrete && (
                <div className="aviso aviso--erro" role="alert">
                  <strong className="aviso__titulo">Frete não calculado</strong>
                  <p>{erroFrete}</p>
                  <p>{FRETE_BLOQUEIA_O_ENVIO}</p>
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
                          {/*
                            TRANSPORTADORA E SERVICO JUNTOS, porque nenhum dos
                            dois identifica a opcao sozinho: a cotacao real traz
                            "CLUBE ENVIOS - Correios" para PAC e para SEDEX.
                            Rotulo neutro quando os dois vem vazios — um radio
                            sem nome fica clicavel mas ilegivel.
                          */}
                          {rotuloDaOpcao(o)}
                          <span className="frete-opcao__prazo">{textoDePrazo(o.prazoDias)}</span>
                        </span>
                        <span className="frete-opcao__valor">{formatarBRL(o.valor)}</span>
                      </label>
                    )
                  })}
                </div>
              )}
            </>
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
              disabled={!entregaResolvida}
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
              O DESCONTO SO APARECE DEPOIS DE O SERVIDOR CONFIRMAR — e quem
              confirma e POST /api/cupons/validar, que roda exatamente as mesmas
              regras do resgate (`validarCupom`, src/repositories/cupons.ts).
              Um valor calculado no navegador a partir de um codigo digitado
              seria um desconto inventado; este veio de quem manda.

              A linha some junto com a previa: editar o campo do cupom invalida
              a resposta anterior (ver `previa`, la em cima), e o total volta ao
              valor cheio no mesmo instante.
            */}
            {previa?.valido && (
              <p className="vitrine__linha" data-testid="desconto">
                {/*
                  `resumo.desconto`, e nao `previa.descontoCentavos`: e o valor
                  EFETIVAMENTE aplicado no total logo abaixo. Os dois so diferem
                  num caso, e e justamente o que faria as duas linhas do mesmo
                  bloco discordarem — um cupom fixo maior que o subtotal, que
                  montarCarrinho limita ao subtotal (src/lib/carrinho.ts). Ali o
                  valor bruto imprimiria "−R$ 1.500,00" acima de um total que so
                  abateu R$ 1.000,00.
                */}
                Cupom {previa.codigo}: −{formatarBRL(resumo.desconto)}
              </p>
            )}
            {/*
              Agora com VALOR REAL e PRAZO — a opcao que o comprador escolheu no
              passo 3. `?? null` nao e formalidade: se por qualquer caminho a
              escolha se perder, a linha volta a dizer "a cotar" em vez de
              imprimir R$ 0,00, e o botao de pagamento abaixo fica desabilitado.
            */}
            <LinhaFrete
              retirada={vaiRetirar}
              valor={opcaoDeFrete?.valor ?? null}
              prazoDias={opcaoDeFrete?.prazoDias ?? null}
            />
            {/*
              A RESSALVA MUDOU DE SIGNIFICADO, e por isso mudou de texto.

              Antes ela dizia "(antes do cupom, verificado na confirmação)" —
              exata enquanto o total ignorava o cupom digitado. Agora ha tres
              estados diferentes e cada um merece a sua frase:

                - cupom digitado e NAO validado: o total ainda nao considera
                  nada, e a tela diz para apertar o botao;
                - cupom validado: o desconto ja esta no numero, e a ressalva
                  restante e outra — a previa nao reserva nada, e o cupom pode
                  esgotar entre este segundo e a confirmacao;
                - sem cupom: nenhuma ressalva, porque nao ha nada pendente.

              Manter a frase antiga no segundo caso seria pior que antes: diria
              "antes do cupom" embaixo de um total que ja o inclui.
            */}
            <p className="vitrine__linha vitrine__linha--total" data-testid="total">
              Total: {formatarBRL(resumo.total)}
              {cupomLimpo !== '' && !previa && ' (sem o cupom — valide para ver o desconto)'}
              {previa?.valido && ' (confirmado no pagamento)'}
            </p>
          </div>

          <div className="form__field">
            <label htmlFor="cupom">Cupom de desconto (opcional)</label>
            <div className="cupom-campo">
              <input
                id="cupom" value={cupom}
                maxLength={TAMANHO_MAXIMO_CUPOM}
                autoCapitalize="characters"
                onChange={(e) => setCupom(e.target.value.toUpperCase())}
                /*
                  Enter no campo VALIDA, e nao envia o pedido. Sem isto, quem
                  digita o codigo e aperta Enter — o reflexo de qualquer
                  formulario — dispararia a criacao do pedido com um cupom que
                  nunca foi conferido, que e o oposto do que este campo agora
                  oferece.
                */
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (cupomLimpo.length >= 3 && !validandoCupom) void validarCupom()
                  }
                }}
              />
              {/*
                Desabilitado abaixo de 3 caracteres porque e o minimo que o
                banco aceita (CHECK cupom_codigo_formato): pedir ao servidor uma
                resposta que ele ja sabe ser "não existe" so gasta a cota de
                validacoes de quem esta digitando.
              */}
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void validarCupom()}
                disabled={cupomLimpo.length < 3 || validandoCupom}
              >
                {validandoCupom ? 'Validando…' : 'Validar cupom'}
              </button>
            </div>

            {/*
              role="status" e nao "alert": a resposta aparece logo abaixo do
              botao que a pessoa acabou de apertar, e ela ja esta olhando para
              ca. O leitor de tela anuncia sem interromper ninguem no meio de
              uma leitura.

              A MENSAGEM DE RECUSA E A MESMA que o checkout mostraria na
              confirmacao (mensagemDeRecusa, src/lib/cupom.ts): duas frases
              diferentes para a mesma recusa fariam o comprador achar que sao
              dois problemas.
            */}
            {previa && (
              <p
                className={`form__status${previa.valido ? '' : ' form__status--error'}`}
                role="status"
                data-testid="resposta-cupom"
              >
                {previa.valido
                  ? `Cupom aplicado: −${formatarBRL(previa.descontoCentavos)}.`
                  : previa.mensagem}
              </p>
            )}
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

          {/*
            O impedimento aparece ACIMA do botao que ele desabilita, e nao
            embaixo: quem chega aqui esta descendo a tela em direcao ao botao, e
            um aviso depois dele so e lido por quem ja tentou clicar.
          */}
          {motivoParaNaoConfirmar && (
            <p className="form__status form__status--error" role="status" data-testid="impedimento">
              {motivoParaNaoConfirmar}
            </p>
          )}

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
              disabled={enviando || !entregaResolvida || motivoParaNaoConfirmar !== null}
            >
              {enviando ? 'Enviando...' : 'Ir para o pagamento'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
