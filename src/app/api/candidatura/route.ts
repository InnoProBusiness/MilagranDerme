import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { ipDoPedido, processarCandidatura } from '@/lib/candidatura'

/**
 * POST /api/candidatura — recebe o formulario da LP de representantes.
 * E o destino do `fetch('/api/candidatura')` em public/script.js.
 *
 * Adaptador fino: toda a logica esta em src/lib/candidatura.ts.
 *
 * Runtime Node explicito: a geracao do PDF usa Buffer e o pdf-lib nao roda
 * no runtime Edge. Node ja e o padrao de um route handler, mas deixar
 * implicito faz um `export const runtime = 'edge'` acidental virar erro de
 * producao em vez de erro de build.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  let dados: unknown
  try {
    dados = await request.json()
  } catch {
    // Corpo vazio ou JSON quebrado. 400 e nao 500: o erro e do cliente, e
    // um 500 aqui poluiria o alerta de erro de servidor com trafego de bot.
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  // `null` e arrays passam por typeof 'object'; a validacao de campos
  // obrigatorios rodaria sobre algo que nao tem os campos e devolveria
  // missing_field, o que e verdade mas esconde a causa real.
  if (typeof dados !== 'object' || dados === null || Array.isArray(dados)) {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const { status, corpo } = await processarCandidatura(
    dados as Record<string, unknown>,
    ipDoPedido(request.headers),
  )
  return NextResponse.json(corpo, { status })
}

export async function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'POST' },
  })
}
