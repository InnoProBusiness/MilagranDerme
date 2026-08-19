import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  Vitrine,
  diminuirQuantidade,
  aumentarQuantidade,
  tetoDeQuantidade,
} from '@/components/vitrine'
import { QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { avisoDeEscassez } from '@/lib/escassez'
import { TEXTO_FRETE_A_COTAR } from '@/components/linha-frete'
import { deInteiro } from '@/lib/money'

// deInteiro(), nunca `100000 as never`. Este preco alimenta as assercoes de
// dinheiro abaixo (R$ 1.000,00 unitario, R$ 3.000,00 no subtotal e no
// total): `as never` desliga o construtor de Centavos e com ele toda a
// validacao de runtime, entao um fixture com 19.9 renderizaria R$ 0,20 em
// vez de estourar — um erro de 100x que o tipo existe justamente para pegar.
const KITS = [{
  id: 'k1', slug: 'kit-milagran', nome: 'Kit Milagran',
  descricao: 'Kit de limpeza de pele instantanea.',
  precoCentavos: deInteiro(100000), unidades: 1, sku: 'MG-KIT-001',
  anvisaRegistro: null, anvisaDispensado: false, ativo: true, ordem: 1,
  // Peso e dimensoes fazem parte de Kit desde que a cotacao de frete passou
  // a le-los do cadastro (src/repositories/produtos.ts). A vitrine nao usa
  // nenhum dos quatro — ela nao conhece o CEP do visitante e por isso nao
  // cota nada —, mas o fixture precisa ser um Kit inteiro para o compilador
  // continuar cobrando a forma do tipo aqui.
  pesoGramas: 760, alturaCm: 6, larguraCm: 18, comprimentoCm: 23,
}]

// O TAMANHO DO LOTE E O DO EVENTO (50 kits, §2/§4 — migrations/1755300700000_seed_estoque.sql),
// para os testes exercitarem os mesmos numeros do dia 25/08.
const LOTE = 50

/**
 * As mensagens vem de `avisoDeEscassez`, NUNCA escritas a mao aqui. Se este
 * arquivo repetisse a copy, ele passaria a ser uma quinta fonte da mesma frase
 * — exatamente o problema que src/lib/escassez.ts existe para nao ter — e o
 * teste continuaria verde com a vitrine escrevendo a sua propria versao do
 * texto. Comparando com a saida do modulo, o teste prova o que interessa: a
 * tela mostra a frase COMBINADA, seja ela qual for.
 */
function escassezDe(disponivel: number) {
  return { disponivel, total: LOTE, aviso: avisoDeEscassez(disponivel, LOTE) }
}

describe('Vitrine', () => {
  it('mostra o preco formatado em reais', () => {
    render(<Vitrine kits={KITS} representante={null} escassez={null} cupom="" />)
    expect(screen.getByText('R$ 1.000,00')).toBeDefined()
  })

  it('recalcula subtotal e total ao aumentar a quantidade', async () => {
    render(<Vitrine kits={KITS} representante={null} escassez={null} cupom="" />)
    const aumentar = screen.getByRole('button', { name: /aumentar/i })
    await userEvent.click(aumentar)
    await userEvent.click(aumentar)
    expect(screen.getByTestId('subtotal')).toHaveTextContent('R$ 3.000,00')
    expect(screen.getByTestId('total')).toHaveTextContent('R$ 3.000,00')
  })

  it('mantem subtotal, frete e total consistentes na quantidade 3', async () => {
    render(<Vitrine kits={KITS} representante={null} escassez={null} cupom="" />)
    const aumentar = screen.getByRole('button', { name: /aumentar/i })
    await userEvent.click(aumentar)
    await userEvent.click(aumentar)
    expect(screen.getByTestId('quantidade')).toHaveTextContent('3')
    expect(screen.getByTestId('subtotal')).toHaveTextContent('R$ 3.000,00')
    expect(screen.getByTestId('frete')).toHaveTextContent(TEXTO_FRETE_A_COTAR)
    expect(screen.getByTestId('total')).toHaveTextContent('R$ 3.000,00')
  })

  // Guarda o QUE O USUARIO VE: o botao "Diminuir" fica desabilitado exatamente
  // na quantidade minima e volta a habilitar assim que ela sobe. Isto e o que
  // realmente impede o clique de derrubar a quantidade abaixo de 1 na UI —
  // por isso e testado diretamente, em vez de inferido a partir do valor
  // mostrado (um clique num botao disabled nao dispara o handler, entao
  // checar so o texto da quantidade depois de um clique nao prova nada sobre
  // este botao especificamente).
  it('desabilita "Diminuir" na quantidade minima e habilita apos incrementar', async () => {
    render(<Vitrine kits={KITS} representante={null} escassez={null} cupom="" />)
    const diminuir = screen.getByRole('button', { name: /diminuir/i })
    expect(diminuir).toBeDisabled()
    expect(screen.getByTestId('quantidade')).toHaveTextContent('1')

    await userEvent.click(screen.getByRole('button', { name: /aumentar/i }))
    expect(diminuir).not.toBeDisabled()
  })

  // Mesma logica para o teto, alcancado programaticamente a partir da
  // constante (nao um "19" magico escrito a mao no teste).
  it('desabilita "Aumentar" ao atingir QUANTIDADE_MAXIMA', async () => {
    render(<Vitrine kits={KITS} representante={null} escassez={null} cupom="" />)
    const aumentar = screen.getByRole('button', { name: /aumentar/i })
    for (let i = 1; i < QUANTIDADE_MAXIMA; i++) {
      await userEvent.click(aumentar)
    }
    expect(screen.getByTestId('quantidade')).toHaveTextContent(String(QUANTIDADE_MAXIMA))
    expect(aumentar).toBeDisabled()
  })

  // O `disabled` do botao e a defesa que o usuario ve, mas o clamp
  // aritmetico por baixo dele (Math.max/Math.min) e a segunda linha de
  // defesa e precisa de um teste proprio que quebre se ela for removida —
  // chamando a funcao pura direto, sem passar por nenhum clique ou pelo
  // atributo disabled.
  it('diminuirQuantidade nunca desce abaixo de 1 (clamp puro, sem clique)', () => {
    expect(diminuirQuantidade(1)).toBe(1)
    expect(diminuirQuantidade(2)).toBe(1)
    expect(diminuirQuantidade(5)).toBe(4)
  })

  it('aumentarQuantidade nunca passa de QUANTIDADE_MAXIMA (clamp puro, sem clique)', () => {
    expect(aumentarQuantidade(QUANTIDADE_MAXIMA, null)).toBe(QUANTIDADE_MAXIMA)
    expect(aumentarQuantidade(QUANTIDADE_MAXIMA - 1, null)).toBe(QUANTIDADE_MAXIMA)
    expect(aumentarQuantidade(1, null)).toBe(2)
  })

  it('DINHEIRO: mostra "a cotar" no frete, nunca R$ 0,00', () => {
    render(<Vitrine kits={KITS} representante={null} escassez={escassezDe(12)} cupom="" />)
    const frete = screen.getByTestId('frete')
    expect(frete).toHaveTextContent(TEXTO_FRETE_A_COTAR)
    // O TESTE INTEIRO E ESTA LINHA. A vitrine nao conhece o CEP do visitante,
    // entao nao ha valor a mostrar — e "R$ 0,00" nao seria "sem valor", seria
    // a loja prometendo frete gratis que ninguem decidiu (ver o cabecalho de
    // src/components/linha-frete.tsx). Vale inclusive com lote presencial na
    // tela: ter estoque nao cota frete.
    expect(frete).not.toHaveTextContent('R$ 0,00')
  })

  it('avisa que o registro ANVISA esta em breve quando nao ha numero', () => {
    render(<Vitrine kits={KITS} representante={null} escassez={null} cupom="" />)
    expect(screen.getByTestId('anvisa')).toHaveTextContent(/em breve/i)
  })

  it('mostra o numero ANVISA quando ele existe', () => {
    render(
      <Vitrine
        kits={[{ ...KITS[0]!, anvisaRegistro: '25351.000123/2026-01' }]}
        representante={null}
        escassez={null}
        cupom=""
      />,
    )
    expect(screen.getByTestId('anvisa')).toHaveTextContent('25351.000123/2026-01')
  })

  /**
   * A situacao REAL do kit do lancamento desde 18/08/2026: o cliente declarou
   * o enquadramento na Lei 15.154/2025 (producao artesanal, dispensada de
   * registro previo) e a migration 1755500000000 gravou a flag. "Em breve"
   * prometia um numero que nunca vira; a tela agora afirma a dispensa, citando
   * a lei — e NUNCA a palavra "aprovado", porque dispensa nao e aprovacao.
   */
  it('kit dispensado mostra a Lei 15.154/2025 em vez de "em breve"', () => {
    render(
      <Vitrine
        kits={[{ ...KITS[0]!, anvisaDispensado: true }]}
        representante={null}
        escassez={null}
        cupom=""
      />,
    )
    const anvisa = screen.getByTestId('anvisa')
    expect(anvisa).toHaveTextContent('Lei nº 15.154/2025')
    expect(anvisa).toHaveTextContent(/dispensado de registro/i)
    expect(anvisa).not.toHaveTextContent(/em breve/i)
    expect(anvisa).not.toHaveTextContent(/aprovado/i)
  })

  it('identifica o representante quando a vitrine e dele', () => {
    render(
      <Vitrine kits={KITS} representante={{ nome: 'Maria', slug: 'maria' }} escassez={null} cupom="" />,
    )
    expect(screen.getByText(/Maria/)).toBeDefined()
  })

  it('mostra mensagem honesta quando nao ha kit disponivel', () => {
    render(<Vitrine kits={[]} representante={null} escassez={null} cupom="" />)
    expect(screen.getByText('Nenhum kit disponivel no momento.')).toBeDefined()
  })

  // ---------- §9: valor unitario ----------

  /**
   * DINHEIRO: a linha nova do resumo mostra o preco de UMA unidade e continua
   * mostrando o de uma unidade depois de a quantidade subir. O risco que ela
   * cobre e o de alguem "corrigir" a linha para o total da linha do carrinho:
   * ai a tela teria duas linhas dizendo R$ 3.000,00 e nenhuma dizendo de onde
   * o numero saiu.
   */
  it('DINHEIRO: mantem "Valor unitário" no preco de uma unidade ao subir a quantidade', async () => {
    render(<Vitrine kits={KITS} representante={null} escassez={null} cupom="" />)
    expect(screen.getByTestId('valor-unitario')).toHaveTextContent('Valor unitário: R$ 1.000,00')

    const aumentar = screen.getByRole('button', { name: /aumentar/i })
    await userEvent.click(aumentar)
    await userEvent.click(aumentar)

    expect(screen.getByTestId('valor-unitario')).toHaveTextContent('Valor unitário: R$ 1.000,00')
    expect(screen.getByTestId('subtotal')).toHaveTextContent('R$ 3.000,00')
  })

  /**
   * As tres linhas do resumo mostram o MESMO valor formatado quando a
   * quantidade e 1 (unitario = subtotal = total, porque o frete ainda nao foi
   * cotado). Cada uma precisa continuar identificavel sozinha — pelo rotulo
   * dentro do proprio texto e pelo data-testid —, senao nem leitor de tela nem
   * teste consegue dizer qual esta olhando.
   */
  it('distingue valor unitario, subtotal e total quando os tres tem o mesmo valor', () => {
    render(<Vitrine kits={KITS} representante={null} escassez={null} cupom="" />)
    expect(screen.getByTestId('valor-unitario')).toHaveTextContent('Valor unitário: R$ 1.000,00')
    expect(screen.getByTestId('subtotal')).toHaveTextContent('Subtotal: R$ 1.000,00')
    expect(screen.getByTestId('total')).toHaveTextContent('Total: R$ 1.000,00 + frete')
  })

  /**
   * A palavra "Total" nao pode fechar uma conta que ainda nao fechou.
   *
   * A vitrine nao conhece o CEP, entao o frete e desconhecido nesta tela — a
   * linha logo acima diz isso. Ate 17/08/2026 a linha de total imprimia so o
   * numero do produto, e quem lesse "Total: R$ 1.000,00" pagaria R$ 1.023,50
   * no checkout. Pouco dinheiro, superficie errada: e a tela principal de
   * compra.
   */
  it('o total da vitrine nunca se apresenta como valor final', () => {
    render(<Vitrine kits={KITS} representante={null} escassez={null} cupom="" />)

    const total = screen.getByTestId('total')
    expect(total).toHaveTextContent('+ frete')
    // E continua coerente com a linha de frete, que diz de onde vem o resto.
    expect(screen.getByTestId('frete')).toHaveTextContent(TEXTO_FRETE_A_COTAR)
  })

  // ---------- §5 e §11: escassez do lote presencial ----------

  it('mostra o contador e a frase combinada do lote presencial', () => {
    render(<Vitrine kits={KITS} representante={null} escassez={escassezDe(8)} cupom="" />)
    expect(screen.getByTestId('kits-disponiveis')).toHaveTextContent('Kits disponíveis: 8 de 50')
    expect(screen.getByTestId('aviso-escassez'))
      .toHaveTextContent(avisoDeEscassez(8, LOTE).mensagem)
    // A classe de nivel e o contrato com o CSS (.escassez--poucos e irmas em
    // src/app/globals.css): sem ela o bloco fica cinza e o alarme visual some.
    expect(screen.getByTestId('escassez').className).toContain('escassez--poucos')
  })

  /**
   * ESTADO VAZIO HONESTO: sem lote presencial cadastrado nao existe numero
   * verdadeiro para mostrar, entao a tela nao mostra numero nenhum — nao
   * inventa "0", que anunciaria um esgotamento que nunca aconteceu.
   */
  it('nao mostra contador nenhum quando nao ha lote presencial', () => {
    render(<Vitrine kits={KITS} representante={null} escassez={null} cupom="" />)
    expect(screen.queryByTestId('escassez')).toBeNull()
    expect(screen.queryByTestId('kits-disponiveis')).toBeNull()
    expect(screen.queryByTestId('aviso-escassez')).toBeNull()
  })

  it('troca a CTA para "COMPRAR ONLINE" quando o lote presencial esgota', () => {
    render(<Vitrine kits={KITS} representante={null} escassez={escassezDe(0)} cupom="" />)

    expect(screen.getByTestId('cta')).toHaveTextContent('COMPRAR ONLINE')
    // Esgotado precisa ser inconfundivel: o bloco troca de nivel (e de cor, no
    // CSS) e o numerao vira selo escrito.
    expect(screen.getByTestId('escassez').className).toContain('escassez--esgotado')
    expect(screen.getByTestId('escassez')).toHaveTextContent(/esgotado/i)
    // A CTA continua LEVANDO a algum lugar: o lote do evento acabou, a loja
    // nao. Um botao morto aqui perderia a venda online, que nao tem teto (§4).
    expect(screen.getByTestId('cta').getAttribute('href')).toContain('/checkout?kit=kit-milagran')
  })

  it('mantem a CTA em "Continuar" enquanto ha lote presencial', () => {
    render(<Vitrine kits={KITS} representante={null} escassez={escassezDe(3)} cupom="" />)
    expect(screen.getByTestId('cta')).toHaveTextContent('Continuar')
    expect(screen.getByTestId('cta')).not.toHaveTextContent('COMPRAR ONLINE')
  })

  // ---------- clamp contra o disponivel presencial ----------

  /**
   * O QUE O USUARIO VE: com 3 kits na caixa, o stepper para em 3 — muito antes
   * de QUANTIDADE_MAXIMA. Sao dois tetos independentes, e este teste so passa
   * se o segundo existir de verdade (com apenas o teto do banco, a quantidade
   * chegaria a 6 depois de seis cliques).
   */
  it('desabilita "Aumentar" no disponivel presencial, antes de QUANTIDADE_MAXIMA', async () => {
    const NA_CAIXA = 3
    // Premissa do teste, asseverada em vez de suposta: se QUANTIDADE_MAXIMA
    // encolhesse ate NA_CAIXA, o teste passaria sem provar nada sobre o
    // segundo teto — os dois limites coincidiriam.
    expect(NA_CAIXA).toBeLessThan(QUANTIDADE_MAXIMA)

    render(<Vitrine kits={KITS} representante={null} escassez={escassezDe(NA_CAIXA)} cupom="" />)
    const aumentar = screen.getByRole('button', { name: /aumentar/i })

    for (let i = 0; i < NA_CAIXA + 3; i++) {
      await userEvent.click(aumentar)
    }

    expect(screen.getByTestId('quantidade')).toHaveTextContent(String(NA_CAIXA))
    expect(aumentar).toBeDisabled()
  })

  /**
   * DECISAO DELIBERADA (ver o comentario de tetoDeQuantidade): lote esgotado
   * NAO trava o stepper em 1. A compra passa a ser online, e o canal online e
   * pre-venda sem teto (§4) — travar em 1 aplicaria o limite da caixa do
   * evento a uma compra que nao sai mais dessa caixa.
   */
  it('nao trava a quantidade em 1 depois de o lote presencial esgotar', async () => {
    render(<Vitrine kits={KITS} representante={null} escassez={escassezDe(0)} cupom="" />)
    const aumentar = screen.getByRole('button', { name: /aumentar/i })

    await userEvent.click(aumentar)
    await userEvent.click(aumentar)

    expect(screen.getByTestId('quantidade')).toHaveTextContent('3')
    expect(aumentar).not.toBeDisabled()
  })

  // Segunda linha de defesa, chamada direta (mesmo motivo dos clamps antigos):
  // o `disabled` pode mudar amanha, a aritmetica precisa continuar coberta.
  it('aumentarQuantidade respeita o disponivel presencial (clamp puro, sem clique)', () => {
    expect(aumentarQuantidade(2, 3)).toBe(3)
    expect(aumentarQuantidade(3, 3)).toBe(3)
    // O teto do banco continua valendo quando a caixa e maior que ele: os dois
    // sao aplicados juntos, nunca um no lugar do outro.
    expect(aumentarQuantidade(QUANTIDADE_MAXIMA, LOTE)).toBe(QUANTIDADE_MAXIMA)
  })

  it('tetoDeQuantidade combina os dois tetos independentes', () => {
    // Sem lote presencial: so o teto do banco.
    expect(tetoDeQuantidade(null)).toBe(QUANTIDADE_MAXIMA)
    // Caixa menor que o teto do banco: manda a caixa.
    expect(tetoDeQuantidade(3)).toBe(3)
    // Caixa maior: manda o teto do banco.
    expect(tetoDeQuantidade(LOTE)).toBe(QUANTIDADE_MAXIMA)
    // Esgotado (e ate saldo negativo, que existe por ajuste de inventario):
    // o teto volta a ser o do banco, porque a venda vira online.
    expect(tetoDeQuantidade(0)).toBe(QUANTIDADE_MAXIMA)
    expect(tetoDeQuantidade(-3)).toBe(QUANTIDADE_MAXIMA)
    // SUM() do Postgres chegando como NULL vira NaN no caminho ate aqui. Um
    // teto NaN desabilitaria o botao "+" para sempre, em silencio.
    expect(tetoDeQuantidade(Number.NaN)).toBe(QUANTIDADE_MAXIMA)
    // Fracionario nao existe em kit: 3.9 kits sao 3 kits.
    expect(tetoDeQuantidade(3.9)).toBe(3)
  })

  /**
   * O elo da campanha (19/08/2026). A vitrine e o lugar onde o link de
   * desconto REALMENTE cai — o que a representante divulga e /r/<slug>, nao a
   * home —, e o href do botao e montado a mao aqui dentro. Este teste existe
   * porque o cupom se perdia exatamente neste ponto: a URL de origem estava
   * certa, a compradora chegava ao checkout, e o desconto anunciado nao
   * aparecia.
   */
  it('CAMPANHA: o cupom do link sobrevive ate o checkout, com a quantidade escolhida', async () => {
    const usuario = userEvent.setup()
    render(<Vitrine kits={KITS} representante={null} escassez={null} cupom="PRE800" />)

    await usuario.click(screen.getByRole('button', { name: /aumentar/i }))

    expect(screen.getByTestId('cta')).toHaveAttribute(
      'href', '/checkout?kit=kit-milagran&q=2&cupom=PRE800',
    )
  })

  it('sem campanha, o link do botao continua o de sempre', () => {
    render(<Vitrine kits={KITS} representante={null} escassez={null} cupom="" />)
    expect(screen.getByTestId('cta')).toHaveAttribute('href', '/checkout?kit=kit-milagran&q=1')
  })
})
