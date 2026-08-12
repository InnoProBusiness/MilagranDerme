import { NextResponse } from 'next/server'

/**
 * Liveness para o HEALTHCHECK do container (ver Dockerfile) e para o
 * Portainer mostrar o servico como healthy.
 *
 * De proposito NAO consulta o Postgres. Um healthcheck que falha quando o
 * banco cai faz o Swarm matar e recriar a aplicacao em loop justamente no
 * momento em que ela estava servindo bem as paginas estaticas (a LP, o
 * /privacidade.html) — troca uma degradacao parcial por uma queda total.
 * O que este endpoint responde e "o processo Node subiu e esta aceitando
 * conexoes"; a saude do banco pertence a monitoracao, nao ao restart loop.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ ok: true, servico: 'milagran' })
}
