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
