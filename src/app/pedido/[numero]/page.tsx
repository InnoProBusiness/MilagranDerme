import { notFound } from 'next/navigation'
import { buscarPedidoComItensPorNumero } from '@/repositories/pedidos'
import { formatarBRL } from '@/lib/money'

// O pedido e mutavel (status muda ao longo da maquina de estados do Plano
// 3), entao esta pagina nao pode ser um snapshot congelado no build.
export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ numero: string }>
}

export default async function PaginaPedido({ params }: Props) {
  const { numero: numeroBruto } = await params

  // pedidos.numero e a chave publica desta URL (nao o uuid interno). Um
  // valor que nem parece numero — /pedido/abc, /pedido/1.5 — nunca bate
  // contra a coluna e so desperdicaria uma consulta; 404 direto.
  const numero = Number(numeroBruto)
  if (!Number.isInteger(numero) || numero <= 0) notFound()

  const pedido = await buscarPedidoComItensPorNumero(numero)
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
