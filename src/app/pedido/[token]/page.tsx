import { notFound } from 'next/navigation'
import { buscarPedidoComItensPorToken } from '@/repositories/pedidos'
import { formatarBRL } from '@/lib/money'
import { LinhaFrete } from '@/components/linha-frete'
import { Pagamento } from '@/components/pagamento'
import type { PedidoStatus } from '@/lib/db-types'

// O pedido e mutavel (o webhook do gateway move o status), entao esta pagina
// nao pode ser um snapshot congelado no build.
export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ token: string }>
}

/** Estados em que ainda cabe cobrar. Espelha a guarda de /api/pagamentos. */
function aceitaPagamento(status: PedidoStatus): boolean {
  return status === 'pendente' || status === 'aguardando_pagamento'
}

const ROTULOS: Record<PedidoStatus, string> = {
  pendente: 'Aguardando pagamento',
  aguardando_pagamento: 'Aguardando confirmação do pagamento',
  pago: 'Pagamento confirmado',
  em_preparacao: 'Em preparação',
  enviado: 'Enviado',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
  reembolsado: 'Reembolsado',
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

  const podePagar = aceitaPagamento(pedido.status)
  // A chave PUBLICA do Mercado Pago e feita para viver no navegador — ela so
  // tokeniza cartao. O access token, que autoriza cobrar, nunca sai do
  // servidor e nao e lido aqui.
  const chavePublica = process.env.MERCADOPAGO_PUBLIC_KEY ?? ''

  return (
    <main>
      <section className="section confirmacao">
        <p className="kicker">{ROTULOS[pedido.status]}</p>
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
            Mesmo componente da vitrine e dos dois passos do checkout — as
            quatro telas que falam de frete do mesmo pedido renderizam o
            mesmo no, por construcao. pedido.freteCentavos existe e e sempre
            0 hoje, e continua DELIBERADAMENTE nao exibido: a politica de
            frete nao foi definida, e "R$ 0,00" prometeria frete gratis que
            ninguem decidiu. Ver src/components/linha-frete.tsx.
          */}
          <LinhaFrete />
          <p className="vitrine__linha vitrine__linha--total">
            Total: {formatarBRL(pedido.totalCentavos)}
          </p>
        </div>

        {podePagar && chavePublica && (
          <Pagamento
            pedidoToken={token}
            totalCentavos={pedido.totalCentavos}
            chavePublica={chavePublica}
            emailComprador={pedido.clienteEmail ?? ''}
          />
        )}

        {/*
          Sem chave publica configurada o Brick nao carrega e o Pix nao e
          gerado. Dizer isso e melhor do que mostrar botoes que falham em
          silencio — e melhor ainda do que fingir que o pedido esta resolvido.
        */}
        {podePagar && !chavePublica && (
          <p className="confirmacao__aviso">
            O pagamento online ainda está sendo liberado. Entraremos em contato
            pelo e-mail e pelo WhatsApp informados no checkout com as instruções.
          </p>
        )}

        {pedido.status === 'pago' && (
          <p className="confirmacao__aviso">
            Pagamento confirmado. Você receberá um e-mail com os detalhes e
            avisaremos assim que o pedido for enviado.
          </p>
        )}

        {pedido.status === 'reembolsado' && (
          <p className="confirmacao__aviso">
            Este pedido foi reembolsado. O valor volta para a mesma forma de
            pagamento usada na compra, no prazo do seu banco.
          </p>
        )}
      </section>
    </main>
  )
}
