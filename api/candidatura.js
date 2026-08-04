// Vercel serverless function (Node runtime).
// Receives the representante application form and emails it via Resend.
//
// Required env var (set in Vercel → Project Settings → Environment Variables):
//   RESEND_API_KEY      — API key from resend.com
//   CANDIDATURA_TO      — destination email address for new applications (milagranoficial@gmail.com)
//   CANDIDATURA_FROM    — verified sender address/domain in Resend (e.g. "Milagran <candidaturas@milagranoficial.com>")

const REQUIRED_FIELDS = [
  'nome', 'whatsapp', 'email', 'cidade', 'estado',
  'area', 'atuaEstetica', 'nivel', 'origem', 'lgpd',
];

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const data = req.body || {};

  for (const field of REQUIRED_FIELDS) {
    if (data[field] === undefined || data[field] === '' || data[field] === false) {
      return res.status(400).json({ error: 'missing_field', field });
    }
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(data.email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  const {
    RESEND_API_KEY,
    CANDIDATURA_TO,
    CANDIDATURA_FROM,
  } = process.env;

  if (!RESEND_API_KEY || !CANDIDATURA_TO || !CANDIDATURA_FROM) {
    console.error('candidatura: missing Resend env vars');
    return res.status(500).json({ error: 'server_not_configured' });
  }

  const rows = [
    ['Nome', data.nome],
    ['WhatsApp', data.whatsapp],
    ['E-mail', data.email],
    ['Cidade', data.cidade],
    ['Estado', data.estado],
    ['Área de atuação', data.area],
    ['Já atua com estética?', data.atuaEstetica],
    ['Nível de interesse', data.nivel],
    ['Como conheceu a marca', data.origem],
  ];

  const html = `
    <h2>Nova candidatura de representante — Milagran</h2>
    <table cellpadding="6" cellspacing="0">
      ${rows.map(([label, value]) => `
        <tr>
          <td><strong>${escapeHtml(label)}</strong></td>
          <td>${escapeHtml(value)}</td>
        </tr>
      `).join('')}
    </table>
  `;

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: CANDIDATURA_FROM,
        to: CANDIDATURA_TO,
        reply_to: data.email,
        subject: `Nova candidatura: ${data.nome} (${data.nivel} — ${data.estado})`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const body = await resendRes.text();
      console.error('candidatura: resend error', resendRes.status, body);
      return res.status(502).json({ error: 'email_provider_error' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('candidatura: unexpected error', err);
    return res.status(500).json({ error: 'unexpected_error' });
  }
}
