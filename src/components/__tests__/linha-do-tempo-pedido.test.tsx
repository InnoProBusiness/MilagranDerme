import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { LinhaDoTempoPedido, etapasDoPedido } from '@/components/linha-do-tempo-pedido'
import { ROTULOS_STATUS } from '@/lib/pedido-status'

// Instantes fixos, com hora que NAO cai perto da virada do dia em Sao Paulo:
// o que a tela precisa provar e a data civil brasileira, e um fixture as 23h
// UTC passaria a valer para o dia seguinte so por causa do fuso do runner.
const CRIADO_EM = new Date('2026-08-16T15:00:00Z')
const ENVIADO_EM = new Date('2026-08-20T15:00:00Z')

// O helper deriva o tipo de entrega do canal, que e o que o banco garante:
// toda venda de balcao e 'retirada' (CHECK pedido_presencial_e_retirada) e o
// online destes casos e o de envio. Os casos de RETIRADA ONLINE — o par que
// nao existia antes de 19/08/2026 — tem helper proprio logo abaixo, porque e
// justamente a combinacao que nenhum destes exercita.
const so = (canal: 'online' | 'presencial', status: Parameters<typeof etapasDoPedido>[2]) =>
  etapasDoPedido(canal, canal === 'presencial' ? 'retirada' : 'envio', status).map((e) => e.status)

const soRetirada = (status: Parameters<typeof etapasDoPedido>[2]) =>
  etapasDoPedido('online', 'retirada', status).map((e) => e.status)

describe('etapasDoPedido — o caminho de cada canal', () => {
  it('o caminho online tem os sete estados de §12, na ordem', () => {
    expect(so('online', 'pendente')).toEqual([
      'pendente', 'aguardando_pagamento', 'pago', 'em_preparacao', 'enviado',
      'em_transito', 'entregue',
    ])
  })

  /**
   * RETIRADA ONLINE: o par que nao existia antes de 19/08/2026 e que nenhum dos
   * outros casos exercita. O caminho e o mesmo do balcao — nao ha postagem —,
   * mas o CANAL e outro, e e o canal que decide a copy.
   */
  it('o caminho da retirada online termina em entregue, sem postagem', () => {
    expect(soRetirada('pago')).toEqual([
      'pendente', 'aguardando_pagamento', 'pago', 'entregue',
    ])
    for (const postagem of ['em_preparacao', 'enviado', 'em_transito']) {
      expect(soRetirada('pago')).not.toContain(postagem)
    }
  })

  // §2: comprou, pagou, levou. Nao ha preparacao, postagem nem transito.
  it('o caminho presencial termina em entregue logo depois de pago', () => {
    expect(so('presencial', 'pago')).toEqual([
      'pendente', 'aguardando_pagamento', 'pago', 'entregue',
    ])
  })

  it('marca o passado, o presente e o futuro do pedido', () => {
    expect(etapasDoPedido('online', 'envio', 'enviado')).toEqual([
      { status: 'pendente', estado: 'feito' },
      { status: 'aguardando_pagamento', estado: 'feito' },
      { status: 'pago', estado: 'feito' },
      { status: 'em_preparacao', estado: 'feito' },
      { status: 'enviado', estado: 'atual' },
      { status: 'em_transito', estado: 'futuro' },
      { status: 'entregue', estado: 'futuro' },
    ])
  })

  // O corte de um pedido interrompido e o que a maquina de estados permite
  // afirmar, e nada alem: reembolso so vem de pedido pago, cancelamento so
  // vem de pedido nao pago.
  it('reembolsado encerra a linha depois de pago, sem prometer entrega', () => {
    const etapas = etapasDoPedido('online', 'envio', 'reembolsado')
    expect(etapas.at(-1)).toEqual({ status: 'reembolsado', estado: 'interrompido' })
    expect(etapas.map((e) => e.status)).not.toContain('entregue')
    expect(etapas.map((e) => e.status)).not.toContain('enviado')
    expect(etapas.find((e) => e.status === 'pago')?.estado).toBe('feito')
  })

  it('cancelado encerra a linha logo depois da criacao do pedido', () => {
    expect(etapasDoPedido('presencial', 'retirada', 'cancelado')).toEqual([
      { status: 'pendente', estado: 'feito' },
      { status: 'cancelado', estado: 'interrompido' },
    ])
  })

  // O FATO manda no rotulo: se a operacao postou um pedido presencial (o
  // painel permite, e nem todo kit do evento sai na mao), a linha do tempo
  // nao pode omitir o estado em que o pedido realmente esta.
  it('cai no caminho completo quando o status nao existe no caminho do canal', () => {
    const etapas = etapasDoPedido('presencial', 'retirada', 'em_transito')
    expect(etapas.map((e) => e.status)).toContain('em_transito')
    expect(etapas.find((e) => e.status === 'em_transito')?.estado).toBe('atual')
  })

  // Nenhum caminho pode sair vazio: uma linha do tempo sem itens seria uma
  // tela de acompanhamento que nao acompanha nada.
  it('nenhum status produz linha do tempo vazia', () => {
    for (const status of Object.keys(ROTULOS_STATUS) as Array<keyof typeof ROTULOS_STATUS>) {
      expect(etapasDoPedido('online', 'envio', status).length).toBeGreaterThan(0)
      expect(etapasDoPedido('online', 'retirada', status).length).toBeGreaterThan(0)
      expect(etapasDoPedido('presencial', 'retirada', status).length).toBeGreaterThan(0)
    }
  })
})

describe('LinhaDoTempoPedido', () => {
  it('desenha uma lista acessivel com o passo atual marcado', () => {
    render(<LinhaDoTempoPedido canal="online" tipoEntrega="envio" status="em_preparacao" />)

    const lista = screen.getByRole('list', { name: 'Andamento do pedido' })
    const itens = within(lista).getAllByRole('listitem')
    expect(itens).toHaveLength(7)

    const atuais = itens.filter((li) => li.getAttribute('aria-current') === 'step')
    expect(atuais).toHaveLength(1)
    expect(atuais[0]).toHaveTextContent(ROTULOS_STATUS.em_preparacao.titulo)
  })

  // So a etapa atual se explica — as outras oito frases de uma vez afogariam
  // justamente a que importa.
  it('mostra a descricao da etapa atual e nao a das outras', () => {
    render(<LinhaDoTempoPedido canal="online" tipoEntrega="envio" status="em_preparacao" />)
    expect(screen.getByText(ROTULOS_STATUS.em_preparacao.descricao)).toBeInTheDocument()
    expect(screen.queryByText(ROTULOS_STATUS.entregue.descricao)).toBeNull()
    expect(screen.queryByText(ROTULOS_STATUS.pago.descricao)).toBeNull()
  })

  it('mostra as duas unicas datas que existem no banco, no fuso do Brasil', () => {
    render(
      <LinhaDoTempoPedido
        canal="online" tipoEntrega="envio" status="em_transito"
        criadoEm={CRIADO_EM} enviadoEm={ENVIADO_EM}
      />,
    )
    expect(screen.getByText('Pedido feito em 16/08/2026')).toBeInTheDocument()
    expect(screen.getByText('Postado em 20/08/2026')).toBeInTheDocument()
  })

  // ESTADO VAZIO HONESTO: sem carimbo no banco, nenhuma data aparece — nada
  // de "—" nem de data aproximada, que viraria discussao de prazo.
  it('nao inventa data quando o pedido ainda nao foi postado', () => {
    render(<LinhaDoTempoPedido canal="online" tipoEntrega="envio" status="pago" criadoEm={CRIADO_EM} />)
    expect(screen.queryByText(/^Postado em/)).toBeNull()
  })

  it('nao mostra as etapas dos Correios para a compra do balcao', () => {
    render(<LinhaDoTempoPedido canal="presencial" tipoEntrega="retirada" status="pago" />)
    expect(screen.queryByText(ROTULOS_STATUS.enviado.titulo)).toBeNull()
    expect(screen.queryByText(ROTULOS_STATUS.em_transito.titulo)).toBeNull()
    expect(screen.getByText(ROTULOS_STATUS.entregue.titulo)).toBeInTheDocument()
  })

  // O defeito que esta sobrescrita existe para impedir: prometer aviso de
  // envio a quem ja saiu do evento com o kit na sacola (§2).
  it('nao promete aviso de envio para a venda presencial ja paga', () => {
    render(<LinhaDoTempoPedido canal="presencial" tipoEntrega="retirada" status="pago" />)
    expect(screen.queryByText(ROTULOS_STATUS.pago.descricao)).toBeNull()
    expect(screen.getByText(/entregue na hora, em mãos/i)).toBeInTheDocument()
  })

  it('mantem a descricao compartilhada quando o canal nao muda a promessa', () => {
    render(<LinhaDoTempoPedido canal="online" tipoEntrega="envio" status="pago" />)
    expect(screen.getByText(ROTULOS_STATUS.pago.descricao)).toBeInTheDocument()
  })

  it('encerra a linha no reembolso, com a etapa marcada como o ponto atual', () => {
    render(<LinhaDoTempoPedido canal="online" tipoEntrega="envio" status="reembolsado" />)
    const itens = within(screen.getByTestId('linha-do-tempo')).getAllByRole('listitem')
    expect(itens.at(-1)).toHaveTextContent(ROTULOS_STATUS.reembolsado.titulo)
    expect(itens.at(-1)).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText(ROTULOS_STATUS.reembolsado.descricao)).toBeInTheDocument()
  })
})
