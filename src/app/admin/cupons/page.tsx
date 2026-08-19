import type { Metadata } from 'next'
import { CuponsAdmin } from '@/components/cupons-admin'
import { listarCupons } from '@/repositories/cupons'
import { listarKitsAtivos } from '@/repositories/produtos'
import { listarRepresentantesAtivas } from '@/repositories/representantes'
import { exigirSessaoDeAdmin } from '../sessao-admin'

/**
 * Campanhas: criar um cupom e sair daqui com o LINK pronto para colar.
 *
 * Ver o cabecalho de src/components/cupons-admin.tsx para o porque desta tela
 * existir e por que ela pergunta preco final em vez de desconto.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Campanhas' }

export default async function PaginaCuponsAdmin() {
  // ANTES da primeira consulta, e apesar de o layout ja conferir. Ver
  // ../sessao-admin.ts.
  await exigirSessaoDeAdmin()

  const [cupons, kits, representantes] = await Promise.all([
    listarCupons(),
    listarKitsAtivos(),
    listarRepresentantesAtivas(),
  ])

  const kit = kits[0]

  // SEM KIT NAO HA CAMPANHA. O formulario inteiro se apoia no preco cheio para
  // traduzir "o kit vai custar 800" em desconto; sem catalogo nao ha de onde
  // tirar esse numero, e um formulario com preco zero produziria um cupom que
  // desconta o kit inteiro. Melhor dizer que falta o kit.
  if (!kit) {
    return (
      <>
        <div className="admin__topo">
          <h1 className="admin__titulo">Campanhas</h1>
        </div>
        <p className="tabela__vazio">
          Nenhum kit ativo no catálogo — sem preço não é possível montar uma oferta.
        </p>
      </>
    )
  }

  // A MESMA origem que os e-mails de pedido e o retorno do Mercado Pago usam
  // (src/lib/email-pedido.ts, src/lib/mercadopago.ts). O link gerado aqui e
  // colado no Instagram e vive meses: apontar para um dominio diferente do que
  // o resto do sistema considera oficial seria a forma mais silenciosa de
  // quebrar uma campanha inteira.
  const urlBase = (process.env.APP_URL ?? 'https://milagranoficial.com.br').replace(/\/$/, '')

  return (
    <>
      <div className="admin__topo">
        <div>
          <h1 className="admin__titulo">Campanhas</h1>
          <p className="admin__lede">
            Crie o cupom e copie o link pronto. Quem abrir o link já encontra o
            desconto aplicado no checkout, sem digitar código.
          </p>
        </div>
      </div>

      <CuponsAdmin
        cupons={cupons}
        precoDoKit={kit.precoCentavos}
        representantes={representantes.map((r) => ({ id: r.id, nome: r.nome, slug: r.slug }))}
        urlBase={urlBase}
      />
    </>
  )
}
