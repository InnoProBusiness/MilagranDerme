import { notFound } from 'next/navigation'
import { buscarPedidoComItensPorToken } from '@/repositories/pedidos'
import { formatarBRL } from '@/lib/money'

// O pedido e mutavel (status muda ao longo da maquina de estados do Plano
// 3), entao esta pagina nao pode ser um snapshot congelado no build.
export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ token: string }>
}

export default async function PaginaPedido({ params }: Props) {
  const { token } = await params

  // A URL e a chave publica (token, um uuid — ver
  // migrations/1755100000000_pedido_token.sql), NAO o numero sequencial:
  // esta pagina nao tem autenticacao, e um numero previsivel deixaria
  // qualquer visitante andar /pedido/1, /pedido/2... e ler a contagem e o
  // faturamento de todos os pedidos da empresa. buscarPedidoComItensPorToken
  // ja descarta um token que nem parece uuid antes de consultar o banco.
  const pedido = await buscarPedidoComItensPorToken(token)
  if (!pedido) notFound()

  return (
    <main>
      <section className="section confirmacao">
        <p className="kicker">Pedido confirmado</p>
        <h1>Pedido nº {pedido.numero}</h1>

        <ul className="confirmacao__itens">
          {pedido.itens.map((item) => (
            <li key={item.id} className="vitrine__linha">
              {item.quantidade}× {item.nomeSnapshot} — {formatarBRL(item.totalCentavos)}
            </li>
          ))}
        </ul>

        <div className="vitrine__resumo">
          <p className="vitrine__linha">Subtotal: {formatarBRL(pedido.subtotalCentavos)}</p>
          {pedido.descontoCentavos > 0 && (
            <p className="vitrine__linha">Desconto: −{formatarBRL(pedido.descontoCentavos)}</p>
          )}
          {/*
            DIVIDA DELIBERADA (nao "consertar"): mesma razao da vitrine —
            frete_centavos e sempre 0 hoje porque a politica ainda nao foi
            definida (ver montarCarrinho em src/lib/carrinho.ts). Mostrar
            "R$ 0,00" prometeria frete gratis que ninguem decidiu.
          */}
          <p className="vitrine__linha">Frete: A definir — em breve</p>
          <p className="vitrine__linha vitrine__linha--total">
            Total: {formatarBRL(pedido.totalCentavos)}
          </p>
        </div>

        {/*
          DIVIDA DELIBERADA (nao "consertar"): o gateway de pagamento e o
          Plano 3 inteiro (Mercado Pago, KYC de CNPJ pendente). Todo pedido
          nasce 'pendente' e fica assim ate o Plano 3 ligar o pagamento — a
          pagina precisa dizer isso, nunca fingir que o pagamento ja
          aconteceu ou que o proximo passo e imediato.
        */}
        <p className="confirmacao__aviso">
          Pagamento: próximo passo. Em breve enviaremos as instruções de
          pagamento para o e-mail e o WhatsApp informados no checkout.
        </p>
      </section>
    </main>
  )
}
