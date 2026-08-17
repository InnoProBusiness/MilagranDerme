import { enviarEmailResend } from '@/lib/candidatura'
import {
  buscarPedidoParaEmail, type CanalVenda, type PedidoParaEmail,
} from '@/repositories/pedidos'
import { formatarBRL } from '@/lib/money'
import { AVISO_PRE_VENDA } from '@/lib/tempo'

function escaparHtml(valor: unknown): string {
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * O QUE ACONTECE COM O KIT DEPOIS DO PAGAMENTO — e isso depende do CANAL da
 * venda.
 *
 * DEFEITO CORRIGIDO EM 16/08/2026, registrado aqui porque a frase antiga
 * chegou a caixas de entrada de verdade: este e-mail dizia "Avisaremos assim
 * que o pedido for enviado" para TODO pedido. No online e verdade; no balcao
 * do evento (§2, §10) e mentira — o comprador pagou, recebeu o kit em maos e
 * saiu, e ficaria esperando um aviso de envio que nunca vai existir. Pior:
 * mandaria gente ligar para a Milagran perguntando por rastreio de um produto
 * que ja esta na casa dela.
 *
 * A ordem do `if` e deliberada: o caso ESTREITO (presencial) e testado e todo
 * o resto cai no texto online, que e o DEFAULT da coluna `canal` no banco
 * (migrations/1755300100000_pedidos_canal_logistica.sql). Um canal novo no
 * ENUM herdaria a copy de envio — a errada para receber e a certa para
 * despachar —, o que e o lado seguro de errar.
 *
 * A frase de pre-venda e a CONSTANTE de src/lib/tempo.ts, com a data de
 * 25/08/2026 dentro dela, e nao um texto escrito aqui: a mesma promessa
 * aparece na home, no checkout e na pagina do pedido, e um e-mail com prazo
 * diferente do que a tela mostra e a divergencia que aquela constante existe
 * para impedir.
 *
 * O paragrafo inteiro sai daqui, INCLUSIVE a frase que apresenta o link: para
 * quem comprou no balcao o link e um comprovante, e para quem comprou online
 * ele e a tela de acompanhamento. Chamar os dois de "acompanhar" faria o
 * e-mail do evento convidar o comprador a acompanhar uma entrega que ja
 * aconteceu na frente dele.
 *
 * Texto voltado ao comprador: acentuacao completa.
 */
function proximoPasso(canal: CanalVenda): string {
  if (canal === 'presencial') {
    return 'O seu kit foi entregue em mãos, no próprio evento: esta compra não '
      + 'passa pelos Correios e não tem código de rastreio. O link abaixo abre '
      + 'o comprovante do seu pedido:'
  }
  return `${AVISO_PRE_VENDA} Assim que ele for postado nos Correios, o código `
    + 'de rastreio aparece na página do seu pedido, que você acompanha por '
    + 'este link:'
}

export function htmlConfirmacaoDePedido(p: PedidoParaEmail, urlBase: string): string {
  const itens = p.itens.map((i) => `
    <tr>
      <td style="color:#f4ecdd;font-size:14px;padding:6px 0;">
        ${escaparHtml(i.quantidade)}× ${escaparHtml(i.nome)}
      </td>
      <td style="color:#f4ecdd;font-size:14px;padding:6px 0;text-align:right;">
        ${escaparHtml(formatarBRL(i.totalCentavos))}
      </td>
    </tr>
  `).join('')

  return `
    <div style="background:#0b0a08;padding:40px 24px;font-family:Helvetica,Arial,sans-serif;">
      <div style="max-width:480px;margin:0 auto;border:1px solid #c9a24d;padding:32px;">
        <h1 style="color:#e9cd8d;font-size:22px;margin:0 0 8px;">MILAGRAN</h1>
        <p style="color:#b9ac93;font-size:13px;margin:0 0 24px;">Pagamento confirmado</p>
        <p style="color:#f4ecdd;font-size:15px;line-height:1.6;">
          Olá, ${escaparHtml(p.clienteNome)}! Recebemos o pagamento do seu
          pedido <strong>nº ${escaparHtml(p.numero)}</strong>.
        </p>
        <table cellpadding="0" cellspacing="0" style="width:100%;margin:22px 0;border-top:1px solid #3a352b;border-bottom:1px solid #3a352b;">
          ${itens}
          <tr>
            <td style="color:#e9cd8d;font-size:16px;padding:10px 0 0;"><strong>Total</strong></td>
            <td style="color:#e9cd8d;font-size:16px;padding:10px 0 0;text-align:right;">
              <strong>${escaparHtml(formatarBRL(p.totalCentavos))}</strong>
            </td>
          </tr>
        </table>
        <p style="color:#f4ecdd;font-size:15px;line-height:1.6;">
          ${escaparHtml(proximoPasso(p.canal))}
        </p>
        <p style="margin:0 0 8px;">
          <a href="${escaparHtml(urlBase)}/pedido/${escaparHtml(p.token)}"
             style="color:#e9cd8d;font-size:14px;">
            Acompanhar meu pedido
          </a>
        </p>
        <p style="color:#8d836f;font-size:12px;line-height:1.6;margin-top:24px;">
          Guarde este e-mail: o link acima é a única forma de abrir este pedido.
        </p>
      </div>
    </div>
  `
}

/**
 * Envia a confirmacao de pagamento ao comprador. Cobre a exigencia
 * "Confirmacao de pedido por e-mail ao comprador" (Modulo 2 da especificacao).
 *
 * NUNCA LANCA. O dinheiro ja entrou e a comissao ja foi creditada quando esta
 * funcao roda; deixar uma falha de e-mail subir faria o webhook devolver 5xx,
 * o Mercado Pago reenviar, e a operacao inteira ficar refem do provedor de
 * e-mail estar de pe. O pedido continua visivel e correto em /pedido/<token>
 * mesmo se o e-mail nao sair.
 *
 * Pelo mesmo motivo e chamada DEPOIS do COMMIT, nunca de dentro da transacao:
 * um e-mail enviado e irreversivel, e um rollback posterior deixaria o
 * comprador com a confirmacao de um pagamento que o banco desfez.
 */
export async function enviarConfirmacaoDePedido(pedidoId: string): Promise<void> {
  try {
    const { RESEND_API_KEY, EMAIL_FROM } = process.env
    if (!RESEND_API_KEY || !EMAIL_FROM) {
      console.warn('[email-pedido] Resend nao configurado; confirmacao nao enviada')
      return
    }

    const pedido = await buscarPedidoParaEmail(pedidoId)
    if (!pedido) return

    const urlBase = (process.env.APP_URL ?? 'https://milagranoficial.com.br').replace(/\/$/, '')

    await enviarEmailResend({
      apiKey: RESEND_API_KEY,
      from: EMAIL_FROM,
      to: pedido.clienteEmail,
      subject: `Pagamento confirmado — pedido nº ${pedido.numero} | Milagran`,
      html: htmlConfirmacaoDePedido(pedido, urlBase),
    })
  } catch (erro) {
    console.error('[email-pedido] falha ao enviar a confirmacao:', erro)
  }
}
