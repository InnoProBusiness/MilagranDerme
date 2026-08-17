import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import {
  criarLimitadorPorIp, ipDoPedido,
  JANELA_RATE_LIMIT_MS, MAX_CANDIDATURAS_POR_JANELA,
} from '@/lib/rate-limit'
// IMPORT DE TIPO, e nao de valor: `import type` some na compilacao, entao
// este modulo continua sem tocar em src/lib/db.ts, sem abrir pool e sem
// exigir DATABASE_URL. E o que mantem src/lib/__tests__/candidatura.test.ts
// rodando sem Postgres nenhum, que e a razao declarada de a logica morar
// aqui e nao no route handler.
import type { EntradaLead, TipoLead } from '@/repositories/leads'

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

// ---- Lead (persistencia da candidatura) ----
//
// Ate 16/08/2026 uma candidatura tinha UM destino: um PDF anexado a um
// e-mail. Nada era gravado — este arquivo nao importava getDb() em lugar
// nenhum. A secao 17 do documento do cliente exige LISTAR representantes e
// distribuidores no painel, e uma caixa de entrada nao e consultavel: nao da
// para filtrar por estado, contar por tipo nem responder "quem se candidatou
// no Ceara em agosto". Pior que isso, o aceite de LGPD que o formulario
// coleta (checkbox `lgpd`, obrigatorio) so virava a linha "Consentimento
// LGPD: Sim" desenhada no PDF: o consentimento era INCOMPROVAVEL, e o unico
// carimbo de tempo existente era "quando o PDF foi gerado", que nao e o
// mesmo fato. Agora cada candidatura tambem vira uma linha em `leads`
// (migrations/1755300400000_leads.sql).

/**
 * Porta de persistencia do lead, INJETADA por quem chama (o route handler em
 * src/app/api/candidatura/route.ts passa `registrarLead`).
 *
 * Injecao, e nao import direto do repositorio, por um motivo so: este modulo
 * e testado sem banco. Importar `registrarLead` como VALOR arrastaria
 * src/lib/db.ts para dentro de src/lib/__tests__/candidatura.test.ts, que
 * hoje roda sem DATABASE_URL e sem Postgres na maquina de desenvolvimento —
 * os testes de e-mail e de PDF passariam a depender de um banco que nao tem
 * nada a ver com o que eles verificam. O parametro e opcional e o ultimo:
 * toda chamada de duas posicoes que ja existia continua valendo, sem lead e
 * sem mudanca de comportamento.
 */
export type GravadorDeLead = (lead: EntradaLead) => Promise<unknown>

/**
 * "Nivel de interesse" do formulario (public/seja-representante.html, select
 * `nivel`, obrigatorio) tem exatamente duas opcoes: Representante e
 * Distribuidor. E dali que sai o tipo do lead — nao e chute nem constante
 * fixa, o proprio candidato ja diz qual dos dois quer ser, e os cartoes de
 * plano da LP levam para o formulario com esse valor em mente
 * (`data-nivel="Representante"` / `data-nivel="Distribuidor"`).
 *
 * Qualquer outro valor (formulario futuro sem o campo, corpo montado a mao)
 * cai em 'representante' em vez de derrubar a gravacao. O motivo e assimetria
 * de dano: um lead no balde errado e uma correcao de um clique no painel,
 * enquanto um valor fora do ENUM tipo_lead faz o INSERT falhar — e como a
 * gravacao e best-effort (ver processarCandidatura), esse lead sumiria em
 * silencio, com a prova de consentimento junto.
 */
function tipoDoNivel(nivel: string): TipoLead {
  return nivel.trim().toLowerCase() === 'distribuidor' ? 'distribuidor' : 'representante'
}

/**
 * "Area de atuacao" e "Ja atua com estetica?" nao tem coluna em `leads` — a
 * tabela e generica, atende tambem o formulario de interessado da home, e
 * criar duas colunas que so um formulario preenche seria carregar NULL/''
 * para sempre em todos os outros. Elas viram texto em `mensagem`, que existe
 * exatamente para o que e especifico de cada origem. Sem isso o painel
 * mostraria MENOS do que o e-mail ja mostrava hoje, o que faria a tela nova
 * nascer pior que a caixa de entrada que ela veio substituir.
 *
 * Com acentuacao completa de proposito: isto e conteudo lido por uma pessoa
 * na tela do painel, nao comentario de codigo.
 */
function mensagemDaCandidatura(dados: DadosCandidatura): string {
  const partes: string[] = []
  const area = texto(dados, 'area')
  const atuaEstetica = texto(dados, 'atuaEstetica')
  if (area) partes.push(`Área de atuação: ${area}`)
  if (atuaEstetica) partes.push(`Já atua com estética: ${atuaEstetica}`)
  return partes.join(' | ')
}

/**
 * Traduz o corpo cru do formulario no lead a gravar. Exportada para poder
 * ser testada sozinha, sem banco e sem e-mail: e uma funcao pura.
 *
 * `origem` recebe o "Como conheceu a marca?" do formulario (Instagram,
 * TikTok, Indicacao, Evento, Outro) tal como veio, em portugues e com
 * acento. leads.origem e texto livre sem CHECK justamente para isso
 * (migrations/1755300400000_leads.sql) — mapear esses rotulos para slugs
 * inventados aqui criaria um segundo vocabulario para manter em sincronia
 * com o `<select>` do HTML, e o primeiro valor novo no formulario viraria um
 * lead com origem errada ou um cadastro recusado.
 *
 * `consentidoEm` e o instante em que o aceite chegou ao servidor. Nao e o
 * carimbo do PDF: aquele diz quando o arquivo foi desenhado e nunca foi
 * consultavel por consulta nenhuma.
 */
export function leadDaCandidatura(
  dados: DadosCandidatura,
  agora: Date = new Date(),
): EntradaLead {
  // Em processarCandidatura este ponto so e alcancado depois de
  // CAMPOS_OBRIGATORIOS, que ja recusa lgpd ausente, '' ou false — na
  // pratica aqui e sempre true. A derivacao existe para a funcao continuar
  // honesta quando chamada de fora desse fluxo: consentimento e o unico
  // campo desta tabela que nao pode ser assumido por conveniencia.
  const consentiu = Boolean(dados.lgpd)

  return {
    tipo: tipoDoNivel(texto(dados, 'nivel')),
    nome: texto(dados, 'nome'),
    email: texto(dados, 'email'),
    whatsapp: texto(dados, 'whatsapp'),
    cidade: texto(dados, 'cidade'),
    estado: texto(dados, 'estado'),
    mensagem: mensagemDaCandidatura(dados),
    consentimentoLgpd: consentiu,
    consentidoEm: consentiu ? agora : null,
    origem: texto(dados, 'origem'),
  }
}

export type Resultado = {
  status: number
  corpo: Record<string, unknown>
}

/**
 * Todo o fluxo, do corpo cru ao par (status, JSON). Fica aqui e nao no
 * route handler para que o handler seja so adaptacao de Request/Response —
 * e para que esta logica continue testavel sem subir o Next.
 *
 * `gravarLead` e opcional e best-effort: ver o bloco de gravacao abaixo. O
 * CONTRATO HTTP nao muda com ele — os mesmos codigos (200/400/429/500/502)
 * pelos mesmos motivos de antes, o que mantem validos tanto os testes deste
 * arquivo quanto o `public/script.js` que le a resposta.
 */
export async function processarCandidatura(
  dados: DadosCandidatura,
  ip: string,
  gravarLead?: GravadorDeLead,
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

  // ---- Grava o lead ANTES de qualquer e-mail sair ----
  //
  // ORDEM. O envio pela Resend e um efeito colateral EXTERNO e irreversivel:
  // depois que a mensagem sai, nada aqui a traz de volta. Gravar o lead
  // depois dela deixaria uma janela em que o processo morre (deploy, OOM do
  // container de 512M, timeout) com o e-mail ja entregue e o consentimento
  // perdido — justamente o registro que so existe em UM lugar, porque o
  // e-mail nao e consultavel. Gravando antes, a unica coisa que pode falhar
  // depois do INSERT e o envio, e o envio ja tem tratamento proprio (502).
  //
  // POSICAO. Depois da validacao, e nao antes: honeypot, campo obrigatorio
  // ausente e e-mail invalido nao podem virar linha em `leads`. Guardar nome,
  // e-mail e whatsapp de quem NAO marcou o checkbox de LGPD e exatamente o
  // tratamento sem base legal que esta tabela existe para tornar impossivel
  // — e um lead de bot nao e um lead, e lixo no painel que a operacao vai
  // ligar de volta.
  //
  // Antes da checagem das variaveis do Resend, tambem de proposito: sem
  // RESEND_API_KEY/EMAIL_FROM/EMAIL_TO o e-mail nunca sai e a linha no banco
  // vira o UNICO vestigio daquela candidatura. E o caso em que descartar
  // doeria mais, nao menos.
  //
  // BEST-EFFORT. Uma falha aqui NAO derruba a candidatura nem vira 5xx: o
  // banco fora do ar as 20h de um dia de campanha nao pode transformar em
  // erro um formulario que a pessoa preencheu certo e que a equipe ainda vai
  // receber por e-mail. Mesmo raciocinio ja aplicado ao e-mail de
  // confirmacao ao candidato, logo abaixo.
  //
  // Reenvio depois de um 502 grava um lead a mais para a mesma pessoa. Isso e
  // esperado e nao e defeito: `leads` nao tem indice unico por e-mail porque
  // cada envio e um evento de consentimento com instante proprio, e um upsert
  // sobrescreveria o `consentido_em` anterior — o comentario que decide isso
  // esta em migrations/1755300400000_leads.sql. Deduplicar para efeito de
  // contato e trabalho da tela.
  if (gravarLead) {
    try {
      await gravarLead(leadDaCandidatura(dados))
    } catch (erro) {
      // SO a mensagem. Uma violacao de CHECK do Postgres em `leads` carrega
      // a linha inteira — nome, e-mail, whatsapp, cidade — na propriedade
      // `detail` do erro, e logar o objeto cru derramaria dado pessoal do
      // candidato no stdout do container, que vai para o log agregado do
      // Swarm. Mesmo aviso registrado em src/repositories/leads.ts e em
      // src/repositories/clientes.ts.
      const motivo = erro instanceof Error ? erro.message : 'erro nao identificado'
      console.error(`candidatura: falha ao gravar o lead, seguindo com o e-mail: ${motivo}`)
    }
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
