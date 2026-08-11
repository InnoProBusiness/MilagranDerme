# Deploy — o que serve o que

Este arquivo existe porque este repositorio hospedou **dois tipos de site
diferentes** e a troca entre eles nao e obvia: antes do Plano 1 ele era um
site estatico puro (HTML na raiz, servido direto pela Vercel); a partir do
Plano 1 ele e uma aplicacao Next.js. As duas configuracoes servem URLs
diferentes a partir dos mesmos arquivos.

## Antes deste branch (deploy estatico)

Sem `package.json` com `next`, a Vercel nao detecta framework, nao roda
build e serve a **raiz do repositorio** como diretorio publico:

| URL | Arquivo |
|---|---|
| `/` | `index.html` (raiz) |
| `/privacidade.html` | `privacidade.html` (raiz) |
| `/styles.css` | `styles.css` (raiz) |
| `/script.js` | `script.js` (raiz) |
| `/assets/*` | `assets/*` (raiz) |
| `/api/candidatura` | `api/candidatura.js` (Serverless Function da Vercel) |

## Depois deste branch (deploy Next.js)

Com `next` no `package.json`, a Vercel detecta Next.js, roda `next build` e
**deixa de servir a raiz do repositorio**. Somente `public/` e as rotas do
App Router ficam acessiveis. Por isso os estaticos foram movidos para
`public/`, preservando exatamente as mesmas URLs:

| URL | Origem |
|---|---|
| `/` | `src/app/page.tsx` → redirect 307 para `/seja-representante.html` |
| `/seja-representante.html` | `public/seja-representante.html` (copia de `index.html`) |
| `/privacidade.html` | `public/privacidade.html` — **URL nao pode mudar** |
| `/styles.css` | `public/styles.css` |
| `/script.js` | `public/script.js` |
| `/assets/*` | `public/assets/*` |
| `/r/<slug>` | `src/app/r/[slug]/page.tsx` + `src/proxy.ts` (cookie de atribuicao) |
| `/api/candidatura` | `api/candidatura.js` — continua sendo Serverless Function da Vercel |

### Detalhes que custam caro descobrir de novo

- **`/privacidade.html` e um compromisso de LGPD.** A URL esta linkada no
  rodape da LP e no consentimento do formulario de candidatura. Nao mova,
  nao renomeie, nao troque por uma rota do App Router sem redirect.
- **`api/candidatura.js` NAO e uma rota do Next.** E uma Serverless Function
  da propria Vercel (diretorio `api/` na raiz), deliberadamente excluida do
  `tsconfig.json`. `next dev`/`next start` **nao emulam** esse diretorio:
  um 404 em `/api/candidatura` no ambiente local e esperado e nao indica
  quebra em producao. Ela depende de `pdf-lib` e das variaveis `RESEND_*`/
  `EMAIL_*`.
- **`index.html` na raiz continua versionado de proposito.** Ele e o que o
  deploy estatico atual serve. Enquanto a Production Branch da Vercel nao
  estiver apontando para o branch com Next, apaga-lo derruba o site no ar.
  Depois do corte, ele fica redundante com `public/seja-representante.html`
  e pode ser removido em commit proprio.
- **Os dois arquivos sao copias.** `index.html` (raiz) e
  `public/seja-representante.html` tem o mesmo conteudo. Enquanto os dois
  existirem, uma edicao de conteudo na LP precisa ir nos dois.
- **`src/app/globals.css` e uma copia de `styles.css`**, feita na Tarefa 1
  do Plano 1 para o App Router. A LP estatica continua usando
  `public/styles.css`; as duas copias so convergem quando a vitrine do
  Plano 2 substituir a LP.

## Pendencia aberta: qual e a Production Branch da Vercel?

Nao verificavel a partir do codigo — depende do painel da Vercel. Antes de
mergear:

1. Confirmar qual branch a Vercel usa como **Production Branch**.
2. Confirmar que o projeto tem `DATABASE_URL`, `DIRECT_URL` e
   `ATRIBUICAO_SECRET` (>= 32 caracteres) configuradas no ambiente de
   producao — sem elas `/r/<slug>` estoura.
3. Depois do primeiro deploy com Next, conferir manualmente:
   `/`, `/privacidade.html`, `/styles.css`, `/assets/logo-160.png`,
   `/api/candidatura` (POST) e `/r/<slug>` de um representante ativo.

O bloqueio de calendario "troca da Production Branch na Vercel" ja esta
registrado no Plano 1; este arquivo e o detalhamento tecnico dele.
