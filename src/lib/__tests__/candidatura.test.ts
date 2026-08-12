import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  excedeuRateLimit, ipDoPedido, gerarPdfCandidatura, processarCandidatura,
} from '@/lib/candidatura'

/**
 * As variaveis do Resend sao apagadas antes de cada teste e restauradas
 * depois. Sem isso, um `.env` local com RESEND_API_KEY real faria o caminho
 * de sucesso disparar e-mail de verdade a cada `npm test` — e o destinatario
 * seria o EMAIL_TO de producao.
 */
const VARS = ['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_TO', 'ENVIAR_CONFIRMACAO'] as const
let salvas: Record<string, string | undefined> = {}

beforeEach(() => {
  salvas = {}
  for (const v of VARS) {
    salvas[v] = process.env[v]
    delete process.env[v]
  }
})

afterEach(() => {
  for (const v of VARS) {
    if (salvas[v] === undefined) delete process.env[v]
    else process.env[v] = salvas[v]
  }
  vi.unstubAllGlobals()
})

const VALIDA = {
  nome: 'Maria Silva',
  whatsapp: '11999998888',
  email: 'maria@exemplo.com',
  cidade: 'Sao Paulo',
  estado: 'SP',
  area: 'Estetica',
  nivel: 'Representante',
  origem: 'Instagram',
  lgpd: true,
}

// Cada teste usa um IP proprio: o contador de rate limit e estado de modulo
// e vaza entre testes se dois compartilharem o mesmo IP.
let contadorIp = 0
const ipUnico = () => `10.0.0.${++contadorIp}`

function configurarResend() {
  process.env.RESEND_API_KEY = 're_chave_de_teste'
  process.env.EMAIL_FROM = 'Milagran <candidaturas@milagranoficial.com.br>'
  process.env.EMAIL_TO = 'destino@exemplo.com'
}

describe('rate limit por IP', () => {
  it('permite 5 envios na janela e barra o sexto', () => {
    const ip = ipUnico()
    for (let i = 0; i < 5; i++) expect(excedeuRateLimit(ip)).toBe(false)
    expect(excedeuRateLimit(ip)).toBe(true)
  })

  it('libera de novo quando a janela de 10 minutos vira', () => {
    const ip = ipUnico()
    const t0 = 1_000_000
    for (let i = 0; i < 6; i++) excedeuRateLimit(ip, t0)
    expect(excedeuRateLimit(ip, t0)).toBe(true)
    expect(excedeuRateLimit(ip, t0 + 10 * 60 * 1000 + 1)).toBe(false)
  })

  it('poda IPs vencidos em vez de acumular para sempre', () => {
    // O container do Swarm roda por semanas; sem poda, cada IP visto uma vez
    // ficaria residente ate o restart, contra o limite de 512M da stack.
    const antigo = ipUnico()
    const t0 = 2_000_000
    excedeuRateLimit(antigo, t0)

    // Uma chamada de outro IP depois da janela dispara a poda do anterior.
    excedeuRateLimit(ipUnico(), t0 + 10 * 60 * 1000 + 1)

    // Se o antigo tivesse sobrevivido, este seria o 2o hit e nao o 1o —
    // observavel so pelo momento em que o bloqueio chega.
    const depois = t0 + 10 * 60 * 1000 + 2
    for (let i = 0; i < 5; i++) expect(excedeuRateLimit(antigo, depois)).toBe(false)
    expect(excedeuRateLimit(antigo, depois)).toBe(true)
  })
})

describe('extracao do IP do cliente', () => {
  it('usa o primeiro elemento de x-forwarded-for, que e o cliente', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.1.1.1, 10.1.1.2' })
    expect(ipDoPedido(h)).toBe('203.0.113.7')
  })

  it('cai para x-real-ip quando nao ha x-forwarded-for', () => {
    expect(ipDoPedido(new Headers({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('nao devolve string vazia quando o header existe mas esta vazio', () => {
    // '' cairia como chave do Map e juntaria visitantes distintos no mesmo
    // contador — um bot esvaziando o header zeraria o limite de todo mundo.
    expect(ipDoPedido(new Headers({ 'x-forwarded-for': '' }))).toBe('desconhecido')
    expect(ipDoPedido(new Headers())).toBe('desconhecido')
  })
})

describe('validacao', () => {
  it('recusa campo obrigatorio ausente dizendo qual e', () => {
    const { nome: _, ...semNome } = VALIDA
    return processarCandidatura(semNome, ipUnico()).then((r) => {
      expect(r.status).toBe(400)
      expect(r.corpo).toEqual({ error: 'missing_field', field: 'nome' })
    })
  })

  it('trata lgpd=false como ausente — consentimento nao dado e consentimento faltando', async () => {
    const r = await processarCandidatura({ ...VALIDA, lgpd: false }, ipUnico())
    expect(r.corpo).toEqual({ error: 'missing_field', field: 'lgpd' })
  })

  it('recusa e-mail sem formato valido', async () => {
    const r = await processarCandidatura({ ...VALIDA, email: 'maria arroba exemplo' }, ipUnico())
    expect(r.status).toBe(400)
    expect(r.corpo).toEqual({ error: 'invalid_email' })
  })

  it('honeypot responde 200 sem enviar nada, para o bot nao aprender que foi pego', async () => {
    const fetchFalso = vi.fn()
    vi.stubGlobal('fetch', fetchFalso)
    configurarResend()

    const r = await processarCandidatura({ ...VALIDA, website: 'http://spam' }, ipUnico())

    expect(r.status).toBe(200)
    expect(r.corpo).toEqual({ ok: true })
    expect(fetchFalso).not.toHaveBeenCalled()
  })

  it('sem as variaveis do Resend devolve server_not_configured, nao 200 mentiroso', async () => {
    const r = await processarCandidatura(VALIDA, ipUnico())
    expect(r.status).toBe(500)
    expect(r.corpo).toEqual({ error: 'server_not_configured' })
  })
})

describe('envio', () => {
  it('manda a notificacao com PDF anexo e reply_to do candidato', async () => {
    const fetchFalso = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchFalso)
    configurarResend()

    const r = await processarCandidatura(VALIDA, ipUnico())

    expect(r.status).toBe(200)
    expect(fetchFalso).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFalso.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    const corpo = JSON.parse(init.body)
    expect(corpo.to).toBe('destino@exemplo.com')
    // Responder o e-mail da equipe tem que cair no candidato, nao no remetente.
    expect(corpo.reply_to).toBe('maria@exemplo.com')
    expect(corpo.attachments[0].filename).toBe('candidatura-maria-silva.pdf')
    expect(corpo.attachments[0].content.length).toBeGreaterThan(0)
  })

  it('nao envia confirmacao ao candidato a menos que ENVIAR_CONFIRMACAO seja "true"', async () => {
    const fetchFalso = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchFalso)
    configurarResend()

    await processarCandidatura(VALIDA, ipUnico())
    expect(fetchFalso).toHaveBeenCalledTimes(1)

    process.env.ENVIAR_CONFIRMACAO = 'true'
    await processarCandidatura(VALIDA, ipUnico())
    expect(fetchFalso).toHaveBeenCalledTimes(3)
  })

  it('falha da confirmacao nao derruba o request — a candidatura ja chegou a equipe', async () => {
    // Se o 2o envio falhasse o request, o candidato reenviaria e a equipe
    // receberia a mesma candidatura duas vezes.
    const fetchFalso = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('erro', { status: 500 }))
    vi.stubGlobal('fetch', fetchFalso)
    configurarResend()
    process.env.ENVIAR_CONFIRMACAO = 'true'

    const r = await processarCandidatura(VALIDA, ipUnico())
    expect(r.status).toBe(200)
    expect(r.corpo).toEqual({ ok: true })
  })

  it('erro do provedor na notificacao vira 502, nao 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('quota', { status: 422 })))
    configurarResend()

    const r = await processarCandidatura(VALIDA, ipUnico())
    expect(r.status).toBe(502)
    expect(r.corpo).toEqual({ error: 'email_provider_error' })
  })

  it('sanitiza o nome no filename do anexo, sem deixar separador de caminho passar', async () => {
    const fetchFalso = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchFalso)
    configurarResend()

    await processarCandidatura({ ...VALIDA, nome: '../../etc/passwd' }, ipUnico())

    const { attachments } = JSON.parse(fetchFalso.mock.calls[0][1].body)
    expect(attachments[0].filename).toBe('candidatura-etc-passwd.pdf')
    expect(attachments[0].filename).not.toContain('/')
  })
})

describe('geracao do PDF', () => {
  it('produz um PDF valido', async () => {
    const bytes = await gerarPdfCandidatura(VALIDA)
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-')
  })

  it('nao estoura com nome fora do WinAnsi — o candidato recebia 500 pelo proprio nome', async () => {
    // As fontes Standard do PDF sao WinAnsi; sem o sanitize, o pdf-lib lanca
    // em qualquer caractere fora dela. Acentuado tem que passar; emoji nao
    // pode derrubar a geracao.
    await expect(gerarPdfCandidatura({ ...VALIDA, nome: 'João Gonçalves 🌟' }))
      .resolves.toBeInstanceOf(Uint8Array)
    await expect(gerarPdfCandidatura({ ...VALIDA, cidade: '北京' }))
      .resolves.toBeInstanceOf(Uint8Array)
  })
})
