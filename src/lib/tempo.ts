export const FUSO_BR = 'America/Sao_Paulo'

const partes = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_BR,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
})

type Civil = { ano: number; mes: number; dia: number; hora: number; minuto: number; segundo: number }

/** Converte um instante para a data/hora civil observada em Sao Paulo. */
function civilBR(instante: Date): Civil {
  const p = Object.fromEntries(
    partes.formatToParts(instante).map((x) => [x.type, x.value]),
  ) as Record<string, string>
  return {
    ano: Number(p.year), mes: Number(p.month), dia: Number(p.day),
    // 'en-CA' com hour12:false emite 24 para meia-noite; normalizar para 0.
    hora: Number(p.hour) % 24, minuto: Number(p.minute), segundo: Number(p.second),
  }
}

/**
 * Encontra o instante UTC correspondente a uma data/hora civil de Sao Paulo.
 *
 * EXPORTADA desde 19/08/2026, quando a tela de campanhas passou a converter a
 * data escolhida num `<input type="date">` para o instante de expiracao do
 * cupom. Aquela conversao tem exatamente o mesmo modo de falha que o comentario
 * de DATA_LANCAMENTO descreve — 'AAAA-MM-DD' lido como UTC vira 21h do dia
 * ANTERIOR em Sao Paulo —, e escrever `T03:00:00Z` a mao seria fixar um offset
 * que esta funcao existe para nao fixar.
 * Usa aproximacao sucessiva para resolver a ambiguidade causada por mudancas de horario de verao.
 * Quando a data/hora civil solicitada nao existe (na transicao de primavera),
 * retorna o primeiro instante valido depois da lacuna horaria.
 */
export function instanteDeCivilBR(ano: number, mes: number, dia: number, hora = 0, minuto = 0, segundo = 0, ms = 0): Date {
  let palpite = Date.UTC(ano, mes - 1, dia, hora, minuto, segundo, ms)
  let converged = false
  for (let i = 0; i < 3; i++) {
    const c = civilBR(new Date(palpite))
    const obtido = Date.UTC(c.ano, c.mes - 1, c.dia, c.hora, c.minuto, c.segundo, ms)
    const alvo = Date.UTC(ano, mes - 1, dia, hora, minuto, segundo, ms)
    if (obtido === alvo) {
      converged = true
      break
    }
    palpite += alvo - obtido
  }
  // When civil time does not exist (spring-forward gap), resolve forward to the first valid instant.
  if (!converged) {
    const c = civilBR(new Date(palpite))
    const obtido = Date.UTC(c.ano, c.mes - 1, c.dia, c.hora, c.minuto, c.segundo, ms)
    const alvo = Date.UTC(ano, mes - 1, dia, hora, minuto, segundo, ms)
    if (obtido < alvo) {
      palpite += alvo - obtido
    }
  }
  return new Date(palpite)
}

export function inicioDoDiaBR(referencia: Date): Date {
  const c = civilBR(referencia)
  return instanteDeCivilBR(c.ano, c.mes, c.dia)
}

export function inicioDoMesBR(referencia: Date): Date {
  const c = civilBR(referencia)
  return instanteDeCivilBR(c.ano, c.mes, 1)
}

/**
 * Retorna o ultimo instante do mes: um millisegundo antes da meia-noite BRT do dia 1 do proximo mes.
 * CUIDADO: este resultado eh valido apenas em precisao de millisegundos (JavaScript Date).
 * Para queries SQL em timestamptz (precisao de microsegundos), use a forma semi-aberta:
 * `>= inicioDoMesBR AND < instanteDeCivilBR(proximoAno, proximoMes, 1)`
 * em vez de `<= fimDoMesBR`.
 */
export function fimDoMesBR(referencia: Date): Date {
  const c = civilBR(referencia)
  const proximoMes = c.mes === 12 ? 1 : c.mes + 1
  const proximoAno = c.mes === 12 ? c.ano + 1 : c.ano
  return new Date(instanteDeCivilBR(proximoAno, proximoMes, 1).getTime() - 1)
}

export function mesmoMesBR(a: Date, b: Date): boolean {
  const ca = civilBR(a)
  const cb = civilBR(b)
  return ca.ano === cb.ano && ca.mes === cb.mes
}

/**
 * Instante do lancamento oficial da Milagran: 25/08/2026, 00:00 em
 * America/Sao_Paulo (§3 do documento do cliente de 16/08/2026).
 *
 * CONSTRUIDA COM instanteDeCivilBR, e nao com um literal de data. As duas
 * formas obvias erram:
 *   - `new Date('2026-08-25')` e lido como UTC pela especificacao de
 *     JavaScript, o que marcaria 24/08 as 21:00 no Brasil — tres horas em que
 *     a loja se declararia lancada na vespera do evento;
 *   - `new Date(2026, 7, 25)` depende do TZ do processo, que e UTC no
 *     container de producao (Dockerfile) e o que o runner tiver no CI.
 * instanteDeCivilBR resolve o offset realmente observado em Sao Paulo naquela
 * data (horario de verao incluso, se algum dia voltar) e e a MESMA funcao que
 * inicioDoDiaBR e inicioDoMesBR usam para fechar o mes de comissao: a virada
 * que a loja enxerga e a virada que o extrato do representante enxerga.
 *
 * CONSTANTE NOMEADA, NAO variavel de ambiente. E a mesma decisao ja registrada
 * para JANELA_ATRIBUICAO_DIAS em src/lib/atribuicao.ts: mudar a data exige
 * alterar esta linha e passar por deploy e revisao. Pelo ambiente, um digito
 * trocado no painel do servidor abriria a venda antes do evento — ou esconderia
 * a loja no dia dele — sem ninguem revisar nada.
 *
 * `const` congela a ligacao, nao o objeto: `Date` e mutavel e um
 * `DATA_LANCAMENTO.setDate(...)` em qualquer ponto do processo moveria o
 * lancamento para todo mundo. Ninguem deve mutar esta constante; quem precisa
 * de uma data derivada cria uma nova a partir de `.getTime()`.
 */
export const DATA_LANCAMENTO: Date = instanteDeCivilBR(2026, 8, 25)

/**
 * O lancamento ja ocorreu no instante dado? Sem argumento, usa o relogio.
 *
 * A comparacao e `>=`: a propria meia-noite de 25/08 ja conta como lancado —
 * o dia 25 inteiro e "depois do lancamento", e nao existe um milissegundo de
 * limbo em que a loja fica sem resposta definida.
 *
 * O parametro `agora` existe para que o chamador de servidor possa decidir uma
 * pagina inteira a partir de UM instante so (um Server Component que consulta
 * duas vezes nao pode obter respostas diferentes no meio da renderizacao) e
 * para que o teste congele o relogio — ver src/lib/__tests__/tempo.test.ts,
 * que usa vi.setSystemTime em vez de depender da data do runner. O default e
 * avaliado a cada chamada, entao ele tambem enxerga o relogio falso do teste.
 */
export function lancamentoJaOcorreu(agora: Date = new Date()): boolean {
  return agora.getTime() >= DATA_LANCAMENTO.getTime()
}

/**
 * §3: o que a loja diz ao comprador online ANTES de DATA_LANCAMENTO.
 *
 * A pre-venda e real — o pedido e pago na hora — e o que muda e so a data de
 * envio. Esta frase e a promessa exata que a Milagran faz nesse periodo, e por
 * isso ela e uma constante unica: se cada tela escrevesse o proprio texto,
 * duas superficies acabariam prometendo prazos diferentes sobre a mesma
 * compra, que e a divergencia que src/components/linha-frete.tsx foi criado
 * para impedir no caso do frete.
 *
 * Texto voltado ao comprador: acentuacao completa, ao contrario dos
 * comentarios e identificadores do projeto.
 */
export const AVISO_PRE_VENDA =
  'Os pedidos online serão enviados após o lançamento oficial da Milagran, realizado em 25/08/2026.'
