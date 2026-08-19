/**
 * RETIRADA NO LOCAL — o endereco, o prazo e as frases, num lugar so.
 *
 * Pedido da cliente em 19/08/2026: alem das opcoes do Clube Envios, quem
 * preferir busca o kit e nao paga frete.
 *
 * POR QUE MODULO UNICO, e nao a mesma frase digitada em cada tela: este
 * endereco vai aparecer no passo de entrega, na revisao, na pagina do pedido,
 * no e-mail de confirmacao e no painel de quem entrega o kit. Sao cinco
 * lugares onde a pessoa pode ler o numero da quadra; se um deles divergir,
 * alguem vai bater numa porta errada num sabado. E a mesma disciplina de
 * src/components/linha-frete.tsx, src/lib/escassez.ts e src/lib/anvisa.ts.
 *
 * CONSTANTE NOMEADA, NAO variavel de ambiente — a mesma decisao ja registrada
 * para DATA_LANCAMENTO em src/lib/tempo.ts. Mudar o ponto de retirada exige
 * alterar esta linha e passar por deploy e revisao; pelo painel do servidor, um
 * digito trocado mandaria compradores para o endereco errado sem ninguem ver.
 *
 * NAO CONFUNDIR COM CEP_ORIGEM_EXPEDICAO (src/lib/frete.ts). Os dois descrevem
 * hoje o mesmo lugar, mas respondem perguntas diferentes: aquele e de onde o
 * pacote PARTE para a transportadora cotar o frete, e pode mudar no dia em que
 * a operacao passar a postar de outro ponto; este e para onde a COMPRADORA vai.
 * Derivar um do outro amarraria as duas coisas e faria uma mudanca de
 * expedicao reescrever, calada, o endereco impresso no e-mail de quem ja
 * comprou.
 */

import { DATA_LANCAMENTO } from '@/lib/tempo'
import { deInteiro, type Centavos } from '@/lib/money'

/**
 * Prazo, em dias corridos, para buscar o kit — contado da DISPONIBILIDADE, que
 * nem sempre e o pagamento. Ver disponivelParaRetiradaEm() no fim do arquivo.
 */
export const PRAZO_RETIRADA_DIAS = 7

/**
 * O frete de uma retirada, em centavos: zero, e com dono.
 *
 * NAO E O MESMO ZERO que `pedidos.frete_centavos` guardava ate 16/08/2026,
 * quando significava "politica de frete ainda nao decidida" — aquele era
 * ausencia de resposta. Este e uma AFIRMACAO: nao ha transporte a cobrar
 * porque nao ha transporte. A diferenca esta gravada no banco, onde a coluna
 * tipo_entrega diz qual dos dois mundos e este, e a CHECK
 * pedido_retirada_sem_frete garante que os dois andam juntos.
 *
 * Constante, e nao `deInteiro(0)` digitado em cada chamador, pelo mesmo motivo
 * de FRETE_PRESENCIAL em src/app/api/vendas-presenciais/route.ts: zero
 * anonimo espalhado pelo codigo e indistinguivel de zero por engano.
 */
export const FRETE_RETIRADA: Centavos = deInteiro(0)

export const ENDERECO_RETIRADA = {
  logradouro: 'Rua ACP 23, Quadra 29, Nº 49',
  complemento: 'Residencial Antônio Carlos Pires',
  cidade: 'Goiânia',
  estado: 'GO',
  cep: '74693158',
} as const

/**
 * O CEP com mascara, para LER — nunca para calcular. Toda comparacao e toda
 * chamada de API usam `ENDERECO_RETIRADA.cep`, que e so digito, do mesmo jeito
 * que `EnderecoDoCep` normaliza em src/lib/cep.ts.
 */
export function cepFormatado(cep: string = ENDERECO_RETIRADA.cep): string {
  return `${cep.slice(0, 5)}-${cep.slice(5)}`
}

/**
 * O endereco em uma linha, para caber ao lado de um radio ou dentro de um
 * e-mail em texto puro.
 */
export function enderecoRetiradaEmLinha(): string {
  const e = ENDERECO_RETIRADA
  return `${e.logradouro} — ${e.complemento}, ${e.cidade}/${e.estado}, CEP ${cepFormatado()}`
}

/**
 * O rotulo da opcao no passo de entrega, no mesmo formato das opcoes de frete
 * de verdade ("CLUBE ENVIOS - Correios · SEDEX") para que as linhas fiquem
 * comparaveis de relance.
 */
export const ROTULO_RETIRADA = 'Retirada no local · Goiânia/GO'

/**
 * O texto do prazo. Nao diz "entrega em 7 dias": nao ha entrega, e o numero
 * significa o CONTRARIO do prazo de uma transportadora — ali e quanto tempo
 * ELES levam para trazer, aqui e quanto tempo VOCE tem para buscar. Confundir
 * os dois faz alguem aparecer no oitavo dia achando que estava adiantado.
 */
export const TEXTO_PRAZO_RETIRADA =
  `Sem frete — retire em até ${PRAZO_RETIRADA_DIAS} dias`

/** Frase de uma linha para quem escolheu retirada, com endereco e prazo. */
export function instrucaoDeRetirada(): string {
  return `Retire o seu kit em ${enderecoRetiradaEmLinha()}. `
    + `Você tem ${PRAZO_RETIRADA_DIAS} dias a partir do momento em que ele fica disponível.`
}

/**
 * Quando o kit fica DISPONIVEL para ser buscado, e ate quando ha prazo.
 *
 * O ERRO QUE ESTAS DUAS FUNCOES EXISTEM PARA NAO COMETER: contar os 7 dias a
 * partir do pagamento. Ate 25/08/2026 a loja vende em PRE-VENDA — o pedido e
 * pago na hora e a entrega e que espera o lancamento, e e isso que AVISO_PRE_VENDA
 * promete por escrito (src/lib/tempo.ts). Uma compra paga hoje, 19/08, com o
 * prazo contado do pagamento, mandaria a compradora buscar o kit ate 26/08 —
 * mas parte dessa janela e ANTERIOR ao dia em que existe kit para entregar. Ela
 * apareceria no dia 21 na frente de uma porta sem nada atras.
 *
 * Por isso a contagem comeca no MAIS TARDE entre o pagamento e o lancamento. Do
 * dia 25 em diante os dois calculos coincidem e esta funcao vira identidade —
 * o que e o objetivo: a regra especial desaparece sozinha quando deixa de ser
 * necessaria, sem ninguem lembrar de remove-la.
 */
export function disponivelParaRetiradaEm(pagoEm: Date): Date {
  return pagoEm.getTime() >= DATA_LANCAMENTO.getTime() ? pagoEm : DATA_LANCAMENTO
}

export function retirarAte(pagoEm: Date): Date {
  const inicio = disponivelParaRetiradaEm(pagoEm)
  // Dias CORRIDOS, e nao uteis: o prazo e uma janela de cortesia para o
  // comprador, nao uma estimativa de transporte. Contar em dias uteis faria a
  // data impressa depender de feriado municipal, que ninguem consegue conferir
  // olhando a tela. Somar pelo calendario (setDate) e nao por milissegundos
  // mantem a hora do dia estavel se o horario de verao algum dia voltar.
  const limite = new Date(inicio.getTime())
  limite.setDate(limite.getDate() + PRAZO_RETIRADA_DIAS)
  return limite
}

/**
 * O que a tela diz a quem escolhe retirada ANTES do lancamento.
 *
 * Espelha AVISO_PRE_VENDA (src/lib/tempo.ts), que promete envio "apos o
 * lancamento oficial": a promessa para quem busca tem que ser a mesma, no
 * verbo certo. Sem esta frase, a compradora que paga hoje leria "retire em ate
 * 7 dias" e apareceria no dia 21 na frente de uma porta sem kit atras — o
 * mesmo defeito que retirarAte() corrige na conta, dito aqui em palavras.
 *
 * A frase SOME sozinha depois do lancamento (quem a exibe checa
 * lancamentoJaOcorreu), pelo mesmo motivo de disponivelParaRetiradaEm virar
 * identidade: regra temporaria que precisa de alguem para lembrar de remove-la
 * e regra que fica errada para sempre.
 */
export const AVISO_RETIRADA_PRE_VENDA =
  'Os kits ficam disponíveis para retirada a partir do lançamento oficial da Milagran, em 25/08/2026.'
