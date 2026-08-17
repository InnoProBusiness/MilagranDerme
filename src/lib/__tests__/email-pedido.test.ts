import { describe, it, expect } from 'vitest'
import { htmlConfirmacaoDePedido } from '@/lib/email-pedido'
import { AVISO_PRE_VENDA } from '@/lib/tempo'
import { deInteiro } from '@/lib/money'
import type { PedidoParaEmail } from '@/repositories/pedidos'

// SO htmlConfirmacaoDePedido e exercitada aqui: ela e pura (pedido + urlBase
// -> string) e nao toca no banco nem na rede. enviarConfirmacaoDePedido, que
// e quem le o pedido e chama o Resend, ja e coberta pelo lado de fora nos
// testes de rota (src/app/api/__tests__/webhook-mp-route.test.ts e
// vendas-presenciais-route.test.ts), que a substituem por um duble.

// deInteiro(), nunca `as never`: e o construtor de Centavos que garante que
// 19990 e inteiro. Um fixture com 199.90 aqui renderizaria R$ 1,99 no corpo
// do e-mail sem nenhum erro de compilacao.
const BASE: PedidoParaEmail = {
  numero: 42,
  token: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  canal: 'online',
  totalCentavos: deInteiro(19990),
  clienteNome: 'Maria Silva',
  clienteEmail: 'maria@exemplo.com',
  itens: [{ nome: 'Kit Milagran', quantidade: 1, totalCentavos: deInteiro(19990) }],
}

const URL_BASE = 'https://milagranoficial.com.br'

describe('htmlConfirmacaoDePedido — o que e comum aos dois canais', () => {
  it('traz o numero, o total formatado e o link do pedido', () => {
    const html = htmlConfirmacaoDePedido(BASE, URL_BASE)
    expect(html).toContain('42')
    expect(html).toContain('R$ 199,90')
    expect(html).toContain(`${URL_BASE}/pedido/${BASE.token}`)
  })

  // O corpo e HTML montado por template string: nome de cliente e conteudo
  // que veio de um formulario publico e nunca pode virar marcacao.
  it('escapa o que veio do comprador', () => {
    const html = htmlConfirmacaoDePedido(
      { ...BASE, clienteNome: '<script>alert(1)</script>' }, URL_BASE,
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('htmlConfirmacaoDePedido — copy por canal', () => {
  // §3: a promessa de prazo do pedido online sai da constante compartilhada,
  // e nao de uma frase escrita dentro do e-mail — tela e e-mail nao podem
  // prometer datas diferentes sobre a mesma compra.
  it('online: usa o aviso de pre-venda com a data de 25/08/2026 e cita os Correios', () => {
    const html = htmlConfirmacaoDePedido(BASE, URL_BASE)
    expect(html).toContain(AVISO_PRE_VENDA)
    expect(html).toContain('25/08/2026')
    expect(html).toMatch(/Correios/)
    expect(html).toMatch(/rastreio/i)
  })

  // O DEFEITO QUE ESTE ARQUIVO CORRIGIU: a copy antiga prometia aviso de
  // envio para TODO pedido, inclusive para quem comprou no balcao e saiu do
  // evento com o kit na mao (§2).
  it('presencial: fala em kit entregue no evento e NAO promete envio', () => {
    const html = htmlConfirmacaoDePedido({ ...BASE, canal: 'presencial' }, URL_BASE)
    expect(html).toMatch(/entregue em mãos/i)
    expect(html).toMatch(/evento/i)
    expect(html).not.toContain(AVISO_PRE_VENDA)
    expect(html).not.toContain('25/08/2026')
    expect(html).not.toMatch(/assim que (o pedido for enviado|ele for postado)/i)
  })

  it('presencial nao oferece rastreio nenhum, nem para acompanhar', () => {
    const html = htmlConfirmacaoDePedido({ ...BASE, canal: 'presencial' }, URL_BASE)
    // A unica mencao permitida a rastreio e a que NEGA a existencia dele.
    expect(html).toMatch(/não tem código de rastreio/i)
    expect(html).not.toMatch(/código de rastreio aparece/i)
  })
})
