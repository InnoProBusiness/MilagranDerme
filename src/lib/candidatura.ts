import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import {
  criarLimitadorPorIp, ipDoPedido,
  JANELA_RATE_LIMIT_MS, MAX_CANDIDATURAS_POR_JANELA,
} from '@/lib/rate-limit'

/**
 * Nucleo do fluxo de candidatura de representante: valida, gera o PDF e
 * envia por e-mail via Resend. Unica implementacao — o route handler em
 * src/app/api/candidatura/route.ts so adapta Request/Response para ca.
 *
 * A logica fica aqui, e nao dentro do route handler, para continuar
 * testavel sem subir o Next.
 *
 * Historico que explica escolhas abaixo: isto nasceu como Serverless
 * Function da Vercel (`api/candidatura.js`, diretorio `api/` na raiz), que
 * o `next start` da VPS nunca executaria — um diretorio `api/` na raiz nao
 * vira rota nenhuma fora da Vercel. Ao migrar, os codigos de erro do
 * contrato HTTP foram preservados um a um.
 */

const CAMPOS_OBRIGATORIOS = [
  'nome', 'whatsapp', 'email', 'cidade', 'estado',
  'area', 'nivel', 'origem', 'lgpd',
] as const

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type DadosCandidatura = Record<string, unknown>

// ---- Rate limit por IP ----
// O mecanismo (contador em memoria do processo, janela deslizante, poda dos
// IPs vencidos) vive em src/lib/rate-limit.ts, compartilhado com
// POST /api/pedidos — inclusive o aviso honesto de que isto e um freio
// contra bot ingenuo, e nao rate limiting distribuido nem controle de
// acesso. Aqui ficam so o contador PROPRIO deste endpoint (Map separado, sem
// orcamento compartilhado com o checkout) e o teto historico de 5 por
// janela.
export const excedeuRateLimit = criarLimitadorPorIp({
  janelaMs: JANELA_RATE_LIMIT_MS,
  maxPorJanela: MAX_CANDIDATURAS_POR_JANELA,
})

// Reexportado no lugar onde o route handler e os testes ja o importavam,
// para que mover a funcao nao vire um churn de imports sem ganho nenhum.
export { ipDoPedido }

function escaparHtml(valor: unknown): string {
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function texto(dados: DadosCandidatura, campo: string): string {
  const valor = dados[campo]
  return valor === undefined || valor === null ? '' : String(valor)
}

// ---- PDF (pdf-lib — JS puro, sem Chromium) ----
export async function gerarPdfCandidatura(dados: DadosCandidatura): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const pagina = pdf.addPage([595.28, 841.89]) // A4
  const { width, height } = pagina.getSize()

  const fonte = await pdf.embedFont(StandardFonts.Helvetica)
  const fonteNegrito = await pdf.embedFont(StandardFonts.HelveticaBold)

  const preto = rgb(0.043, 0.039, 0.031)
  const ouro = rgb(0.788, 0.635, 0.302)
  const ouroClaro = rgb(0.914, 0.804, 0.553)
  const creme = rgb(0.957, 0.925, 0.867)
  const cremeSuave = rgb(0.725, 0.675, 0.576)

  pagina.drawRectangle({ x: 0, y: 0, width, height, color: preto })
  pagina.drawRectangle({ x: 50, y: height - 90, width: width - 100, height: 1.5, color: ouro })

  pagina.drawText('MILAGRAN', {
    x: 50, y: height - 70, size: 26, font: fonteNegrito, color: ouroClaro,
  })
  pagina.drawText('Candidatura de Representante', {
    x: 50, y: height - 110, size: 13, font: fonte, color: cremeSuave,
  })

  const linhas: Array<[string, string]> = [
    ['Nome completo', texto(dados, 'nome')],
    ['WhatsApp', texto(dados, 'whatsapp')],
    ['E-mail', texto(dados, 'email')],
    ['Cidade', texto(dados, 'cidade')],
    ['Estado', texto(dados, 'estado')],
    ['Area de atuacao', texto(dados, 'area')],
    ['Ja atua com estetica?', texto(dados, 'atuaEstetica') || '-'],
    ['Nivel de interesse', texto(dados, 'nivel')],
    ['Como conheceu a marca', texto(dados, 'origem')],
    ['Consentimento LGPD', dados.lgpd ? 'Sim' : 'Nao'],
  ]

  let y = height - 160
  for (const [rotulo, valor] of linhas) {
    pagina.drawText(rotulo.toUpperCase(), { x: 50, y, size: 9, font: fonteNegrito, color: ouro })
    // WinAnsi (a codificacao das fontes Standard do PDF) nao cobre todo o
    // Unicode: um nome com caractere fora dela faz o pdf-lib lancar, e o
    // candidato recebia 500 por causa do proprio nome. O sanitize troca o
    // que a fonte nao sabe desenhar; o dado integro vai no corpo do e-mail.
    pagina.drawText(paraWinAnsi(valor), { x: 50, y: y - 16, size: 13, font: fonte, color: creme })
    y -= 46
  }

  const gerado = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  pagina.drawText(paraWinAnsi(`Gerado automaticamente em ${gerado}`), {
    x: 50, y: 40, size: 8, font: fonte, color: cremeSuave,
  })

  return pdf.save()
}

/**
 * Normaliza para o que as fontes Standard do PDF conseguem desenhar:
 * decompoe os acentos (NFD) e descarta as marcas combinantes, depois troca
 * qualquer resto fora do Latin-1 por '?'. "Joao Gutemberg" continua legivel;
 * um emoji vira '?' em vez de derrubar a geracao inteira.
 */
function paraWinAnsi(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\xFF]/g, '?')
}

type EnvioResend = {
  apiKey: string
  from: string
  to: string
  replyTo?: string
  subject: string
  html: string
  attachments?: Array<{ filename: string; content: string }>
}

export async function enviarEmailResend(envio: EnvioResend): Promise<void> {
  const corpo: Record<string, unknown> = {
    from: envio.from,
    to: envio.to,
    subject: envio.subject,
    html: envio.html,
  }
  if (envio.replyTo) corpo.reply_to = envio.replyTo
  if (envio.attachments) corpo.attachments = envio.attachments

  const resposta = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${envio.apiKey}`,
    },
    body: JSON.stringify(corpo),
  })

  if (!resposta.ok) {
    // O texto da resposta da Resend nunca inclui a API key; o `throw` sobe
    // para o handler, que loga e devolve um codigo generico ao cliente.
    throw new Error(`Resend respondeu ${resposta.status}: ${await resposta.text()}`)
  }
}

function htmlConfirmacao(dados: DadosCandidatura): string {
  return `
    <div style="background:#0b0a08;padding:40px 24px;font-family:Helvetica,Arial,sans-serif;">
      <div style="max-width:480px;margin:0 auto;border:1px solid #c9a24d;padding:32px;">
        <h1 style="color:#e9cd8d;font-size:22px;margin:0 0 8px;">MILAGRAN</h1>
        <p style="color:#b9ac93;font-size:13px;margin:0 0 24px;">Candidatura recebida</p>
        <p style="color:#f4ecdd;font-size:15px;line-height:1.6;">
          Olá, ${escaparHtml(dados.nome)}! Recebemos sua candidatura para
          <strong>${escaparHtml(dados.nivel)}</strong> Milagran em
          ${escaparHtml(dados.cidade)}/${escaparHtml(dados.estado)}.
        </p>
        <p style="color:#f4ecdd;font-size:15px;line-height:1.6;">
          Nossa equipe vai analisar suas informações e entrar em contato pelo
          WhatsApp ou e-mail informado. Obrigado pelo interesse em fazer
          parte da marca.
        </p>
      </div>
    </div>
  `
}

function htmlNotificacao(dados: DadosCandidatura): string {
  const linhas: Array<[string, string]> = [
    ['Nome', texto(dados, 'nome')],
    ['WhatsApp', texto(dados, 'whatsapp')],
    ['E-mail', texto(dados, 'email')],
    ['Cidade', texto(dados, 'cidade')],
    ['Estado', texto(dados, 'estado')],
    ['Área de atuação', texto(dados, 'area')],
    ['Já atua com estética?', texto(dados, 'atuaEstetica') || '—'],
    ['Nível de interesse', texto(dados, 'nivel')],
    ['Como conheceu a marca', texto(dados, 'origem')],
  ]

  return `
    <h2>Nova candidatura de representante — Milagran</h2>
    <table cellpadding="6" cellspacing="0">
      ${linhas.map(([rotulo, valor]) => `
        <tr>
          <td><strong>${escaparHtml(rotulo)}</strong></td>
          <td>${escaparHtml(valor)}</td>
        </tr>
      `).join('')}
    </table>
    <p>PDF da candidatura em anexo.</p>
  `
}

export type Resultado = {
  status: number
  corpo: Record<string, unknown>
}

/**
 * Todo o fluxo, do corpo cru ao par (status, JSON). Fica aqui e nao no
 * route handler para que o handler seja so adaptacao de Request/Response —
 * e para que esta logica continue testavel sem subir o Next.
 */
export async function processarCandidatura(
  dados: DadosCandidatura,
  ip: string,
): Promise<Resultado> {
  if (excedeuRateLimit(ip)) {
    return { status: 429, corpo: { error: 'rate_limited' } }
  }

  // Honeypot: campo escondido que usuario real nunca preenche. Responde
  // como sucesso, sem enviar nada, para o bot nao aprender que foi pego.
  if (dados.website) {
    console.warn('candidatura: honeypot acionado, descartando em silencio')
    return { status: 200, corpo: { ok: true } }
  }

  for (const campo of CAMPOS_OBRIGATORIOS) {
    const valor = dados[campo]
    if (valor === undefined || valor === '' || valor === false) {
      return { status: 400, corpo: { error: 'missing_field', field: campo } }
    }
  }

  if (!EMAIL_REGEX.test(texto(dados, 'email'))) {
    return { status: 400, corpo: { error: 'invalid_email' } }
  }

  const { RESEND_API_KEY, EMAIL_FROM, EMAIL_TO, ENVIAR_CONFIRMACAO } = process.env

  const faltando: string[] = []
  if (!RESEND_API_KEY) faltando.push('RESEND_API_KEY')
  if (!EMAIL_FROM) faltando.push('EMAIL_FROM')
  if (!EMAIL_TO) faltando.push('EMAIL_TO')

  if (faltando.length > 0) {
    console.error(`candidatura: variavel(is) de ambiente ausente(s): ${faltando.join(', ')}`)
    return { status: 500, corpo: { error: 'server_not_configured' } }
  }

  let pdfBase64: string
  try {
    pdfBase64 = Buffer.from(await gerarPdfCandidatura(dados)).toString('base64')
  } catch (erro) {
    console.error('candidatura: falha ao gerar o PDF', erro)
    return { status: 500, corpo: { error: 'pdf_generation_failed' } }
  }

  const nome = texto(dados, 'nome')
  try {
    await enviarEmailResend({
      apiKey: RESEND_API_KEY!,
      from: EMAIL_FROM!,
      to: EMAIL_TO!,
      replyTo: texto(dados, 'email'),
      subject: `Nova candidatura de representante — ${nome} / ${texto(dados, 'cidade')}-${texto(dados, 'estado')}`,
      html: htmlNotificacao(dados),
      attachments: [{
        // O nome do arquivo vem do candidato: barra, contrabarra e ".."
        // viram separador de caminho em alguns clientes de e-mail. Restringe
        // ao que e seguro em vez de so trocar espaco por hifen.
        filename: `candidatura-${nome.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'sem-nome'}.pdf`,
        content: pdfBase64,
      }],
    })
  } catch (erro) {
    console.error('candidatura: falha ao enviar a notificacao', erro)
    return { status: 502, corpo: { error: 'email_provider_error' } }
  }

  if (ENVIAR_CONFIRMACAO === 'true') {
    try {
      await enviarEmailResend({
        apiKey: RESEND_API_KEY!,
        from: EMAIL_FROM!,
        to: texto(dados, 'email'),
        subject: 'Recebemos sua candidatura — Milagran',
        html: htmlConfirmacao(dados),
      })
    } catch (erro) {
      // Best-effort: a candidatura ja chegou para a equipe. Falhar o request
      // aqui faria o candidato reenviar e duplicar a notificacao.
      console.error('candidatura: falha ao enviar a confirmacao', erro)
    }
  }

  return { status: 200, corpo: { ok: true } }
}
