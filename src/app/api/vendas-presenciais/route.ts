import { z } from 'zod'
import { getDb } from '@/lib/db'
import { exigirPapel } from '@/lib/guarda'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { deInteiro, type Centavos } from '@/lib/money'
import { criarPagamentoMP, ErroMercadoPago, type RespostaPagamentoMP } from '@/lib/mercadopago'
import { mapearStatusMP } from '@/lib/pedido-status'
import { mensagemDoPagamento } from '@/lib/pagamento-mensagens'
import { enviarConfirmacaoDePedido } from '@/lib/email-pedido'
import { buscarKitAtivoPorSlug } from '@/repositories/produtos'
import { salvarClienteComEndereco, CpfDivergenteError } from '@/repositories/clientes'
import { criarPedido, PrecoDivergenteError } from '@/repositories/pedidos'
import { baixarEstoque, EstoqueInsuficienteError } from '@/repositories/estoque'
import { abrirPagamento, vincularAoProvedor, type Pagamento } from '@/repositories/pagamentos'
import { conciliarPagamento, type ResultadoConciliacao } from '@/repositories/conciliacao'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * O BALCAO DO EVENTO DE 25/08 (§10 do documento do cliente de 16/08/2026).
 *
 * Uma pessoa esta na frente do vendedor, com o kit na mao, e a fila anda. Tudo
 * neste arquivo e escrito para essa cena, e e por isso que ele diverge da rota
 * do checkout online (src/app/api/pedidos/route.ts) em quatro pontos que valem
 * ser lidos juntos:
 *
 *   1. ESTOQUE BAIXA NA CRIACAO, nao no pagamento. No online a unidade so sai
 *      quando o dinheiro entra (§4: carrinho abandonado nao segura estoque, e a
 *      baixa mora dentro de conciliarPagamento, src/repositories/conciliacao.ts).
 *      Aqui a reserva e imediata porque o comprador leva o kit AGORA: entre o
 *      "confirmar venda" e o webhook do Pix cabem dois minutos de fila, e nesses
 *      dois minutos a caixa nao pode prometer a mesma unidade a mais ninguem.
 *   2. NAO HA ENDERECO. `salvarClienteComEndereco(cliente, null, trx)` — o balcao
 *      nao pergunta para onde entregar porque nao ha entrega
 *      (src/repositories/clientes.ts explica por que endereco forjado foi
 *      recusado).
 *   3. NAO HA FRETE. Ver FRETE_PRESENCIAL logo abaixo.
 *   4. HA SESSAO. O checkout e publico e por isso tem rate limit por IP; aqui
 *      quem entra e um vendedor autenticado — ver o comentario sobre rate limit
 *      no fim deste bloco.
 *
 * O QUE NAO MUDA: o pagamento passa pelo MESMO Mercado Pago e e confirmado pelo
 * MESMO webhook (decisao do cliente em 16/08, item 4). NAO EXISTE venda
 * "declarada" pelo vendedor: nenhum campo deste corpo diz que o pagamento
 * aconteceu, e nenhum caminho daqui marca pedido como pago por conta propria. O
 * que marca e conciliarPagamento, sobre a resposta do provedor ou sobre o
 * webhook. Um botao "recebi em dinheiro" nesta rota seria a forma mais curta de
 * transformar a planilha do evento em ficcao.
 *
 * SEM RATE LIMIT POR IP, e a ausencia e deliberada. src/app/api/pedidos/route.ts
 * tem o freio porque e anonimo e escreve CPF de terceiros; aqui a porta e
 * `exigirPapel` (src/lib/guarda.ts), que e controle de acesso de verdade. Pior:
 * no evento TODAS as vendas saem do mesmo celular, atras do mesmo IP (o WiFi do
 * local ou o CGNAT da operadora), entao um teto de 10 requisicoes por 10 minutos
 * pararia o balcao na 11a venda do dia — exatamente a pendencia ja registrada em
 * docs/superpowers/plans/2026-08-16-milagran-lancamento-25-08.md (§8, item 2).
 */

/**
 * FRETE ZERO AQUI NAO E "POLITICA INDEFINIDA".
 *
 * Ate 16/08/2026, src/app/api/pedidos/route.ts gravava `frete: deInteiro(0)`
 * embaixo de um comentario que dizia, com todas as letras, "PLACEHOLDER DE
 * POLITICA INDEFINIDA, nao frete gratis": a coluna pedidos.frete_centavos e NOT
 * NULL, precisava de um numero, e ninguem tinha decidido quanto cobrar. O zero
 * de la era uma divida.
 *
 * O zero DAQUI e um fato do negocio: venda presencial nao tem frete porque o kit
 * sai na mao do comprador (§2, "comprou → pagou → levou na hora"). Nao ha
 * transportadora, nao ha cotacao a fazer, nao ha valor a descobrir depois. E a
 * mesma distincao que src/lib/carrinho.ts registra no tipo ResumoCarrinho
 * ("ZERO AQUI NAO E MAIS POLITICA INDEFINIDA: e sem frete a somar, e tem dono")
 * e que src/components/linha-frete.tsx exprime recebendo `null` para "ainda nao
 * cotado" — um estado DIFERENTE de zero, que nenhuma tela pode imprimir como
 * "R$ 0,00".
 *
 * Consequencia pratica: nao existe caminho nesta rota que chame src/lib/frete.ts.
 * Se um dia o balcao passar a despachar alguma coisa, o valor tem que entrar no
 * INSERT — pedidos.frete_centavos e pedidos.total_centavos sao CONGELADOS pelo
 * trigger pedido_atribuicao_imutavel_trg e nao ha UPDATE de correcao depois.
 */
const FRETE_PRESENCIAL = deInteiro(0)

/**
 * Os campos da venda, comuns aos dois metodos de pagamento.
 *
 * CPF E OBRIGATORIO NO BALCAO, e isso e uma decisao tomada contra o instinto de
 * encurtar a fila. O contrato do plano listava `cpf?`; o opcional nao sobrevive
 * ao encontro com duas realidades:
 *
 *   1. O BANCO NAO TEM COMO REPRESENTAR A AUSENCIA. clientes.cpf e NOT NULL com
 *      CHECK cliente_cpf_digitos ('^[0-9]{11}$', migrations/1755000100000_clientes.sql).
 *      Aceitar a ausencia significaria INVENTAR onze digitos — e um CPF inventado
 *      e pior do que o endereco inventado que salvarClienteComEndereco
 *      (src/repositories/clientes.ts) ja recusou por escrito: endereco falso
 *      atrapalha a expedicao, CPF falso e documento de identidade de outra pessoa
 *      colado no cadastro de uma pessoa real, e ainda viaja para o campo `payer`
 *      da cobranca no Mercado Pago (src/lib/mercadopago.ts), onde vira registro
 *      fiscal.
 *   2. O PROVEDOR EXIGE. `identification: { type: 'CPF', number }` vai em toda
 *      cobranca criada por criarPagamentoMP, e Pix sem identificacao do pagador e
 *      recusado. Uma venda sem CPF nao seria uma venda mais rapida — seria uma
 *      venda que nao consegue ser cobrada.
 *
 * O CUSTO ESTA ASSUMIDO: onze digitos a mais por comprador na fila. Tornar o
 * campo opcional de verdade exige migration (coluna nullable + CHECK parcial) E
 * uma decisao de como cobrar sem identificacao — as duas coisas sao do cliente,
 * e nenhuma delas entra de contrabando por um `.optional()` no schema de uma
 * rota.
 *
 * Os formatos sao os MESMOS de src/app/api/pedidos/route.ts, de proposito: o
 * comprador que fecha no balcao e o mesmo que pode ter comprado online, cai no
 * mesmo cadastro por lower(email), e uma regra de formato mais frouxa aqui faria
 * a segunda compra dele levar CpfDivergenteError sem ninguem entender por que.
 */
const CAMPOS_DA_VENDA = {
  kitSlug: z.string().min(1),
  quantidade: z.number().int().min(1).max(QUANTIDADE_MAXIMA),
  nome: z.string().trim().min(3),
  email: z.string().email(),
  cpf: z.string().regex(/^\d{11}$/),
  whatsapp: z.string().regex(/^\d{10,13}$/),
}

/**
 * UNIAO DISCRIMINADA POR `metodo`, no molde exato de
 * src/app/api/pagamentos/route.ts — e nao o `metodo` solto que a tabela de rotas
 * do plano esbocou.
 *
 * O motivo e do provedor, nao de gosto: POST /v1/payments recusa uma cobranca de
 * cartao sem `token`, e esse token so pode ser gerado NO NAVEGADOR, pelo Payment
 * Brick. O numero do cartao nunca chega a este servidor — e o que mantem a
 * aplicacao fora do escopo de PCI. Entao ou o corpo carrega os campos do Brick,
 * ou "cartao" e uma opcao que falha no provedor depois de a venda ja estar
 * registrada, com a fila parada na frente do vendedor.
 *
 * Os nomes sao IDENTICOS aos de /api/pagamentos para que a tela de balcao
 * (src/components/venda-presencial.tsx) reaproveite, sem tradutor no meio, o
 * mesmo payload que o wizard do checkout ja monta.
 *
 * `.strict()` nos dois ramos: DINHEIRO NUNCA VEM DO CORPO. O preco sai do
 * catalogo (buscarKitAtivoPorSlug + montarCarrinho) e o frete e a constante
 * acima. Sem o strict, um `total` ou um `precoUnitarioCentavos` no corpo seria
 * apenas IGNORADO — e um teste que provasse "o valor gravado bateu com o
 * catalogo" continuaria verde enquanto a API aceitava a tentativa. Com ele, a
 * tentativa de manipulacao e um 422 explicito.
 */
const Corpo = z.discriminatedUnion('metodo', [
  z.object({
    metodo: z.literal('pix'),
    ...CAMPOS_DA_VENDA,
  }).strict(),
  z.object({
    metodo: z.literal('cartao'),
    // Token gerado no navegador pelo Payment Brick; o numero do cartao nao
    // passa por aqui. Mesma decisao (e mesmo comentario) de
    // src/app/api/pagamentos/route.ts.
    token: z.string().min(1),
    parcelas: z.number().int().min(1).max(12),
    metodoPagamentoId: z.string().min(1),
    emissorId: z.string().min(1).optional(),
    ...CAMPOS_DA_VENDA,
  }).strict(),
])

/**
 * O kit vendido no balcao nao tem linha de estoque no canal presencial.
 *
 * CLASSE LOCAL despachada por `instanceof`, no molde de RecusaDeCupom
 * (src/app/api/pedidos/route.ts): ela existe para atravessar o rollback da
 * transacao carregando a informacao de que a recusa e de NEGOCIO, e nao uma
 * falha de infraestrutura que mereceria 500.
 *
 * POR QUE RECUSAR, se baixarEstoque (src/repositories/estoque.ts) devolve
 * `false` nesse caso em vez de lancar: aquele `false` foi escolhido pensando no
 * OUTRO chamador — a conciliacao de um pagamento JA APROVADO, onde lancar
 * desfaria o COMMIT que marca o pedido como pago e deixaria o comprador
 * debitado. Aqui e o inverso exato: nada foi cobrado ainda, e seguir em frente
 * registraria uma venda de balcao que nao consome caixa nenhuma — o contador de
 * §11 continuaria anunciando 50 kits enquanto o vendedor entrega o 51o. A mesma
 * devolucao, dois chamadores, duas leituras corretas e opostas.
 */
class EstoqueNaoConfiguradoError extends Error {
  constructor(readonly kitSlug: string) {
    super(`estoque_nao_configurado: o kit ${kitSlug} nao tem linha de estoque no canal presencial`)
    this.name = 'EstoqueNaoConfiguradoError'
  }
}

/**
 * Unico ponto de leitura de uma mensagem de erro para logar. So `error.message`
 * e seguro: uma violacao de CHECK em `clientes` carrega a linha inteira — nome,
 * e-mail, CPF, whatsapp — na propriedade `detail` do erro do Postgres (ver o doc
 * comment de salvarClienteComEndereco em src/repositories/clientes.ts), e uma
 * violacao em estoque_movimentos carrega o pedido_id. Nunca logar nem devolver o
 * objeto de erro cru nem `detail`. Copiado de src/app/api/pedidos/route.ts, onde
 * a mesma regra ja vale.
 */
function mensagemSeguraDoErro(e: unknown): string {
  return e instanceof Error ? e.message : 'erro_desconhecido'
}

/**
 * Separa "Maria Aparecida da Silva" em first_name/last_name para o campo `payer`
 * do Mercado Pago. Nome sem sobrenome repete o proprio nome: o provedor recusa
 * last_name vazio.
 *
 * DUPLICADO de src/app/api/pagamentos/route.ts, conscientemente. Sao quatro
 * linhas puras e sem estado; importa-las de la traria junto o modulo inteiro
 * daquela rota, inclusive o contador de rate limit que vive no escopo do modulo
 * — e o balcao herdaria o teto por IP que este arquivo acabou de explicar por
 * que nao pode ter. No dia em que aparecer um terceiro chamador, o lugar dela e
 * src/lib, com os dois lados atualizados no mesmo commit.
 */
function separarNome(completo: string): { nome: string; sobrenome: string } {
  const partes = completo.trim().split(/\s+/)
  if (partes.length === 1) return { nome: partes[0], sobrenome: partes[0] }
  return { nome: partes[0], sobrenome: partes.slice(1).join(' ') }
}

export async function POST(req: Request) {
  // PRIMEIRA LINHA DA ROTA, antes de ler corpo e antes de tocar no banco: quem
  // nao tem sessao de vendedor nao chega a escrever nada. `admin` passa junto
  // por COBERTURA (src/lib/guarda.ts) — quem administra o evento tambem vende
  // nele. A uniao Usuario | Response e o que faz esquecer esta checagem nao
  // compilar.
  const usuario = await exigirPapel(req, ['vendedor'])
  if (usuario instanceof Response) return usuario

  const parsed = Corpo.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'dados_invalidos' }, { status: 422 })
  }
  const d = parsed.data

  const kit = await buscarKitAtivoPorSlug(d.kitSlug)
  if (!kit) return Response.json({ error: 'kit_indisponivel' }, { status: 422 })

  // O preco vem do catalogo, sempre. montarCarrinho tambem e quem aplica os
  // tetos de quantidade e de subtotal (src/lib/carrinho.ts) antes de qualquer
  // escrita. O frete entra explicito, em vez de cair no default do parametro,
  // para que o zero desta venda tenha um nome e um comentario — ver
  // FRETE_PRESENCIAL.
  const carrinho = montarCarrinho(
    [{
      kitId: kit.id, nome: kit.nome,
      precoUnitario: kit.precoCentavos, quantidade: d.quantidade,
    }],
    deInteiro(0),
    FRETE_PRESENCIAL,
  )

  let venda: { id: string; numero: number; token: string; totalCentavos: Centavos }

  try {
    venda = await getDb().transaction().execute(async (trx) => {
      // Cliente sem endereco (§10). O `null` nao e "esqueci de preencher": e o
      // valor que salvarClienteComEndereco (src/repositories/clientes.ts) recebe
      // para NAO tocar em `enderecos`, e e ele que mantem esta venda fora da
      // fila da expedicao (listarLogisticaAdmin so lista pedido com endereco).
      const { clienteId, enderecoId } = await salvarClienteComEndereco(
        { nome: d.nome, email: d.email, cpf: d.cpf, whatsapp: d.whatsapp },
        null,
        trx,
      )

      const pedido = await criarPedido({
        canal: 'presencial',
        // QUEM operou a venda. A coluna e congelada pelo trigger de
        // imutabilidade, entao o valor certo tem que entrar no INSERT — nao ha
        // "corrigir o vendedor" depois, e o relatorio de §17 (e a premiacao
        // amarrada a ele) sai daqui.
        vendedorId: usuario.id,
        // ATRIBUICAO DE COMISSAO: 'casa', sem representante. Nao e a mesma
        // pergunta que `canal` (os dois eixos sao ortogonais — ver
        // migrations/1755300100000_pedidos_canal_logistica.sql), e a resposta
        // 'casa' e deliberada: o cookie de atribuicao que o checkout online le
        // (src/app/api/pedidos/route.ts) mora no navegador de QUEM COMPRA. No
        // balcao o navegador e o do VENDEDOR, e ele e o mesmo o dia inteiro —
        // ler o cookie aqui atribuiria todas as vendas do evento ao ultimo link
        // de representante que aquele celular tiver aberto, uma vez, por
        // acidente. O CHECK pedido_origem_coerente ainda exige representante_id
        // NULL para 'casa'.
        origem: 'casa',
        representanteId: null,
        percentualComissao: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        desconto: deInteiro(0),
        frete: FRETE_PRESENCIAL,
        // prazoDiasEstimado fica ausente (null): nao ha entrega a estimar, e o
        // CHECK pedido_prazo_valido recusaria um 0 usado como "nao se aplica".
        itens: carrinho.linhas.map((l) => ({
          kitId: l.kitId,
          quantidade: l.quantidade,
          precoUnitarioCentavos: l.precoUnitario,
        })),
        clienteId,
        enderecoId,
      }, trx)

      // ---------------------------------------------------------------
      // A BAIXA DE ESTOQUE VEM AQUI, DEPOIS DE criarPedido, E TEM QUE VIR.
      //
      // Por que nao antes, se a intencao e "checar o estoque antes de vender":
      // o movimento de baixa referencia o pedido (estoque_movimentos.pedido_id,
      // NOT NULL para 'baixa' pelo CHECK movimento_pedido_coerente em
      // migrations/1755300000000_canal_e_estoque.sql). Sem o pedido gravado nao
      // existe a que amarrar a saida — e uma baixa sem venda do outro lado e
      // exatamente o tipo de lancamento que faz o livro-razao deixar de
      // explicar a si mesmo.
      //
      // A ordem tambem obedece a ORDEM DE LOCK DE TODO O SISTEMA: `pedidos`
      // primeiro, `estoques` depois (definida em
      // src/repositories/conciliacao.ts e repetida em
      // src/repositories/estoque.ts). Inverter em UM caminho basta para
      // deadlockar com o webhook do Mercado Pago, que trava as duas tabelas na
      // ordem canonica.
      //
      // Estar na MESMA transacao e o que importa para a promessa de §10: ou a
      // venda existe com a unidade baixada, ou nao existe nem uma coisa nem
      // outra. Nao ha estado intermediario em que o vendedor entregou o kit e o
      // contador nao mexeu.
      // ---------------------------------------------------------------
      const baixou = await baixarEstoque({
        kitId: kit.id,
        canal: 'presencial',
        pedidoId: pedido.id,
        quantidade: d.quantidade,
        // Texto do extrato do painel, no formato de src/repositories/conciliacao.ts
        // ("Pedido #1042") com a palavra que distingue a venda de balcao. Nao e
        // chave de nada: quem amarra o movimento a venda e pedido_id.
        motivo: `Venda presencial #${pedido.numero}`,
      }, trx)

      if (!baixou) throw new EstoqueNaoConfiguradoError(d.kitSlug)

      return {
        id: pedido.id,
        numero: pedido.numero,
        token: pedido.token,
        totalCentavos: pedido.totalCentavos,
      }
    })
  } catch (e) {
    const mensagem = mensagemSeguraDoErro(e)

    // Todo despacho abaixo e por `instanceof`, NUNCA por prefixo de string: um
    // `mensagem.startsWith(...)` amarra o codigo HTTP a uma frase repetida em
    // dois arquivos, e reescrever a frase no repositorio faria o balcao passar a
    // responder 500 em silencio, com a suite inteira verde. Mesmo raciocinio ja
    // escrito em src/app/api/pedidos/route.ts.

    // ACABARAM OS KITS DA CAIXA. Isto NAO e 500: e a resposta certa de um
    // sistema funcionando, e a tela do vendedor precisa dizer isso em voz alta
    // para quem esta na fila. 409 (conflito com o estado do recurso), com
    // mensagem propria — a copy de vitrine e contador mora em
    // src/lib/escassez.ts e fala com o COMPRADOR sobre o saldo; esta aqui fala
    // com o OPERADOR sobre a venda que acabou de ser recusada, e por isso diz
    // quantos restam (o vendedor pode fechar a venda com menos unidades).
    if (e instanceof EstoqueInsuficienteError) {
      console.error('[vendas-presenciais] venda recusada por estoque:', mensagem)
      return Response.json({
        error: 'estoque_esgotado',
        mensagem: e.disponivel > 0
          ? `Restam apenas ${e.disponivel} kit(s) na caixa do evento e esta venda pedia ${e.solicitado}. Ajuste a quantidade.`
          : 'Os kits do evento acabaram. Ofereça a compra online ao cliente.',
        disponivel: e.disponivel,
      }, { status: 409 })
    }

    // O kit existe no catalogo mas ninguem criou o estoque presencial dele.
    // Codigo PROPRIO, e nao reaproveitar 'estoque_esgotado': o conserto e
    // diferente (um ajuste no painel, nao "venda menos kits") e achatar os dois
    // faria o vendedor tentar a vida reduzindo a quantidade para sempre.
    if (e instanceof EstoqueNaoConfiguradoError) {
      console.error('[vendas-presenciais] venda recusada:', mensagem)
      return Response.json({
        error: 'estoque_nao_configurado',
        mensagem: 'Este kit não está configurado para venda no evento. Chame o administrador antes de entregar o produto.',
      }, { status: 409 })
    }

    // CPF QUE NAO BATE COM O CADASTRO DAQUELE E-MAIL.
    //
    // DIVERGE DE PROPOSITO de src/app/api/pedidos/route.ts, que devolve um 422
    // generico e MUDO. La o argumento e forte: a rota e anonima, e uma mensagem
    // especifica vira oraculo — qualquer pessoa descobre, so pela forma da
    // resposta, que um e-mail pertence a um cliente cadastrado, e depois acerta
    // o CPF por tentativa e erro para comprar em nome dele.
    //
    // Aqui nao ha anonimo: quem chegou ate esta linha passou por `exigirPapel`,
    // tem conta nominal, sessao revogavel e vai ficar gravado em
    // pedidos.vendedor_id de tudo que fizer. O oraculo que o 422 mudo protege
    // exige um atacante sem identidade, e ele nao existe deste lado da porta. O
    // que existe e uma fila e uma pessoa esperando: um "dados inválidos" sem
    // dizer QUAL dado faz o vendedor redigitar tudo, tres vezes, e chamar o
    // suporte. A mensagem abaixo diz o que conferir sem afirmar que o e-mail ja
    // existe.
    //
    // O codigo continua sendo `dados_invalidos` e o motivo cru so vai para o log
    // (via mensagemSeguraDoErro, nunca error.detail).
    if (e instanceof CpfDivergenteError) {
      console.error('[vendas-presenciais] falha ao registrar a venda:', mensagem)
      return Response.json({
        error: 'dados_invalidos',
        mensagem: 'Confira o e-mail e o CPF digitados: eles não conferem entre si.',
      }, { status: 422 })
    }

    // Preco do catalogo mudou entre a tela do vendedor e o INSERT. A mensagem
    // crua carrega o uuid do kit e os dois precos; so a curada sai daqui.
    if (e instanceof PrecoDivergenteError) {
      console.error('[vendas-presenciais] falha ao registrar a venda:', mensagem)
      return Response.json({
        error: 'dados_invalidos',
        mensagem: 'O preço do kit mudou. Atualize a tela e refaça a venda.',
      }, { status: 422 })
    }

    console.error('[vendas-presenciais] falha ao registrar a venda:', mensagem)
    return Response.json({ error: 'nao_foi_possivel_registrar_a_venda' }, { status: 500 })
  }

  // =====================================================================
  // A PARTIR DAQUI A VENDA ESTA COMMITADA: o pedido existe e a unidade ja saiu
  // do estoque presencial. Nenhuma resposta abaixo pode deixar duvida sobre
  // isso, e por isso TODAS carregam `vendaRegistrada: true`, `numero` e `token`
  // — inclusive as de erro. Uma tela operada em pe, com fila, precisa de UM
  // campo para ler; um erro generico ali vira kit entregue sem venda
  // registrada, ou o contrario: venda registrada tratada como inexistente e
  // refeita, baixando duas unidades por um kit so.
  //
  // ORDEM DELIBERADA: commitar primeiro, cobrar depois. A chamada de rede ao
  // Mercado Pago NAO pode acontecer dentro da transacao — sao ate 15 segundos de
  // timeout (src/lib/mercadopago.ts) segurando uma conexao de um pool de 5 e,
  // pior, segurando o lock da linha de `estoques`, que e o ponto de
  // serializacao de TODAS as vendas presenciais daquele kit. Um provedor lento
  // travaria a fila inteira do evento, e nao so a venda que esta sendo feita.
  //
  // O QUE ISSO CUSTA, dito por extenso: se o provedor falhar, sobra um pedido
  // 'pendente' com a unidade ja reservada. E o lado certo do erro — o outro
  // caminho (cobrar antes de commitar) produziria cobranca aprovada sem venda
  // registrada, que e dinheiro recebido sem rastro. A reserva presa e
  // recuperavel e tem dois caminhos ja existentes: cobrar de novo o MESMO
  // pedido por POST /api/pagamentos com o token devolvido aqui (nunca refazer a
  // venda: isso criaria um segundo pedido e uma segunda baixa), ou desistir e
  // devolver a unidade a prateleira pelo painel. ATENCAO ao desistir: cancelar o
  // pedido por PATCH /api/admin/pedidos/[id] move o status mas NAO estorna
  // estoque — quem estorna e conciliarPagamento, pelo webhook. Sem webhook de
  // cancelamento, a unidade volta por `ajustarEstoque` (src/repositories/estoque.ts),
  // que existe exatamente para correcao de inventario com motivo escrito.
  // =====================================================================

  const { nome, sobrenome } = separarNome(d.nome)

  // OS DOIS PASSOS DA COBRANCA FICAM NO MESMO try, e nao so a chamada de rede:
  // depois do COMMIT, QUALQUER falha daqui para baixo precisa sair como uma
  // resposta que diga que a venda existe. Um throw solto no `abrirPagamento`
  // viraria um 500 generico do Next, sem numero e sem token — a tela do balcao
  // leria "deu erro" e o vendedor refaria a venda, baixando uma segunda unidade
  // por um kit so.
  //
  // A linha local nasce ANTES da chamada ao provedor: o id dela e a chave de
  // idempotencia (X-Idempotency-Key) enviada ao Mercado Pago. Sem ela nao
  // existiria identificador estavel para reenviar a mesma requisicao sem cobrar
  // duas vezes. Mesma ordem, e mesmo motivo, de src/app/api/pagamentos/route.ts.
  let local: Pagamento
  let resposta: RespostaPagamentoMP
  try {
    local = await abrirPagamento({
      pedidoId: venda.id,
      metodo: d.metodo,
      valor: venda.totalCentavos,
      parcelas: d.metodo === 'cartao' ? d.parcelas : 1,
    })

    resposta = await criarPagamentoMP(
      d.metodo === 'pix'
        ? {
            metodo: 'pix',
            valor: venda.totalCentavos,
            descricao: `Pedido #${venda.numero} — Milagran`,
            referenciaExterna: venda.id,
            pagador: { email: d.email, nome, sobrenome, cpf: d.cpf },
          }
        : {
            metodo: 'cartao',
            valor: venda.totalCentavos,
            descricao: `Pedido #${venda.numero} — Milagran`,
            referenciaExterna: venda.id,
            pagador: { email: d.email, nome, sobrenome, cpf: d.cpf },
            token: d.token,
            parcelas: d.parcelas,
            metodoPagamentoId: d.metodoPagamentoId,
            emissorId: d.emissorId,
          },
      local.id,
    )
  } catch (e) {
    // A mensagem do provedor vai so para o log: ela carrega vocabulario interno
    // e, em alguns erros, ecoa o payload enviado — que tem CPF e e-mail do
    // comprador.
    console.error('[vendas-presenciais] cobranca nao foi criada:', mensagemSeguraDoErro(e))

    // 502 quando quem falhou foi o Mercado Pago (gateway a frente nao respondeu
    // ou recusou a criacao) e 500 quando a falha foi nossa — o banco recusando o
    // INSERT em `pagamentos`, por exemplo. A distincao existe para o diagnostico
    // depois do evento: as duas paradas tem causas e responsaveis diferentes, e
    // achatar tudo em 502 mandaria a operacao ligar para o provedor por um
    // problema que estava aqui dentro.
    const doProvedor = e instanceof ErroMercadoPago

    return Response.json({
      error: doProvedor ? 'falha_no_provedor' : 'nao_foi_possivel_cobrar',
      // As tres linhas que tiram a ambiguidade da tela do balcao. Valem para
      // qualquer uma das duas causas: a venda ESTA registrada nas duas.
      vendaRegistrada: true,
      numero: venda.numero,
      token: venda.token,
      mensagem: 'A venda foi registrada, mas a cobrança não foi criada. NÃO entregue o kit: tente cobrar de novo por este mesmo pedido.',
    }, { status: doProvedor ? 502 : 500 })
  }

  const status = mapearStatusMP(resposta.status)
  if (status === null) {
    // Status que nao sabemos ler: a cobranca EXISTE no provedor, entao a linha
    // local precisa apontar para ela de qualquer jeito. O webhook reconcilia
    // quando o status virar algo conhecido.
    console.error('[vendas-presenciais] status desconhecido do provedor:', resposta.status)
    await vincularAoProvedor(local.id, resposta.id, 'pendente')
    return Response.json({
      vendaRegistrada: true,
      numero: venda.numero,
      token: venda.token,
      pagamento: { metodo: d.metodo, status: 'pendente' },
    }, { status: 202 })
  }

  // ESTE try NAO E DECORACAO. Sem ele, uma falha aqui dentro escapa do
  // handler e o Next devolve um 500 SEM CORPO — sem `vendaRegistrada`, sem
  // `numero`, sem `token`. A tela do balcao cai no desfecho "nao da para
  // saber" (o mais seguro que ela tem, mas tambem o mais caro): o vendedor
  // para, com fila na frente, para conferir no painel um pedido que nos
  // sabemos que existe, com a unidade ja baixada.
  //
  // A DIFERENCA PARA O catch DE CIMA importa e e o motivo de `cobrancaCriada`
  // existir: la a cobranca NAO chegou a ser criada, entao "cobre de novo" e a
  // instrucao certa. Aqui `criarPagamentoMP` JA VOLTOU com sucesso — o
  // dinheiro pode inclusive ja ter sido capturado. Mandar cobrar de novo
  // cobraria o comprador duas vezes pelo mesmo kit.
  let conciliado: ResultadoConciliacao
  try {
    conciliado = await getDb().transaction().execute(async (trx) => {
      await vincularAoProvedor(local.id, resposta.id, status, trx)
    // MESMA funcao que o webhook chama. Um cartao aprovado na hora move o pedido
    // por este caminho; se o webhook do mesmo pagamento chegar logo depois,
    // conciliarPagamento devolve no-op.
    //
    // ELA VAI TENTAR BAIXAR O ESTOQUE DE NOVO ao entrar em 'pago', e isso e
    // esperado: baixarEstoque encontra a baixa que ESTA transacao ja gravou na
    // criacao e devolve `false`, sem gravar um segundo movimento — e o caso 2
    // documentado em ResultadoConciliacao.estoqueBaixado
    // (src/repositories/conciliacao.ts), com o indice unico parcial
    // estoque_baixa_unica_por_pedido como rede embaixo. Sem essa idempotencia,
    // toda venda presencial paga tiraria DUAS unidades da caixa.
      return conciliarPagamento(venda.id, status, trx)
    })
  } catch (e) {
    console.error('[vendas-presenciais] conciliacao falhou apos a cobranca:', mensagemSeguraDoErro(e))

    // O webhook do Mercado Pago e a rede de seguranca real deste caminho: a
    // cobranca tem `external_reference` = id do pedido, entao a notificacao
    // reconcilia o pedido sozinha, mesmo sem a linha local ter sido vinculada
    // aqui. Por isso a instrucao e ESPERAR E CONFERIR, nunca refazer.
    return Response.json({
      error: 'conciliacao_falhou',
      vendaRegistrada: true,
      cobrancaCriada: true,
      numero: venda.numero,
      token: venda.token,
      mensagem: 'A venda está registrada e a cobrança JÁ FOI criada — não cobre de novo, '
        + 'o comprador seria cobrado duas vezes. NÃO entregue o kit: abra o pedido pelo link '
        + 'abaixo e confira se o pagamento foi confirmado.',
    }, { status: 500 })
  }

  // Depois do COMMIT, nunca de dentro da transacao: e-mail enviado nao volta
  // atras, rollback volta. `mudou` garante envio unico — o webhook do mesmo
  // pagamento, chegando depois, ja encontra o pedido pago e nao reenvia.
  //
  // Fora do try acima de proposito: enviarConfirmacaoDePedido nunca lanca (o
  // doc dela registra isso), e engoli-la naquele catch faria uma falha de
  // e-mail ser anunciada ao vendedor como falha de conciliacao.
  if (conciliado.mudou && conciliado.para === 'pago') {
    await enviarConfirmacaoDePedido(venda.id)
  }

  // CARTAO RECUSADO E 402, E NAO UM 201 COM O MOTIVO ESCONDIDO NO CORPO. A venda
  // existe (por isso `vendaRegistrada: true` e o token vao junto), mas o
  // pagamento nao aconteceu — e a unica leitura que nao pode falhar nesta tela e
  // "posso entregar o kit?". Um 2xx aqui faria qualquer front-end ingenuo que
  // olha `response.ok` mostrar "VENDA APROVADA" para um cartao negado, com o
  // comprador saindo pela porta com o produto.
  //
  // O pedido continua 'pendente' (pedidoAposPagamento devolve null para
  // 'recusado' sobre 'pendente', src/lib/pedido-status.ts): a proxima tentativa
  // e uma cobranca NOVA sobre o MESMO pedido, por /api/pagamentos com este
  // token. Refazer a venda inteira baixaria uma segunda unidade.
  if (status === 'recusado') {
    return Response.json({
      error: 'pagamento_recusado',
      vendaRegistrada: true,
      numero: venda.numero,
      token: venda.token,
      pagamento: { metodo: d.metodo, status },
      mensagem: mensagemDoPagamento(resposta.statusDetail),
    }, { status: 402 })
  }

  if (d.metodo === 'pix') {
    // Pix nasce PENDENTE, e isso e o caminho feliz do balcao: o QR aparece na
    // tela, o comprador paga, o webhook confirma. A tela so pode anunciar "VENDA
    // APROVADA" quando `pagamento.status` virar 'aprovado' — nunca pelo 201.
    return Response.json({
      vendaRegistrada: true,
      numero: venda.numero,
      token: venda.token,
      pagamento: {
        metodo: 'pix',
        status,
        pixCopiaECola: resposta.pixCopiaECola,
        pixQrBase64: resposta.pixQrBase64,
        expiraEm: resposta.expiraEm,
      },
    }, { status: 201 })
  }

  return Response.json({
    vendaRegistrada: true,
    numero: venda.numero,
    token: venda.token,
    pagamento: {
      metodo: 'cartao',
      status,
      // O unico campo que autoriza a entrega do kit no ato.
      pedidoPago: conciliado.para === 'pago',
    },
  }, { status: 201 })
}

/**
 * Os outros verbos respondem 405 com `Allow`, explicitamente.
 *
 * O Next ja devolveria 405 por conta propria para um metodo sem handler, mas sem
 * o cabecalho `Allow` — que e o que diz ao cliente qual verbo usar (RFC 9110
 * exige o cabecalho na resposta 405). Escrever os handlers tambem torna a
 * superficie da rota legivel no proprio arquivo: esta e uma rota de escrita e so
 * POST escreve.
 */
function metodoNaoPermitido() {
  return Response.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'POST' },
  })
}

export async function GET() {
  return metodoNaoPermitido()
}

export async function PUT() {
  return metodoNaoPermitido()
}

export async function PATCH() {
  return metodoNaoPermitido()
}

export async function DELETE() {
  return metodoNaoPermitido()
}
