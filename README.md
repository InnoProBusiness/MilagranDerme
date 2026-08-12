# Milagran — plataforma

Loja propria da Milagran Derme com atribuicao de venda por representante:
quem chega por `/r/<slug>` tem essa origem gravada de forma imutavel no
pedido, e e ela que decide quem recebe comissao. Aplicacao Next.js 16 (App
Router) em deploy unico, Postgres acessado por Kysely, migrations em SQL
puro escritas a mao.

## Pre-requisitos

- **Node 20.9+** (ambiente de referencia: 24.x)
- **Docker** — o Postgres local sobe por `docker compose`, na **versao 14**,
  a mesma de producao (ver `docker-compose.yml`)
- **npm** (o `package-lock.json` versionado e o do npm)

## Setup

```bash
npm install
cp .env.example .env      # e preencher (ver abaixo)
npm run db:up             # sobe o Postgres local na porta 55432
npm run db:migrate        # aplica migrations/*.sql (usa DIRECT_URL)
npm run db:types          # regenera src/lib/db-types.ts (usa DATABASE_URL)
npm test
```

O `.env` precisa de tres variaveis para os testes passarem:

| Variavel | Para que serve |
|---|---|
| `DATABASE_URL` | Conexao da aplicacao e dos testes. |
| `DIRECT_URL` | Conexao usada so pelas migrations (**nunca** via pooler). |
| `ATRIBUICAO_SECRET` | Chave HMAC do cookie de atribuicao. **Minimo 32 caracteres.** |

Gerar o segredo:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Em desenvolvimento local as duas URLs apontam para o mesmo Postgres do
Docker; os valores prontos estao no `.env.example`.

> **Por que duas URLs.** `db:migrate` passa `-d DIRECT_URL` para o
> node-pg-migrate de proposito: o default da ferramenta e `DATABASE_URL`, e
> em producao isso rodaria DDL atraves do pooler, que pode nao sustentar o
> advisory lock de sessao entre statements. Ja `db:types`
> (kysely-codegen) le `DATABASE_URL`. Sem `DATABASE_URL` definida, todos os
> arquivos de teste que tocam o banco falham com `DATABASE_URL nao
> configurada` — nao ha bug, falta o `.env`.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento (`next dev`) |
| `npm run build` / `npm start` | Build e servidor de producao |
| `npm test` | Suite completa (Vitest, uma vez) |
| `npm run test:watch` | Vitest em modo watch |
| `npm run typecheck` | `tsc --noEmit`, `strict: true` |
| `npm run db:up` | Sobe o Postgres local (docker compose) |
| `npm run db:migrate` | Aplica as migrations pendentes |
| `npm run db:types` | Regenera os tipos do banco |

Os testes rodam **contra o Postgres real**, nao contra mock: as garantias
que mais importam aqui (unicidade, CHECK, triggers de imutabilidade) sao do
banco, e um mock nao as testa. Por isso `npm run db:up` e `db:migrate`
precisam ter rodado antes.

## Como o codigo esta organizado

| Caminho | Responsabilidade |
|---|---|
| `migrations/*.sql` | DDL em SQL puro, ordenado por timestamp. Nenhuma ferramenta gera DDL. |
| `src/lib/money.ts` | Dinheiro em centavos inteiros e arredondamento de comissao |
| `src/lib/tempo.ts` | Limites de periodo em `America/Sao_Paulo` |
| `src/lib/atribuicao.ts` | Assinatura e verificacao do cookie de atribuicao (HMAC) |
| `src/lib/resolver-pedido.ts` | Cookie → atribuicao autoritativa do pedido |
| `src/proxy.ts` | Grava o cookie em `/r/<slug>` (Next 16 renomeou `middleware`) |
| `src/repositories/*` | Acesso ao banco por entidade |
| `public/` | LP de recrutamento, politica de privacidade e estaticos |
| `src/lib/candidatura.ts` | Validacao, PDF e envio da candidatura (Resend) |
| `src/app/api/*` | Route handlers: `candidatura` (POST) e `health` |
| `Dockerfile`, `milagran-stack.example.yml`, `deploy/` | Deploy em Docker Swarm |

Regras que valem para todo o codigo (dinheiro sempre em centavos inteiros,
fuso `America/Sao_Paulo`, migrations a mao, atribuicao autoritativa no
pedido) estao em `docs/superpowers/plans/` — secao **Global Constraints**.

## Deploy

Alvo unico: **VPS em Docker Swarm**, atras do Traefik. Nao ha Vercel nem
Serverless Function. O ciclo completo, o mapa de URLs e as armadilhas da
maquina estao em [`DEPLOY.md`](./DEPLOY.md) — leia antes de mexer em
`public/`, no `Dockerfile` ou no stack.
