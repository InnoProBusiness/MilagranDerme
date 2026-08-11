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
 * Usa aproximacao sucessiva para resolver a ambiguidade causada por mudancas de horario de verao.
 * Quando a data/hora civil solicitada nao existe (na transicao de primavera),
 * retorna o primeiro instante valido depois da lacuna horaria.
 */
function instanteDeCivilBR(ano: number, mes: number, dia: number, hora = 0, minuto = 0, segundo = 0, ms = 0): Date {
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
