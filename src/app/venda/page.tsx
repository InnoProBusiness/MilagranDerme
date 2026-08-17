import { redirect } from 'next/navigation'
import { usuarioDaSessaoNoServidor } from '@/lib/guarda'
import { saldoDoEstoque } from '@/repositories/estoque'
import { buscarKitAtivoPorSlug, listarKitsAtivos } from '@/repositories/produtos'
import { VendaPresencial } from '@/components/venda-presencial'

/**
 * O BALCAO DO EVENTO DE 25/08 (§10), pelo lado do servidor.
 *
 * Server Component fino: confere a sessao, le o kit e o saldo da caixa e
 * entrega tudo pronto para src/components/venda-presencial.tsx, que e onde
 * mora a tela de verdade. Nada de dado vivo e buscado no navegador — o
 * contador que o vendedor ve na primeira pintura ja e o numero do banco
 * naquele instante.
 *
 * `force-dynamic` porque as tres leituras abaixo sao vivas: a sessao muda
 * (expira, e revogada, o usuario e desativado), o preco do kit muda no
 * catalogo e o saldo do lote muda a cada venda do evento. Um snapshot
 * congelado no `next build` abriria o balcao do dia 25/08 anunciando o
 * estoque do dia do deploy.
 */
export const dynamic = 'force-dynamic'

type Props = {
  searchParams: Promise<{ kit?: string }>
}

export default async function PaginaVenda({ searchParams }: Props) {
  /**
   * A SESSAO E A PRIMEIRA COISA, antes de tocar em `searchParams` e antes de
   * qualquer leitura do banco. Nao e estilo: o cabecalho de src/lib/guarda.ts
   * avisa que uma tela que apenas ESCONDE conteudo com base neste retorno nao
   * esta protegida — os dados so podem ser buscados depois da checagem.
   *
   * `usuarioDaSessaoNoServidor` devolve null tanto para "nao ha cookie" quanto
   * para "o cookie nao vale mais" (expirado, revogado, usuario desativado), e
   * quem decide o que fazer com isso e cada pagina. Aqui a decisao e mandar
   * para o login com o destino embutido, para o vendedor voltar direto ao
   * balcao em vez de cair na tela padrao — /entrar so aceita destinos de uma
   * lista fechada, entao este parametro nao vira open redirect.
   *
   * `redirect()` lanca, entao o compilador ja sabe que daqui para baixo
   * `usuario` nao e null: nao ha caminho em que a tela renderize sem sessao.
   */
  const usuario = await usuarioDaSessaoNoServidor()
  if (!usuario) redirect(`/entrar?destino=${encodeURIComponent('/venda')}`)

  const sp = await searchParams

  // Mesma resolucao de /checkout e de GET /api/estoque: `?kit=<slug>` quando
  // ha mais de um kit no catalogo, senao o PRIMEIRO ATIVO — que e estavel
  // entre dois acessos porque `listarKitsAtivos` ordena por ordem e depois por
  // slug (src/repositories/produtos.ts), e nao pela varredura do Postgres.
  const kitPedido = sp.kit ? await buscarKitAtivoPorSlug(sp.kit) : null
  const kit = kitPedido ?? (await listarKitsAtivos())[0] ?? null

  if (!kit) {
    // ESTADO VAZIO HONESTO: catalogo vazio (ou kit desativado e nenhum outro
    // ativo) nao vira uma tela de venda com campos em branco esperando um kit
    // que nao existe — a rota recusaria com 422 `kit_indisponivel` depois de o
    // vendedor digitar tudo.
    return (
      <section className="section venda">
        <p className="kicker">Balcão do evento</p>
        <h1>Nenhum kit ativo no catálogo</h1>
        <div className="aviso aviso--erro" role="status">
          <strong className="aviso__titulo">Não é possível vender agora</strong>
          <p>
            Não há kit ativo para vender no balcão. Chame o administrador antes de
            atender o próximo da fila.
          </p>
        </div>
      </section>
    )
  }

  /**
   * SO O CANAL PRESENCIAL. Os dois estoques sao separados por decisao do
   * cliente (§4, e o cabecalho de src/repositories/estoque.ts): vender online
   * nao tira unidade da caixa do evento e vice-versa. Somar os dois aqui — ou
   * cair no online quando nao ha presencial — faria o balcao anunciar unidades
   * que estao em outro lugar.
   *
   * `null` = nao existe linha de estoque presencial para este kit. Sobe como
   * `null` ate a tela, que entao nao mostra contador nenhum em vez de inventar
   * um zero (ver SaldoDoBalcao em src/components/venda-presencial.tsx).
   *
   * LEITURA FORA DE TRANSACAO, e isso e proposital: este numero e um RETRATO,
   * bom para o vendedor se orientar e imprestavel para decidir uma venda.
   * Quem decide e `baixarEstoque` sob `FOR UPDATE`, dentro da transacao de
   * POST /api/vendas-presenciais — o unico lugar do sistema em que o saldo e
   * lido com a linha travada.
   */
  const saldo = await saldoDoEstoque(kit.id, 'presencial')

  return (
    <VendaPresencial
      // Nome e papel, e mais nada: o resto de `Usuario` (id, e-mail) nao tem
      // uso na tela e id de usuario nao precisa viajar para o HTML de uma
      // pagina que fica aberta num tablet em cima de um balcao.
      vendedor={{ nome: usuario.nome, papel: usuario.papel }}
      kit={kit}
      saldoInicial={saldo === null ? null : { disponivel: saldo.disponivel, total: saldo.total }}
    />
  )
}
