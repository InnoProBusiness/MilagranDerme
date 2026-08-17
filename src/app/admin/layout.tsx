import type { Metadata } from 'next'
import { AbasAdmin, SairDoPainel } from '@/components/navegacao-admin'
import { exigirSessaoDeAdmin } from './sessao-admin'

/**
 * O quadro comum das cinco telas de §17: quem esta logado, as abas e a largura
 * propria do painel (.admin em globals.css, maior que a coluna de leitura da
 * loja porque aqui o conteudo e tabela densa).
 *
 * ESTE LAYOUT NAO E UMA BARREIRA DE SEGURANCA, e a frase merece estar escrita
 * no arquivo que as pessoas leem esperando que ele seja. Um `layout.tsx` do
 * Next e composicao de UI: ele nao intercepta a requisicao, nao roda "antes"
 * da pagina por contrato nenhum e nao tem como impedir que o `page.tsx`
 * aninhado seja renderizado — os dois sao renderizados no mesmo request, e a
 * pagina consultaria o banco de qualquer forma. Um redirect daqui interrompe a
 * arvore, mas confiar nisso e confiar em ordem de execucao que o framework nao
 * promete e que muda entre versoes.
 *
 * Por isso a guarda esta AQUI E EM CADA UMA DAS CINCO PAGINAS, com a mesma
 * funcao (./sessao-admin.ts). A daqui existe para o chrome nao vazar o nome do
 * administrador para quem nao tem sessao; as das paginas sao as que realmente
 * ficam entre o visitante e o banco.
 */
export const dynamic = 'force-dynamic'

/**
 * `robots: noindex, nofollow` no SEGMENTO INTEIRO — as cinco telas herdam.
 *
 * O painel exige sessao e um buscador nunca veria o conteudo, mas a URL vaza
 * por outros caminhos (um link colado num grupo, o Referer de um clique) e uma
 * vez indexada ela vira alvo de varredura automatica. Custo zero, e o lugar
 * certo e o layout: repetir em cinco `page.tsx` e esquecer no sexto.
 */
export const metadata: Metadata = {
  title: 'Painel',
  robots: { index: false, follow: false },
}

export default async function LayoutAdmin({ children }: { children: React.ReactNode }) {
  const usuario = await exigirSessaoDeAdmin()

  return (
    <div className="admin">
      <div className="admin__topo">
        <div>
          <p className="admin__lede">Milagran Derme · Painel administrativo</p>
          {/*
            Nome e e-mail de quem esta logado ficam visiveis o tempo todo de
            proposito: o painel e aberto em maquina compartilhada, e a primeira
            pergunta de quem senta na frente dele e "esta logado como quem?".
            Sem isso, o administrador que herdou o notebook do evento executa
            uma acao de expedicao achando que e a sessao dele.
          */}
          <p className="admin__lede">
            Sessão de <strong>{usuario.nome}</strong> · {usuario.email}
          </p>
        </div>

        <SairDoPainel />
      </div>

      <AbasAdmin />

      {/*
        SEM <main> aqui. Ele existiu por um momento, quando o wrapper do layout
        raiz ainda era uma <div>; assim que aquele wrapper virou <main>
        (src/app/layout.tsx), este passou a ser um segundo landmark aninhado
        dentro do primeiro — HTML invalido, e dois destinos concorrentes para o
        "ir para o conteudo principal" do leitor de tela. O landmark do painel
        e o mesmo da loja, e o "pular para o conteudo" do cabecalho ja cai
        acima destas abas.
      */}
      {children}
    </div>
  )
}
