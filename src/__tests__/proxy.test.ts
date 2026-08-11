import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { getDb, closeDb } from '@/lib/db'
import { proxy } from '@/proxy'
import {
  NOME_COOKIE_ATRIBUICAO, assinarAtribuicao, verificarAtribuicao, type Atribuicao,
} from '@/lib/atribuicao'

// next/experimental/testing/server foi avaliado antes de escrever este
// arquivo. Ele so cobre duas coisas: (1) unstable_doesMiddlewareMatch, que
// testa se um config.matcher bate com uma URL, e (2)
// unstable_getResponseFromNextConfig, que testa headers/redirects/rewrites
// declarados em next.config.js. Nenhum dos dois executa a funcao `proxy`
// exportada por um arquivo de proxy — nao ha, nessa API experimental,
// como invocar logica customizada e inspecionar a resposta. Por isso este
// arquivo importa `proxy` diretamente e chama com um NextRequest construido
// a mao, como a propria Next.js orienta a fazer quando a utility acima nao
// serve (https://nextjs.org/docs/app/guides/testing).

const SEGREDO = 'a'.repeat(64)

// Slugs proprios deste arquivo, distintos dos usados por
// representantes.test.ts ("maria"/"joao"/"ana"). O Vitest roda arquivos de
// teste em paralelo; como os dois arquivos escrevem na mesma tabela
// "representantes" do Postgres real, um DELETE sem filtro (ou slugs que
// colidem) faz um arquivo apagar as linhas que o outro acabou de inserir.
// Slugs exclusivos + DELETE escopado por slug tornam os dois arquivos
// independentes mesmo rodando ao mesmo tempo.
const SLUG_ATIVO = 'proxy-maria'
const SLUG_INATIVO = 'proxy-ana'

async function semear() {
  const db = getDb()
  await db.deleteFrom('representantes').where('slug', 'in', [SLUG_ATIVO, SLUG_INATIVO]).execute()
  await db.insertInto('representantes').values([
    { slug: SLUG_ATIVO, codigo: 'PROXYMARIA', nome: 'Maria (proxy test)', email: 'proxy-maria@exemplo.com', percentual_comissao: '20.00', ativo: true },
    { slug: SLUG_INATIVO, codigo: 'PROXYANA', nome: 'Ana (proxy test)', email: 'proxy-ana@exemplo.com', percentual_comissao: '20.00', ativo: false },
  ]).execute()
}

function cookieExistente(a: Atribuicao): string {
  return `${NOME_COOKIE_ATRIBUICAO}=${assinarAtribuicao(a, SEGREDO)}`
}

function requisicao(caminho: string, cookieHeader?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${caminho}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  })
}

describe('proxy de atribuicao (src/proxy.ts)', () => {
  // O proxy registra console.warn nos caminhos em que a atribuicao se perde
  // (ver "avisar" em src/proxy.ts). O spy mantem a saida do teste limpa e
  // serve de assercao nos dois testes que cobram a migalha de log.
  let avisos: ReturnType<typeof vi.spyOn>

  beforeAll(() => {
    process.env.ATRIBUICAO_SECRET = SEGREDO
  })
  beforeEach(async () => {
    avisos = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await semear()
  })
  afterEach(() => { avisos.mockRestore() })
  afterAll(async () => { await closeDb() })

  it('slug ativo grava o cookie de atribuicao', async () => {
    const resposta = await proxy(requisicao(`/r/${SLUG_ATIVO}`))
    const setado = resposta.cookies.get(NOME_COOKIE_ATRIBUICAO)
    expect(setado).toBeDefined()

    const atribuicao = verificarAtribuicao(setado!.value, SEGREDO)
    expect(atribuicao?.slug).toBe(SLUG_ATIVO)
  })

  it('representante inativo nao grava cookie nenhum', async () => {
    const resposta = await proxy(requisicao(`/r/${SLUG_INATIVO}`))
    expect(resposta.cookies.get(NOME_COOKIE_ATRIBUICAO)).toBeUndefined()
  })

  it('slug desconhecido nao grava cookie nenhum', async () => {
    const resposta = await proxy(requisicao('/r/proxy-nao-existe'))
    expect(resposta.cookies.get(NOME_COOKIE_ATRIBUICAO)).toBeUndefined()
  })

  it('DINHEIRO: slug percent-encoded na URL grava o cookie do mesmo jeito que o slug literal', async () => {
    // nextUrl.pathname NUNCA vem decodificado; params.slug (que a pagina
    // recebe) vem. Antes do decode no proxy, esta URL renderizava a pagina
    // da Maria com 200 e sem Set-Cookie nenhum — a venda seguinte era
    // gravada como 'casa' e a Maria nao recebia.
    const codificado = `/r/${SLUG_ATIVO.replace('i', '%69')}`
    expect(codificado).toBe('/r/proxy-mar%69a')

    const resposta = await proxy(requisicao(codificado))
    const setado = resposta.cookies.get(NOME_COOKIE_ATRIBUICAO)
    expect(setado).toBeDefined()
    expect(verificarAtribuicao(setado!.value, SEGREDO)?.slug).toBe(SLUG_ATIVO)
  })

  it('percent-encoding malformado nao estoura o proxy e nao grava cookie', async () => {
    // decodeURIComponent('%E0%A4%A') lanca URIError. Um throw aqui viraria
    // 500 na pagina inteira; o proxy trata como slug inexistente.
    const resposta = await proxy(requisicao('/r/%E0%A4%A'))
    expect(resposta.cookies.get(NOME_COOKIE_ATRIBUICAO)).toBeUndefined()
    expect(resposta.headers.get('set-cookie')).toBeNull()
  })

  it('registra o slug perdido em vez de falhar em silencio', async () => {
    await proxy(requisicao('/r/proxy-nao-existe'))

    expect(avisos).toHaveBeenCalledTimes(1)
    const [mensagem, dados] = avisos.mock.calls[0] as [string, Record<string, string>]
    expect(mensagem).toContain('[atribuicao]')
    expect(dados).toEqual({ slug: 'proxy-nao-existe', motivo: 'slug_inexistente_ou_inativo' })
  })

  it('registra o cookie descartado sem logar o valor, a assinatura ou o segredo', async () => {
    const forjado = assinarAtribuicao(
      { slug: SLUG_ATIVO, em: Date.now(), utmSource: null, utmMedium: null, utmCampaign: null },
      'b'.repeat(64), // outro segredo: nao passa na verificacao
    )
    const resposta = await proxy(
      requisicao(`/r/${SLUG_ATIVO}`, `${NOME_COOKIE_ATRIBUICAO}=${forjado}`),
    )

    // O visitante continua atribuido: o cookie ruim e substituido por um bom.
    expect(resposta.cookies.get(NOME_COOKIE_ATRIBUICAO)).toBeDefined()

    expect(avisos).toHaveBeenCalledTimes(1)
    const [, dados] = avisos.mock.calls[0] as [string, Record<string, string>]
    expect(dados.motivo).toBe('assinatura_invalida_ou_expirado')

    const tudoQueFoiLogado = JSON.stringify(avisos.mock.calls)
    expect(tudoQueFoiLogado).not.toContain(forjado)
    expect(tudoQueFoiLogado).not.toContain(SEGREDO)
  })

  it('DINHEIRO: visitante com atribuicao valida ao representante ativo que cai num link morto (inativo) continua atribuido ao original', async () => {
    // Este e o cenario que o proxy existe para prevenir: um link morto ou
    // digitado errado NAO PODE, via LAST CLICK, apagar uma atribuicao valida
    // a um representante que de fato fechou a venda.
    const atribuicaoExistente: Atribuicao = {
      slug: SLUG_ATIVO, em: Date.now(), utmSource: null, utmMedium: null, utmCampaign: null,
    }
    const resposta = await proxy(requisicao(`/r/${SLUG_INATIVO}`, cookieExistente(atribuicaoExistente)))

    // O proxy nao devolve nenhum Set-Cookie — o navegador continua
    // mandando de volta o cookie original, que ainda aponta para SLUG_ATIVO.
    expect(resposta.cookies.get(NOME_COOKIE_ATRIBUICAO)).toBeUndefined()
    expect(resposta.headers.get('set-cookie')).toBeNull()
  })
})
