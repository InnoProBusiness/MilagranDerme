import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AbasAdmin, hrefDaAbaAtual, SairDoPainel } from '@/components/navegacao-admin'

// usePathname() exige um App Router montado, inexistente em jsdom puro. O
// caminho e injetado por este mock para cada teste escolher em que tela do
// painel a navegacao esta sendo renderizada.
let caminhoAtual = '/admin'
vi.mock('next/navigation', () => ({
  usePathname: () => caminhoAtual,
}))

// As abas de verdade, na ordem do componente: e sobre elas que a regra precisa
// valer, e nao sobre um par inventado de caminhos.
const HREFS = ['/admin', '/admin/vendas', '/admin/estoque', '/admin/logistica', '/admin/leads']

describe('hrefDaAbaAtual', () => {
  /**
   * O caso que obriga a funcao a existir, e que a PRIMEIRA versao deste arquivo
   * errava: TODA rota do painel comeca por '/admin', entao casar aba por aba
   * com startsWith marcaria "Resumo" como aberta nas cinco telas. Duas abas com
   * aria-current="page" ao mesmo tempo nao sao so um detalhe visual — sao dois
   * "lugar atual" anunciados no mesmo documento.
   */
  it('escolhe a aba mais especifica, e nao a raiz do painel', () => {
    expect(hrefDaAbaAtual('/admin/vendas', HREFS)).toBe('/admin/vendas')
  })

  it('marca a raiz quando o caminho e exatamente o dela', () => {
    expect(hrefDaAbaAtual('/admin', HREFS)).toBe('/admin')
  })

  // Uma subrota futura (/admin/vendas/1042) mantem "Vendas" marcada: quem
  // navegou para dentro de uma secao continua dentro dela.
  it('marca a secao tambem em subcaminhos dela', () => {
    expect(hrefDaAbaAtual('/admin/vendas/1042', HREFS)).toBe('/admin/vendas')
  })

  // A armadilha do prefixo sem barra: '/admin/vendas-antigas' NAO e uma
  // subrota de '/admin/vendas' — cai na raiz, que e o ancestral de verdade.
  it('nao confunde secao com outra que so comeca igual', () => {
    expect(hrefDaAbaAtual('/admin/vendas-antigas', HREFS)).toBe('/admin')
  })

  // Fora do painel nao ha aba atual nenhuma — e a funcao diz isso em vez de
  // devolver a primeira da lista.
  it('nao marca nada fora do painel', () => {
    expect(hrefDaAbaAtual('/comprar', HREFS)).toBeNull()
  })
})

describe('AbasAdmin', () => {
  it('marca exatamente uma aba como atual', () => {
    caminhoAtual = '/admin/estoque'
    render(<AbasAdmin />)

    const atuais = screen.getAllByRole('link').filter(
      (link) => link.getAttribute('aria-current') === 'page',
    )

    expect(atuais).toHaveLength(1)
    expect(atuais[0]).toHaveTextContent('Estoque')
  })

  // As secoes de §17 vivem numa lista so, e e ela que faz uma tela nova
  // aparecer em todas as outras de uma vez. Campanhas entrou em 19/08/2026.
  it('lista as secoes do painel, na ordem', () => {
    caminhoAtual = '/admin'
    render(<AbasAdmin />)

    const rotulos = screen.getAllByRole('link').map((link) => link.textContent)
    expect(rotulos).toEqual(['Resumo', 'Vendas', 'Estoque', 'Logística', 'Campanhas', 'Leads'])
  })
})

describe('SairDoPainel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * SEGURANCA: sair tem que chamar a rota que REVOGA a sessao no banco, e nao
   * apenas limpar algo no navegador. O painel e aberto em maquina compartilhada
   * e a sessao dura 12 horas — apagar o cookie sem revogar deixaria o token
   * valendo para quem o tivesse copiado.
   *
   * O teste usa a resposta de FALHA de proposito: no caminho de sucesso o
   * componente navega com location.assign, que jsdom nao implementa. Testar o
   * desfecho ruim prova a chamada (que e o que importa aqui) e ainda cobre a
   * mensagem que a rota manda mostrar quando a revogacao nao aconteceu.
   */
  it('SEGURANCA: chama DELETE /api/sessao e avisa quando a revogacao falha', async () => {
    const fetchMock = vi.fn(async (entrada: string, init?: RequestInit) => {
      void entrada
      void init
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'nao_foi_possivel_encerrar_a_sessao' }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SairDoPainel />)
    await userEvent.click(screen.getByRole('button', { name: /^sair$/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessao')
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE')

    expect(await screen.findByRole('status')).toHaveTextContent(
      /não foi possível encerrar a sessão/i,
    )
  })
})
