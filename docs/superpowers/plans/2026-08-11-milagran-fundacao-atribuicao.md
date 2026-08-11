# Plataforma Milagran — Plano 1: Fundação, Dados e Atribuição

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estabelecer a fundação técnica da plataforma e entregar o mecanismo de atribuição de venda funcionando ponta a ponta — um visitante que chega por `/r/maria` tem essa origem gravada de forma inviolável no pedido.

**Architecture:** Aplicação Next.js 16 (App Router) em deploy único, com Postgres acessado por query builder tipado. Migrations em SQL puro, nunca geradas por ORM, porque todo mecanismo de idempotência e unicidade do sistema é índice parcial e ORMs tratam índice parcial escrito à mão como drift. Atribuição resolvida no servidor: o cookie é apenas um sinal do navegador, e o valor autoritativo é congelado na linha do pedido no momento da criação.

**Tech Stack:** Next.js 16.3 · React 19 · TypeScript strict · Postgres 17 · Kysely (query builder tipado) · node-pg-migrate (SQL puro) · Vitest · Docker (Postgres local de teste)

## Global Constraints

Estas regras valem para **todas** as tarefas deste plano e dos planos seguintes. Os requisitos de cada tarefa incluem esta seção implicitamente.

- **Dinheiro é sempre `integer` em centavos.** Nunca `float`, nunca `NUMERIC`, nunca aritmética em reais. Uma comissão de 20% calculada em ponto flutuante produz dinheiro real errado.
- **Fuso horário é `America/Sao_Paulo`** em todo agrupamento por período (meta do mês, vendas de hoje, ranking). O cron da Vercel roda em UTC; converter é responsabilidade da aplicação. Uma venda às 21h30 do dia 31 pertence ao mês que terminou.
- **Migrations são arquivos `.sql` escritos à mão.** Nenhuma ferramenta gera DDL. Todo índice único parcial é escrito explicitamente e nunca removido sem migration própria.
- **A atribuição autoritativa vive no pedido, não no cookie.** O cookie é sinal; o servidor resolve e congela.
- **TypeScript `strict: true`.** `any` só é tolerado na fronteira de resposta de gateway, e imediatamente validado com Zod.
- **Nenhum segredo em código.** Tudo por variável de ambiente, e todo novo segredo entra no `.env.example` no mesmo commit.
- **Toda tarefa termina com commit.** Mensagem em inglês, imperativo, sem `--no-verify`.
- **Node 20.9+** (ambiente atual: 24.13.1).

## Premissa que precisa de confirmação por escrito

A base de cálculo da comissão está implementada como **percentual sobre o subtotal dos produtos já com desconto de cupom aplicado, excluindo frete**. Esta é a interpretação mais comum e a mais defensável, mas é decisão de negócio, não técnica. Está isolada numa única função (`calcularComissao`, Tarefa 3) justamente para que trocá-la seja barato — mas trocar depois de o primeiro extrato ser exibido a um representante significa recalcular extratos já vistos. **Confirmar antes da Tarefa 10 do Plano 3.**

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `package.json` | Dependências e scripts. Substitui o atual (que só tem pdf-lib) |
| `tsconfig.json` | TypeScript strict |
| `next.config.ts` | Configuração do Next |
| `vitest.config.ts` | Runner de testes, ambiente node |
| `docker-compose.yml` | Postgres 17 local para desenvolvimento e teste |
| `migrations/*.sql` | DDL em SQL puro, versionado, ordenado por timestamp |
| `src/lib/money.ts` | Centavos, formatação BRL, arredondamento de percentual |
| `src/lib/tempo.ts` | Limites de período em America/Sao_Paulo |
| `src/lib/db.ts` | Instância Kysely, pool, singleton |
| `src/lib/db-types.ts` | Tipos gerados a partir do banco |
| `src/lib/atribuicao.ts` | Assinatura, verificação e resolução de atribuição |
| `src/repositories/produtos.ts` | Leitura e escrita de produtos e kits |
| `src/repositories/representantes.ts` | Leitura e escrita de representantes |
| `src/repositories/pedidos.ts` | Criação de pedido com atribuição congelada |
| `src/app/r/[slug]/page.tsx` | Página individual do representante |
| `src/proxy.ts` | Captura de `?ref=` e normalização de rota (Next 16 renomeou `middleware.ts`) |
| `src/app/globals.css` | `styles.css` atual, colado |

**Decisão de decomposição:** os repositórios são separados por entidade, não por camada técnica, porque é assim que mudam juntos. `atribuicao.ts` é lib e não repositório porque é lógica pura, sem I/O — o que a torna testável sem banco e é justamente o código que mais precisa de teste.

---

## Task 1: Scaffold Next.js com TypeScript strict e Vitest

**Files:**
- Create: `package.json` (substitui o atual), `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.gitignore` (append), `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Modify: `.gitignore`
- Test: `src/lib/__tests__/smoke.test.ts`

**Interfaces:**
- Consumes: nada (primeira tarefa)
- Produces: projeto Next compilável; comando `npm test` funcionando; `src/app/globals.css` contendo os tokens de marca reutilizados pelas tarefas de UI

- [ ] **Step 1: Preservar o CSS atual antes de sobrescrever a estrutura**

O `styles.css` na raiz é CSS puro sem build step e é o design system da marca. Ele vira o `globals.css` sem edição.

```bash
mkdir -p src/app src/lib src/repositories migrations
cp styles.css src/app/globals.css
```

- [ ] **Step 2: Escrever o package.json**

Substitui o atual. `pdf-lib` permanece porque `api/candidatura.js` ainda depende dele.

```json
{
  "name": "milagran-plataforma",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "db:up": "docker compose up -d",
    "db:migrate": "node-pg-migrate -m migrations up",
    "db:types": "kysely-codegen --out-file src/lib/db-types.ts"
  },
  "dependencies": {
    "next": "16.3.0",
    "react": "19.2.0",
    "react-dom": "19.2.0",
    "kysely": "^0.28.0",
    "pg": "^8.13.0",
    "zod": "^4.4.3",
    "pdf-lib": "^1.17.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "node-pg-migrate": "^7.9.0",
    "kysely-codegen": "^0.18.0"
  }
}
```

- [ ] **Step 3: Escrever tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", "api"]
}
```

`api` fica excluído porque `api/candidatura.js` é JavaScript legado que continua deployado como função serverless independente.

- [ ] **Step 4: Escrever next.config.ts e vitest.config.ts**

```ts
// next.config.ts
import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
}

export default config
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
```

- [ ] **Step 5: Escrever o teste de fumaça**

```ts
// src/lib/__tests__/smoke.test.ts
import { describe, it, expect } from 'vitest'

describe('ambiente de teste', () => {
  it('roda TypeScript com alias @/', async () => {
    const { ok } = await import('@/lib/smoke')
    expect(ok()).toBe(true)
  })
})
```

- [ ] **Step 6: Rodar o teste e confirmar que falha**

```bash
npm install
npm test
```

Esperado: FALHA com `Cannot find module '@/lib/smoke'`.

- [ ] **Step 7: Implementar o mínimo para passar**

```ts
// src/lib/smoke.ts
export function ok(): boolean {
  return true
}
```

- [ ] **Step 8: Escrever layout e página raiz**

```tsx
// src/app/layout.tsx
import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Milagran Derme',
  description: 'Kit de limpeza de pele instantânea.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
```

```tsx
// src/app/page.tsx
export default function Home() {
  return <main><h1>Milagran</h1></main>
}
```

- [ ] **Step 9: Rodar testes, typecheck e build**

```bash
npm test
npm run typecheck
npm run build
```

Esperado: os três passam. O build é o que prova que o Next 16 subiu de verdade com Node 24.

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json next.config.ts vitest.config.ts src/ .gitignore
git commit -m "Scaffold Next.js 16 app with strict TypeScript and Vitest"
```

---

## Task 2: Postgres local e runner de migrations em SQL puro

**Files:**
- Create: `docker-compose.yml`, `migrations/1754900000000_extensoes.sql`, `.env.example` (append)
- Test: `src/lib/__tests__/db.test.ts`
- Create: `src/lib/db.ts`

**Interfaces:**
- Consumes: projeto compilável da Tarefa 1
- Produces: `getDb(): Kysely<DB>` singleton; banco local em `postgres://milagran:milagran@localhost:5433/milagran`; convenção de migration em SQL puro

- [ ] **Step 1: Escrever o docker-compose**

Porta 5433 e não 5432 para não colidir com um Postgres já instalado na máquina.

```yaml
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: milagran
      POSTGRES_PASSWORD: milagran
      POSTGRES_DB: milagran
    ports:
      - "5433:5432"
    volumes:
      - milagran_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U milagran"]
      interval: 3s
      timeout: 3s
      retries: 10

volumes:
  milagran_pgdata:
```

- [ ] **Step 2: Acrescentar as variáveis ao .env.example**

```bash
cat >> .env.example <<'EOF'

# --- Banco de dados ---
# Local: docker compose up -d
# Producao: string COM POOLING do provedor. A string direta (sem pooler)
# so deve ser usada por node-pg-migrate, nunca pela aplicacao — sem pooler,
# trafego de campanha estoura max_connections e a loja devolve 500 no pico.
DATABASE_URL=postgres://milagran:milagran@localhost:5433/milagran
DIRECT_URL=postgres://milagran:milagran@localhost:5433/milagran

# Segredo para assinar o cookie de atribuicao (HMAC).
# Gerar com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ATRIBUICAO_SECRET=
EOF
```

- [ ] **Step 3: Subir o banco e escrever a primeira migration**

```bash
npm run db:up
```

```sql
-- migrations/1754900000000_extensoes.sql
-- Up Migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Down Migration
DROP EXTENSION IF EXISTS pgcrypto;
```

`pgcrypto` fornece `gen_random_uuid()`, usado como chave primária em todas as tabelas.

- [ ] **Step 4: Escrever o teste de conexão**

```ts
// src/lib/__tests__/db.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { sql } from 'kysely'

describe('conexao com o banco', () => {
  afterAll(async () => { await closeDb() })

  it('executa uma query e enxerga a extensao pgcrypto', async () => {
    const r = await sql<{ uuid: string }>`SELECT gen_random_uuid()::text AS uuid`
      .execute(getDb())
    expect(r.rows[0]!.uuid).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('devolve a mesma instancia em chamadas repetidas', () => {
    expect(getDb()).toBe(getDb())
  })
})
```

- [ ] **Step 5: Rodar e confirmar que falha**

```bash
npm test -- db.test
```

Esperado: FALHA com `Cannot find module '@/lib/db'`.

- [ ] **Step 6: Implementar db.ts**

O singleton em `globalThis` é obrigatório: em serverless, instanciar um pool por requisição esgota as conexões do banco sob tráfego.

```ts
// src/lib/db.ts
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { DB } from '@/lib/db-types'

// Postgres devolve int8 (bigint) como string por seguranca. Como todo
// dinheiro no sistema cabe em int4 e ids sao uuid, converter para number
// e seguro e evita string vazando para calculo.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))

declare global {
  // eslint-disable-next-line no-var
  var __milagranDb: Kysely<DB> | undefined
}

export function getDb(): Kysely<DB> {
  if (!globalThis.__milagranDb) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL nao configurada')

    globalThis.__milagranDb = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          connectionString,
          max: 5,
          idleTimeoutMillis: 10_000,
        }),
      }),
    })
  }
  return globalThis.__milagranDb
}

export async function closeDb(): Promise<void> {
  if (globalThis.__milagranDb) {
    await globalThis.__milagranDb.destroy()
    globalThis.__milagranDb = undefined
  }
}
```

- [ ] **Step 7: Gerar os tipos e rodar o teste**

```bash
npm run db:migrate
npm run db:types
npm test -- db.test
```

Esperado: PASSA. `db:types` cria `src/lib/db-types.ts` a partir do banco real — é essa a fonte dos tipos, não um arquivo de schema paralelo que pode divergir.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml migrations/ src/lib/db.ts src/lib/db-types.ts src/lib/__tests__/db.test.ts .env.example
git commit -m "Add local Postgres, plain-SQL migration runner and typed db client"
```

---

## Task 3: Dinheiro em centavos e cálculo de comissão

**Files:**
- Create: `src/lib/money.ts`
- Test: `src/lib/__tests__/money.test.ts`

**Interfaces:**
- Consumes: nada além do scaffold
- Produces:
  - `type Centavos = number & { readonly __marca: 'Centavos' }`
  - `centavos(reais: number): Centavos` — converte **reais** para centavos
  - `deInteiro(valorEmCentavos: number): Centavos` — marca um inteiro que **já está em centavos** (ex.: vindo do banco)
  - `formatarBRL(v: Centavos): string`
  - `multiplicar(v: Centavos, qtd: number): Centavos`
  - `aplicarPercentual(v: Centavos, pct: number): Centavos`
  - `calcularComissao(subtotalComDesconto: Centavos, pctComissao: number): Centavos`

> **Atenção às unidades.** `centavos(19.90)` → `1990`. `deInteiro(1990)` → `1990`.
> As duas produzem `Centavos`, mas partem de unidades diferentes. Trocar uma
> pela outra multiplica ou divide o valor por 100 sem erro de compilação,
> porque ambas devolvem o mesmo tipo. Nos testes abaixo, use `centavos()`
> quando o valor estiver escrito em reais e `deInteiro()` quando estiver
> escrito em centavos.

- [ ] **Step 1: Escrever os testes**

O teste do arredondamento é o mais importante do arquivo: é onde dinheiro se perde.

```ts
// src/lib/__tests__/money.test.ts
import { describe, it, expect } from 'vitest'
import {
  centavos, deInteiro, formatarBRL, multiplicar, aplicarPercentual, calcularComissao,
} from '@/lib/money'

describe('centavos', () => {
  it('converte reais para centavos sem erro de ponto flutuante', () => {
    expect(centavos(19.90)).toBe(1990)
    expect(centavos(0.1) + centavos(0.2)).toBe(centavos(0.3))
  })

  it('rejeita valor com mais de duas casas decimais', () => {
    expect(() => centavos(19.999)).toThrow(/duas casas/)
  })

  it('rejeita valor nao finito', () => {
    expect(() => centavos(Number.NaN)).toThrow(/finito/)
  })
})

describe('deInteiro', () => {
  it('marca um inteiro que ja esta em centavos, sem converter', () => {
    expect(deInteiro(1990)).toBe(1990)
  })

  it('rejeita valor nao inteiro — centavos fracionarios nao existem', () => {
    expect(() => deInteiro(19.5)).toThrow(/inteiro/)
  })
})

describe('formatarBRL', () => {
  it('formata no padrao brasileiro', () => {
    expect(formatarBRL(deInteiro(1990))).toBe('R$ 19,90')
    expect(formatarBRL(deInteiro(1234567))).toBe('R$ 12.345,67')
  })

  it('formata zero e negativo', () => {
    expect(formatarBRL(deInteiro(0))).toBe('R$ 0,00')
    expect(formatarBRL(deInteiro(-500))).toBe('-R$ 5,00')
  })

  it('formata o mesmo valor vindo de reais ou de centavos', () => {
    expect(formatarBRL(centavos(19.90))).toBe(formatarBRL(deInteiro(1990)))
  })
})

describe('multiplicar', () => {
  it('multiplica por quantidade inteira', () => {
    expect(multiplicar(deInteiro(1990), 3)).toBe(5970)
  })

  it('rejeita quantidade nao inteira', () => {
    expect(() => multiplicar(deInteiro(1990), 1.5)).toThrow(/inteira/)
  })

  it('rejeita quantidade negativa', () => {
    expect(() => multiplicar(deInteiro(1990), -1)).toThrow(/inteira/)
  })
})

describe('aplicarPercentual', () => {
  it('arredonda meio para cima, de forma deterministica', () => {
    // 1990 centavos * 15% = 298,5 -> 299
    expect(aplicarPercentual(deInteiro(1990), 15)).toBe(299)
  })

  it('nao acumula erro em valores que geram divisao inexata', () => {
    // 3333 centavos * 33% = 1099,89 -> 1100
    expect(aplicarPercentual(deInteiro(3333), 33)).toBe(1100)
  })

  it('rejeita percentual fora de 0..100', () => {
    expect(() => aplicarPercentual(deInteiro(100), -1)).toThrow(/percentual/)
    expect(() => aplicarPercentual(deInteiro(100), 101)).toThrow(/percentual/)
  })
})

describe('calcularComissao', () => {
  it('incide sobre o subtotal ja com desconto, sem frete', () => {
    // Pedido: 3 kits a R$ 199,90 = R$ 599,70
    // Cupom MARIA10 (10%) = -R$ 59,97 -> R$ 539,73
    // Frete NAO entra na base.
    // Comissao 20% sobre 53973 centavos = 10794,6 -> 10795
    expect(calcularComissao(centavos(539.73), 20)).toBe(10795)
  })

  it('devolve zero quando o subtotal e zero', () => {
    expect(calcularComissao(deInteiro(0), 20)).toBe(0)
  })

  it('rejeita base negativa — estorno e lancamento proprio, nao comissao negativa', () => {
    expect(() => calcularComissao(deInteiro(-100), 20)).toThrow(/negativa/)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
npm test -- money.test
```

Esperado: FALHA com `Cannot find module '@/lib/money'`.

- [ ] **Step 3: Implementar money.ts**

```ts
// src/lib/money.ts

/**
 * Valor monetario em centavos inteiros. O tipo e "branded" para que passar
 * um number cru onde se espera Centavos nao compile — o que impede o erro
 * classico de misturar reais e centavos no mesmo calculo.
 */
export type Centavos = number & { readonly __marca: 'Centavos' }

const formatador = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
})

export function centavos(reais: number): Centavos {
  if (!Number.isFinite(reais)) {
    throw new Error(`Valor monetario precisa ser finito, recebido: ${reais}`)
  }
  // Multiplicar por 100 em ponto flutuante erra (19.90 * 100 = 1989.9999...).
  // Arredondar depois de multiplicar resolve para toda faixa de valor real.
  const c = Math.round(reais * 100)
  if (Math.abs(reais * 100 - c) > 1e-6) {
    throw new Error(`Valor monetario nao pode ter mais de duas casas: ${reais}`)
  }
  return c as Centavos
}

/** Constroi Centavos a partir de um inteiro que ja esta em centavos (ex.: vindo do banco). */
export function deInteiro(valor: number): Centavos {
  if (!Number.isInteger(valor)) {
    throw new Error(`Centavos precisa ser inteiro, recebido: ${valor}`)
  }
  return valor as Centavos
}

export function formatarBRL(valor: Centavos): string {
  // Intl usa NBSP entre simbolo e numero; normalizar para espaco comum
  // para que a saida seja estavel em teste e em HTML.
  return formatador.format(valor / 100).replace(/ /g, ' ')
}

export function multiplicar(valor: Centavos, quantidade: number): Centavos {
  if (!Number.isInteger(quantidade) || quantidade < 0) {
    throw new Error(`Quantidade precisa ser inteira e nao negativa: ${quantidade}`)
  }
  return (valor * quantidade) as Centavos
}

/**
 * Aplica percentual sobre um valor em centavos.
 * Arredondamento: meio para cima (round-half-up), deterministico e sempre
 * favorecendo o representante em caso de empate. A regra precisa ser unica
 * em todo o sistema, senao o extrato nao fecha com o total.
 */
export function aplicarPercentual(valor: Centavos, percentual: number): Centavos {
  if (!Number.isFinite(percentual) || percentual < 0 || percentual > 100) {
    throw new Error(`Percentual precisa estar entre 0 e 100: ${percentual}`)
  }
  return Math.round((valor * percentual) / 100) as Centavos
}

/**
 * Comissao do representante.
 *
 * BASE DE CALCULO: subtotal dos produtos JA COM desconto de cupom aplicado,
 * EXCLUINDO frete. Ver "Premissa que precisa de confirmacao" no plano.
 * Trocar esta regra depois de o primeiro extrato ser exibido exige
 * recalcular extratos ja vistos por representantes.
 */
export function calcularComissao(
  subtotalComDesconto: Centavos,
  percentualComissao: number,
): Centavos {
  if (subtotalComDesconto < 0) {
    throw new Error(
      'Base de comissao nao pode ser negativa. Estorno e lancamento proprio no ledger.',
    )
  }
  return aplicarPercentual(subtotalComDesconto, percentualComissao)
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
npm test -- money.test
npm run typecheck
```

Esperado: PASSA nos dois.

- [ ] **Step 5: Commit**

```bash
git add src/lib/money.ts src/lib/__tests__/money.test.ts
git commit -m "Add integer-cents money type with deterministic commission rounding"
```

---

## Task 4: Limites de período em America/Sao_Paulo

**Files:**
- Create: `src/lib/tempo.ts`
- Test: `src/lib/__tests__/tempo.test.ts`

**Interfaces:**
- Consumes: nada
- Produces:
  - `inicioDoMesBR(referencia: Date): Date`
  - `fimDoMesBR(referencia: Date): Date`
  - `inicioDoDiaBR(referencia: Date): Date`
  - `mesmoMesBR(a: Date, b: Date): boolean`

- [ ] **Step 1: Escrever os testes**

O caso das 21h30 é exatamente o bug que quebraria a apuração de meta.

```ts
// src/lib/__tests__/tempo.test.ts
import { describe, it, expect } from 'vitest'
import { inicioDoMesBR, fimDoMesBR, inicioDoDiaBR, mesmoMesBR } from '@/lib/tempo'

describe('limites de mes em America/Sao_Paulo', () => {
  it('venda as 21h30 BRT do dia 31 pertence ao mes que terminou', () => {
    // 31/08/2026 21:30 BRT = 01/09/2026 00:30 UTC
    const venda = new Date('2026-09-01T00:30:00Z')
    const agostoBR = new Date('2026-08-15T12:00:00Z')
    expect(mesmoMesBR(venda, agostoBR)).toBe(true)
  })

  it('venda as 22h30 BRT do dia 31 ainda pertence a agosto', () => {
    const venda = new Date('2026-09-01T01:30:00Z')
    const agostoBR = new Date('2026-08-15T12:00:00Z')
    expect(mesmoMesBR(venda, agostoBR)).toBe(true)
  })

  it('primeiro instante de setembro em BRT nao pertence a agosto', () => {
    // 01/09/2026 00:00 BRT = 01/09/2026 03:00 UTC
    const venda = new Date('2026-09-01T03:00:00Z')
    const agostoBR = new Date('2026-08-15T12:00:00Z')
    expect(mesmoMesBR(venda, agostoBR)).toBe(false)
  })

  it('inicio do mes e a meia-noite BRT do dia 1, expressa em UTC', () => {
    const r = inicioDoMesBR(new Date('2026-08-15T12:00:00Z'))
    expect(r.toISOString()).toBe('2026-08-01T03:00:00.000Z')
  })

  it('fim do mes e o instante imediatamente anterior ao inicio do proximo', () => {
    const r = fimDoMesBR(new Date('2026-08-15T12:00:00Z'))
    expect(r.toISOString()).toBe('2026-09-01T02:59:59.999Z')
  })

  it('inicio do dia e a meia-noite BRT, expressa em UTC', () => {
    const r = inicioDoDiaBR(new Date('2026-08-11T23:00:00Z'))
    // 11/08 23:00 UTC = 11/08 20:00 BRT, entao o dia BR e 11/08
    expect(r.toISOString()).toBe('2026-08-11T03:00:00.000Z')
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
npm test -- tempo.test
```

Esperado: FALHA com `Cannot find module '@/lib/tempo'`.

- [ ] **Step 3: Implementar tempo.ts**

Usa `Intl` em vez de biblioteca de data para não trazer dependência, e porque `Intl` já carrega o banco de fusos do sistema — inclusive mudanças históricas de horário de verão.

```ts
// src/lib/tempo.ts

export const FUSO_BR = 'America/Sao_Paulo'

const partes = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_BR,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
})

type Civil = { ano: number; mes: number; dia: number; hora: number; minuto: number; segundo: number }

/** Converte um instante para a data/hora civil observada em Sao Paulo. */
function civilBR(instante: Date): Civil {
  const p = Object.fromEntries(
    partes.formatToParts(instante).map((x) => [x.type, x.value]),
  ) as Record<string, string>
  return {
    ano: Number(p.year), mes: Number(p.month), dia: Number(p.day),
    // 'en-CA' com hour12:false emite 24 para meia-noite; normalizar para 0.
    hora: Number(p.hour) % 24, minuto: Number(p.minute), segundo: Number(p.second),
  }
}

/**
 * Encontra o instante UTC correspondente a uma data/hora civil de Sao Paulo.
 * Sao Paulo nao observa horario de verao desde 2019, mas resolver por
 * aproximacao sucessiva mantem a funcao correta para datas historicas e
 * caso a politica volte a mudar.
 */
function instanteDeCivilBR(ano: number, mes: number, dia: number, hora = 0, minuto = 0, segundo = 0, ms = 0): Date {
  let palpite = Date.UTC(ano, mes - 1, dia, hora, minuto, segundo, ms)
  for (let i = 0; i < 3; i++) {
    const c = civilBR(new Date(palpite))
    const obtido = Date.UTC(c.ano, c.mes - 1, c.dia, c.hora, c.minuto, c.segundo, ms)
    const alvo = Date.UTC(ano, mes - 1, dia, hora, minuto, segundo, ms)
    if (obtido === alvo) break
    palpite += alvo - obtido
  }
  return new Date(palpite)
}

export function inicioDoDiaBR(referencia: Date): Date {
  const c = civilBR(referencia)
  return instanteDeCivilBR(c.ano, c.mes, c.dia)
}

export function inicioDoMesBR(referencia: Date): Date {
  const c = civilBR(referencia)
  return instanteDeCivilBR(c.ano, c.mes, 1)
}

export function fimDoMesBR(referencia: Date): Date {
  const c = civilBR(referencia)
  const proximoMes = c.mes === 12 ? 1 : c.mes + 1
  const proximoAno = c.mes === 12 ? c.ano + 1 : c.ano
  return new Date(instanteDeCivilBR(proximoAno, proximoMes, 1).getTime() - 1)
}

export function mesmoMesBR(a: Date, b: Date): boolean {
  const ca = civilBR(a)
  const cb = civilBR(b)
  return ca.ano === cb.ano && ca.mes === cb.mes
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
npm test -- tempo.test
```

Esperado: PASSA, incluindo os três testes de fronteira de mês.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tempo.ts src/lib/__tests__/tempo.test.ts
git commit -m "Add America/Sao_Paulo period boundaries for goal and report grouping"
```

---

## Task 5: Schema de produtos e kits

**Files:**
- Create: `migrations/1754900100000_produtos.sql`, `src/repositories/produtos.ts`
- Test: `src/repositories/__tests__/produtos.test.ts`
- Modify: `src/lib/db-types.ts` (regenerado)

**Interfaces:**
- Consumes: `getDb()` da Tarefa 2, `Centavos`/`deInteiro` da Tarefa 3
- Produces:
  - `listarKitsAtivos(): Promise<Kit[]>`
  - `buscarKitPorSlug(slug: string): Promise<Kit | null>`
  - `type Kit = { id: string; slug: string; nome: string; descricao: string; precoCentavos: Centavos; unidades: number; sku: string; ativo: boolean; ordem: number }`

- [ ] **Step 1: Escrever a migration**

`unidades` responde à pergunta em aberto "o que é um kit": um SKU com N unidades do mesmo produto, não um bundle de composição própria. Se o Kit 5 vier a ter brinde diferente, isso vira tabela de composição numa migration futura.

```sql
-- migrations/1754900100000_produtos.sql
-- Up Migration
CREATE TABLE kits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text        NOT NULL,
  nome            text        NOT NULL,
  descricao       text        NOT NULL DEFAULT '',
  preco_centavos  integer     NOT NULL,
  unidades        smallint    NOT NULL,
  sku             text        NOT NULL,
  -- Numero de notificacao/registro do cosmetico na ANVISA. Obrigatorio
  -- para venda legal e exibido na pagina do produto.
  anvisa_registro text,
  ativo           boolean     NOT NULL DEFAULT true,
  ordem           smallint    NOT NULL DEFAULT 0,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  atualizado_em   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT kits_preco_positivo   CHECK (preco_centavos > 0),
  CONSTRAINT kits_unidades_positiva CHECK (unidades > 0)
);

CREATE UNIQUE INDEX kits_slug_unico ON kits (slug);
CREATE UNIQUE INDEX kits_sku_unico  ON kits (sku);
-- Consulta da vitrine: so ativos, na ordem definida pelo admin.
CREATE INDEX kits_ativos_ordem ON kits (ordem) WHERE ativo;

-- Down Migration
DROP TABLE kits;
```

- [ ] **Step 2: Rodar a migration e regenerar os tipos**

```bash
npm run db:migrate
npm run db:types
```

- [ ] **Step 3: Escrever os testes**

```ts
// src/repositories/__tests__/produtos.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { listarKitsAtivos, buscarKitPorSlug } from '@/repositories/produtos'

async function semear() {
  const db = getDb()
  await db.deleteFrom('kits').execute()
  await db.insertInto('kits').values([
    { slug: 'kit-1', nome: 'Kit 1', preco_centavos: 19990, unidades: 1, sku: 'MG-K1', ordem: 1, ativo: true },
    { slug: 'kit-3', nome: 'Kit 3', preco_centavos: 53900, unidades: 3, sku: 'MG-K3', ordem: 2, ativo: true },
    { slug: 'kit-antigo', nome: 'Kit descontinuado', preco_centavos: 9990, unidades: 1, sku: 'MG-OLD', ordem: 3, ativo: false },
  ]).execute()
}

describe('repositorio de produtos', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('lista apenas kits ativos, na ordem definida', async () => {
    const kits = await listarKitsAtivos()
    expect(kits.map((k) => k.slug)).toEqual(['kit-1', 'kit-3'])
  })

  it('devolve preco como Centavos inteiro, nunca string', async () => {
    const [primeiro] = await listarKitsAtivos()
    expect(primeiro!.precoCentavos).toBe(19990)
    expect(typeof primeiro!.precoCentavos).toBe('number')
  })

  it('busca por slug', async () => {
    const kit = await buscarKitPorSlug('kit-3')
    expect(kit?.nome).toBe('Kit 3')
    expect(kit?.unidades).toBe(3)
  })

  it('devolve null para slug inexistente', async () => {
    expect(await buscarKitPorSlug('nao-existe')).toBeNull()
  })

  it('nao devolve kit inativo na busca por slug', async () => {
    expect(await buscarKitPorSlug('kit-antigo')).toBeNull()
  })

  it('impede dois kits com o mesmo slug', async () => {
    await expect(
      getDb().insertInto('kits').values({
        slug: 'kit-1', nome: 'Duplicado', preco_centavos: 100,
        unidades: 1, sku: 'MG-DUP', ordem: 9, ativo: true,
      }).execute(),
    ).rejects.toThrow(/kits_slug_unico/)
  })

  it('impede preco zero ou negativo', async () => {
    await expect(
      getDb().insertInto('kits').values({
        slug: 'kit-gratis', nome: 'Gratis', preco_centavos: 0,
        unidades: 1, sku: 'MG-FREE', ordem: 9, ativo: true,
      }).execute(),
    ).rejects.toThrow(/kits_preco_positivo/)
  })
})
```

- [ ] **Step 4: Rodar e confirmar que falha**

```bash
npm test -- produtos.test
```

Esperado: FALHA com `Cannot find module '@/repositories/produtos'`.

- [ ] **Step 5: Implementar o repositório**

```ts
// src/repositories/produtos.ts
import { getDb } from '@/lib/db'
import { deInteiro, type Centavos } from '@/lib/money'

export type Kit = {
  id: string
  slug: string
  nome: string
  descricao: string
  precoCentavos: Centavos
  unidades: number
  sku: string
  anvisaRegistro: string | null
  ativo: boolean
  ordem: number
}

type LinhaKit = {
  id: string; slug: string; nome: string; descricao: string
  preco_centavos: number; unidades: number; sku: string
  anvisa_registro: string | null; ativo: boolean; ordem: number
}

function paraKit(l: LinhaKit): Kit {
  return {
    id: l.id,
    slug: l.slug,
    nome: l.nome,
    descricao: l.descricao,
    precoCentavos: deInteiro(l.preco_centavos),
    unidades: l.unidades,
    sku: l.sku,
    anvisaRegistro: l.anvisa_registro,
    ativo: l.ativo,
    ordem: l.ordem,
  }
}

export async function listarKitsAtivos(): Promise<Kit[]> {
  const linhas = await getDb()
    .selectFrom('kits')
    .selectAll()
    .where('ativo', '=', true)
    .orderBy('ordem', 'asc')
    .execute()
  return linhas.map((l) => paraKit(l as LinhaKit))
}

export async function buscarKitPorSlug(slug: string): Promise<Kit | null> {
  const linha = await getDb()
    .selectFrom('kits')
    .selectAll()
    .where('slug', '=', slug)
    .where('ativo', '=', true)
    .executeTakeFirst()
  return linha ? paraKit(linha as LinhaKit) : null
}
```

- [ ] **Step 6: Rodar e confirmar que passa**

```bash
npm test -- produtos.test
npm run typecheck
```

Esperado: PASSA. Os dois últimos testes provam que as constraints estão de fato no banco — validação em código não substitui constraint.

- [ ] **Step 7: Commit**

```bash
git add migrations/ src/repositories/produtos.ts src/repositories/__tests__/produtos.test.ts src/lib/db-types.ts
git commit -m "Add kits table with price and ANVISA fields, plus typed repository"
```

---

## Task 6: Schema de representantes

**Files:**
- Create: `migrations/1754900200000_representantes.sql`, `src/repositories/representantes.ts`
- Test: `src/repositories/__tests__/representantes.test.ts`

**Interfaces:**
- Consumes: `getDb()`, `deInteiro`
- Produces:
  - `buscarRepresentanteAtivoPorSlug(slug: string): Promise<Representante | null>`
  - `type Representante = { id: string; slug: string; nome: string; codigo: string; percentualComissao: number; ativo: boolean }`

- [ ] **Step 1: Escrever a migration**

`slug` nunca é reutilizado, mesmo após desligamento — links antigos continuam circulando no Instagram. Por isso a unicidade não é parcial: vale inclusive para inativos.

```sql
-- migrations/1754900200000_representantes.sql
-- Up Migration
CREATE TABLE representantes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text        NOT NULL,
  codigo               text        NOT NULL,
  nome                 text        NOT NULL,
  email                text        NOT NULL,
  whatsapp             text        NOT NULL DEFAULT '',
  cidade               text        NOT NULL DEFAULT '',
  estado               char(2)     NOT NULL DEFAULT '',
  foto_url             text,
  -- Percentual configuravel POR representante (spec 8). Guardado como
  -- numeric para permitir 12,5% sem perder precisao no cadastro; o calculo
  -- em si acontece em centavos inteiros (ver src/lib/money.ts).
  percentual_comissao  numeric(5,2) NOT NULL DEFAULT 20.00,
  ativo                boolean     NOT NULL DEFAULT true,
  criado_em            timestamptz NOT NULL DEFAULT now(),
  atualizado_em        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rep_percentual_valido CHECK (percentual_comissao >= 0 AND percentual_comissao <= 100),
  -- Slug entra na URL publica: minusculas, numeros e hifen apenas.
  CONSTRAINT rep_slug_formato CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
);

-- Slug NUNCA e reutilizado, nem apos desligamento: o link antigo continua
-- circulando. Por isso a unicidade nao filtra por ativo.
CREATE UNIQUE INDEX rep_slug_unico   ON representantes (slug);
CREATE UNIQUE INDEX rep_codigo_unico ON representantes (codigo);
CREATE UNIQUE INDEX rep_email_unico  ON representantes (lower(email));

-- Down Migration
DROP TABLE representantes;
```

- [ ] **Step 2: Migrar, regenerar tipos e escrever os testes**

```bash
npm run db:migrate && npm run db:types
```

```ts
// src/repositories/__tests__/representantes.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { buscarRepresentanteAtivoPorSlug } from '@/repositories/representantes'

async function semear() {
  const db = getDb()
  await db.deleteFrom('representantes').execute()
  await db.insertInto('representantes').values([
    { slug: 'maria', codigo: 'MARIA', nome: 'Maria', email: 'maria@exemplo.com', percentual_comissao: '20.00', ativo: true },
    { slug: 'joao', codigo: 'JOAO', nome: 'Joao', email: 'joao@exemplo.com', percentual_comissao: '15.50', ativo: true },
    { slug: 'ana', codigo: 'ANA', nome: 'Ana', email: 'ana@exemplo.com', percentual_comissao: '20.00', ativo: false },
  ]).execute()
}

describe('repositorio de representantes', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('busca representante ativo por slug', async () => {
    const r = await buscarRepresentanteAtivoPorSlug('maria')
    expect(r?.nome).toBe('Maria')
    expect(r?.percentualComissao).toBe(20)
  })

  it('devolve percentual fracionario como number', async () => {
    const r = await buscarRepresentanteAtivoPorSlug('joao')
    expect(r?.percentualComissao).toBe(15.5)
  })

  it('nao devolve representante inativo', async () => {
    expect(await buscarRepresentanteAtivoPorSlug('ana')).toBeNull()
  })

  it('devolve null para slug inexistente', async () => {
    expect(await buscarRepresentanteAtivoPorSlug('ninguem')).toBeNull()
  })

  it('impede reutilizar o slug de um representante desligado', async () => {
    await expect(
      getDb().insertInto('representantes').values({
        slug: 'ana', codigo: 'ANA2', nome: 'Outra Ana',
        email: 'ana2@exemplo.com', percentual_comissao: '20.00', ativo: true,
      }).execute(),
    ).rejects.toThrow(/rep_slug_unico/)
  })

  it('rejeita slug com maiuscula ou espaco', async () => {
    await expect(
      getDb().insertInto('representantes').values({
        slug: 'Maria Silva', codigo: 'MS', nome: 'Maria Silva',
        email: 'ms@exemplo.com', percentual_comissao: '20.00', ativo: true,
      }).execute(),
    ).rejects.toThrow(/rep_slug_formato/)
  })

  it('rejeita percentual acima de 100', async () => {
    await expect(
      getDb().insertInto('representantes').values({
        slug: 'ganancioso', codigo: 'GAN', nome: 'Ganancioso',
        email: 'g@exemplo.com', percentual_comissao: '150.00', ativo: true,
      }).execute(),
    ).rejects.toThrow(/rep_percentual_valido/)
  })
})
```

- [ ] **Step 3: Rodar e confirmar que falha**

```bash
npm test -- representantes.test
```

Esperado: FALHA com `Cannot find module '@/repositories/representantes'`.

- [ ] **Step 4: Implementar o repositório**

```ts
// src/repositories/representantes.ts
import { getDb } from '@/lib/db'

export type Representante = {
  id: string
  slug: string
  codigo: string
  nome: string
  fotoUrl: string | null
  cidade: string
  estado: string
  percentualComissao: number
  ativo: boolean
}

type LinhaRepresentante = {
  id: string; slug: string; codigo: string; nome: string
  foto_url: string | null; cidade: string; estado: string
  percentual_comissao: string | number; ativo: boolean
}

function paraRepresentante(l: LinhaRepresentante): Representante {
  return {
    id: l.id,
    slug: l.slug,
    codigo: l.codigo,
    nome: l.nome,
    fotoUrl: l.foto_url,
    cidade: l.cidade,
    estado: l.estado,
    // numeric chega como string do driver pg; Number aqui e seguro porque
    // percentual nao e dinheiro — o dinheiro e calculado em centavos inteiros.
    percentualComissao: Number(l.percentual_comissao),
    ativo: l.ativo,
  }
}

export async function buscarRepresentanteAtivoPorSlug(
  slug: string,
): Promise<Representante | null> {
  const linha = await getDb()
    .selectFrom('representantes')
    .selectAll()
    .where('slug', '=', slug)
    .where('ativo', '=', true)
    .executeTakeFirst()
  return linha ? paraRepresentante(linha as LinhaRepresentante) : null
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

```bash
npm test -- representantes.test
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add migrations/ src/repositories/representantes.ts src/repositories/__tests__/representantes.test.ts src/lib/db-types.ts
git commit -m "Add representantes table with never-reused slug and per-rep commission rate"
```

---

## Task 7: Cookie de atribuição assinado

**Files:**
- Create: `src/lib/atribuicao.ts`
- Test: `src/lib/__tests__/atribuicao.test.ts`

**Interfaces:**
- Consumes: `ATRIBUICAO_SECRET` do ambiente
- Produces:
  - `type Atribuicao = { slug: string; em: number; utmSource: string | null; utmMedium: string | null; utmCampaign: string | null }`
  - `assinarAtribuicao(a: Atribuicao, segredo: string): string`
  - `verificarAtribuicao(valor: string, segredo: string, agora?: Date): Atribuicao | null`
  - `NOME_COOKIE_ATRIBUICAO = '__Host-mg_attr'`
  - `JANELA_ATRIBUICAO_DIAS = 30`

- [ ] **Step 1: Escrever os testes**

Este é o arquivo mais sensível do plano: se a assinatura for falsificável, um representante pode atribuir a si vendas que não fez.

```ts
// src/lib/__tests__/atribuicao.test.ts
import { describe, it, expect } from 'vitest'
import {
  assinarAtribuicao, verificarAtribuicao, NOME_COOKIE_ATRIBUICAO,
  JANELA_ATRIBUICAO_DIAS, type Atribuicao,
} from '@/lib/atribuicao'

const SEGREDO = 'a'.repeat(64)
const base: Atribuicao = {
  slug: 'maria',
  em: Date.parse('2026-08-11T12:00:00Z'),
  utmSource: 'instagram',
  utmMedium: 'bio',
  utmCampaign: 'lancamento',
}

describe('cookie de atribuicao', () => {
  it('usa o prefixo __Host-, que proibe subdominio sobrescrever', () => {
    expect(NOME_COOKIE_ATRIBUICAO).toBe('__Host-mg_attr')
  })

  it('faz ida e volta preservando todos os campos', () => {
    const v = verificarAtribuicao(assinarAtribuicao(base, SEGREDO), SEGREDO,
      new Date('2026-08-12T12:00:00Z'))
    expect(v).toEqual(base)
  })

  it('rejeita payload adulterado', () => {
    const assinado = assinarAtribuicao(base, SEGREDO)
    const [payload, sig] = assinado.split('.')
    const outro = Buffer.from(
      JSON.stringify({ ...base, slug: 'joao' }),
    ).toString('base64url')
    expect(verificarAtribuicao(`${outro}.${sig}`, SEGREDO,
      new Date('2026-08-12T12:00:00Z'))).toBeNull()
    expect(payload).not.toBe(outro)
  })

  it('rejeita assinatura de outro segredo', () => {
    const assinado = assinarAtribuicao(base, SEGREDO)
    expect(verificarAtribuicao(assinado, 'b'.repeat(64),
      new Date('2026-08-12T12:00:00Z'))).toBeNull()
  })

  it('rejeita valor malformado sem estourar', () => {
    for (const lixo of ['', '.', 'abc', 'a.b.c', 'nao-base64.xx']) {
      expect(() => verificarAtribuicao(lixo, SEGREDO)).not.toThrow()
      expect(verificarAtribuicao(lixo, SEGREDO)).toBeNull()
    }
  })

  it('aceita dentro da janela de 30 dias', () => {
    const quase = new Date(base.em + (JANELA_ATRIBUICAO_DIAS - 1) * 86_400_000)
    expect(verificarAtribuicao(assinarAtribuicao(base, SEGREDO), SEGREDO, quase))
      .not.toBeNull()
  })

  it('expira depois da janela de 30 dias', () => {
    const depois = new Date(base.em + (JANELA_ATRIBUICAO_DIAS + 1) * 86_400_000)
    expect(verificarAtribuicao(assinarAtribuicao(base, SEGREDO), SEGREDO, depois))
      .toBeNull()
  })

  it('aceita atribuicao sem UTM', () => {
    const semUtm: Atribuicao = { slug: 'ana', em: base.em, utmSource: null, utmMedium: null, utmCampaign: null }
    expect(verificarAtribuicao(assinarAtribuicao(semUtm, SEGREDO), SEGREDO,
      new Date('2026-08-12T12:00:00Z'))).toEqual(semUtm)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
npm test -- atribuicao.test
```

Esperado: FALHA com `Cannot find module '@/lib/atribuicao'`.

- [ ] **Step 3: Implementar atribuicao.ts**

```ts
// src/lib/atribuicao.ts
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Prefixo __Host-: o navegador so aceita o cookie se ele for Secure,
 * Path=/ e SEM atributo Domain. Isso impede que qualquer subdominio
 * sobrescreva a atribuicao pelo navegador — defesa em profundidade
 * gratuita, complementar ao HMAC.
 */
export const NOME_COOKIE_ATRIBUICAO = '__Host-mg_attr'
export const JANELA_ATRIBUICAO_DIAS = 30

export type Atribuicao = {
  slug: string
  /** Instante da primeira visita, em epoch ms. */
  em: number
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
}

function assinar(payload: string, segredo: string): string {
  return createHmac('sha256', segredo).update(payload).digest('base64url')
}

export function assinarAtribuicao(a: Atribuicao, segredo: string): string {
  const payload = Buffer.from(JSON.stringify(a)).toString('base64url')
  return `${payload}.${assinar(payload, segredo)}`
}

export function verificarAtribuicao(
  valor: string,
  segredo: string,
  agora: Date = new Date(),
): Atribuicao | null {
  const partes = valor.split('.')
  if (partes.length !== 2) return null
  const [payload, assinaturaRecebida] = partes as [string, string]
  if (!payload || !assinaturaRecebida) return null

  const esperada = assinar(payload, segredo)
  // timingSafeEqual estoura se os buffers tiverem tamanhos diferentes —
  // caso tipico de atacante sondando o endpoint. Comparar tamanho antes.
  const a = Buffer.from(assinaturaRecebida)
  const b = Buffer.from(esperada)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let dados: unknown
  try {
    dados = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  if (typeof dados !== 'object' || dados === null) return null
  const d = dados as Record<string, unknown>
  if (typeof d.slug !== 'string' || typeof d.em !== 'number') return null

  const limite = d.em + JANELA_ATRIBUICAO_DIAS * 86_400_000
  if (agora.getTime() > limite) return null

  const texto = (v: unknown): string | null => (typeof v === 'string' ? v : null)

  return {
    slug: d.slug,
    em: d.em,
    utmSource: texto(d.utmSource),
    utmMedium: texto(d.utmMedium),
    utmCampaign: texto(d.utmCampaign),
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
npm test -- atribuicao.test
npm run typecheck
```

Esperado: PASSA nos 8 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/atribuicao.ts src/lib/__tests__/atribuicao.test.ts
git commit -m "Add HMAC-signed attribution cookie with 30-day window"
```

---

## Task 8: Página do representante em `/r/[slug]`

**Files:**
- Create: `src/app/r/[slug]/page.tsx`, `src/app/r/[slug]/registrar-atribuicao.ts`
- Test: `src/app/r/__tests__/registrar-atribuicao.test.ts`

**Interfaces:**
- Consumes: `buscarRepresentanteAtivoPorSlug`, `assinarAtribuicao`, `verificarAtribuicao`, `NOME_COOKIE_ATRIBUICAO`
- Produces:
  - `resolverAtribuicao(params): { cookieNovo: Atribuicao | null; efetiva: Atribuicao }` — lógica pura, testável sem HTTP

- [ ] **Step 1: Escrever os testes da regra de conflito**

Esta é a regra que vai ser contestada por gente real. Ela precisa de teste antes de existir.

```ts
// src/app/r/__tests__/registrar-atribuicao.test.ts
import { describe, it, expect } from 'vitest'
import { resolverAtribuicao } from '@/app/r/[slug]/registrar-atribuicao'
import type { Atribuicao } from '@/lib/atribuicao'

const emAgosto = Date.parse('2026-08-11T12:00:00Z')
const existente: Atribuicao = {
  slug: 'maria', em: emAgosto,
  utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
}

describe('resolucao de atribuicao', () => {
  it('grava a atribuicao quando nao existe nenhuma', () => {
    const r = resolverAtribuicao({
      slugVisitado: 'maria', atual: null,
      utm: { source: 'instagram', medium: 'bio', campaign: 'lancamento' },
      agora: new Date(emAgosto),
    })
    expect(r.efetiva.slug).toBe('maria')
    expect(r.cookieNovo?.slug).toBe('maria')
  })

  it('LAST CLICK: visitar outro representante transfere a atribuicao', () => {
    const r = resolverAtribuicao({
      slugVisitado: 'joao', atual: existente,
      utm: { source: null, medium: null, campaign: null },
      agora: new Date(emAgosto + 86_400_000),
    })
    expect(r.efetiva.slug).toBe('joao')
    expect(r.cookieNovo?.slug).toBe('joao')
  })

  it('revisitar o mesmo representante NAO reinicia a janela de 30 dias', () => {
    const r = resolverAtribuicao({
      slugVisitado: 'maria', atual: existente,
      utm: { source: null, medium: null, campaign: null },
      agora: new Date(emAgosto + 10 * 86_400_000),
    })
    expect(r.efetiva.em).toBe(emAgosto)
    expect(r.cookieNovo).toBeNull()
  })

  it('preserva o UTM da primeira visita quando a revisita nao traz UTM', () => {
    const r = resolverAtribuicao({
      slugVisitado: 'maria', atual: existente,
      utm: { source: null, medium: null, campaign: null },
      agora: new Date(emAgosto + 86_400_000),
    })
    expect(r.efetiva.utmSource).toBe('instagram')
  })

  it('troca de representante carrega o UTM da nova visita', () => {
    const r = resolverAtribuicao({
      slugVisitado: 'joao', atual: existente,
      utm: { source: 'whatsapp', medium: 'direct', campaign: 'agosto' },
      agora: new Date(emAgosto + 86_400_000),
    })
    expect(r.efetiva.utmSource).toBe('whatsapp')
    expect(r.efetiva.utmCampaign).toBe('agosto')
  })

  it('trunca UTM absurdamente longo em vez de gravar lixo no cookie', () => {
    const r = resolverAtribuicao({
      slugVisitado: 'maria', atual: null,
      utm: { source: 'x'.repeat(500), medium: null, campaign: null },
      agora: new Date(emAgosto),
    })
    expect(r.efetiva.utmSource!.length).toBeLessThanOrEqual(120)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
npm test -- registrar-atribuicao.test
```

Esperado: FALHA com `Cannot find module`.

- [ ] **Step 3: Implementar a lógica de resolução**

```ts
// src/app/r/[slug]/registrar-atribuicao.ts
import type { Atribuicao } from '@/lib/atribuicao'

const MAX_UTM = 120

export type Utm = {
  source: string | null
  medium: string | null
  campaign: string | null
}

function limitar(v: string | null): string | null {
  if (v === null) return null
  const limpo = v.trim()
  return limpo === '' ? null : limpo.slice(0, MAX_UTM)
}

/**
 * REGRA DE CONFLITO — LAST CLICK.
 *
 * Se o visitante ja tem atribuicao a um representante e entra pelo link de
 * outro, a atribuicao passa para o mais recente. Escolhemos last click
 * porque e a regra defensavel numa conversa entre pessoas que se conhecem:
 * quem falou com o cliente por ultimo foi quem fechou.
 *
 * Revisitar o MESMO representante nao reinicia a janela de 30 dias — senao
 * bastaria pedir ao cliente para reabrir o link para estender a atribuicao
 * indefinidamente.
 *
 * Esta e a regra do cookie. A hierarquia completa (cupom > last click >
 * first click) se completa no momento da criacao do pedido, no Plano 2,
 * onde o cupom informado tem prioridade sobre o cookie.
 */
export function resolverAtribuicao(params: {
  slugVisitado: string
  atual: Atribuicao | null
  utm: Utm
  agora: Date
}): { cookieNovo: Atribuicao | null; efetiva: Atribuicao } {
  const { slugVisitado, atual, utm, agora } = params

  if (atual && atual.slug === slugVisitado) {
    return { cookieNovo: null, efetiva: atual }
  }

  const nova: Atribuicao = {
    slug: slugVisitado,
    em: agora.getTime(),
    utmSource: limitar(utm.source),
    utmMedium: limitar(utm.medium),
    utmCampaign: limitar(utm.campaign),
  }
  return { cookieNovo: nova, efetiva: nova }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
npm test -- registrar-atribuicao.test
```

Esperado: PASSA nos 6 testes.

- [ ] **Step 5: Implementar a página**

```tsx
// src/app/r/[slug]/page.tsx
import { notFound } from 'next/navigation'
import { cookies } from 'next/headers'
import { buscarRepresentanteAtivoPorSlug } from '@/repositories/representantes'
import { listarKitsAtivos } from '@/repositories/produtos'
import { formatarBRL } from '@/lib/money'
import {
  NOME_COOKIE_ATRIBUICAO, JANELA_ATRIBUICAO_DIAS,
  assinarAtribuicao, verificarAtribuicao,
} from '@/lib/atribuicao'
import { resolverAtribuicao } from './registrar-atribuicao'

// A atribuicao depende de cookie e query string, entao a pagina nao pode
// ser estatica.
export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function primeiro(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

export default async function PaginaRepresentante({ params, searchParams }: Props) {
  const { slug } = await params
  const query = await searchParams

  const representante = await buscarRepresentanteAtivoPorSlug(slug)
  if (!representante) notFound()

  const segredo = process.env.ATRIBUICAO_SECRET
  if (!segredo) throw new Error('ATRIBUICAO_SECRET nao configurada')

  const jar = await cookies()
  const bruto = jar.get(NOME_COOKIE_ATRIBUICAO)?.value ?? null
  const atual = bruto ? verificarAtribuicao(bruto, segredo) : null

  const { cookieNovo } = resolverAtribuicao({
    slugVisitado: representante.slug,
    atual,
    utm: {
      source: primeiro(query.utm_source),
      medium: primeiro(query.utm_medium),
      campaign: primeiro(query.utm_campaign),
    },
    agora: new Date(),
  })

  if (cookieNovo) {
    jar.set(NOME_COOKIE_ATRIBUICAO, assinarAtribuicao(cookieNovo, segredo), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: JANELA_ATRIBUICAO_DIAS * 86_400,
    })
  }

  const kits = await listarKitsAtivos()

  return (
    <main className="section">
      <p className="kicker">Representante oficial Milagran</p>
      <h1>{representante.nome}</h1>
      <ul>
        {kits.map((kit) => (
          <li key={kit.id}>
            {kit.nome} — {formatarBRL(kit.precoCentavos)}
          </li>
        ))}
      </ul>
    </main>
  )
}
```

> A vitrine completa (seletor de quantidade, cupom, resumo do pedido) é a Tarefa 1 do Plano 2. Aqui a página existe para provar que a atribuição funciona ponta a ponta.

- [ ] **Step 6: Verificar manualmente e commitar**

```bash
npm run db:up
npm run db:migrate
npm run build
npm run dev
```

Abrir `http://localhost:3000/r/maria` (depois de semear um representante) e confirmar no DevTools que o cookie `__Host-mg_attr` foi setado. Abrir `/r/nao-existe` e confirmar 404.

> **Nota:** o prefixo `__Host-` exige `Secure`, então o cookie **não é setado em `http://localhost`** em alguns navegadores. Verifique em `https://` no preview da Vercel, ou rode `next dev --experimental-https` localmente.

```bash
git add src/app/r/
git commit -m "Add representative landing page with last-click attribution capture"
```

---

## Task 9: Pedido com atribuição congelada

**Files:**
- Create: `migrations/1754900300000_pedidos.sql`, `src/repositories/pedidos.ts`
- Test: `src/repositories/__tests__/pedidos.test.ts`

**Interfaces:**
- Consumes: `getDb()`, `Centavos`, `Atribuicao`, `buscarRepresentanteAtivoPorSlug`
- Produces:
  - `criarPedido(entrada: EntradaPedido): Promise<Pedido>`
  - `type OrigemAtribuicao = 'link' | 'cupom' | 'casa' | 'rep_inativo'`

- [ ] **Step 1: Escrever a migration**

O ponto central: `representante_id`, `percentual_comissao_snapshot` e os UTM são gravados **na criação** e nunca recalculados. Se a Maria for desligada ou tiver o percentual alterado amanhã, o pedido de hoje continua valendo o que valia hoje.

```sql
-- migrations/1754900300000_pedidos.sql
-- Up Migration
CREATE TYPE pedido_status AS ENUM (
  'pendente', 'aguardando_pagamento', 'pago', 'em_preparacao',
  'enviado', 'entregue', 'cancelado', 'reembolsado'
);

CREATE TYPE origem_atribuicao AS ENUM (
  'link',        -- veio do cookie, por /r/slug
  'cupom',       -- cupom de representante teve prioridade sobre o cookie
  'casa',        -- sem representante: venda do perfil oficial
  'rep_inativo'  -- cookie apontava para representante desligado
);

CREATE TABLE pedidos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero            bigint GENERATED ALWAYS AS IDENTITY,
  status            pedido_status NOT NULL DEFAULT 'pendente',

  -- ATRIBUICAO CONGELADA. Gravada na criacao, nunca recalculada.
  -- ON DELETE RESTRICT: representante com pedido nao pode ser apagado,
  -- so desativado — senao o historico de comissao perde a referencia.
  representante_id  uuid REFERENCES representantes (id) ON DELETE RESTRICT,
  origem            origem_atribuicao NOT NULL,
  -- Snapshot do percentual no momento da venda. Alterar o cadastro do
  -- representante depois NAO muda a comissao de pedidos ja feitos.
  percentual_comissao_snapshot numeric(5,2),
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,

  subtotal_centavos integer NOT NULL,
  desconto_centavos integer NOT NULL DEFAULT 0,
  frete_centavos    integer NOT NULL DEFAULT 0,
  total_centavos    integer NOT NULL,

  criado_em         timestamptz NOT NULL DEFAULT now(),
  pago_em           timestamptz,
  entregue_em       timestamptz,

  CONSTRAINT pedido_valores_nao_negativos CHECK (
    subtotal_centavos >= 0 AND desconto_centavos >= 0 AND
    frete_centavos >= 0 AND total_centavos >= 0
  ),
  CONSTRAINT pedido_desconto_nao_excede CHECK (desconto_centavos <= subtotal_centavos),
  CONSTRAINT pedido_total_confere CHECK (
    total_centavos = subtotal_centavos - desconto_centavos + frete_centavos
  ),
  -- Se ha representante, ha percentual congelado. Se nao ha, nao pode haver.
  CONSTRAINT pedido_atribuicao_coerente CHECK (
    (representante_id IS NULL     AND percentual_comissao_snapshot IS NULL)
    OR
    (representante_id IS NOT NULL AND percentual_comissao_snapshot IS NOT NULL)
  ),
  -- 'casa' e 'rep_inativo' nunca tem representante atribuido.
  CONSTRAINT pedido_origem_coerente CHECK (
    (origem IN ('casa', 'rep_inativo') AND representante_id IS NULL)
    OR
    (origem IN ('link', 'cupom')       AND representante_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX pedidos_numero_unico ON pedidos (numero);
-- Consulta do dashboard do representante e do relatorio admin (spec 29).
CREATE INDEX pedidos_rep_data ON pedidos (representante_id, criado_em DESC)
  WHERE representante_id IS NOT NULL;
CREATE INDEX pedidos_status ON pedidos (status);

-- Down Migration
DROP TABLE pedidos;
DROP TYPE origem_atribuicao;
DROP TYPE pedido_status;
```

- [ ] **Step 2: Migrar, regenerar tipos e escrever os testes**

```bash
npm run db:migrate && npm run db:types
```

```ts
// src/repositories/__tests__/pedidos.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { criarPedido } from '@/repositories/pedidos'
import { centavos } from '@/lib/money'

let idMaria: string

async function semear() {
  const db = getDb()
  await db.deleteFrom('pedidos').execute()
  await db.deleteFrom('representantes').execute()
  const maria = await db.insertInto('representantes').values({
    slug: 'maria', codigo: 'MARIA', nome: 'Maria',
    email: 'maria@exemplo.com', percentual_comissao: '20.00', ativo: true,
  }).returning('id').executeTakeFirstOrThrow()
  idMaria = maria.id
}

describe('criacao de pedido com atribuicao congelada', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('congela representante, percentual e UTM na criacao', async () => {
    const p = await criarPedido({
      origem: 'link', representanteId: idMaria,
      percentualComissao: 20,
      utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
      subtotal: centavos(599.70), desconto: centavos(59.97), frete: centavos(0),
    })
    expect(p.representanteId).toBe(idMaria)
    expect(p.percentualComissaoSnapshot).toBe(20)
    expect(p.utmSource).toBe('instagram')
    expect(p.totalCentavos).toBe(53973)
  })

  it('alterar o percentual do representante NAO muda pedido ja criado', async () => {
    const p = await criarPedido({
      origem: 'link', representanteId: idMaria, percentualComissao: 20,
      utmSource: null, utmMedium: null, utmCampaign: null,
      subtotal: centavos(100), desconto: centavos(0), frete: centavos(0),
    })
    await getDb().updateTable('representantes')
      .set({ percentual_comissao: '5.00' }).where('id', '=', idMaria).execute()

    const relido = await getDb().selectFrom('pedidos')
      .select('percentual_comissao_snapshot')
      .where('id', '=', p.id).executeTakeFirstOrThrow()
    expect(Number(relido.percentual_comissao_snapshot)).toBe(20)
  })

  it('aceita venda da casa, sem representante', async () => {
    const p = await criarPedido({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      subtotal: centavos(199.90), desconto: centavos(0), frete: centavos(0),
    })
    expect(p.representanteId).toBeNull()
    expect(p.origem).toBe('casa')
  })

  it('registra rep_inativo em vez de perder o motivo', async () => {
    const p = await criarPedido({
      origem: 'rep_inativo', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      subtotal: centavos(199.90), desconto: centavos(0), frete: centavos(0),
    })
    expect(p.origem).toBe('rep_inativo')
  })

  it('o banco rejeita origem link sem representante', async () => {
    await expect(criarPedido({
      origem: 'link', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      subtotal: centavos(100), desconto: centavos(0), frete: centavos(0),
    })).rejects.toThrow(/pedido_origem_coerente/)
  })

  it('o banco rejeita total que nao fecha com as parcelas', async () => {
    await expect(
      getDb().insertInto('pedidos').values({
        origem: 'casa', subtotal_centavos: 10000, desconto_centavos: 0,
        frete_centavos: 0, total_centavos: 9999,
      }).execute(),
    ).rejects.toThrow(/pedido_total_confere/)
  })

  it('o banco rejeita desconto maior que o subtotal', async () => {
    await expect(
      getDb().insertInto('pedidos').values({
        origem: 'casa', subtotal_centavos: 1000, desconto_centavos: 2000,
        frete_centavos: 0, total_centavos: 0,
      }).execute(),
    ).rejects.toThrow(/pedido_desconto_nao_excede/)
  })

  it('impede apagar representante que ja tem pedido', async () => {
    await criarPedido({
      origem: 'link', representanteId: idMaria, percentualComissao: 20,
      utmSource: null, utmMedium: null, utmCampaign: null,
      subtotal: centavos(100), desconto: centavos(0), frete: centavos(0),
    })
    await expect(
      getDb().deleteFrom('representantes').where('id', '=', idMaria).execute(),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 3: Rodar e confirmar que falha**

```bash
npm test -- pedidos.test
```

Esperado: FALHA com `Cannot find module '@/repositories/pedidos'`.

- [ ] **Step 4: Implementar o repositório**

```ts
// src/repositories/pedidos.ts
import { getDb } from '@/lib/db'
import { deInteiro, type Centavos } from '@/lib/money'

export type OrigemAtribuicao = 'link' | 'cupom' | 'casa' | 'rep_inativo'

export type EntradaPedido = {
  origem: OrigemAtribuicao
  representanteId: string | null
  percentualComissao: number | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  subtotal: Centavos
  desconto: Centavos
  frete: Centavos
}

export type Pedido = {
  id: string
  numero: number
  status: string
  origem: OrigemAtribuicao
  representanteId: string | null
  percentualComissaoSnapshot: number | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  subtotalCentavos: Centavos
  descontoCentavos: Centavos
  freteCentavos: Centavos
  totalCentavos: Centavos
  criadoEm: Date
}

export async function criarPedido(e: EntradaPedido): Promise<Pedido> {
  const total = (e.subtotal - e.desconto + e.frete) as Centavos

  const linha = await getDb()
    .insertInto('pedidos')
    .values({
      origem: e.origem,
      representante_id: e.representanteId,
      percentual_comissao_snapshot:
        e.percentualComissao === null ? null : e.percentualComissao.toFixed(2),
      utm_source: e.utmSource,
      utm_medium: e.utmMedium,
      utm_campaign: e.utmCampaign,
      subtotal_centavos: e.subtotal,
      desconto_centavos: e.desconto,
      frete_centavos: e.frete,
      total_centavos: total,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  const l = linha as unknown as {
    id: string; numero: number; status: string; origem: OrigemAtribuicao
    representante_id: string | null
    percentual_comissao_snapshot: string | number | null
    utm_source: string | null; utm_medium: string | null; utm_campaign: string | null
    subtotal_centavos: number; desconto_centavos: number
    frete_centavos: number; total_centavos: number; criado_em: Date
  }

  return {
    id: l.id,
    numero: Number(l.numero),
    status: l.status,
    origem: l.origem,
    representanteId: l.representante_id,
    percentualComissaoSnapshot:
      l.percentual_comissao_snapshot === null ? null : Number(l.percentual_comissao_snapshot),
    utmSource: l.utm_source,
    utmMedium: l.utm_medium,
    utmCampaign: l.utm_campaign,
    subtotalCentavos: deInteiro(l.subtotal_centavos),
    descontoCentavos: deInteiro(l.desconto_centavos),
    freteCentavos: deInteiro(l.frete_centavos),
    totalCentavos: deInteiro(l.total_centavos),
    criadoEm: l.criado_em,
  }
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

```bash
npm test
npm run typecheck
```

Esperado: toda a suíte passa. Os quatro testes que esperam erro de constraint são os mais importantes: provam que a integridade está no banco, não numa validação que alguém pode esquecer de chamar.

- [ ] **Step 6: Commit**

```bash
git add migrations/ src/repositories/pedidos.ts src/repositories/__tests__/pedidos.test.ts src/lib/db-types.ts
git commit -m "Add pedidos table with frozen attribution snapshot and integrity constraints"
```

---

## Auto-revisão

**Cobertura contra a spec (itens do Plano 1):**

| Item da spec | Tarefa |
|---|---|
| 6 — atribuição de venda, cookie, janela de 30 dias | 7, 8 |
| 10 — registro da origem da venda | 9 |
| 11 — parâmetros UTM | 7, 8, 9 |
| 13 — regra de atribuição com janela configurável | 7 |
| 14 — conflito entre representantes (last click) | 8 |
| 16 — os 8 status de pedido | 9 |
| 17 — percentual configurável por representante | 6, 9 |
| 30 — cadastro de produto com preço, SKU, status | 5 |
| 32 — estrutura de banco relacionada corretamente | 5, 6, 9 |
| 34 — número ANVISA no cadastro do produto | 5 |
| 36 — perfil oficial como origem comercial (`casa`) | 9 |

**Lacunas conhecidas e deliberadas deste plano:** cupom, checkout, gateway, itens do pedido, comissão em ledger, autenticação e dashboard. Todos estão nos planos seguintes, e nenhum deles é pré-requisito da atribuição funcionar.

**Consistência de tipos:** `Centavos` é produzido por `centavos()` e `deInteiro()` (Tarefa 3) e consumido nas Tarefas 5 e 9. `Atribuicao` é definido na Tarefa 7 e consumido na 8. `OrigemAtribuicao` é definido na Tarefa 9 e alinhado com o `ENUM` da migration da mesma tarefa. `getDb`/`closeDb` (Tarefa 2) são usados em todos os testes de repositório.

---

## Sequência dos planos seguintes

| Plano | Escopo | Depende de |
|---|---|---|
| **1 — Fundação, dados e atribuição** *(este)* | Scaffold, dinheiro, fuso, produtos, representantes, atribuição, pedido | — |
| **2 — Loja, cupom e checkout** | Vitrine, seletor de quantidade, cupom com limite por cliente, checkout de 4 etapas, itens do pedido | 1 |
| **3 — Gateway, webhook e comissão** | Mercado Pago, webhook idempotente, máquina de estados do pedido, ledger de comissão append-only, carência | 2 |
| **4 — Autenticação e área do representante** | Login, recuperação de senha, revogação de sessão, dashboard, metas, saque | 3 |
| **5 — Admin, materiais e suporte** | Gestão de representantes, pedidos, cupons, aprovação de saque, ranking, materiais, tickets | 4 |

**Bloqueio de calendário que corre em paralelo e não depende de código:** abertura e KYC da conta Mercado Pago, verificação do domínio no Resend com SPF/DKIM, troca da default branch no GitHub, e ajuste da Production Branch na Vercel. Nenhum desses acelera com esforço de desenvolvimento, e o Plano 3 não pode ser homologado sem o primeiro.
