import { saldoDoEstoque } from '@/repositories/estoque'
import { avisoDeEscassez, type AvisoEscassez } from '@/lib/escassez'

/**
 * O lote presencial do lancamento, do jeito que a Vitrine
 * (src/components/vitrine.tsx) pede a prop `escassez`.
 *
 * POR QUE ESTE ARQUIVO EXISTE: tres superficies de servidor precisam da mesma
 * combinacao "le o saldo presencial, transforma em frase" — a home (§5/§11),
 * /comprar e /r/<slug>. Sao tres linhas cada, e tres copias de tres linhas e
 * exatamente como este projeto ja deixou telas discordarem sobre o mesmo
 * pedido antes (ver o cabecalho de src/components/linha-frete.tsx). GET
 * /api/estoque faz a MESMA composicao para o navegador; se um dia a regra
 * mudar, os dois lados tem que mudar juntos.
 *
 * NAO fica em src/lib/escassez.ts de proposito: aquele modulo e puro e e
 * importado por um client component (src/components/contador-estoque.tsx).
 * Um import de @/repositories/estoque la dentro arrastaria `pg` para o bundle
 * do navegador e quebraria o build. Este arquivo e so de servidor — mesma
 * separacao que src/lib/guarda.ts ja faz.
 *
 * DEVOLVE null quando o kit nao tem linha de estoque presencial. Isso NAO e
 * "esgotado" e NAO e zero: e um kit que nunca entrou no evento. A tela que
 * recebe null nao mostra contador nenhum — anunciar "os 0 kits foram
 * esgotados" sobre um lote que nunca existiu e uma frase falsa, e a mesma
 * disciplina que o frete segue ao dizer "a cotar" em vez de "R$ 0,00".
 */
export type EscassezDoLote = {
  disponivel: number
  total: number
  aviso: AvisoEscassez
}

export async function escassezPresencialDoKit(kitId: string): Promise<EscassezDoLote | null> {
  const presencial = await saldoDoEstoque(kitId, 'presencial')
  if (!presencial) return null

  // O aviso le o saldo CRU e o contador recebe o saldo CLAMPADO em zero —
  // mesma divisao de src/app/api/estoque/route.ts. `ajustarEstoque` pode
  // deixar o disponivel negativo (uma recontagem no balcao), e negativo e zero
  // caem os dois em 'esgotado', entao o clamp nao muda uma palavra da frase.
  // O que ele impede e a tela imprimir "Kits disponíveis: -3", que nao e
  // verdade nenhuma sobre a caixa do evento.
  return {
    disponivel: Math.max(0, presencial.disponivel),
    total: presencial.total,
    aviso: avisoDeEscassez(presencial.disponivel, presencial.total),
  }
}
