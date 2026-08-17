import { describe, it, expect } from 'vitest'
import {
  avisoDeEscassez, LIMIAR_POUCOS_KITS, LIMIAR_ULTIMOS_KITS,
  type NivelEscassez,
} from '@/lib/escassez'

// Lote do lancamento presencial: 50 kits, semeados em
// migrations/1755300700000_seed_estoque.sql. Usar o mesmo numero dos testes
// que a operacao vai ver na tela deixa as mensagens legiveis aqui embaixo.
const LOTE = 50

describe('faixas de escassez', () => {
  it('saldo folgado nao fala em escassez', () => {
    expect(avisoDeEscassez(LOTE, LOTE).nivel).toBe('normal')
    expect(avisoDeEscassez(37, LOTE).nivel).toBe('normal')
  })

  it('saldo pequeno avisa que restam poucos', () => {
    expect(avisoDeEscassez(8, LOTE).nivel).toBe('poucos')
  })

  it('saldo minimo vira contagem regressiva', () => {
    expect(avisoDeEscassez(3, LOTE).nivel).toBe('ultimos')
  })

  it('saldo zerado esgota', () => {
    expect(avisoDeEscassez(0, LOTE).nivel).toBe('esgotado')
  })

  // Os limiares sao contrato entre este arquivo e a copy do cliente. Se
  // alguem trocar os valores sem trocar as mensagens, a faixa 'poucos'
  // desaparece (ou engole a 'ultimos') e a cadeia de ifs para de fazer
  // sentido. Este teste falha antes de a home mentir.
  it('os dois limiares se mantem ordenados', () => {
    expect(LIMIAR_ULTIMOS_KITS).toBeLessThan(LIMIAR_POUCOS_KITS)
    expect(LIMIAR_ULTIMOS_KITS).toBe(5)
    expect(LIMIAR_POUCOS_KITS).toBe(10)
  })
})

// As fronteiras sao o unico lugar onde um `<` no lugar de um `<=` passa
// despercebido: no meio da faixa os quatro niveis se comportam igual.
describe('fronteiras exatas entre as faixas', () => {
  const ESPERADO: ReadonlyArray<readonly [number, NivelEscassez]> = [
    [0, 'esgotado'],
    [1, 'ultimos'],
    [5, 'ultimos'],
    [6, 'poucos'],
    [10, 'poucos'],
    [11, 'normal'],
    [999, 'normal'],
  ]

  for (const [saldo, nivel] of ESPERADO) {
    it(`disponivel ${saldo} cai em ${nivel}`, () => {
      expect(avisoDeEscassez(saldo, LOTE).nivel).toBe(nivel)
    })
  }

  // Um kit ainda e um kit: 1 nao pode cair no mesmo balde do zero, senao a
  // vitrine troca a CTA por "COMPRAR ONLINE" com estoque presencial na mao
  // do vendedor.
  it('um unico kit restante nao e esgotado', () => {
    expect(avisoDeEscassez(1, LOTE).nivel).not.toBe('esgotado')
  })
})

// Copy aprovada pelo cliente (§5 e §11). Se estes literais mudarem, mudou o
// que a Milagran promete na vitrine — o teste existe para que isso seja uma
// decisao, nunca um efeito colateral de refatoracao.
describe('mensagens exatas do documento do cliente', () => {
  it('esgotado anuncia o tamanho do lote, nao o saldo zero', () => {
    expect(avisoDeEscassez(0, LOTE).mensagem)
      .toBe('Os 50 kits disponíveis para compra presencial foram esgotados.')
  })

  it('ultimos conta o que sobrou', () => {
    expect(avisoDeEscassez(4, LOTE).mensagem)
      .toBe('Últimos 4 kits disponíveis para compra presencial.')
  })

  it('poucos conta o que sobrou', () => {
    expect(avisoDeEscassez(7, LOTE).mensagem)
      .toBe('Restam apenas 7 kits disponíveis para levar hoje.')
  })

  it('normal anuncia o tamanho do lote', () => {
    expect(avisoDeEscassez(42, LOTE).mensagem)
      .toBe('Apenas 50 kits disponíveis para levar na hora.')
  })

  it('as mensagens vao acentuadas para a tela', () => {
    expect(avisoDeEscassez(2, LOTE).mensagem).toContain('Últimos')
    expect(avisoDeEscassez(2, LOTE).mensagem).toContain('disponíveis')
  })
})

describe('numeros que a operacao consegue produzir', () => {
  // Movimento de 'ajuste' positivo (recontagem no evento) sobe o saldo sem
  // ser 'entrada', entao nao entra em total = SUM(entrada). O par fica
  // incoerente por construcao e a funcao nao pode lancar por causa disso:
  // seria a home caindo por uma correcao de inventario feita no balcao.
  it('disponivel maior que total nao quebra', () => {
    const aviso = avisoDeEscassez(60, LOTE)
    expect(aviso.nivel).toBe('normal')
    expect(aviso.mensagem).toBe('Apenas 50 kits disponíveis para levar na hora.')
  })

  it('disponivel maior que total tambem vale nas faixas de contagem', () => {
    expect(avisoDeEscassez(8, 5)).toEqual({
      nivel: 'poucos',
      mensagem: 'Restam apenas 8 kits disponíveis para levar hoje.',
    })
    expect(avisoDeEscassez(3, 0)).toEqual({
      nivel: 'ultimos',
      mensagem: 'Últimos 3 kits disponíveis para compra presencial.',
    })
  })

  // Saldo negativo existe: 'ajuste' para baixo, e o canal online, que e
  // ilimitado e por isso pode baixar abaixo de zero
  // (migrations/1755300000000_canal_e_estoque.sql). Sem estoque provado, a
  // loja nao promete kit nenhum.
  it('saldo negativo cai em esgotado, nunca em promessa de kit', () => {
    expect(avisoDeEscassez(-3, LOTE).nivel).toBe('esgotado')
    expect(avisoDeEscassez(-3, LOTE).mensagem).not.toContain('-3')
  })

  it('lote negativo nao vira anuncio de lote negativo', () => {
    expect(avisoDeEscassez(0, -50).mensagem)
      .toBe('Os 0 kits disponíveis para compra presencial foram esgotados.')
  })

  // SUM() em Postgres devolve NULL sobre zero linhas; o caminho
  // NULL -> undefined -> Number() -> NaN chega ate aqui. O pior desfecho nao
  // e o erro, e a home escrevendo "Restam apenas NaN kits" no dia do evento.
  it('valor nao numerico degrada para esgotado em vez de imprimir NaN', () => {
    expect(avisoDeEscassez(Number.NaN, LOTE).nivel).toBe('esgotado')
    expect(avisoDeEscassez(Number.NaN, Number.NaN).mensagem)
      .toBe('Os 0 kits disponíveis para compra presencial foram esgotados.')
  })

  it('saldo fracionario nao vaza casa decimal para a tela', () => {
    expect(avisoDeEscassez(5.9, LOTE)).toEqual({
      nivel: 'ultimos',
      mensagem: 'Últimos 5 kits disponíveis para compra presencial.',
    })
  })

  // Invariante de tela: nenhuma combinacao plausivel de saldo pode produzir
  // texto quebrado. Uma varredura barata cobre o que os casos pontuais
  // deixariam passar se alguem mexer na formatacao.
  it('nenhuma faixa produz NaN, undefined ou numero negativo na frase', () => {
    for (let saldo = -5; saldo <= LOTE + 10; saldo++) {
      const { mensagem } = avisoDeEscassez(saldo, LOTE)
      expect(mensagem).not.toContain('NaN')
      expect(mensagem).not.toContain('undefined')
      expect(mensagem).not.toContain('-')
      expect(mensagem.endsWith('.')).toBe(true)
    }
  })
})
