/**
 * Rodape compartilhado por TODAS as rotas do App Router (renderizado uma
 * unica vez em src/app/layout.tsx). Mesmo motivo do cabecalho para morar em
 * arquivo proprio: layout do Next nao e lugar de export extra.
 *
 * SERVER COMPONENT: so texto e link.
 */

/** Dados institucionais reais, os mesmos da LP de recrutamento. */
const CNPJ = '68.232.977/0001-78'
const WHATSAPP_LINK = 'https://wa.me/556291129089'
const WHATSAPP_VISIVEL = '(62) 9112-9089'
const EMAIL = 'milagranoficial@gmail.com'
const INSTAGRAM = 'milagran.oficial'

export function Rodape() {
  // Ano do servidor. As paginas da loja sao `force-dynamic` (leem estoque e
  // pedido ao vivo), entao este valor e calculado a cada acesso; numa rota que
  // venha a ser pre-renderizada no build, ele congela na data do deploy — o
  // que e aceitavel para uma linha de copyright e nao justifica um
  // 'use client' no rodape de todas as telas.
  const ano = new Date().getFullYear()

  return (
    <footer className="rodape">
      <div className="rodape__grid">
        <div className="rodape__coluna">
          <span className="rodape__marca">Milagran Derme</span>
          <p>Kit de limpeza de pele instantânea. Lançamento oficial em 25 de agosto de 2026.</p>
          <p>CNPJ {CNPJ}</p>
        </div>

        {/*
          `id="contato"` e o alvo do item "Contato" do menu de §25. Ele mora no
          RODAPE, e nao numa secao propria da home, porque os canais de contato
          da marca ja estao aqui e uma secao separada seria a mesma lista escrita
          duas vezes — que e como duas superficies acabam publicando telefones
          diferentes.

          Consequencia que vale saber: como o rodape aparece em TODAS as rotas,
          `#contato` funciona no checkout e no painel tambem, sem voltar para a
          home.
        */}
        <div className="rodape__coluna" id="contato">
          <h2>Contato</h2>
          <ul className="rodape__lista">
            <li>
              <a href={WHATSAPP_LINK} target="_blank" rel="noopener noreferrer">
                WhatsApp {WHATSAPP_VISIVEL}
              </a>
            </li>
            <li>
              <a href={`mailto:${EMAIL}`}>{EMAIL}</a>
            </li>
            <li>
              <a
                href={`https://instagram.com/${INSTAGRAM}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                @{INSTAGRAM}
              </a>
            </li>
          </ul>
        </div>

        {/*
          §14 do documento do cliente: o convite para representante continua
          disponivel, mas DISCRETO — a pagina de lancamento vende o kit ao
          consumidor final, e representante deixou de ser o assunto principal
          do site (era ele quem ocupava "/" ate 16/08/2026).

          Por isso o CTA e link de texto (.rodape__cta) e nao `.btn--solid`:
          um botao dourado aqui disputaria atencao com a CTA de compra.

          <a> CRU, e nao next/link, e isso NAO e descuido de estilo:
          /seja-representante.html e um arquivo estatico de public/, fora do
          App Router. Um <Link> tentaria navegacao client-side para uma rota
          que o roteador nao conhece. E a mesma URL que
          deploy/milagran-ci-deploy.sh usa para aprovar ou reverter o deploy
          inteiro (verificar_borda) — ela precisa continuar respondendo 200.
        */}
        <div className="rodape__coluna">
          <h2>Representantes</h2>
          <div className="rodape__representante">
            <p>Quer representar a Milagran?</p>
            <a className="rodape__cta" href="/seja-representante.html">
              Conheça as oportunidades
            </a>
          </div>
        </div>
      </div>

      <div className="rodape__legal">
        <span>Milagran Derme · CNPJ {CNPJ} · © {ano}</span>
        {/*
          /privacidade.html e compromisso de LGPD: a URL esta linkada no
          consentimento do formulario de candidatura e no rodape da LP. Nao
          muda de endereco (ver DEPLOY.md).
        */}
        <a href="/privacidade.html">Política de Privacidade</a>
      </div>
    </footer>
  )
}
