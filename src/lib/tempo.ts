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
 * Sao Paulo nao observa horario de verao desde 2019, mas resolver por
 * aproximacao sucessiva mantem a funcao correta para datas historicas e
 * caso a politica volte a mudar.
 */
function instanteDeCivilBR(ano: number, mes: number, dia: number, hora = 0, minuto = 0, segundo = 0, ms = 0): Date {
  let palpite = Date.UTC(ano, mes - 1, dia, hora, minuto, segundo, ms)
  for (let i = 0; i < 3; i++) {
    const c = civilBR(new Date(palpite))
    const obtido = Date.UTC(c.ano, c.mes - 1, c.dia, c.hora, c.minuto, c.segundo, ms)
    const alvo = Date.UTC(ano, mes - 1, dia, hora, minuto, segundo, ms)
    if (obtido === alvo) break
    palpite += alvo - obtido
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
