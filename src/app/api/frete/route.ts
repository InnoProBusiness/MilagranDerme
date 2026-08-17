import { z } from 'zod'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import {
  cotarFrete, ClubeEnviosError, CotacaoIlegivelError, FreteNaoConfiguradoError,
} from '@/lib/frete'
import {
  criarLimitadorPorIp, ipDoPedido,
  JANELA_RATE_LIMIT_MS, MAX_COTACOES_POR_JANELA,
} from '@/lib/rate-limit'
import { buscarKitAtivoPorSlug } from '@/repositories/produtos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/frete — a cotacao que o checkout mostra ao comprador (§13 do
 * documento do cliente de 16/08/2026).
 *
 * O passo 3 do wizard (src/components/checkout-wizard.tsx) chama esta rota com o
 * CEP digitado e recebe a lista de opcoes; o comprador escolhe uma e o SUBMIT
 * envia apenas o `idServico` dela para POST /api/pedidos, que RECOTA no servidor
 * antes de gravar. Ou seja: nada do que sai daqui volta como dinheiro. Esta rota
 * informa; ela nao decide valor de pedido nenhum.
 *
 * POR QUE ELA EXISTE, SE O PEDIDO RECOTA DE QUALQUER JEITO: porque o comprador
 * precisa VER o valor e o prazo antes de decidir, e porque a escolha entre PAC e
 * SEDEX e dele. Sem esta rota, a unica forma de mostrar frete seria mandar o
 * valor do navegador para o servidor no submit — que e exatamente o que o
 * `.strict()` de POST /api/pedidos existe para recusar.
 *
 * ESTA ROTA GASTA DINHEIRO A CADA REQUISICAO. `cotarFrete` (src/lib/frete.ts)
 * fala com a API do Clube Envios, e cada chamada consome cota da conta da
 * Milagran. Dai o rate limit proprio logo abaixo, e dai a ORDEM das validacoes
 * no handler: tudo o que da para recusar sem falar com o provedor (rate limit,
 * schema, formato do CEP, kit inexistente) e recusado ANTES da chamada. Uma
 * validacao movida para depois da cotacao nao muda resposta nenhuma — muda a
 * fatura.
 *
 * DINHEIRO NUNCA VEM DO CORPO, aqui tambem: o `valor_declarado` mandado ao
 * provedor sai do preco de CATALOGO vezes a quantidade, e as dimensoes saem do
 * cadastro do kit. Ver o comentario da cotacao no meio do handler.
 */

/**
 * Contador PROPRIO (criarLimitadorPorIp devolve um Map novo a cada chamada,
 * src/lib/rate-limit.ts): o teto da cotacao nao divide orcamento com o checkout
 * nem com o formulario de candidatura. Se dividisse, cotar o frete quatro vezes
 * — corrigindo o CEP, mudando a quantidade — deixaria o comprador sem cota para
 * FECHAR o pedido, que e a unica requisicao que realmente importa.
 *
 * O teto e MAX_COTACOES_POR_JANELA, mais alto que o do checkout de proposito, e
 * o porque esta escrito na constante. Vale aqui, na integra, o aviso honesto do
 * cabecalho de src/lib/rate-limit.ts: contador em MEMORIA DO PROCESSO, IP vindo
 * de header forjavel — quebra-molas contra abuso ingenuo, nunca controle de
 * acesso.
 */
const excedeuRateLimit = criarLimitadorPorIp({
  janelaMs: JANELA_RATE_LIMIT_MS,
  maxPorJanela: MAX_COTACOES_POR_JANELA,
})

/**
 * Tres campos, e nenhum deles e dinheiro.
 *
 * `.strict()` e o que transforma essa regra em resposta HTTP: mandar
 * `valorCentavos`, `frete` ou `precoUnitarioCentavos` junto e 422 explicito, nao
 * um campo ignorado em silencio. A diferenca importa porque uma cotacao que
 * aceitasse valor do cliente seria o caminho mais curto para a tela exibir um
 * frete inventado e o comprador reclamar da cobranca depois — mesmo raciocinio,
 * palavra por palavra, do schema de src/app/api/pedidos/route.ts.
 *
 * `cep` entra como texto solto de proposito, SEM o regex no schema: um CEP fora
 * de formato precisa virar 422 `cep_invalido`, e nao o `dados_invalidos`
 * generico de qualquer outro campo. Quem chama e um formulario em que o CEP e o
 * campo que a pessoa esta digitando naquele instante; a tela precisa poder
 * apontar para ele em vez de dizer "dados invalidos" sobre um corpo que ela
 * mesma montou. Ver a checagem no handler.
 *
 * `quantidade` reusa QUANTIDADE_MAXIMA (src/lib/carrinho.ts) para que a cotacao
 * cubra exatamente a faixa que o checkout consegue comprar. Um teto maior aqui
 * cotaria um volume que nunca vira pedido; um teto menor faria o comprador ver
 * "frete indisponivel" numa quantidade que a loja aceita vender.
 */
const Corpo = z.object({
  cep: z.string().trim(),
  kitSlug: z.string().min(1),
  quantidade: z.number().int().min(1).max(QUANTIDADE_MAXIMA),
}).strict()

/**
 * O MESMO formato exigido por POST /api/pedidos (`cep: z.string().regex(/^\d{8}$/)`)
 * e pela coluna `enderecos.cep` (CHECK endereco_cep_digitos), e a igualdade e o
 * ponto: um CEP aceito aqui e recusado la faria a tela cotar com sucesso e
 * falhar no submit, sem que nada explicasse a diferenca ao comprador. Por isso
 * esta rota NAO normaliza "01310-100" tirando o hifen por conta propria — quem
 * normaliza e o formulario, uma vez, antes de qualquer chamada.
 */
const CEP_DE_OITO_DIGITOS = /^\d{8}$/

/**
 * Unico ponto de leitura de mensagem de erro deste arquivo, copiado de
 * src/app/api/pedidos/route.ts pelo mesmo motivo de la: nunca logar o objeto de
 * erro cru. Aqui o risco tem nome proprio — a mensagem de `ClubeEnviosError`
 * pode ecoar o payload enviado ao provedor, que carrega o CEP do comprador, e
 * por isso ela vai para o log de servidor e NUNCA para a resposta.
 */
function mensagemSeguraDoErro(e: unknown): string {
  return e instanceof Error ? e.message : 'erro_desconhecido'
}

export async function POST(req: Request) {
  // PRIMEIRA COISA DO HANDLER: antes de ler o corpo, antes de tocar no banco e —
  // sobretudo — antes de gastar uma requisicao paga no Clube Envios.
  if (excedeuRateLimit(ipDoPedido(req.headers))) {
    return Response.json({ error: 'rate_limited' }, { status: 429 })
  }

  const parsed = Corpo.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    // Erro ACHATADO, sem detalhe de campo: padrao da casa. Quem manda um corpo
    // fora do contrato e a nossa propria tela ou alguem sondando a API, e nenhum
    // dos dois ganha nada com a lista de campos aceitos.
    return Response.json({ error: 'dados_invalidos' }, { status: 422 })
  }
  const d = parsed.data

  if (!CEP_DE_OITO_DIGITOS.test(d.cep)) {
    return Response.json({
      error: 'cep_invalido',
      mensagem: 'Informe um CEP com 8 dígitos, apenas números.',
    }, { status: 422 })
  }

  // O kit vem do CATALOGO, e a leitura acontece antes da cotacao por dois
  // motivos: e ela que fornece preco e dimensoes (nenhum dos dois pode vir do
  // corpo) e e ela que evita gastar uma chamada no provedor por um slug que nao
  // existe. Mesmo codigo de erro de src/app/api/pedidos/route.ts, de proposito:
  // o kit que nao da para comprar tambem nao da para cotar.
  const kit = await buscarKitAtivoPorSlug(d.kitSlug)
  if (!kit) return Response.json({ error: 'kit_indisponivel' }, { status: 422 })

  // Subtotal pelo mesmo caminho do checkout (montarCarrinho, src/lib/carrinho.ts)
  // em vez de uma multiplicacao escrita aqui: e ele que aplica os tetos de
  // quantidade e de subtotal e que garante que o numero declarado ao provedor e
  // o MESMO que POST /api/pedidos vai declarar na recotacao. Duas contas
  // diferentes para o mesmo carrinho seriam dois valores declarados diferentes
  // para a mesma caixa.
  const carrinho = montarCarrinho([{
    kitId: kit.id, nome: kit.nome,
    precoUnitario: kit.precoCentavos, quantidade: d.quantidade,
  }])

  try {
    const cotacao = await cotarFrete({
      cepDestino: d.cep,
      // Valor declarado e o SUBTOTAL dos produtos, sem desconto e sem frete: e
      // quanto vale a mercadoria dentro da caixa para efeito de transporte.
      // Cupom nao entra — declarar a menor reduz o que a transportadora repoe se
      // extraviar. Identico ao que POST /api/pedidos declara na recotacao.
      valorDeclarado: carrinho.subtotal,
      // Dimensoes do CADASTRO do kit (src/repositories/produtos.ts), nunca
      // numeros escritos nesta rota: peso/medida errados sao frete errado, e o
      // erro so aparece no balcao dos Correios. `quantidade` multiplica o volume
      // porque cada unidade e uma caixa.
      volumes: [{
        alturaCm: kit.alturaCm,
        larguraCm: kit.larguraCm,
        comprimentoCm: kit.comprimentoCm,
        pesoGramas: kit.pesoGramas,
        quantidade: d.quantidade,
      }],
    })

    /**
     * LISTA VAZIA NAO E SUCESSO.
     *
     * O provedor respondeu, aceitou o pedido de cotacao e nao devolveu servico
     * nenhum: nenhuma transportadora atende aquele CEP com aquele volume.
     * Devolver `{ opcoes: [] }` com 200 seria a versao educada de inventar frete
     * zero — a tela teria uma lista vazia para desenhar, o comprador seguiria
     * para o passo 4 sem opcao escolhida e o submit morreria com um erro que nao
     * tem nada a ver com a causa. E o mesmo principio de CotacaoIlegivelError
     * (src/lib/frete.ts): quando nao ha valor, a resposta certa nao e um valor.
     *
     * 422 e nao 503 porque REPETIR NAO ADIANTA: nao ha indisponibilidade
     * temporaria a esperar, ha um destino que aquele volume nao alcanca. A
     * mensagem manda conferir o CEP, que e a unica acao util de quem esta na
     * tela. O codigo e proprio (`frete_sem_atendimento`) e nao reaproveita
     * `frete_indisponivel` de proposito — os dois pedem coisas diferentes do
     * comprador, e um so codigo faria a tela dizer "tente de novo em instantes"
     * para quem precisa corrigir um digito.
     */
    if (cotacao.opcoes.length === 0) {
      console.error('[frete] cotacao sem opcoes para o CEP informado')
      return Response.json({
        error: 'frete_sem_atendimento',
        mensagem: 'Nenhuma transportadora atende esse CEP para este kit. Confira o CEP digitado.',
      }, { status: 422 })
    }

    return Response.json({
      /**
       * Exatamente os quatro campos do contrato (§5 do plano), e nada alem.
       *
       * `idCotacao` e `idTransportadora` ficam de fora: o primeiro e rastro de
       * suporte do provedor e o segundo nao tem uso na tela — o que o comprador
       * le e o nome. O unico id que atravessa e `idServico`, porque e ele que
       * volta no corpo de POST /api/pedidos para dizer QUAL opcao foi escolhida.
       *
       * `valorCentavos` e INTEIRO EM CENTAVOS, e o nome carrega a unidade de
       * proposito: `OpcaoDeFrete.valor` ja e `Centavos` (tipo branded de
       * src/lib/money.ts), mas o tipo nao sobrevive ao JSON. Formatar em reais e
       * trabalho da tela (formatarBRL); mandar "23,50" daqui obrigaria o
       * navegador a desfazer a formatacao para somar, que e onde nasce o erro de
       * fator 100.
       *
       * A ORDEM E A DO PROVEDOR, sem reordenar. Uma cotacao repetida do mesmo
       * CEP devolve a lista na mesma ordem, e a tela decide como apresentar
       * (destacar a mais barata e escolha de UI, nao de API). Ordenar aqui
       * criaria uma segunda regra de "qual e a primeira" para conviver com a de
       * `opcaoMaisBarata` em src/lib/frete.ts.
       */
      opcoes: cotacao.opcoes.map((o) => ({
        idServico: o.idServico,
        transportadora: o.transportadora,
        valorCentavos: o.valor,
        prazoDias: o.prazoDias,
      })),
    })
  } catch (erro) {
    // DESPACHO POR CLASSE, nunca por texto de mensagem — mesma regra do catch de
    // src/app/api/pedidos/route.ts. As tres classes sao "nao deu para cotar" por
    // motivos diferentes (o provedor recusou ou nao respondeu; a resposta veio
    // ilegivel; falta credencial ou CEP de origem no ambiente) e as tres tem o
    // MESMO desfecho para quem esta comprando: 503 com mensagem curada. O motivo
    // especifico so vai para o log — a mensagem de ClubeEnviosError pode ecoar o
    // payload enviado, que carrega o CEP do comprador.
    //
    // FreteNaoConfiguradoError merece um paragrafo proprio: ela e falha NOSSA
    // (CLUBE_ENVIOS_TOKEN, CLUBE_ENVIOS_CLIENTE_ID ou CEP_ORIGEM_EXPEDICAO
    // ausentes na stack) e mesmo assim vira 503, nao 500. E deliberado: para o
    // comprador o efeito e identico, e o log ja carrega qual variavel falta. O
    // que NAO pode acontecer em nenhum dos tres casos e a rota devolver uma lista
    // de opcoes com valor zero para "nao travar o checkout" — frete zero gravado
    // vira prejuizo por pedido, e a coluna e congelada pelo trigger de
    // imutabilidade (ver o cabecalho de src/lib/frete.ts).
    if (
      erro instanceof ClubeEnviosError
      || erro instanceof CotacaoIlegivelError
      || erro instanceof FreteNaoConfiguradoError
    ) {
      console.error('[frete] cotacao indisponivel:', mensagemSeguraDoErro(erro))
      return Response.json({
        error: 'frete_indisponivel',
        mensagem: 'Não foi possível calcular o frete agora. Tente novamente em instantes.',
      }, { status: 503 })
    }

    // Sobra o que NAO e falha do provedor: `cotarFrete` tambem lanca Error comum
    // quando um volume vem com medida zerada ou nao inteira, e isso e defeito do
    // NOSSO cadastro (kits.peso_gramas e companhia), nao indisponibilidade
    // externa. 500 em vez de 503 para que o log conte a historia certa — 503
    // sugere "tente de novo", e tentar de novo com o mesmo kit quebrado nao
    // resolve nada. Mesma distincao de src/app/api/pedidos/route.ts.
    console.error('[frete] falha inesperada ao cotar:', mensagemSeguraDoErro(erro))
    return Response.json({ error: 'nao_foi_possivel_cotar_o_frete' }, { status: 500 })
  }
}

/**
 * Demais verbos: 405 com `Allow`, padrao da casa (src/app/api/pedidos/route.ts).
 *
 * POST e nao GET para uma leitura, e a escolha e consciente: o corpo carrega CEP
 * — dado que localiza uma pessoa — e um GET colocaria esse CEP na querystring,
 * de onde ele iria parar no log de acesso do Traefik e no historico do
 * navegador. Alem disso, um GET convida cache; esta resposta depende de uma
 * tabela de transportadora que muda sem aviso.
 */
function metodoNaoPermitido() {
  return Response.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'POST' },
  })
}

export const GET = metodoNaoPermitido
export const PUT = metodoNaoPermitido
export const PATCH = metodoNaoPermitido
export const DELETE = metodoNaoPermitido
