/**
 * Rate limit por IP — um unico mecanismo para os endpoints publicos.
 *
 * O QUE ISTO E: um freio contra abuso ingenuo. Um script que dispara o mesmo
 * POST em loop bate no teto e para de escrever no banco.
 *
 * O QUE ISTO NAO E: rate limiting distribuido. O contador vive na MEMORIA DO
 * PROCESSO. Com uma replica unica no Swarm ele cobre todo o trafego de
 * verdade; se um dia `replicas` passar de 1, vira aproximacao — cada replica
 * conta o seu pedaco e o limite efetivo vira N x teto por janela. Nesse dia o
 * certo e mover o contador para Redis (a stack `evolution` da VPS ja tem um),
 * nao aumentar o teto. Tambem nao e controle de acesso: o IP vem de um header
 * que o cliente pode forjar (ver ipDoPedido) e um atacante com muitos IPs
 * passa por cima. Nada aqui substitui as validacoes e constraints que
 * realmente protegem os dados.
 *
 * Historico: isto nasceu dentro de src/lib/candidatura.ts, para o formulario
 * de representante. O checkout (POST /api/pedidos) precisa do mesmo freio —
 * e escreve dado bem mais sensivel — entao o mecanismo virou este modulo
 * compartilhado em vez de uma segunda copia que fosse divergir com o tempo.
 */

/** Janela unica dos dois endpoints. */
export const JANELA_RATE_LIMIT_MS = 10 * 60 * 1000

/** Formulario de candidatura de representante (comportamento historico). */
export const MAX_CANDIDATURAS_POR_JANELA = 5

/**
 * Checkout. Mais folgado que o formulario de candidatura de proposito: uma
 * unica saida de operadora movel (CGNAT) coloca muitos compradores reais
 * atras do mesmo IP, e recusar uma compra legitima custa mais do que aceitar
 * mais uma tentativa de abuso. Dez pedidos em dez minutos do mesmo IP ja e
 * muito acima de qualquer padrao de compra humano no volume desta loja.
 */
export const MAX_PEDIDOS_POR_JANELA = 10

/**
 * Login (POST /api/sessao). MAIS APERTADO que o checkout de proposito: e a
 * unica rota do sistema em que forca bruta de SENHA e possivel. Nas outras, o
 * pior que um loop consegue e encher o banco de lixo ou de dado pessoal de
 * terceiros; aqui o premio de acertar e uma sessao de administrador, com
 * acesso a §17 inteiro (nome, e-mail, whatsapp e historico de compra de todo
 * mundo). Teto menor troca um pouco de conveniencia por um custo maior de
 * tentativa, na unica porta onde adivinhar leva a algum lugar.
 *
 * POR QUE 8 E NAO 3. O contador soma TENTATIVAS, e o login que da certo
 * tambem gasta orcamento. No dia 25/08 os vendedores entram todos na mesma
 * hora, do mesmo WiFi do local (ou do mesmo CGNAT da operadora), o que
 * significa UM IP para o balcao inteiro: com teto 3, o quarto vendedor a
 * digitar a senha certa leva 429 e fica sem conseguir trabalhar. Oito cobre
 * cerca de quatro pessoas entrando com um erro de digitacao cada uma na mesma
 * janela de 10 minutos, e ainda assim e menos da metade do teto do checkout.
 *
 * O QUE ESTE NUMERO NAO E: a defesa contra forca bruta. Quem defende de
 * verdade e o scrypt de src/lib/senha.ts (custo por tentativa) somado a uma
 * senha boa — e vale aqui, na integra, a limitacao do cabecalho deste arquivo:
 * o contador e EM MEMORIA, POR PROCESSO, entao ele zera quando o container
 * reinicia e um atacante com muitos IPs passa por cima dele. Baixar este
 * numero nao compensa uma senha fraca; o que compensa e a senha.
 */
export const MAX_LOGINS_POR_JANELA = 8

/**
 * Cotacao de frete (POST /api/frete). O unico teto deste arquivo que NAO
 * protege o banco: protege a CONTA DA MILAGRAN no Clube Envios. Cada requisicao
 * que chega ate `cotarFrete` (src/lib/frete.ts) gasta uma chamada paga no
 * provedor, entao aqui o abuso nao enche tabela de lixo — ele consome cota, e o
 * sintoma no dia 25/08 apareceria como "frete indisponivel" para comprador
 * legitimo, que e o pior modo de falhar possivel.
 *
 * POR QUE 20, E NAO OS 10 DO CHECKOUT. Uma unica compra faz VARIAS cotacoes: o
 * comprador digita o CEP, corrige um digito, muda a quantidade, volta um passo
 * no wizard (src/components/checkout-wizard.tsx) — cada uma dessas acoes e uma
 * cotacao nova, porque o valor tem que refletir o CEP e a quantidade atuais.
 * Com o mesmo teto do checkout, o segundo comprador atras do WiFi do evento (ou
 * do CGNAT da operadora — sempre UM IP para muita gente, ver a pendencia
 * registrada em docs/superpowers/plans/2026-08-16-milagran-lancamento-25-08.md)
 * levaria 429 antes de conseguir ver quanto custa a entrega. Vinte cobre cerca
 * de cinco compradores com quatro cotacoes cada na mesma janela de 10 minutos.
 *
 * Nao e o dobro por acaso e nao substitui teto no provedor: se um dia a cota do
 * Clube Envios virar o gargalo de verdade, o lugar de resolver e um cache de
 * cotacao por (CEP, kit, quantidade) — nao baixar este numero ate machucar
 * comprador.
 */
export const MAX_COTACOES_POR_JANELA = 20

/**
 * Quantas validacoes de cupom um IP pode pedir por janela.
 *
 * MAIS BAIXO QUE A COTACAO (20) de proposito, e por um motivo que a cotacao nao
 * tem: POST /api/cupons/validar responde, para qualquer visitante, SE UM CODIGO
 * EXISTE. Sem teto ela vira um oraculo de forca bruta sobre um espaco pequeno —
 * codigos reais sao curtos e memoraveis (PRE200, LANCAMENTO), porque tem que
 * caber num story de Instagram. Descobrir um cupom ativo assim nao quebra nada
 * tecnicamente; so da a um estranho o desconto que a Milagran deu a uma
 * campanha especifica.
 *
 * MAIS ALTO QUE O CHECKOUT (10) tambem de proposito: validar e uma acao de
 * TENTATIVA — a pessoa digita errado, corrige, testa o cupom da amiga — e o teto
 * precisa caber nisso sem esbarrar em quem so quer conferir um codigo. Doze
 * cobre um comprador indeciso com folga, e o CGNAT da operadora (sempre UM IP
 * para muita gente) continua sendo o caso que aperta primeiro.
 */
export const MAX_VALIDACOES_DE_CUPOM_POR_JANELA = 12

type Entrada = { inicioJanela: number; total: number }

/**
 * Cria um contador INDEPENDENTE. Cada endpoint chama esta funcao uma vez e
 * fica com o seu proprio Map: um teto atingido no checkout nao pode consumir
 * o orcamento do formulario de candidatura, nem o contrario.
 */
export function criarLimitadorPorIp(
  { janelaMs, maxPorJanela }: { janelaMs: number; maxPorJanela: number },
): (ip: string, agora?: number) => boolean {
  const contadorPorIp = new Map<string, Entrada>()

  /**
   * Sem esta poda o Map cresce para sempre: cada IP visto uma unica vez fica
   * residente ate o container reiniciar. Num processo de vida longa (o
   * container do Swarm roda por semanas, ao contrario de um Lambda) isso e um
   * vazamento de memoria lento contra o limite de 512M da stack.
   */
  function podarExpirados(agora: number): void {
    for (const [ip, entrada] of contadorPorIp) {
      if (agora - entrada.inicioJanela > janelaMs) contadorPorIp.delete(ip)
    }
  }

  return function excedeu(ip: string, agora: number = Date.now()): boolean {
    const entrada = contadorPorIp.get(ip)

    if (!entrada || agora - entrada.inicioJanela > janelaMs) {
      podarExpirados(agora)
      contadorPorIp.set(ip, { inicioJanela: agora, total: 1 })
      return false
    }

    entrada.total += 1
    return entrada.total > maxPorJanela
  }
}

/**
 * O IP real chega em X-Forwarded-For porque o Traefik esta na frente
 * (`passHostHeader=true` na stack). O primeiro elemento da lista e o
 * cliente; os seguintes sao os proxies. Um cliente pode forjar o header,
 * entao isto vale como freio para bot ingenuo, nao como controle de acesso.
 */
export function ipDoPedido(headers: Headers): string {
  const encaminhado = headers.get('x-forwarded-for')
  if (encaminhado) {
    const primeiro = encaminhado.split(',')[0].trim()
    if (primeiro) return primeiro
  }
  return headers.get('x-real-ip')?.trim() || 'desconhecido'
}
