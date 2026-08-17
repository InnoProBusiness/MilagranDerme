import { notFound } from 'next/navigation'
import { buscarPedidoComItensPorToken } from '@/repositories/pedidos'
import { formatarBRL } from '@/lib/money'
import { LinhaFrete } from '@/components/linha-frete'
import { LinhaDoTempoPedido } from '@/components/linha-do-tempo-pedido'
import { Pagamento } from '@/components/pagamento'
import { AVISO_PRE_VENDA, lancamentoJaOcorreu } from '@/lib/tempo'
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

/**
 * O objeto ja saiu da expedicao? A partir daqui o aviso de pre-venda de §3
 * ("serao enviados apos o lancamento") deixa de fazer sentido: o pedido JA
 * foi enviado, e repetir a promessa de envio depois do envio confunde quem
 * so quer o codigo de rastreio.
 */
function jaSaiuDaExpedicao(status: PedidoStatus): boolean {
  return status === 'enviado' || status === 'em_transito' || status === 'entregue'
}

/** Fim de linha: nao ha entrega a descrever para um pedido que nao existe mais. */
function encerrado(status: PedidoStatus): boolean {
  return status === 'cancelado' || status === 'reembolsado'
}

// O mapa de rotulos que vivia AQUI foi promovido a ROTULOS_STATUS em
// src/lib/pedido-status.ts. Motivo: o painel administrativo, a tela do
// vendedor e o e-mail de confirmacao passaram a mostrar o mesmo status desta
// pagina, e copy duplicada ja permitiu que telas discordassem sobre o mesmo
// pedido neste projeto (ver o cabecalho de src/components/linha-frete.tsx).
// Um mapa so, com titulo e descricao, e a garantia de que nao ha divergencia
// possivel — e o Record<PedidoStatus, ...> faz o compilador exigir que um
// valor novo do ENUM (como 'em_transito') ganhe rotulo antes de compilar.
//
// QUEM LE O MAPA AGORA E A LINHA DO TEMPO (src/components/linha-do-tempo-
// pedido.tsx), e nao mais um kicker de uma linha so. O kicker dizia o estado
// atual e escondia o resto: quem estava em "Em preparacao" nao tinha como
// saber que faltavam "Enviado", "Em transito" e "Entregue", nem que o
// caminho da compra do balcao termina tres passos antes (§2). A linha do
// tempo mostra o caminho inteiro do CANAL daquele pedido, com o ponto atual
// marcado — e continua lendo os mesmos rotulos, entao nao ha copy nova
// competindo com a do painel.

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

  // O CANAL da venda, congelado na linha do pedido desde a criacao
  // (migrations/1755300100000_pedidos_canal_logistica.sql). Ele decide a copy
  // desta tela inteira, porque as duas compras nao tem nada em comum depois
  // do pagamento: uma termina com o kit na mao do comprador dentro do evento
  // (§2), a outra comeca a esperar os Correios (§13).
  const presencial = pedido.canal === 'presencial'

  // Sem <main> proprio: o landmark de conteudo principal e o do layout raiz
  // (src/app/layout.tsx). Um <main> aqui ficaria aninhado dentro dele.
  return (
    <section className="section confirmacao">
      <p className="kicker">{presencial ? 'Compra no evento' : 'Pedido online'}</p>
      <h1>Pedido nº {pedido.numero}</h1>

      <LinhaDoTempoPedido
        canal={pedido.canal}
        status={pedido.status}
        criadoEm={pedido.criadoEm}
        enviadoEm={pedido.enviadoEm}
      />

      {/*
        COPY POR CANAL (§2, §3). Os dois blocos abaixo sao excludentes e
        respondem a mesma pergunta — "e agora, o que acontece com o meu
        kit?" — com as duas respostas diferentes que a Milagran tem.
      */}
      {presencial && !encerrado(pedido.status) && (
        <p className="confirmacao__aviso">
          {podePagar
            ? 'Esta é uma compra presencial: assim que o pagamento for confirmado, o vendedor entrega o seu kit na hora, no próprio evento. Não há envio pelos Correios nem código de rastreio.'
            : 'O kit desta compra foi entregue em mãos no evento. Não há envio pelos Correios nem código de rastreio — guarde este link, ele é o comprovante do seu pedido.'}
        </p>
      )}

      {/*
        §3: pre-venda. O texto e a CONSTANTE de src/lib/tempo.ts, nunca uma
        frase escrita aqui — a mesma promessa aparece na home e no checkout,
        e duas superficies prometendo prazos diferentes sobre a mesma compra
        e exatamente o que LinhaFrete foi criado para impedir no caso do
        frete.
        Some depois da postagem e depois do lancamento: nos dois casos a
        frase deixou de descrever a realidade do pedido que esta na tela.
      */}
      {!presencial && !jaSaiuDaExpedicao(pedido.status) && !encerrado(pedido.status)
        && !lancamentoJaOcorreu() && (
        <p className="aviso-prevenda">{AVISO_PRE_VENDA}</p>
      )}

      {/*
        ENTREGA E RASTREIO (§13). So no online: a venda de balcao nao tem
        endereco, nao tem transportadora e nao tem prazo — dizer "prazo
        estimado" para quem ja esta com o kit na sacola seria inventar uma
        espera.
      */}
      {!presencial && !encerrado(pedido.status) && (
        <div className="vitrine__resumo" data-testid="entrega">
          {pedido.rastreioCodigo ? (
            <>
              <p className="vitrine__linha">
                Código de rastreio: <strong>{pedido.rastreioCodigo}</strong>
              </p>
              {/*
                A transportadora e opcional de proposito no banco (as duas
                colunas sao independentes) e a operacao pode gravar o codigo
                antes de saber por quem despachou. ESTADO VAZIO HONESTO: a
                linha simplesmente nao aparece, em vez de "Transportadora: —"
                ou de um "Correios" chutado que mandaria o comprador
                consultar o site errado.
              */}
              {pedido.rastreioTransportadora && (
                <p className="vitrine__linha">
                  Transportadora: {pedido.rastreioTransportadora}
                </p>
              )}
            </>
          ) : (
            <p className="vitrine__linha">
              O código de rastreio aparece aqui assim que o pedido for postado.
            </p>
          )}

          {/*
            PRAZO E ESTIMATIVA, NUNCA PROMESSA. O numero vem da cotacao do
            Clube Envios feita no momento da compra (src/lib/frete.ts) e §13
            diz, com todas as letras, que o prazo real depende da regiao de
            entrega e do servico dos Correios. A ressalva anda GRUDADA no
            numero, na mesma caixa: separada dela, o comprador leva so o
            numero e volta cobrando a data.
          */}
          {pedido.prazoDiasEstimado !== null && (
            <p className="vitrine__linha">
              Prazo estimado da transportadora: {pedido.prazoDiasEstimado}{' '}
              {pedido.prazoDiasEstimado === 1 ? 'dia útil' : 'dias úteis'} após
              a postagem. É uma estimativa, não uma garantia: o prazo real
              depende da região de entrega e do serviço dos Correios.
            </p>
          )}
        </div>
      )}

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
          mesmo no, por construcao.
          DIVIDA PAGA EM 16/08/2026, e a historia importa: ate aqui esta
          linha nao passava valor nenhum e o comentario explicava que
          pedido.freteCentavos era sempre 0 e DELIBERADAMENTE nao exibido,
          porque nao havia politica de frete decidida e "R$ 0,00"
          prometeria frete gratis que ninguem tinha decidido dar. A politica
          passou a existir naquele dia (cotacao pela API do Clube Envios,
          §13): a rota do checkout cota pelo CEP e grava o valor em
          pedidos.frete_centavos antes do INSERT — obrigatoriamente antes,
          porque a coluna e congelada pelo trigger de imutabilidade. O que
          esta tela mostra agora e esse valor real, cobrado de verdade, e
          nao mais um silencio. O `| null` de LinhaFrete continua existindo
          para a VITRINE, que nao conhece o CEP do visitante e por isso nao
          tem valor nenhum a mostrar.
          `prazoDias` fica de fora AQUI de proposito, embora o componente
          aceite: o prazo desta tela ja aparece la em cima, na caixa de
          entrega, com a ressalva de §13 grudada nele. Passa-lo tambem para
          esta linha imprimiria o mesmo numero duas vezes na mesma pagina, e
          a segunda copia viria sem a ressalva — que e justamente a parte que
          impede o comprador de ler estimativa como data marcada. As palavras
          sao as mesmas do componente ("dias uteis") para que as duas telas
          nao descrevam a mesma cotacao com unidades diferentes.
        */}
        <LinhaFrete valor={pedido.freteCentavos} />
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

      {/*
        OS DOIS confirmacao__aviso DE 'pago' E 'reembolsado' NAO SUMIRAM —
        MUDARAM DE LUGAR. As frases exatas que ficavam aqui embaixo ("Pagamento
        confirmado. Você receberá um e-mail..." e "Este pedido foi reembolsado.
        O valor volta...") foram absorvidas palavra por palavra pelas
        `descricao` de ROTULOS_STATUS (src/lib/pedido-status.ts) e agora sao
        renderizadas pela linha do tempo, na etapa em que o pedido esta. Manter
        os dois blocos aqui alem disso imprimiria a MESMA frase duas vezes na
        mesma tela — foi por isso que sairam, e nao porque a promessa deixou de
        valer.
        A unica frase que precisou de versao propria por canal e a de 'pago'
        para a venda de balcao, que prometia aviso de envio a quem ja levou o
        kit; ela mora em DESCRICAO_PRESENCIAL, no componente da linha do tempo,
        com o motivo escrito.
      */}
    </section>
  )
}
