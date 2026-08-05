// Vercel serverless function (Node runtime) — POST /api/candidatura
// Receives the representante application form, validates it, generates a
// branded PDF of the submission, and emails it via Resend.
//
// Required env vars (Vercel → Project Settings → Environment Variables):
//   RESEND_API_KEY      — API key from resend.com
//   EMAIL_FROM          — verified sender address/domain in Resend
//                          (e.g. "Milagran <candidaturas@milagranoficial.com>")
//   EMAIL_TO            — destination address for new candidatura notifications
//   ENVIAR_CONFIRMACAO  — "true" to also email the candidate a confirmation
//
// All read via process.env — never hardcoded. No values are ever logged.

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const REQUIRED_FIELDS = [
  'nome', 'whatsapp', 'email', 'cidade', 'estado',
  'area', 'nivel', 'origem', 'lgpd',
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Basic per-IP rate limiting ----
// In-memory only: state lives inside a single warm Lambda instance and is
// lost on cold start, and is NOT shared across concurrent instances. This
// is a best-effort speed bump against naive bots, not real distributed
// rate limiting. For durable protection, back this with Vercel KV/Upstash.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX = 5; // max submissions per IP per window
const rateLimitStore = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) return true;
  return false;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- PDF generation (pdf-lib — pure JS, no Chromium) ----
async function generateCandidaturaPdf(data) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const black = rgb(0.043, 0.039, 0.031);
  const gold = rgb(0.788, 0.635, 0.302);
  const goldLight = rgb(0.914, 0.804, 0.553);
  const cream = rgb(0.957, 0.925, 0.867);
  const creamMuted = rgb(0.725, 0.675, 0.576);

  // background
  page.drawRectangle({ x: 0, y: 0, width, height, color: black });

  // header rule
  page.drawRectangle({ x: 50, y: height - 90, width: width - 100, height: 1.5, color: gold });

  page.drawText('MILAGRAN', {
    x: 50, y: height - 70, size: 26, font: fontBold, color: goldLight,
  });
  page.drawText('Candidatura de Representante', {
    x: 50, y: height - 110, size: 13, font, color: creamMuted,
  });

  const rows = [
    ['Nome completo', data.nome],
    ['WhatsApp', data.whatsapp],
    ['E-mail', data.email],
    ['Cidade', data.cidade],
    ['Estado', data.estado],
    ['Área de atuação', data.area],
    ['Já atua com estética?', data.atuaEstetica || '—'],
    ['Nível de interesse', data.nivel],
    ['Como conheceu a marca', data.origem],
    ['Consentimento LGPD', data.lgpd ? 'Sim' : 'Não'],
  ];

  let y = height - 160;
  for (const [label, value] of rows) {
    page.drawText(label.toUpperCase(), {
      x: 50, y, size: 9, font: fontBold, color: gold,
    });
    page.drawText(String(value), {
      x: 50, y: y - 16, size: 13, font, color: cream,
    });
    y -= 46;
  }

  page.drawText(`Gerado automaticamente em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, {
    x: 50, y: 40, size: 8, font, color: creamMuted,
  });

  return pdfDoc.save();
}

async function sendResendEmail({ apiKey, from, to, replyTo, subject, html, attachments }) {
  const payload = { from, to, subject, html };
  if (replyTo) payload.reply_to = replyTo;
  if (attachments) payload.attachments = attachments;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
  return res.json();
}

function buildConfirmationHtml(data) {
  return `
    <div style="background:#0b0a08;padding:40px 24px;font-family:Helvetica,Arial,sans-serif;">
      <div style="max-width:480px;margin:0 auto;border:1px solid #c9a24d;padding:32px;">
        <h1 style="color:#e9cd8d;font-size:22px;margin:0 0 8px;">MILAGRAN</h1>
        <p style="color:#b9ac93;font-size:13px;margin:0 0 24px;">Candidatura recebida</p>
        <p style="color:#f4ecdd;font-size:15px;line-height:1.6;">
          Olá, ${escapeHtml(data.nome)}! Recebemos sua candidatura para
          <strong>${escapeHtml(data.nivel)}</strong> Milagran em
          ${escapeHtml(data.cidade)}/${escapeHtml(data.estado)}.
        </p>
        <p style="color:#f4ecdd;font-size:15px;line-height:1.6;">
          Nossa equipe vai analisar suas informações e entrar em contato pelo
          WhatsApp ou e-mail informado. Obrigado pelo interesse em fazer
          parte da marca.
        </p>
      </div>
    </div>
  `;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  const data = req.body || {};

  // Honeypot: real users never fill this hidden field. Bots often do.
  // Respond as if successful, without sending anything, so bots don't
  // learn they were caught.
  if (data.website) {
    console.warn('candidatura: honeypot triggered, silently dropping', { ip });
    return res.status(200).json({ ok: true });
  }

  for (const field of REQUIRED_FIELDS) {
    if (data[field] === undefined || data[field] === '' || data[field] === false) {
      return res.status(400).json({ error: 'missing_field', field });
    }
  }

  if (!EMAIL_REGEX.test(data.email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  const { RESEND_API_KEY, EMAIL_FROM, EMAIL_TO, ENVIAR_CONFIRMACAO } = process.env;

  const missingVars = [];
  if (!RESEND_API_KEY) missingVars.push('RESEND_API_KEY');
  if (!EMAIL_FROM) missingVars.push('EMAIL_FROM');
  if (!EMAIL_TO) missingVars.push('EMAIL_TO');

  if (missingVars.length > 0) {
    console.error(`candidatura: missing required env var(s): ${missingVars.join(', ')}`);
    return res.status(500).json({ error: 'server_not_configured' });
  }

  let pdfBase64;
  try {
    const pdfBytes = await generateCandidaturaPdf(data);
    pdfBase64 = Buffer.from(pdfBytes).toString('base64');
  } catch (err) {
    console.error('candidatura: PDF generation failed', err);
    return res.status(500).json({ error: 'pdf_generation_failed' });
  }

  const rows = [
    ['Nome', data.nome],
    ['WhatsApp', data.whatsapp],
    ['E-mail', data.email],
    ['Cidade', data.cidade],
    ['Estado', data.estado],
    ['Área de atuação', data.area],
    ['Já atua com estética?', data.atuaEstetica || '—'],
    ['Nível de interesse', data.nivel],
    ['Como conheceu a marca', data.origem],
  ];

  const notificationHtml = `
    <h2>Nova candidatura de representante — Milagran</h2>
    <table cellpadding="6" cellspacing="0">
      ${rows.map(([label, value]) => `
        <tr>
          <td><strong>${escapeHtml(label)}</strong></td>
          <td>${escapeHtml(value)}</td>
        </tr>
      `).join('')}
    </table>
    <p>PDF da candidatura em anexo.</p>
  `;

  try {
    await sendResendEmail({
      apiKey: RESEND_API_KEY,
      from: EMAIL_FROM,
      to: EMAIL_TO,
      replyTo: data.email,
      subject: `Nova candidatura de representante — ${data.nome} / ${data.cidade}-${data.estado}`,
      html: notificationHtml,
      attachments: [
        {
          filename: `candidatura-${data.nome.replace(/\s+/g, '-').toLowerCase()}.pdf`,
          content: pdfBase64,
        },
      ],
    });
  } catch (err) {
    console.error('candidatura: failed to send notification email', err);
    return res.status(502).json({ error: 'email_provider_error' });
  }

  if (ENVIAR_CONFIRMACAO === 'true') {
    try {
      await sendResendEmail({
        apiKey: RESEND_API_KEY,
        from: EMAIL_FROM,
        to: data.email,
        subject: 'Recebemos sua candidatura — Milagran',
        html: buildConfirmationHtml(data),
      });
    } catch (err) {
      // Confirmation email is best-effort — do not fail the request over it.
      console.error('candidatura: failed to send confirmation email', err);
    }
  }

  return res.status(200).json({ ok: true });
}
