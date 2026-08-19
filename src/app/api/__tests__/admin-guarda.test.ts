import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'kysely'
import { getDb, closeDb } from '@/lib/db'
import { NOME_COOKIE_SESSAO } from '@/lib/sessao'
import { criarUsuario } from '@/repositories/usuarios'
import { abrirSessao } from '@/repositories/sessoes'
import { GET as vendas } from '@/app/api/admin/vendas/route'
import { GET as estoque } from '@/app/api/admin/estoque/route'
import { GET as logistica } from '@/app/api/admin/logistica/route'
import { GET as leads } from '@/app/api/admin/leads/route'
import { PATCH as atualizarPedido } from '@/app/api/admin/pedidos/[id]/route'
import {
  GET as cupons, POST as criarCupomRota, PATCH as alternarCupom,
} from '@/app/api/admin/cupons/route'

/**
 * SEGURANCA: este arquivo vale por TODAS as rotas /api/admin/* de uma vez.
 *
 * O painel de §17 mostra nome, e-mail, whatsapp e endereco residencial de cada
 * comprador, a lista de contatos de todo lead do lancamento e o faturamento da
 * empresa. Uma dessas rotas sem `exigirPapel` (src/lib/guarda.ts) nao fica
 * vermelha em teste nenhum dos outros arquivos: ela continua respondendo 200
 * com os dados certos para quem chamou — o defeito e justamente responder bem
 * demais, para gente demais.
 *
 * POR ISSO A LISTA E UM ARRAY E OS TESTES SAO GERADOS EM LACO. Nao ha um teste
 * escrito a mao por rota que alguem possa esquecer de copiar: acrescentar a
 * rota nova a `ROTAS` ja cria as quatro asseveracoes dela. E, para que
 * "esquecer de acrescentar" tambem seja pego, o ultimo teste deste arquivo
 * varre o DIRETORIO src/app/api/admin no disco e exige que toda rota
 * encontrada la esteja nesta lista.
 *
 * As quatro asseveracoes por rota:
 *   1. sem cookie              -> 401 nao_autenticado
 *   2. cookie de sessao invalida -> 401 (token que nao existe no banco)
 *   3. sessao de 'vendedor'    -> 403 acesso_negado
 *   4. sessao de 'admin'       -> passa (qualquer coisa que nao seja 401/403)
 *
 * A QUARTA E TAO IMPORTANTE QUANTO AS OUTRAS TRES: sem ela, uma rota quebrada
 * que devolvesse 401 para todo mundo — inclusive para o dono da empresa no dia
 * do evento — passaria neste arquivo com louvor. Um teste de controle de acesso
 * que so sabe recusar nao prova controle de acesso, prova porta trancada.
 *
 * NAMESPACE PROPRIO: os dois usuarios deste arquivo tem e-mails que nao
 * aparecem em nenhum outro teste. O Vitest roda os arquivos em paralelo contra
 * o mesmo Postgres, e os testes de usuarios.ts/sessoes.ts fazem DELETE+INSERT
 * das proprias linhas ao mesmo tempo que este roda.
 */

const EMAIL_ADMIN = 'guarda.admin@exemplo.com'
const EMAIL_VENDEDOR = 'guarda.vendedor@exemplo.com'

// Senha de teste. Nao ha segredo aqui: ela existe so para `criarUsuario` gerar
// um hash valido — nenhuma rota deste arquivo autentica por senha, todas
// autenticam pelo cookie de sessao aberto no beforeAll.
const SENHA = 'guarda-de-teste-9f2a'

/**
 * uuid v4 sintaticamente valido que nao pertence a pedido nenhum.
 *
 * A ESCOLHA E DELIBERADA e faz parte da prova: um id BEM FORMADO e INEXISTENTE
 * separa "a guarda rodou primeiro" de "a rota foi ao banco antes de conferir a
 * sessao". Se PATCH /api/admin/pedidos/[id] lesse o pedido antes de
 * `exigirPapel`, a requisicao sem cookie voltaria 404 (nao achou o pedido) em
 * vez de 401 — e o teste ficaria vermelho apontando exatamente a inversao.
 */
const ID_PEDIDO_INEXISTENTE = '00000000-0000-4000-8000-000000000000'

type RotaAdmin = {
  metodo: 'GET' | 'POST' | 'PATCH'
  /**
   * O caminho como ele existe NO DISCO, com o segmento dinamico entre
   * colchetes — e o que o ultimo teste compara com src/app/api/admin.
   */
  caminho: string
  /** URL concreta da requisicao (com o segmento dinamico ja resolvido). */
  url: string
  /** Corpo cru, so para os verbos que tem corpo. */
  corpo?: string
  /**
   * Chama o handler exportado. Precisa ser uma funcao por rota porque as
   * assinaturas diferem: as rotas estaticas recebem so `Request` e a dinamica
   * recebe tambem o contexto, cujo `params` e uma PROMISE em Next 16.
   */
  chamar: (req: Request) => Promise<Response>
}

const ROTAS: readonly RotaAdmin[] = [
  {
    metodo: 'GET',
    caminho: '/api/admin/vendas',
    url: 'http://localhost/api/admin/vendas',
    chamar: (req) => vendas(req),
  },
  {
    metodo: 'GET',
    caminho: '/api/admin/estoque',
    url: 'http://localhost/api/admin/estoque',
    chamar: (req) => estoque(req),
  },
  {
    metodo: 'GET',
    caminho: '/api/admin/logistica',
    url: 'http://localhost/api/admin/logistica',
    chamar: (req) => logistica(req),
  },
  {
    metodo: 'GET',
    caminho: '/api/admin/leads',
    url: 'http://localhost/api/admin/leads',
    chamar: (req) => leads(req),
  },
  {
    metodo: 'GET',
    caminho: '/api/admin/cupons',
    url: 'http://localhost/api/admin/cupons',
    chamar: (req) => cupons(req),
  },
  {
    // AS TRES DA MESMA ROTA, e nao so a leitura. POST cria desconto e PATCH
    // desliga campanha: um vendedor que alcancasse qualquer uma das duas
    // poderia criar para si um cupom de 100% ou derrubar a oferta do
    // lancamento. Um `caminho` repetido nao atrapalha a varredura de diretorio
    // la embaixo — ela so exige que todo arquivo esteja representado.
    metodo: 'POST',
    caminho: '/api/admin/cupons',
    url: 'http://localhost/api/admin/cupons',
    // Corpo vazio: recusado com 422 DEPOIS da guarda, do mesmo jeito que o
    // PATCH de pedidos abaixo.
    corpo: '{}',
    chamar: (req) => criarCupomRota(req),
  },
  {
    metodo: 'PATCH',
    caminho: '/api/admin/cupons',
    url: 'http://localhost/api/admin/cupons',
    corpo: '{}',
    chamar: (req) => alternarCupom(req),
  },
  {
    metodo: 'PATCH',
    caminho: '/api/admin/pedidos/[id]',
    url: `http://localhost/api/admin/pedidos/${ID_PEDIDO_INEXISTENTE}`,
    // Corpo VAZIO de proposito: a rota recusa isso com 422
    // `nada_para_atualizar`, o que prova que a requisicao do admin atravessou a
    // guarda sem que este teste precise inventar uma transicao de status valida
    // (que exigiria criar pedido, cliente e itens so para provar autenticacao).
    corpo: '{}',
    chamar: (req) => atualizarPedido(req, { params: Promise.resolve({ id: ID_PEDIDO_INEXISTENTE }) }),
  },
]

function requisicao(rota: RotaAdmin, cookie?: string): Request {
  return new Request(rota.url, {
    method: rota.metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(rota.corpo === undefined ? {} : { body: rota.corpo }),
  })
}

// Cookie no formato que o navegador manda, para exercitar tokenDoCookie
// (src/lib/sessao.ts) de verdade: e ele quem separa o header cru, e o teste nao
// pode pular essa parte injetando o usuario direto no handler.
function cookieDe(token: string): string {
  return `${NOME_COOKIE_SESSAO}=${token}`
}

let cookieAdmin: string
let cookieVendedor: string

describe('SEGURANCA: /api/admin/* atras de exigirPapel', () => {
  beforeAll(async () => {
    const db = getDb()

    for (const email of [EMAIL_ADMIN, EMAIL_VENDEDOR]) {
      // Sobras de uma execucao anterior. `sessoes.usuario_id` e ON DELETE
      // CASCADE (migrations/1755300300000_usuarios_sessoes.sql), entao as
      // sessoes antigas destes dois vao junto. Nenhum dos dois chega a ser
      // vendedor de pedido nenhum, entao o ON DELETE RESTRICT de
      // pedidos.vendedor_id nunca e alcancado.
      await db.deleteFrom('usuarios')
        .where(sql<boolean>`lower(email) = lower(${email})`)
        .execute()
    }

    const admin = await criarUsuario({
      nome: 'Admin da Guarda', email: EMAIL_ADMIN, senha: SENHA, papel: 'admin',
    })
    const vendedor = await criarUsuario({
      nome: 'Vendedor da Guarda', email: EMAIL_VENDEDOR, senha: SENHA, papel: 'vendedor',
    })

    // Sessoes de verdade, gravadas no banco: `abrirSessao` guarda so o hash do
    // token (src/repositories/sessoes.ts) e devolve o token cru uma unica vez —
    // e esse token cru que vira cookie aqui, exatamente como no navegador.
    cookieAdmin = cookieDe((await abrirSessao(admin.id)).token)
    cookieVendedor = cookieDe((await abrirSessao(vendedor.id)).token)
  })

  afterAll(async () => { await closeDb() })

  for (const rota of ROTAS) {
    describe(`${rota.metodo} ${rota.caminho}`, () => {
      it('SEGURANCA: sem cookie devolve 401 e nao vaza nada no corpo', async () => {
        const r = await rota.chamar(requisicao(rota))

        expect(r.status).toBe(401)
        // Corpo INTEIRO com toEqual, e nao so o codigo: uma resposta de recusa
        // que "so acrescentasse um detalhe util" (o motivo, o papel exigido, o
        // nome do recurso) ja seria informacao entregue a quem nao se
        // autenticou.
        expect(await r.json()).toEqual({ error: 'nao_autenticado' })
        // Recusa depende de QUEM pediu; cache compartilhado guarda por URL. Sem
        // este cabecalho, a resposta de um caminho pode ser servida a outro
        // visitante — ver o doc comment de exigirPapel em src/lib/guarda.ts.
        expect(r.headers.get('cache-control')).toBe('no-store')
      })

      it('SEGURANCA: cookie com token inexistente devolve 401', async () => {
        // Token bem formado (o alfabeto de gerarTokenDeSessao) que nunca foi
        // gravado. Prova que a rota nao acredita no cookie: quem decide e
        // `sessaoValida` consultando sessoes.token_hash.
        const r = await rota.chamar(requisicao(rota, cookieDe('e'.repeat(43))))

        expect(r.status).toBe(401)
        expect(await r.json()).toEqual({ error: 'nao_autenticado' })
      })

      it('SEGURANCA: sessao de vendedor devolve 403', async () => {
        const r = await rota.chamar(requisicao(rota, cookieVendedor))

        expect(r.status).toBe(403)
        expect(await r.json()).toEqual({ error: 'acesso_negado' })
        expect(r.headers.get('cache-control')).toBe('no-store')
      })

      it('sessao de admin atravessa a guarda', async () => {
        const r = await rota.chamar(requisicao(rota, cookieAdmin))

        // O QUE ESTE TESTE PROVA e so que a guarda deixou passar — o status
        // depois dela e assunto de cada rota (200 nas leituras, 422
        // `nada_para_atualizar` no PATCH de corpo vazio). Fixar um numero aqui
        // amarraria este arquivo de seguranca ao contrato de cada rota e ele
        // ficaria vermelho por motivo nenhum na primeira mudanca de resposta.
        expect(r.status).not.toBe(401)
        expect(r.status).not.toBe(403)
      })
    })
  }

  /**
   * O TESTE QUE FECHA O BURACO DA LISTA.
   *
   * Os lacos acima so protegem as rotas que alguem lembrou de escrever em
   * `ROTAS`. Uma rota nova em src/app/api/admin/, criada amanha sem guarda e
   * sem entrada aqui, passaria despercebida — e e exatamente assim que buraco
   * de controle de acesso aparece: nao por alguem remover uma protecao, e sim
   * por alguem acrescentar uma porta.
   *
   * A varredura le o DISCO, que e a mesma fonte que o roteador do Next usa: uma
   * pasta com `route.ts` dentro de src/app/api/admin E uma rota servida, sem
   * excecao. Quem criar uma tem que acrescenta-la a `ROTAS`, e ai as quatro
   * asseveracoes de acesso passam a valer para ela automaticamente.
   */
  it('SEGURANCA: toda rota em src/app/api/admin esta coberta por este arquivo', () => {
    const dirAdmin = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'admin')

    const rotasNoDisco = (dir: string, caminho: string): string[] => {
      const achadas: string[] = []
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (item.isDirectory()) {
          achadas.push(...rotasNoDisco(join(dir, item.name), `${caminho}/${item.name}`))
        } else if (item.name === 'route.ts') {
          achadas.push(caminho)
        }
      }
      return achadas
    }

    // DEDUPLICADO dos dois lados: desde 19/08/2026 uma mesma rota aparece em
    // ROTAS uma vez por METODO (/api/admin/cupons tem GET, POST e PATCH). A
    // varredura continua respondendo a pergunta que importa — existe algum
    // arquivo `route.ts` sob src/app/api/admin que este teste nao exercita? —,
    // e cobrir uma rota com mais metodos deixou de fazer o teste falhar.
    const unicos = (l: string[]) => [...new Set(l)].sort()

    expect(unicos(rotasNoDisco(dirAdmin, '/api/admin'))).toEqual(
      unicos(ROTAS.map((r) => r.caminho)),
    )
  })
})
