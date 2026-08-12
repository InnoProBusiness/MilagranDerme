# Plataforma Milagran — Plano 2: Loja, Cupom e Checkout

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um visitante que chega por `/r/maria` escolhe a quantidade de kits, aplica um cupom, preenche seus dados e gera um pedido — com a atribuição da Maria congelada nele e o subtotal amarrado, pelo banco, à soma dos itens.

**Architecture:** O carrinho é lógica pura sobre `Centavos`, sem I/O, para que o cálculo de dinheiro seja testável sem banco. O cupom é resolvido no servidor dentro da mesma transação que cria o pedido, com a linha do cupom travada — é a única forma de o limite de uso não estourar sob concorrência. A criação do pedido passa a ser transacional e a receber itens em vez de um subtotal pronto: uma constraint no banco garante que `subtotal_centavos` seja exatamente a soma dos itens, porque o valor sobre o qual a comissão incide não pode depender de a aplicação ter somado certo.

**Tech Stack:** Next.js 16.3 (App Router) · React 19 · TypeScript strict · Postgres 14 · Kysely · node-pg-migrate (SQL puro) · Vitest

## Global Constraints

Valem para **todas** as tarefas. Herdadas do Plano 1 e não negociáveis.

- **Dinheiro é sempre `integer` em centavos.** Nunca `float`, nunca `NUMERIC`, nunca aritmética em reais.
- **Fuso horário `America/Sao_Paulo`** em todo agrupamento por período e em toda janela de validade.
- **Migrations são arquivos `.sql` escritos à mão.** Nenhuma ferramenta gera DDL. Todo índice parcial é escrito explicitamente.
- **A atribuição autoritativa vive no pedido, não no cookie.**
- **Linhas de row typing vêm do gerado:** `Selectable<Tabela>` de `@/lib/db-types`. Nunca um tipo escrito à mão descrevendo a linha, nunca `as` no call site.
- **`criarPedido` e o resgate de cupom rodam na mesma transação.** Um pedido sem seus itens, ou um cupom debitado sem pedido, é corrupção de dados.
- TypeScript `strict: true`. Nenhum segredo em código.
- Commits em inglês, imperativo. Nunca `--no-verify`.
- Node 20.9+.

## Decisões de produto travadas neste plano

| Decisão | Valor | Origem |
|---|---|---|
| Preço do kit | **R$ 1.000,00** (`100000` centavos), **linear por quantidade** — 3 kits custam R$ 3.000,00, sem desconto por volume | Cliente, 12/08/2026 |
| Frete | **Em breve.** `frete_centavos = 0` em todo pedido, e a UI mostra "a definir" em vez de "R$ 0,00" | Cliente, 12/08/2026 |
| Registro ANVISA | **Em breve.** Placeholder no dado, aviso visível na página do produto | Cliente, 12/08/2026 |
| Base da comissão | Subtotal dos produtos **já com desconto do cupom**, sem frete | Plano 1, `calcularComissao` |

**Os dois "em breve" são dívida deliberada e precisam ser visíveis na tela, não só no código.** Um frete escondido como "R$ 0,00" é uma promessa de frete grátis que ninguém tomou; um cosmético sem número ANVISA exibido é venda irregular. A Tarefa 8 coloca os dois avisos na interface e a Tarefa 2 deixa o dado marcado.

## Restrições herdadas que este plano precisa honrar

De [`2026-08-11-pendencias-carregadas.md`](2026-08-11-pendencias-carregadas.md):

- **Cupom de representante desativado** — o resgate reconsulta `ativo`. Um cupom de quem saiu não credita comissão a quem não está mais na operação. (Tarefa 5)
- **Pedido de valor zero** — com `pedido_itens` existindo, amarre `subtotal_centavos` à soma dos itens e exija `> 0`. (Tarefa 1)
- **Não mutar o retorno do resolver** — `resolverAtribuicaoDoPedido` devolve `Readonly`; a prioridade do cupom constrói um objeto novo. (Tarefa 6)
- **Intervalos por período em SQL** usam a forma semiaberta `>= inicio AND < proximoInicio`. (Tarefa 5)

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `migrations/1755000000000_pedido_itens.sql` | Itens do pedido e a constraint que amarra o subtotal |
| `migrations/1755000100000_clientes.sql` | Cliente e endereço de entrega |
| `migrations/1755000200000_cupons.sql` | Cupons e registro de uso |
| `src/lib/carrinho.ts` | Cálculo puro: quantidade, subtotal, desconto, total. Sem I/O |
| `src/lib/cupom.ts` | Regras de validade do cupom. Puro, sem I/O |
| `src/repositories/cupons.ts` | Leitura do cupom e resgate transacional com trava |
| `src/repositories/clientes.ts` | Upsert de cliente e endereço |
| `src/repositories/pedidos.ts` | *(modificar)* `criarPedido` transacional recebendo itens |
| `src/lib/montar-pedido.ts` | Carrinho + cupom + atribuição → `EntradaPedido`. Onde a hierarquia cupom > last click é decidida |
| `src/app/comprar/page.tsx` | Vitrine oficial (origem `casa`) |
| `src/app/r/[slug]/page.tsx` | *(modificar)* Vitrine do representante |
| `src/components/vitrine.tsx` | Seletor de quantidade, cupom, resumo. Compartilhado pelas duas vitrines |
| `src/app/checkout/page.tsx` | Checkout de 4 etapas |
| `src/app/api/pedidos/route.ts` | Cria o pedido. Único ponto de escrita |
| `src/app/pedido/[numero]/page.tsx` | Confirmação |

**Decisão de decomposição.** `carrinho.ts` e `cupom.ts` são puros de propósito: é onde o dinheiro é calculado, e teste de dinheiro não deve precisar de banco nem de servidor. `montar-pedido.ts` existe separado porque a hierarquia de atribuição é a regra mais contestável do sistema — ela merece um arquivo com nome, não uma condicional dentro de um route handler.

---

## Task 1: Itens do pedido, com o subtotal amarrado ao banco

**Files:**
- Create: `migrations/1755000000000_pedido_itens.sql`
- Modify: `src/repositories/pedidos.ts`
- Test: `src/repositories/__tests__/pedidos.test.ts` *(estender)*

**Interfaces:**
- Consumes: `getDb()`, `Centavos`, `deInteiro`, `EntradaPedido`, `criarPedido` (Plano 1)
- Produces:
  - `type ItemDoPedido = { kitId: string; quantidade: number; precoUnitarioCentavos: Centavos }`
  - `EntradaPedido` passa a ter `itens: ItemDoPedido[]` e **perde** `subtotal`
  - `criarPedido(e: EntradaPedido): Promise<Pedido>` — agora transacional

- [ ] **Step 1: Escrever a migration**

O preço unitário é copiado para a linha do item no momento da compra. Se o preço do kit mudar amanhã, o pedido de hoje continua valendo o que valia hoje — mesmo princípio do `percentual_comissao_snapshot`.

```sql
-- migrations/1755000000000_pedido_itens.sql
-- Up Migration
CREATE TABLE pedido_itens (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id                uuid NOT NULL REFERENCES pedidos (id) ON DELETE CASCADE,
  kit_id                   uuid NOT NULL REFERENCES kits (id) ON DELETE RESTRICT,
  -- Snapshot do catalogo no momento da compra. Nunca recalculado.
  nome_snapshot            text        NOT NULL,
  preco_unitario_centavos  integer     NOT NULL,
  quantidade               smallint    NOT NULL,
  total_centavos           integer     NOT NULL,
  criado_em                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT item_quantidade_positiva CHECK (quantidade > 0),
  CONSTRAINT item_preco_positivo      CHECK (preco_unitario_centavos > 0),
  CONSTRAINT item_total_confere       CHECK (total_centavos = preco_unitario_centavos * quantidade)
);

CREATE INDEX pedido_itens_pedido ON pedido_itens (pedido_id);
-- Um kit aparece uma vez por pedido; quantidade e coluna, nao linha repetida.
CREATE UNIQUE INDEX pedido_itens_kit_unico ON pedido_itens (pedido_id, kit_id);

-- Pedido sem item nao existe, e subtotal e a soma dos itens — nao um numero
-- que a aplicacao mandou. A comissao incide sobre este valor.
ALTER TABLE pedidos ADD CONSTRAINT pedido_subtotal_positivo CHECK (subtotal_centavos > 0);

CREATE FUNCTION pedido_conferir_subtotal() RETURNS trigger AS $$
DECLARE
  soma integer;
  esperado integer;
BEGIN
  SELECT COALESCE(SUM(total_centavos), 0) INTO soma
    FROM pedido_itens WHERE pedido_id = COALESCE(NEW.pedido_id, OLD.pedido_id);
  SELECT subtotal_centavos INTO esperado
    FROM pedidos WHERE id = COALESCE(NEW.pedido_id, OLD.pedido_id);

  IF soma IS DISTINCT FROM esperado THEN
    RAISE EXCEPTION
      'pedido_subtotal_confere: subtotal do pedido e % mas a soma dos itens e %',
      esperado, soma;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- CONSTRAINT TRIGGER DEFERRABLE: a checagem roda no COMMIT, nao a cada
-- INSERT. Sem isso seria impossivel inserir o pedido e depois seus itens
-- dentro da mesma transacao — o primeiro INSERT ja falharia.
CREATE CONSTRAINT TRIGGER pedido_subtotal_confere_trg
  AFTER INSERT OR UPDATE OR DELETE ON pedido_itens
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pedido_conferir_subtotal();

-- Down Migration
DROP TRIGGER pedido_subtotal_confere_trg ON pedido_itens;
DROP FUNCTION pedido_conferir_subtotal();
ALTER TABLE pedidos DROP CONSTRAINT pedido_subtotal_positivo;
DROP TABLE pedido_itens;
```

- [ ] **Step 2: Migrar e regenerar tipos**

```bash
npm run db:up && npm run db:migrate && npm run db:types
```

- [ ] **Step 3: Escrever os testes**

```ts
// acrescentar em src/repositories/__tests__/pedidos.test.ts
import { deInteiro } from '@/lib/money'
import { sql } from 'kysely'

describe('pedido com itens', () => {
  it('deriva o subtotal da soma dos itens', async () => {
    const p = await criarPedido({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: deInteiro(0), frete: deInteiro(0),
      itens: [{ kitId: idKit, quantidade: 3, precoUnitarioCentavos: deInteiro(100000) }],
    })
    expect(p.subtotalCentavos).toBe(300000)
    expect(p.totalCentavos).toBe(300000)
  })

  it('grava o nome e o preco do kit como snapshot', async () => {
    const p = await criarPedido({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: deInteiro(0), frete: deInteiro(0),
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(100000) }],
    })
    const itens = await getDb().selectFrom('pedido_itens')
      .selectAll().where('pedido_id', '=', p.id).execute()
    expect(itens).toHaveLength(1)
    expect(itens[0]!.nome_snapshot).toBe('Kit Milagran')
    expect(itens[0]!.preco_unitario_centavos).toBe(100000)
  })

  it('mudar o preco do kit depois NAO altera o pedido', async () => {
    const p = await criarPedido({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: deInteiro(0), frete: deInteiro(0),
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(100000) }],
    })
    await getDb().updateTable('kits')
      .set({ preco_centavos: 50000 }).where('id', '=', idKit).execute()

    const item = await getDb().selectFrom('pedido_itens')
      .select('preco_unitario_centavos').where('pedido_id', '=', p.id)
      .executeTakeFirstOrThrow()
    expect(item.preco_unitario_centavos).toBe(100000)
  })

  it('rejeita pedido sem itens', async () => {
    await expect(criarPedido({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: deInteiro(0), frete: deInteiro(0), itens: [],
    })).rejects.toThrow(/sem itens|pedido_subtotal_positivo/)
  })

  it('o banco rejeita um subtotal que nao bate com os itens', async () => {
    // Insercao crua, ignorando o repositorio: prova que a garantia esta no
    // banco e nao numa soma que a aplicacao pode errar.
    await expect(
      getDb().transaction().execute(async (trx) => {
        await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx)
        const pedido = await trx.insertInto('pedidos').values({
          origem: 'casa', subtotal_centavos: 999999,
          desconto_centavos: 0, frete_centavos: 0, total_centavos: 999999,
        }).returning('id').executeTakeFirstOrThrow()
        await trx.insertInto('pedido_itens').values({
          pedido_id: pedido.id, kit_id: idKit, nome_snapshot: 'Kit Milagran',
          preco_unitario_centavos: 100000, quantidade: 1, total_centavos: 100000,
        }).execute()
      }),
    ).rejects.toThrow(/pedido_subtotal_confere/)
  })

  it('apagar o pedido leva os itens junto', async () => {
    const p = await criarPedido({
      origem: 'casa', representanteId: null, percentualComissao: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      desconto: deInteiro(0), frete: deInteiro(0),
      itens: [{ kitId: idKit, quantidade: 1, precoUnitarioCentavos: deInteiro(100000) }],
    })
    await getDb().deleteFrom('pedidos').where('id', '=', p.id).execute()
    const restantes = await getDb().selectFrom('pedido_itens')
      .selectAll().where('pedido_id', '=', p.id).execute()
    expect(restantes).toHaveLength(0)
  })
})
```

O `beforeEach` do arquivo precisa semear um kit e guardar seu id em `idKit`, com `nome: 'Kit Milagran'` e `preco_centavos: 100000`, limpando por `slug` no padrão escopado que os outros arquivos já usam.

- [ ] **Step 4: Rodar e confirmar que falha**

```bash
npm test -- pedidos.test
```

Esperado: FALHA — `criarPedido` ainda não aceita `itens`.

- [ ] **Step 5: Reescrever `criarPedido` como transacional**

```ts
// src/repositories/pedidos.ts — substituir EntradaPedido e criarPedido
export type ItemDoPedido = {
  kitId: string
  quantidade: number
  precoUnitarioCentavos: Centavos
}

export type EntradaPedido = {
  origem: OrigemAtribuicao
  representanteId: string | null
  percentualComissao: number | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  desconto: Centavos
  frete: Centavos
  itens: ItemDoPedido[]
}

export async function criarPedido(e: EntradaPedido): Promise<Pedido> {
  if (e.itens.length === 0) {
    throw new Error('Pedido sem itens nao pode ser criado')
  }

  const subtotal = e.itens.reduce(
    (acc, i) => acc + i.precoUnitarioCentavos * i.quantidade,
    0,
  ) as Centavos
  const total = (subtotal - e.desconto + e.frete) as Centavos

  return getDb().transaction().execute(async (trx) => {
    const linha = await trx.insertInto('pedidos').values({
      origem: e.origem,
      representante_id: e.representanteId,
      percentual_comissao_snapshot:
        e.percentualComissao === null ? null : e.percentualComissao,
      utm_source: e.utmSource,
      utm_medium: e.utmMedium,
      utm_campaign: e.utmCampaign,
      subtotal_centavos: subtotal,
      desconto_centavos: e.desconto,
      frete_centavos: e.frete,
      total_centavos: total,
    }).returningAll().executeTakeFirstOrThrow()

    // Nome e preco vem do catalogo AGORA e viram snapshot na linha do item.
    for (const item of e.itens) {
      const kit = await trx.selectFrom('kits')
        .select(['nome', 'preco_centavos'])
        .where('id', '=', item.kitId)
        .executeTakeFirstOrThrow()

      await trx.insertInto('pedido_itens').values({
        pedido_id: linha.id,
        kit_id: item.kitId,
        nome_snapshot: kit.nome,
        preco_unitario_centavos: item.precoUnitarioCentavos,
        quantidade: item.quantidade,
        total_centavos: item.precoUnitarioCentavos * item.quantidade,
      }).execute()
    }

    return paraPedido(linha)
  })
}
```

O `paraPedido` é o mapeador que já existe no arquivo; extraia-o se ainda estiver inline.

- [ ] **Step 6: Rodar toda a suíte**

```bash
npm test && npm run typecheck
```

Todo teste antigo que chamava `criarPedido` com `subtotal` precisa passar `itens`. Ajuste as chamadas — **não** as asserções de valor.

- [ ] **Step 7: Commit**

```bash
git add migrations/ src/repositories/ src/lib/db-types.ts
git commit -m "Tie order subtotal to the sum of its items in the database"
```

---

## Task 2: Cliente e endereço de entrega

**Files:**
- Create: `migrations/1755000100000_clientes.sql`, `src/repositories/clientes.ts`
- Test: `src/repositories/__tests__/clientes.test.ts`

**Interfaces:**
- Consumes: `getDb()`
- Produces:
  - `type EntradaCliente = { nome: string; email: string; cpf: string; whatsapp: string }`
  - `type EntradaEndereco = { cep: string; rua: string; numero: string; complemento: string; bairro: string; cidade: string; estado: string }`
  - `salvarClienteComEndereco(c: EntradaCliente, e: EntradaEndereco): Promise<{ clienteId: string; enderecoId: string }>`

- [ ] **Step 1: Escrever a migration**

```sql
-- migrations/1755000100000_clientes.sql
-- Up Migration
CREATE TABLE clientes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text        NOT NULL,
  email         text        NOT NULL,
  cpf           text        NOT NULL,
  whatsapp      text        NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cliente_email_formato CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- Guardado so com digitos. A formatacao e responsabilidade da interface.
  CONSTRAINT cliente_cpf_digitos    CHECK (cpf ~ '^[0-9]{11}$')
);

-- Identidade do cliente para o limite de uso de cupom por pessoa.
-- lower(email) porque o valor armazenado mantem a caixa que a pessoa digitou.
CREATE UNIQUE INDEX cliente_email_unico ON clientes (lower(email));
CREATE INDEX cliente_cpf ON clientes (cpf);

CREATE TABLE enderecos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  uuid NOT NULL REFERENCES clientes (id) ON DELETE CASCADE,
  cep         text        NOT NULL,
  rua         text        NOT NULL,
  numero      text        NOT NULL,
  complemento text        NOT NULL DEFAULT '',
  bairro      text        NOT NULL,
  cidade      text        NOT NULL,
  estado      varchar(2)  NOT NULL,
  criado_em   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT endereco_cep_digitos CHECK (cep ~ '^[0-9]{8}$'),
  CONSTRAINT endereco_uf_valida   CHECK (estado ~ '^[A-Z]{2}$')
);

CREATE INDEX enderecos_cliente ON enderecos (cliente_id);

ALTER TABLE pedidos ADD COLUMN cliente_id  uuid REFERENCES clientes (id) ON DELETE RESTRICT;
ALTER TABLE pedidos ADD COLUMN endereco_id uuid REFERENCES enderecos (id) ON DELETE RESTRICT;

-- Down Migration
ALTER TABLE pedidos DROP COLUMN endereco_id;
ALTER TABLE pedidos DROP COLUMN cliente_id;
DROP TABLE enderecos;
DROP TABLE clientes;
```

`cliente_id` entra nulável de propósito: os pedidos que a Tarefa 1 já criou não têm cliente, e uma coluna `NOT NULL` quebraria a migration. A Tarefa 9 é quem passa a sempre preencher.

- [ ] **Step 2: Migrar, regenerar tipos e escrever os testes**

```bash
npm run db:migrate && npm run db:types
```

```ts
// src/repositories/__tests__/clientes.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { salvarClienteComEndereco } from '@/repositories/clientes'

const CLIENTE = { nome: 'Ana Souza', email: 'Ana@Exemplo.com', cpf: '12345678901', whatsapp: '11988887777' }
const ENDERECO = { cep: '01310100', rua: 'Av Paulista', numero: '1000', complemento: 'ap 51', bairro: 'Bela Vista', cidade: 'Sao Paulo', estado: 'SP' }

describe('clientes', () => {
  beforeEach(async () => {
    await getDb().deleteFrom('clientes').where('cpf', '=', '12345678901').execute()
  })
  afterAll(async () => { await closeDb() })

  it('salva cliente e endereco juntos', async () => {
    const r = await salvarClienteComEndereco(CLIENTE, ENDERECO)
    expect(r.clienteId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.enderecoId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reconhece o mesmo cliente por e-mail, ignorando a caixa', async () => {
    const a = await salvarClienteComEndereco(CLIENTE, ENDERECO)
    const b = await salvarClienteComEndereco({ ...CLIENTE, email: 'ana@exemplo.com' }, ENDERECO)
    expect(b.clienteId).toBe(a.clienteId)
  })

  it('cada compra grava um endereco novo, sem sobrescrever o anterior', async () => {
    const a = await salvarClienteComEndereco(CLIENTE, ENDERECO)
    const b = await salvarClienteComEndereco(CLIENTE, { ...ENDERECO, numero: '2000' })
    expect(b.enderecoId).not.toBe(a.enderecoId)
    const enderecos = await getDb().selectFrom('enderecos')
      .selectAll().where('cliente_id', '=', a.clienteId).execute()
    expect(enderecos).toHaveLength(2)
  })

  it('o banco rejeita CPF com pontuacao', async () => {
    await expect(
      salvarClienteComEndereco({ ...CLIENTE, cpf: '123.456.789-01' }, ENDERECO),
    ).rejects.toThrow(/cliente_cpf_digitos/)
  })

  it('o banco rejeita UF minuscula', async () => {
    await expect(
      salvarClienteComEndereco(CLIENTE, { ...ENDERECO, estado: 'sp' }),
    ).rejects.toThrow(/endereco_uf_valida/)
  })

  it('o banco rejeita CEP com hifen', async () => {
    await expect(
      salvarClienteComEndereco(CLIENTE, { ...ENDERECO, cep: '01310-100' }),
    ).rejects.toThrow(/endereco_cep_digitos/)
  })
})
```

- [ ] **Step 3: Rodar e confirmar que falha**

```bash
npm test -- clientes.test
```

Esperado: FALHA com `Cannot find module '@/repositories/clientes'`.

- [ ] **Step 4: Implementar o repositório**

```ts
// src/repositories/clientes.ts
import { getDb } from '@/lib/db'
import { sql } from 'kysely'

export type EntradaCliente = { nome: string; email: string; cpf: string; whatsapp: string }
export type EntradaEndereco = {
  cep: string; rua: string; numero: string; complemento: string
  bairro: string; cidade: string; estado: string
}

/**
 * O cliente e identificado por lower(email). Endereco NAO e atualizado: cada
 * compra grava o endereco daquela compra, porque o pedido antigo tem que
 * continuar mostrando para onde foi entregue.
 */
export async function salvarClienteComEndereco(
  c: EntradaCliente,
  e: EntradaEndereco,
): Promise<{ clienteId: string; enderecoId: string }> {
  return getDb().transaction().execute(async (trx) => {
    const existente = await trx.selectFrom('clientes')
      .select('id')
      .where(sql<boolean>`lower(email) = lower(${c.email})`)
      .executeTakeFirst()

    let clienteId: string
    if (existente) {
      clienteId = existente.id
      await trx.updateTable('clientes')
        .set({ nome: c.nome, whatsapp: c.whatsapp, cpf: c.cpf, atualizado_em: new Date() })
        .where('id', '=', clienteId)
        .execute()
    } else {
      const novo = await trx.insertInto('clientes')
        .values({ nome: c.nome, email: c.email, cpf: c.cpf, whatsapp: c.whatsapp })
        .returning('id').executeTakeFirstOrThrow()
      clienteId = novo.id
    }

    const endereco = await trx.insertInto('enderecos')
      .values({ cliente_id: clienteId, ...e })
      .returning('id').executeTakeFirstOrThrow()

    return { clienteId, enderecoId: endereco.id }
  })
}
```

- [ ] **Step 5: Rodar, confirmar verde e commitar**

```bash
npm test && npm run typecheck
git add migrations/ src/repositories/ src/lib/db-types.ts
git commit -m "Add customer and delivery address with digit-only CPF and CEP"
```

---

## Task 3: Cálculo do carrinho, puro

**Files:**
- Create: `src/lib/carrinho.ts`
- Test: `src/lib/__tests__/carrinho.test.ts`

**Interfaces:**
- Consumes: `Centavos`, `deInteiro`, `multiplicar` de `@/lib/money`
- Produces:
  - `type LinhaCarrinho = { kitId: string; nome: string; precoUnitario: Centavos; quantidade: number; total: Centavos }`
  - `type ResumoCarrinho = { linhas: LinhaCarrinho[]; subtotal: Centavos; desconto: Centavos; frete: Centavos; total: Centavos; freteADefinir: boolean }`
  - `QUANTIDADE_MAXIMA = 20`
  - `montarCarrinho(itens, desconto?): ResumoCarrinho`

- [ ] **Step 1: Escrever os testes**

```ts
// src/lib/__tests__/carrinho.test.ts
import { describe, it, expect } from 'vitest'
import { deInteiro } from '@/lib/money'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'

const KIT = { kitId: 'k1', nome: 'Kit Milagran', precoUnitario: deInteiro(100000) }

describe('montarCarrinho', () => {
  it('preco e linear: 3 kits custam 3x o preco unitario', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 3 }])
    expect(r.subtotal).toBe(300000)
    expect(r.total).toBe(300000)
  })

  it('frete e zero e marcado como a definir', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 1 }])
    expect(r.frete).toBe(0)
    expect(r.freteADefinir).toBe(true)
  })

  it('desconto sai do subtotal e nao do frete', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 2 }], deInteiro(20000))
    expect(r.subtotal).toBe(200000)
    expect(r.desconto).toBe(20000)
    expect(r.total).toBe(180000)
  })

  it('limita o desconto ao subtotal — total nunca fica negativo', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: 1 }], deInteiro(500000))
    expect(r.desconto).toBe(100000)
    expect(r.total).toBe(0)
  })

  it('rejeita carrinho vazio', () => {
    expect(() => montarCarrinho([])).toThrow(/vazio/)
  })

  it('rejeita quantidade zero ou negativa', () => {
    expect(() => montarCarrinho([{ ...KIT, quantidade: 0 }])).toThrow(/quantidade/i)
    expect(() => montarCarrinho([{ ...KIT, quantidade: -1 }])).toThrow(/quantidade/i)
  })

  it('rejeita quantidade acima do teto', () => {
    expect(() => montarCarrinho([{ ...KIT, quantidade: QUANTIDADE_MAXIMA + 1 }]))
      .toThrow(/maxima/i)
  })

  it('aceita exatamente o teto', () => {
    const r = montarCarrinho([{ ...KIT, quantidade: QUANTIDADE_MAXIMA }])
    expect(r.subtotal).toBe(100000 * QUANTIDADE_MAXIMA)
  })

  it('soma varios kits diferentes', () => {
    const r = montarCarrinho([
      { ...KIT, quantidade: 2 },
      { kitId: 'k2', nome: 'Kit Duo', precoUnitario: deInteiro(180000), quantidade: 1 },
    ])
    expect(r.subtotal).toBe(380000)
    expect(r.linhas).toHaveLength(2)
    expect(r.linhas[0]!.total).toBe(200000)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
npm test -- carrinho.test
```

- [ ] **Step 3: Implementar**

```ts
// src/lib/carrinho.ts
import { deInteiro, multiplicar, type Centavos } from '@/lib/money'

/**
 * Teto por pedido. Existe para que um erro de digitacao ou um bot nao gere
 * um pedido de R$ 2 milhoes que estoura o int4 do banco e aparece como erro
 * cru do Postgres em vez de mensagem de validacao.
 */
export const QUANTIDADE_MAXIMA = 20

export type EntradaLinha = {
  kitId: string
  nome: string
  precoUnitario: Centavos
  quantidade: number
}

export type LinhaCarrinho = EntradaLinha & { total: Centavos }

export type ResumoCarrinho = {
  linhas: LinhaCarrinho[]
  subtotal: Centavos
  desconto: Centavos
  frete: Centavos
  total: Centavos
  /**
   * A politica de frete ainda nao foi definida. Enquanto for true, a
   * interface mostra "a definir" — nunca "R$ 0,00", que seria uma promessa
   * de frete gratis que ninguem tomou.
   */
  freteADefinir: boolean
}

const FRETE_A_DEFINIR = true

export function montarCarrinho(
  itens: EntradaLinha[],
  desconto: Centavos = deInteiro(0),
): ResumoCarrinho {
  if (itens.length === 0) {
    throw new Error('Carrinho vazio nao pode ser resumido')
  }

  const linhas = itens.map((i) => {
    if (!Number.isInteger(i.quantidade) || i.quantidade < 1) {
      throw new Error(`Quantidade precisa ser inteira e maior que zero: ${i.quantidade}`)
    }
    if (i.quantidade > QUANTIDADE_MAXIMA) {
      throw new Error(`Quantidade maxima por kit e ${QUANTIDADE_MAXIMA}, recebido ${i.quantidade}`)
    }
    return { ...i, total: multiplicar(i.precoUnitario, i.quantidade) }
  })

  const subtotal = linhas.reduce((acc, l) => acc + l.total, 0) as Centavos
  // O desconto nunca ultrapassa o subtotal: a constraint
  // pedido_desconto_nao_excede rejeitaria, e um total negativo nao existe.
  const descontoAplicado = Math.min(desconto, subtotal) as Centavos
  const frete = deInteiro(0)

  return {
    linhas,
    subtotal,
    desconto: descontoAplicado,
    frete,
    total: (subtotal - descontoAplicado + frete) as Centavos,
    freteADefinir: FRETE_A_DEFINIR,
  }
}
```

- [ ] **Step 4: Rodar, confirmar verde e commitar**

```bash
npm test -- carrinho.test && npm run typecheck
git add src/lib/carrinho.ts src/lib/__tests__/carrinho.test.ts
git commit -m "Add pure cart calculation with shipping marked as pending"
```

---

## Task 4: Schema de cupons

**Files:**
- Create: `migrations/1755000200000_cupons.sql`
- Test: `src/repositories/__tests__/cupons.test.ts` *(parcial — só o schema)*

**Interfaces:**
- Consumes: `getDb()`
- Produces: tabelas `cupons` e `cupom_usos`; tipos gerados `Cupons`, `CupomUsos`, `TipoDesconto`

- [ ] **Step 1: Escrever a migration**

```sql
-- migrations/1755000200000_cupons.sql
-- Up Migration
CREATE TYPE tipo_desconto AS ENUM ('percentual', 'fixo');

CREATE TABLE cupons (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo             text          NOT NULL,
  tipo               tipo_desconto NOT NULL,
  -- percentual: 1..100. fixo: valor em centavos.
  valor              integer       NOT NULL,
  inicia_em          timestamptz   NOT NULL DEFAULT now(),
  expira_em          timestamptz,
  limite_total       integer,
  limite_por_cliente integer       NOT NULL DEFAULT 1,
  ativo              boolean       NOT NULL DEFAULT true,
  -- Cupom de representante. NULL = cupom da casa, nao atribui comissao.
  representante_id   uuid REFERENCES representantes (id) ON DELETE RESTRICT,
  criado_em          timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT cupom_valor_positivo   CHECK (valor > 0),
  CONSTRAINT cupom_percentual_valido CHECK (tipo <> 'percentual' OR valor <= 100),
  CONSTRAINT cupom_limites_positivos CHECK (
    (limite_total IS NULL OR limite_total > 0) AND limite_por_cliente > 0
  ),
  CONSTRAINT cupom_janela_coerente  CHECK (expira_em IS NULL OR expira_em > inicia_em),
  -- Codigo entra em campo de formulario: maiusculas, digitos, 3 a 24 chars.
  CONSTRAINT cupom_codigo_formato   CHECK (codigo ~ '^[A-Z0-9]{3,24}$')
);

CREATE UNIQUE INDEX cupom_codigo_unico ON cupons (codigo);
CREATE INDEX cupom_representante ON cupons (representante_id) WHERE representante_id IS NOT NULL;

CREATE TABLE cupom_usos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cupom_id   uuid NOT NULL REFERENCES cupons (id)   ON DELETE RESTRICT,
  pedido_id  uuid NOT NULL REFERENCES pedidos (id)  ON DELETE CASCADE,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

-- Um pedido consome um cupom uma unica vez.
CREATE UNIQUE INDEX cupom_uso_pedido_unico ON cupom_usos (pedido_id);
-- As duas consultas do resgate: total usado e usado por este cliente.
CREATE INDEX cupom_usos_cupom   ON cupom_usos (cupom_id);
CREATE INDEX cupom_usos_cliente ON cupom_usos (cupom_id, cliente_id);

ALTER TABLE pedidos ADD COLUMN cupom_id uuid REFERENCES cupons (id) ON DELETE RESTRICT;

-- Down Migration
ALTER TABLE pedidos DROP COLUMN cupom_id;
DROP TABLE cupom_usos;
DROP TABLE cupons;
DROP TYPE tipo_desconto;
```

- [ ] **Step 2: Migrar, regenerar tipos e escrever os testes de constraint**

```bash
npm run db:migrate && npm run db:types
```

```ts
// src/repositories/__tests__/cupons.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'

const CODIGOS = ['MARIA10', 'FIXO50', 'RUIM']

async function limpar() {
  const db = getDb()
  await db.deleteFrom('cupons').where('codigo', 'in', CODIGOS).execute()
}

describe('schema de cupons', () => {
  beforeEach(limpar)
  afterAll(async () => { await closeDb() })

  it('aceita cupom percentual valido', async () => {
    await getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'percentual', valor: 10 }).execute()
    const c = await getDb().selectFrom('cupons').selectAll()
      .where('codigo', '=', 'MARIA10').executeTakeFirstOrThrow()
    expect(c.limite_por_cliente).toBe(1)
    expect(c.ativo).toBe(true)
  })

  it('rejeita percentual acima de 100', async () => {
    await expect(getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'percentual', valor: 150 }).execute(),
    ).rejects.toThrow(/cupom_percentual_valido/)
  })

  it('aceita desconto fixo acima de 100 — sao centavos, nao porcentagem', async () => {
    await getDb().insertInto('cupons')
      .values({ codigo: 'FIXO50', tipo: 'fixo', valor: 5000 }).execute()
    const c = await getDb().selectFrom('cupons').select('valor')
      .where('codigo', '=', 'FIXO50').executeTakeFirstOrThrow()
    expect(c.valor).toBe(5000)
  })

  it('rejeita codigo minusculo', async () => {
    await expect(getDb().insertInto('cupons')
      .values({ codigo: 'maria10', tipo: 'percentual', valor: 10 }).execute(),
    ).rejects.toThrow(/cupom_codigo_formato/)
  })

  it('rejeita codigo duplicado', async () => {
    await getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'percentual', valor: 10 }).execute()
    await expect(getDb().insertInto('cupons')
      .values({ codigo: 'MARIA10', tipo: 'fixo', valor: 500 }).execute(),
    ).rejects.toThrow(/cupom_codigo_unico/)
  })

  it('rejeita janela invertida', async () => {
    await expect(getDb().insertInto('cupons').values({
      codigo: 'RUIM', tipo: 'percentual', valor: 10,
      inicia_em: new Date('2026-09-01'), expira_em: new Date('2026-08-01'),
    }).execute()).rejects.toThrow(/cupom_janela_coerente/)
  })

  it('rejeita limite por cliente zero', async () => {
    await expect(getDb().insertInto('cupons').values({
      codigo: 'RUIM', tipo: 'percentual', valor: 10, limite_por_cliente: 0,
    }).execute()).rejects.toThrow(/cupom_limites_positivos/)
  })
})
```

- [ ] **Step 3: Rodar, confirmar verde e commitar**

```bash
npm test -- cupons.test && npm run typecheck
git add migrations/ src/repositories/__tests__/cupons.test.ts src/lib/db-types.ts
git commit -m "Add coupon schema with per-customer and total usage limits"
```

---

## Task 5: Validade do cupom e resgate com trava

**Files:**
- Create: `src/lib/cupom.ts`, `src/repositories/cupons.ts`
- Test: `src/lib/__tests__/cupom.test.ts`, `src/repositories/__tests__/cupons.test.ts` *(estender)*

**Interfaces:**
- Consumes: `Centavos`, `aplicarPercentual`, `deInteiro`, `getDb()`
- Produces:
  - `type MotivoRecusa = 'inexistente' | 'inativo' | 'nao_iniciado' | 'expirado' | 'esgotado' | 'limite_do_cliente' | 'representante_inativo'`
  - `type CupomValido = { id: string; codigo: string; desconto: Centavos; representanteId: string | null }`
  - `type ResultadoCupom = { ok: true; cupom: CupomValido } | { ok: false; motivo: MotivoRecusa }`
  - `calcularDesconto(tipo, valor, subtotal): Centavos`
  - `resgatarCupom(codigo, subtotal, clienteId, trx): Promise<ResultadoCupom>`

- [ ] **Step 1: Escrever os testes puros**

```ts
// src/lib/__tests__/cupom.test.ts
import { describe, it, expect } from 'vitest'
import { deInteiro } from '@/lib/money'
import { calcularDesconto } from '@/lib/cupom'

describe('calcularDesconto', () => {
  it('percentual incide sobre o subtotal', () => {
    expect(calcularDesconto('percentual', 10, deInteiro(300000))).toBe(30000)
  })

  it('percentual arredonda meio para cima', () => {
    // 1990 * 15% = 298,5 -> 299, mesma regra do resto do sistema
    expect(calcularDesconto('percentual', 15, deInteiro(1990))).toBe(299)
  })

  it('fixo devolve o proprio valor em centavos', () => {
    expect(calcularDesconto('fixo', 5000, deInteiro(300000))).toBe(5000)
  })

  it('fixo nunca ultrapassa o subtotal', () => {
    expect(calcularDesconto('fixo', 500000, deInteiro(100000))).toBe(100000)
  })

  it('percentual de 100 zera o subtotal', () => {
    expect(calcularDesconto('percentual', 100, deInteiro(100000))).toBe(100000)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha, depois implementar o puro**

```bash
npm test -- cupom.test
```

```ts
// src/lib/cupom.ts
import { aplicarPercentual, deInteiro, type Centavos } from '@/lib/money'

export type TipoDesconto = 'percentual' | 'fixo'

export type MotivoRecusa =
  | 'inexistente' | 'inativo' | 'nao_iniciado' | 'expirado'
  | 'esgotado' | 'limite_do_cliente' | 'representante_inativo'

export type CupomValido = {
  id: string
  codigo: string
  desconto: Centavos
  representanteId: string | null
}

export type ResultadoCupom =
  | { ok: true; cupom: CupomValido }
  | { ok: false; motivo: MotivoRecusa }

/**
 * Percentual usa aplicarPercentual, a MESMA funcao que calcula comissao —
 * uma regra de arredondamento so no sistema inteiro, senao o extrato do
 * representante nao fecha com o total do pedido.
 *
 * O desconto nunca ultrapassa o subtotal: a constraint
 * pedido_desconto_nao_excede rejeitaria a gravacao.
 */
export function calcularDesconto(
  tipo: TipoDesconto,
  valor: number,
  subtotal: Centavos,
): Centavos {
  const bruto = tipo === 'percentual'
    ? aplicarPercentual(subtotal, valor)
    : deInteiro(valor)
  return Math.min(bruto, subtotal) as Centavos
}

/** Mensagem para a pessoa que digitou o codigo. Nunca expoe estrutura interna. */
export function mensagemDeRecusa(motivo: MotivoRecusa): string {
  switch (motivo) {
    case 'inexistente':           return 'Cupom nao encontrado. Confira o codigo.'
    case 'inativo':               return 'Este cupom nao esta mais disponivel.'
    case 'nao_iniciado':          return 'Este cupom ainda nao comecou a valer.'
    case 'expirado':              return 'Este cupom expirou.'
    case 'esgotado':              return 'Este cupom atingiu o limite de usos.'
    case 'limite_do_cliente':     return 'Voce ja usou este cupom.'
    case 'representante_inativo': return 'Este cupom nao esta mais disponivel.'
  }
}
```

O `switch` sem `default` sobre a união é proposital: se um motivo novo for adicionado, o `tsc` reprova aqui.

- [ ] **Step 3: Escrever os testes de resgate, incluindo concorrência**

```ts
// acrescentar em src/repositories/__tests__/cupons.test.ts
import { resgatarCupom } from '@/repositories/cupons'
import { deInteiro } from '@/lib/money'

describe('resgate de cupom', () => {
  it('aceita cupom valido e calcula o desconto', async () => {
    const r = await getDb().transaction().execute((trx) =>
      resgatarCupom('MARIA10', deInteiro(300000), idCliente, trx))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.cupom.desconto).toBe(30000)
  })

  it('recusa cupom inexistente', async () => {
    const r = await getDb().transaction().execute((trx) =>
      resgatarCupom('NAOEXISTE', deInteiro(100000), idCliente, trx))
    expect(r).toEqual({ ok: false, motivo: 'inexistente' })
  })

  it('recusa cupom expirado', async () => {
    const r = await getDb().transaction().execute((trx) =>
      resgatarCupom('EXPIRADO', deInteiro(100000), idCliente, trx))
    expect(r).toEqual({ ok: false, motivo: 'expirado' })
  })

  it('recusa cupom de representante DESLIGADO', async () => {
    // Restricao herdada do Plano 1: origem rep_inativo degrada o caminho do
    // link; o cupom precisa do equivalente, senao credita comissao a quem
    // nao esta mais na operacao.
    const r = await getDb().transaction().execute((trx) =>
      resgatarCupom('DESLIGADO', deInteiro(100000), idCliente, trx))
    expect(r).toEqual({ ok: false, motivo: 'representante_inativo' })
  })

  it('recusa quando o cliente ja usou o cupom', async () => {
    await getDb().insertInto('cupom_usos')
      .values({ cupom_id: idCupomMaria, pedido_id: idPedido, cliente_id: idCliente })
      .execute()
    const r = await getDb().transaction().execute((trx) =>
      resgatarCupom('MARIA10', deInteiro(100000), idCliente, trx))
    expect(r).toEqual({ ok: false, motivo: 'limite_do_cliente' })
  })

  it('DINHEIRO: dois resgates simultaneos nao estouram o limite total', async () => {
    // limite_total = 1. Sem a trava na linha do cupom, os dois leem
    // "0 usos" e os dois passam.
    const rodar = () => getDb().transaction().execute(async (trx) => {
      const r = await resgatarCupom('LIMITE1', deInteiro(100000), idCliente, trx)
      if (r.ok) {
        await new Promise((res) => setTimeout(res, 50))
        const pedido = await trx.insertInto('pedidos').values({
          origem: 'casa', subtotal_centavos: 100000, desconto_centavos: 0,
          frete_centavos: 0, total_centavos: 100000,
        }).returning('id').executeTakeFirstOrThrow()
        await trx.insertInto('cupom_usos').values({
          cupom_id: r.cupom.id, pedido_id: pedido.id, cliente_id: idCliente,
        }).execute()
      }
      return r
    })

    const [a, b] = await Promise.all([rodar(), rodar()])
    const aceitos = [a, b].filter((r) => r.ok).length
    expect(aceitos).toBe(1)
  })
})
```

O `beforeEach` precisa semear: `MARIA10` (percentual 10, representante ativo), `EXPIRADO` (`expira_em` no passado), `DESLIGADO` (representante com `ativo = false`), `LIMITE1` (`limite_total = 1`), mais um cliente e um pedido para o teste de limite por cliente.

- [ ] **Step 4: Rodar e confirmar que falha, depois implementar o repositório**

```ts
// src/repositories/cupons.ts
import { sql, type Transaction } from 'kysely'
import type { DB } from '@/lib/db-types'
import { calcularDesconto, type ResultadoCupom } from '@/lib/cupom'
import type { Centavos } from '@/lib/money'

/**
 * Resgata um cupom DENTRO da transacao que cria o pedido.
 *
 * A linha do cupom e travada com SELECT ... FOR UPDATE antes de contar os
 * usos. Sem isso, dois checkouts simultaneos leem a mesma contagem, os dois
 * passam, e o limite estoura — o modo de falha classico de cupom, e o unico
 * caminho pelo qual um desconto e concedido alem do autorizado.
 *
 * Recebe a transacao em vez de abrir a propria: o resgate e a criacao do
 * pedido tem que ser atomicos. Cupom debitado sem pedido, ou pedido com
 * desconto sem uso registrado, sao os dois corrupcao de dados.
 */
export async function resgatarCupom(
  codigo: string,
  subtotal: Centavos,
  clienteId: string,
  trx: Transaction<DB>,
  agora: Date = new Date(),
): Promise<ResultadoCupom> {
  const cupom = await trx.selectFrom('cupons')
    .selectAll()
    .where('codigo', '=', codigo.trim().toUpperCase())
    .forUpdate()
    .executeTakeFirst()

  if (!cupom) return { ok: false, motivo: 'inexistente' }
  if (!cupom.ativo) return { ok: false, motivo: 'inativo' }
  if (agora < cupom.inicia_em) return { ok: false, motivo: 'nao_iniciado' }
  if (cupom.expira_em && agora >= cupom.expira_em) return { ok: false, motivo: 'expirado' }

  if (cupom.representante_id) {
    const rep = await trx.selectFrom('representantes')
      .select('id')
      .where('id', '=', cupom.representante_id)
      .where('ativo', '=', true)
      .executeTakeFirst()
    if (!rep) return { ok: false, motivo: 'representante_inativo' }
  }

  if (cupom.limite_total !== null) {
    const { total } = await trx.selectFrom('cupom_usos')
      .select(sql<number>`count(*)::int`.as('total'))
      .where('cupom_id', '=', cupom.id)
      .executeTakeFirstOrThrow()
    if (total >= cupom.limite_total) return { ok: false, motivo: 'esgotado' }
  }

  const { doCliente } = await trx.selectFrom('cupom_usos')
    .select(sql<number>`count(*)::int`.as('doCliente'))
    .where('cupom_id', '=', cupom.id)
    .where('cliente_id', '=', clienteId)
    .executeTakeFirstOrThrow()
  if (doCliente >= cupom.limite_por_cliente) {
    return { ok: false, motivo: 'limite_do_cliente' }
  }

  return {
    ok: true,
    cupom: {
      id: cupom.id,
      codigo: cupom.codigo,
      desconto: calcularDesconto(cupom.tipo, cupom.valor, subtotal),
      representanteId: cupom.representante_id,
    },
  }
}
```

- [ ] **Step 5: Rodar, confirmar verde e commitar**

```bash
npm test && npm run typecheck
git add src/lib/cupom.ts src/repositories/cupons.ts src/lib/__tests__/ src/repositories/__tests__/
git commit -m "Redeem coupons under a row lock so usage limits hold under concurrency"
```

---

## Task 6: Montagem do pedido e a hierarquia de atribuição

**Files:**
- Create: `src/lib/montar-pedido.ts`
- Test: `src/lib/__tests__/montar-pedido.test.ts`

**Interfaces:**
- Consumes: `AtribuicaoDoPedido`, `resolverAtribuicaoDoPedido`, `CupomValido`, `EntradaPedido`, `ResumoCarrinho`
- Produces: `aplicarPrioridadeDoCupom(atribuicao, cupom, buscarPercentual): Promise<AtribuicaoDoPedido>`

- [ ] **Step 1: Escrever os testes**

Esta é a regra que dez pessoas vão contestar. Ela precisa de teste antes de existir.

```ts
// src/lib/__tests__/montar-pedido.test.ts
import { describe, it, expect } from 'vitest'
import { aplicarPrioridadeDoCupom } from '@/lib/montar-pedido'
import type { AtribuicaoDoPedido } from '@/lib/resolver-pedido'

const DA_CASA: Readonly<AtribuicaoDoPedido> = {
  origem: 'casa', representanteId: null, percentualComissao: null,
  utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
}
const DA_MARIA: Readonly<AtribuicaoDoPedido> = {
  origem: 'link', representanteId: 'id-maria', percentualComissao: 20,
  utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
}
const percentualDe = async (id: string) => (id === 'id-joao' ? 15 : 20)

describe('prioridade do cupom sobre o last click', () => {
  it('sem cupom, a atribuicao do cookie passa intacta', async () => {
    const r = await aplicarPrioridadeDoCupom(DA_MARIA, null, percentualDe)
    expect(r).toEqual(DA_MARIA)
  })

  it('cupom do Joao vence o cookie da Maria', async () => {
    const r = await aplicarPrioridadeDoCupom(
      DA_MARIA, { id: 'c1', codigo: 'JOAO10', desconto: 0 as never, representanteId: 'id-joao' },
      percentualDe,
    )
    expect(r.origem).toBe('cupom')
    expect(r.representanteId).toBe('id-joao')
    expect(r.percentualComissao).toBe(15)
  })

  it('cupom da casa nao rouba a venda da Maria', async () => {
    const r = await aplicarPrioridadeDoCupom(
      DA_MARIA, { id: 'c2', codigo: 'BLACKFRIDAY', desconto: 0 as never, representanteId: null },
      percentualDe,
    )
    expect(r.origem).toBe('link')
    expect(r.representanteId).toBe('id-maria')
  })

  it('cupom do Joao sobre venda da casa atribui ao Joao', async () => {
    const r = await aplicarPrioridadeDoCupom(
      DA_CASA, { id: 'c1', codigo: 'JOAO10', desconto: 0 as never, representanteId: 'id-joao' },
      percentualDe,
    )
    expect(r.origem).toBe('cupom')
    expect(r.representanteId).toBe('id-joao')
  })

  it('os UTM da visita sobrevivem a troca de atribuicao', async () => {
    const r = await aplicarPrioridadeDoCupom(
      DA_MARIA, { id: 'c1', codigo: 'JOAO10', desconto: 0 as never, representanteId: 'id-joao' },
      percentualDe,
    )
    expect(r.utmSource).toBe('instagram')
    expect(r.utmCampaign).toBe('lancamento')
  })

  it('NAO muta a atribuicao recebida', async () => {
    const antes = { ...DA_MARIA }
    await aplicarPrioridadeDoCupom(
      DA_MARIA, { id: 'c1', codigo: 'JOAO10', desconto: 0 as never, representanteId: 'id-joao' },
      percentualDe,
    )
    expect(DA_MARIA).toEqual(antes)
  })

  it('cada chamada devolve um objeto novo', async () => {
    const a = await aplicarPrioridadeDoCupom(DA_CASA, null, percentualDe)
    const b = await aplicarPrioridadeDoCupom(DA_CASA, null, percentualDe)
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha, depois implementar**

```ts
// src/lib/montar-pedido.ts
import type { AtribuicaoDoPedido } from '@/lib/resolver-pedido'
import type { CupomValido } from '@/lib/cupom'

/**
 * HIERARQUIA DE ATRIBUICAO: cupom > last click > first click.
 *
 * O cookie ja resolveu o last click (resolverAtribuicaoDoPedido). Aqui o
 * cupom tem a ultima palavra, e apenas quando ele pertence a um
 * representante: um cupom da casa (BLACKFRIDAY) e promocao da marca e nao
 * pode roubar a venda de quem trouxe o cliente.
 *
 * Por que o cupom vence: e a acao mais deliberada do comprador. Ele digitou
 * o codigo daquela pessoa. O cookie pode ter 29 dias e vir de um clique
 * esquecido; o cupom foi digitado agora, na hora de pagar.
 *
 * O percentual vem do banco, nunca do cupom nem do cookie — mesmo motivo do
 * resolver: cadastro muda, e o pedido tem que valer o percentual de hoje.
 *
 * Devolve sempre um objeto novo. Mutar o recebido corromperia a atribuicao
 * de todos os pedidos seguintes do mesmo processo.
 */
export async function aplicarPrioridadeDoCupom(
  atribuicao: Readonly<AtribuicaoDoPedido>,
  cupom: CupomValido | null,
  buscarPercentual: (representanteId: string) => Promise<number>,
): Promise<AtribuicaoDoPedido> {
  if (!cupom || !cupom.representanteId) {
    return { ...atribuicao }
  }

  return {
    ...atribuicao,
    origem: 'cupom',
    representanteId: cupom.representanteId,
    percentualComissao: await buscarPercentual(cupom.representanteId),
  }
}
```

- [ ] **Step 3: Rodar, confirmar verde e commitar**

```bash
npm test -- montar-pedido.test && npm run typecheck
git add src/lib/montar-pedido.ts src/lib/__tests__/montar-pedido.test.ts
git commit -m "Give a representative's coupon priority over the last-click cookie"
```

---

## Task 7: Semear o kit real

**Files:**
- Create: `migrations/1755000300000_seed_kit.sql`
- Test: `src/repositories/__tests__/produtos.test.ts` *(estender)*

**Interfaces:**
- Consumes: tabela `kits`
- Produces: um kit ativo, slug `kit-milagran`, `preco_centavos = 100000`

- [ ] **Step 1: Escrever a migration de semeadura**

```sql
-- migrations/1755000300000_seed_kit.sql
-- Up Migration
--
-- Preco definido pelo cliente em 12/08/2026: R$ 1.000,00 por kit, linear
-- por quantidade (3 kits = R$ 3.000,00, sem desconto por volume).
--
-- anvisa_registro fica NULL de proposito. O numero real ainda nao foi
-- fornecido, e a pagina do produto mostra "em breve" enquanto for NULL.
-- Cosmetico sem regularizacao exibida nao pode ser vendido no Brasil: isto
-- e divida visivel, nao um campo esquecido.
INSERT INTO kits (slug, nome, descricao, preco_centavos, unidades, sku, anvisa_registro, ativo, ordem)
VALUES (
  'kit-milagran',
  'Kit Milagran',
  'Kit de limpeza de pele instantanea.',
  100000,
  1,
  'MG-KIT-001',
  NULL,
  true,
  1
)
ON CONFLICT (slug) DO NOTHING;

-- Down Migration
DELETE FROM kits WHERE slug = 'kit-milagran';
```

- [ ] **Step 2: Migrar e verificar**

```bash
npm run db:migrate
docker compose exec -T db psql -U milagran -d milagran -c "SELECT slug, preco_centavos, anvisa_registro FROM kits;"
```

Esperado: uma linha, `100000`, `anvisa_registro` nulo.

- [ ] **Step 3: Acrescentar o teste**

```ts
// acrescentar em src/repositories/__tests__/produtos.test.ts
describe('kit de producao', () => {
  it('existe um kit ativo a R$ 1.000,00', async () => {
    const kit = await buscarKitAtivoPorSlug('kit-milagran')
    expect(kit).not.toBeNull()
    expect(kit!.precoCentavos).toBe(100000)
    expect(formatarBRL(kit!.precoCentavos)).toBe('R$ 1.000,00')
  })

  it('o registro ANVISA ainda nao foi preenchido — divida conhecida', async () => {
    const kit = await buscarKitAtivoPorSlug('kit-milagran')
    expect(kit!.anvisaRegistro).toBeNull()
  })
})
```

O segundo teste falha no dia em que o número for preenchido. Isso é intencional: ele é o lembrete executável de que a dívida existe, e quem preencher o número vai apagá-lo conscientemente.

> **Atenção do `beforeEach`:** `produtos.test.ts` limpa a tabela `kits`. Restrinja essa limpeza aos slugs de teste (`kit-1`, `kit-3`, `kit-antigo`), senão a semeadura é apagada e este teste falha de forma intermitente. Isso já estava na lista de pendências carregadas.

- [ ] **Step 4: Rodar, confirmar verde e commitar**

```bash
npm test && npm run typecheck
git add migrations/ src/repositories/__tests__/produtos.test.ts
git commit -m "Seed the production kit at R$ 1,000.00 with ANVISA pending"
```

---

## Task 8: Vitrine

**Files:**
- Create: `src/components/vitrine.tsx`, `src/app/comprar/page.tsx`
- Modify: `src/app/r/[slug]/page.tsx`
- Test: `src/components/__tests__/vitrine.test.tsx`

**Interfaces:**
- Consumes: `listarKitsAtivos`, `montarCarrinho`, `formatarBRL`, `QUANTIDADE_MAXIMA`
- Produces: `<Vitrine kits={...} representante={...} />`

- [ ] **Step 1: Instalar o ambiente de teste de componente**

```bash
npm i -D @testing-library/react @testing-library/user-event jsdom
```

Acrescentar ao `vitest.config.ts` um segundo projeto com `environment: 'jsdom'` para `src/**/__tests__/**/*.test.tsx`, mantendo `node` para os `.test.ts`. Os testes de banco continuam em `node`.

- [ ] **Step 2: Escrever os testes**

```tsx
// src/components/__tests__/vitrine.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Vitrine } from '@/components/vitrine'

const KITS = [{
  id: 'k1', slug: 'kit-milagran', nome: 'Kit Milagran',
  descricao: 'Kit de limpeza de pele instantanea.',
  precoCentavos: 100000 as never, unidades: 1, sku: 'MG-KIT-001',
  anvisaRegistro: null, ativo: true, ordem: 1,
}]

describe('Vitrine', () => {
  it('mostra o preco formatado em reais', () => {
    render(<Vitrine kits={KITS} representante={null} />)
    expect(screen.getByText('R$ 1.000,00')).toBeDefined()
  })

  it('recalcula o total ao aumentar a quantidade', async () => {
    render(<Vitrine kits={KITS} representante={null} />)
    await userEvent.click(screen.getByRole('button', { name: /aumentar/i }))
    await userEvent.click(screen.getByRole('button', { name: /aumentar/i }))
    expect(screen.getByTestId('total')).toHaveTextContent('R$ 3.000,00')
  })

  it('nao deixa a quantidade cair abaixo de 1', async () => {
    render(<Vitrine kits={KITS} representante={null} />)
    await userEvent.click(screen.getByRole('button', { name: /diminuir/i }))
    expect(screen.getByTestId('quantidade')).toHaveTextContent('1')
  })

  it('mostra "a definir" no frete, nunca R$ 0,00', () => {
    render(<Vitrine kits={KITS} representante={null} />)
    const frete = screen.getByTestId('frete')
    expect(frete).toHaveTextContent(/a definir/i)
    expect(frete).not.toHaveTextContent('R$ 0,00')
  })

  it('avisa que o registro ANVISA esta em breve quando nao ha numero', () => {
    render(<Vitrine kits={KITS} representante={null} />)
    expect(screen.getByTestId('anvisa')).toHaveTextContent(/em breve/i)
  })

  it('mostra o numero ANVISA quando ele existe', () => {
    render(<Vitrine kits={[{ ...KITS[0]!, anvisaRegistro: '25351.000123/2026-01' }]} representante={null} />)
    expect(screen.getByTestId('anvisa')).toHaveTextContent('25351.000123/2026-01')
  })

  it('identifica o representante quando a vitrine e dele', () => {
    render(<Vitrine kits={KITS} representante={{ nome: 'Maria', slug: 'maria' }} />)
    expect(screen.getByText(/Maria/)).toBeDefined()
  })
})
```

- [ ] **Step 3: Rodar, confirmar que falha, implementar o componente**

O componente é um Client Component (`'use client'`) com estado de quantidade e campo de cupom. Estrutura mínima exigida pelos testes:

```tsx
// src/components/vitrine.tsx
'use client'
import { useState } from 'react'
import type { Kit } from '@/repositories/produtos'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { formatarBRL } from '@/lib/money'

export function Vitrine({
  kits, representante,
}: { kits: Kit[]; representante: { nome: string; slug: string } | null }) {
  const kit = kits[0]
  const [quantidade, setQuantidade] = useState(1)
  if (!kit) return <p>Nenhum kit disponivel no momento.</p>

  const resumo = montarCarrinho([{
    kitId: kit.id, nome: kit.nome,
    precoUnitario: kit.precoCentavos, quantidade,
  }])

  return (
    <section className="section">
      {representante && <p className="kicker">Representante oficial: {representante.nome}</p>}
      <h1>{kit.nome}</h1>
      <p>{kit.descricao}</p>
      <p data-testid="preco-unitario">{formatarBRL(kit.precoCentavos)}</p>

      <div>
        <button type="button" aria-label="Diminuir quantidade"
          onClick={() => setQuantidade((q) => Math.max(1, q - 1))}>−</button>
        <span data-testid="quantidade">{quantidade}</span>
        <button type="button" aria-label="Aumentar quantidade"
          onClick={() => setQuantidade((q) => Math.min(QUANTIDADE_MAXIMA, q + 1))}>+</button>
      </div>

      <dl>
        <dt>Subtotal</dt><dd data-testid="subtotal">{formatarBRL(resumo.subtotal)}</dd>
        <dt>Frete</dt>
        <dd data-testid="frete">
          {resumo.freteADefinir ? 'A definir — em breve' : formatarBRL(resumo.frete)}
        </dd>
        <dt>Total</dt><dd data-testid="total">{formatarBRL(resumo.total)}</dd>
      </dl>

      <p data-testid="anvisa">
        {kit.anvisaRegistro
          ? `Registro ANVISA ${kit.anvisaRegistro}`
          : 'Registro ANVISA: em breve'}
      </p>

      <a href={`/checkout?kit=${kit.slug}&q=${quantidade}`}>Continuar</a>
    </section>
  )
}
```

- [ ] **Step 4: Ligar as duas rotas**

`src/app/comprar/page.tsx` é um Server Component que chama `listarKitsAtivos()` e renderiza `<Vitrine kits={kits} representante={null} />`.

`src/app/r/[slug]/page.tsx` mantém toda a lógica de atribuição que já tem e troca a listagem atual por `<Vitrine kits={kits} representante={{ nome: representante.nome, slug: representante.slug }} />`.

- [ ] **Step 5: Rodar tudo e commitar**

```bash
npm test && npm run typecheck && npm run build
git add src/components/ src/app/comprar/ src/app/r/ vitest.config.ts package.json package-lock.json
git commit -m "Add storefront with quantity selector and pending shipping notice"
```

---

## Task 9: Checkout e criação do pedido

**Files:**
- Create: `src/app/checkout/page.tsx`, `src/app/api/pedidos/route.ts`, `src/app/pedido/[numero]/page.tsx`
- Test: `src/app/api/__tests__/pedidos-route.test.ts`

**Interfaces:**
- Consumes: tudo das tarefas anteriores
- Produces: `POST /api/pedidos` → `{ numero: number }`; página de confirmação

- [ ] **Step 1: Escrever os testes do endpoint**

```ts
// src/app/api/__tests__/pedidos-route.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getDb, closeDb } from '@/lib/db'
import { POST } from '@/app/api/pedidos/route'
import { assinarAtribuicao } from '@/lib/atribuicao'

const SEGREDO = 'a'.repeat(64)
const COMPRADOR = {
  nome: 'Ana Souza', email: 'ana.checkout@exemplo.com',
  cpf: '12345678901', whatsapp: '11988887777',
  cep: '01310100', rua: 'Av Paulista', numero: '1000',
  complemento: '', bairro: 'Bela Vista', cidade: 'Sao Paulo', estado: 'SP',
}

function requisicao(body: unknown, cookie?: string) {
  return new Request('http://localhost/api/pedidos', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie: `__Host-mg_attr=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/pedidos', () => {
  beforeEach(semear)
  afterAll(async () => { await closeDb() })

  it('cria o pedido e devolve o numero', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 2, ...COMPRADOR }))
    expect(r.status).toBe(201)
    const body = await r.json()
    expect(typeof body.numero).toBe('number')
  })

  it('DINHEIRO: o preco vem do banco, nunca do corpo da requisicao', async () => {
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1,
      precoUnitarioCentavos: 1, total: 1, // tentativa de manipulacao
      ...COMPRADOR,
    }))
    const { numero } = await r.json()
    const pedido = await getDb().selectFrom('pedidos').selectAll()
      .where('numero', '=', numero).executeTakeFirstOrThrow()
    expect(pedido.subtotal_centavos).toBe(100000)
    expect(pedido.total_centavos).toBe(100000)
  })

  it('DINHEIRO: a venda pelo link da Maria e atribuida a ela', async () => {
    const cookie = assinarAtribuicao({
      slug: 'maria', em: Date.now(),
      utmSource: 'instagram', utmMedium: 'bio', utmCampaign: 'lancamento',
    }, SEGREDO)
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR }, cookie))
    const { numero } = await r.json()
    const pedido = await getDb().selectFrom('pedidos').selectAll()
      .where('numero', '=', numero).executeTakeFirstOrThrow()
    expect(pedido.origem).toBe('link')
    expect(pedido.representante_id).toBe(idMaria)
    expect(pedido.utm_source).toBe('instagram')
  })

  it('sem cookie, a venda e da casa', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1, ...COMPRADOR }))
    const { numero } = await r.json()
    const pedido = await getDb().selectFrom('pedidos').select('origem')
      .where('numero', '=', numero).executeTakeFirstOrThrow()
    expect(pedido.origem).toBe('casa')
  })

  it('cupom aplicado desconta e registra o uso', async () => {
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1, cupom: 'MARIA10', ...COMPRADOR,
    }))
    const { numero } = await r.json()
    const pedido = await getDb().selectFrom('pedidos').selectAll()
      .where('numero', '=', numero).executeTakeFirstOrThrow()
    expect(pedido.desconto_centavos).toBe(10000)
    expect(pedido.total_centavos).toBe(90000)
    const usos = await getDb().selectFrom('cupom_usos').selectAll()
      .where('pedido_id', '=', pedido.id).execute()
    expect(usos).toHaveLength(1)
  })

  it('cupom invalido devolve 422 e NAO cria pedido', async () => {
    const antes = await contarPedidos()
    const r = await POST(requisicao({
      kitSlug: 'kit-milagran', quantidade: 1, cupom: 'NAOEXISTE', ...COMPRADOR,
    }))
    expect(r.status).toBe(422)
    expect(await contarPedidos()).toBe(antes)
  })

  it('rejeita quantidade acima do teto', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 999, ...COMPRADOR }))
    expect(r.status).toBe(422)
  })

  it('rejeita corpo sem os campos do comprador', async () => {
    const r = await POST(requisicao({ kitSlug: 'kit-milagran', quantidade: 1 }))
    expect(r.status).toBe(422)
  })
})
```

- [ ] **Step 2: Rodar, confirmar que falha, implementar o endpoint**

O handler valida o corpo com Zod, **lê o preço do banco** (nunca do corpo), resolve a atribuição pelo cookie, e faz tudo numa transação: cliente, endereço, cupom sob trava, pedido, itens, uso do cupom.

```ts
// src/app/api/pedidos/route.ts
import { z } from 'zod'
import { getDb } from '@/lib/db'
import { buscarKitAtivoPorSlug } from '@/repositories/produtos'
import { salvarClienteComEndereco } from '@/repositories/clientes'
import { resgatarCupom } from '@/repositories/cupons'
import { resolverAtribuicaoDoPedido } from '@/lib/resolver-pedido'
import { aplicarPrioridadeDoCupom } from '@/lib/montar-pedido'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { segredoDeAtribuicao, NOME_COOKIE_ATRIBUICAO } from '@/lib/atribuicao'
import { mensagemDeRecusa } from '@/lib/cupom'
import { deInteiro } from '@/lib/money'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Corpo = z.object({
  kitSlug: z.string().min(1),
  quantidade: z.number().int().min(1).max(QUANTIDADE_MAXIMA),
  cupom: z.string().trim().min(3).max(24).optional(),
  nome: z.string().trim().min(3),
  email: z.string().email(),
  cpf: z.string().regex(/^\d{11}$/),
  whatsapp: z.string().regex(/^\d{10,13}$/),
  cep: z.string().regex(/^\d{8}$/),
  rua: z.string().trim().min(1),
  numero: z.string().trim().min(1),
  complemento: z.string().trim().default(''),
  bairro: z.string().trim().min(1),
  cidade: z.string().trim().min(1),
  estado: z.string().regex(/^[A-Z]{2}$/),
})

export async function POST(req: Request) {
  const parsed = Corpo.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'dados_invalidos' }, { status: 422 })
  }
  const d = parsed.data

  const kit = await buscarKitAtivoPorSlug(d.kitSlug)
  if (!kit) return Response.json({ error: 'kit_indisponivel' }, { status: 422 })

  // O preco vem do catalogo. Nada no corpo da requisicao influencia dinheiro.
  const carrinho = montarCarrinho([{
    kitId: kit.id, nome: kit.nome,
    precoUnitario: kit.precoCentavos, quantidade: d.quantidade,
  }])

  const segredo = segredoDeAtribuicao()
  const cookie = req.headers.get('cookie')
    ?.split('; ').find((c) => c.startsWith(`${NOME_COOKIE_ATRIBUICAO}=`))
    ?.slice(NOME_COOKIE_ATRIBUICAO.length + 1) ?? null
  const doCookie = await resolverAtribuicaoDoPedido(cookie, segredo)

  try {
    const numero = await getDb().transaction().execute(async (trx) => {
      const { clienteId, enderecoId } = await salvarClienteComEndereco(d, d)

      let desconto = deInteiro(0)
      let cupomId: string | null = null
      let atribuicao = doCookie

      if (d.cupom) {
        const r = await resgatarCupom(d.cupom, carrinho.subtotal, clienteId, trx)
        if (!r.ok) throw new RecusaDeCupom(r.motivo)
        desconto = r.cupom.desconto
        cupomId = r.cupom.id
        atribuicao = await aplicarPrioridadeDoCupom(doCookie, r.cupom, percentualDoRepresentante(trx))
      }

      // criarPedido, os itens e o uso do cupom, todos em trx.
      // ... ver Step 3
      return numeroDoPedido
    })
    return Response.json({ numero }, { status: 201 })
  } catch (e) {
    if (e instanceof RecusaDeCupom) {
      return Response.json({ error: 'cupom_recusado', mensagem: mensagemDeRecusa(e.motivo) }, { status: 422 })
    }
    throw e
  }
}
```

- [ ] **Step 3: Fazer `criarPedido` aceitar uma transação externa**

Adicione um parâmetro opcional `trx?: Transaction<DB>` a `criarPedido`: quando presente, usa-a em vez de abrir a própria. Sem isso, o cupom e o pedido ficam em transações diferentes e um pode existir sem o outro. Grave também `cliente_id`, `endereco_id` e `cupom_id` no pedido, e insira `cupom_usos` na mesma transação.

- [ ] **Step 4: Checkout de 4 etapas e confirmação**

`src/app/checkout/page.tsx` é um Client Component com quatro passos — produto e quantidade, dados pessoais, endereço, revisão — mantendo estado local e fazendo um único `POST /api/pedidos` no fim. A revisão mostra "Frete: a definir — em breve". No sucesso, navega para `/pedido/<numero>`.

`src/app/pedido/[numero]/page.tsx` é um Server Component que lê o pedido e seus itens, mostra o número, os itens, os valores e o aviso de que o pagamento é o próximo passo — o gateway é o Plano 3.

- [ ] **Step 5: Rodar tudo e commitar**

```bash
npm test && npm run typecheck && npm run build
git add src/app/
git commit -m "Create orders from checkout with server-side pricing and attribution"
```

---

## Auto-revisão

**Cobertura contra a spec:**

| Item da spec | Tarefa |
|---|---|
| 1 — seletor de quantidade com preço recalculado | 3, 8 |
| 1 — campo de cupom com validação | 5, 9 |
| 1 — resumo do pedido | 3, 8 |
| 2 — checkout com dados do comprador e endereço | 2, 9 |
| 2 — recálculo de Produto/Quantidade/Subtotal/Desconto/Frete/Total | 3 |
| 5 — pedido vinculado ao representante de origem | 6, 9 |
| 7 — cupom com código, tipo, valor, datas, limites, status, representante | 4 |
| 14 — regra de conflito entre representantes | 6 |
| 15 — checkout em 4 etapas | 9 |
| 30 — cadastro de produto com preço e SKU | 7 |
| 32 — `order_items`, `customers`, `addresses`, `coupons`, `coupon_usages` | 1, 2, 4 |

**Lacunas deliberadas:** pagamento, webhook e máquina de estados são o Plano 3; o pedido nasce `pendente`. Frete e número ANVISA são dívida visível na interface, por decisão do cliente. Estoque continua fora — não há reserva nem baixa.

**Consistência de tipos:** `Centavos` (Plano 1) atravessa `carrinho.ts`, `cupom.ts` e `pedidos.ts`. `AtribuicaoDoPedido` sai do resolver (Plano 1) e é transformado em `montar-pedido.ts` sem mutação. `CupomValido` é definido na Tarefa 5 e consumido na 6 e na 9. `EntradaPedido` muda na Tarefa 1 e todas as chamadas posteriores usam a forma nova.

---

## Dependências fora do código

- **`DIRECT_URL` não existe no serviço da VPS.** Este plano adiciona quatro migrations e o `db:migrate` lê essa variável. **A primeira migration falha em produção enquanto isso não for configurado.**
- **Conta no Mercado Pago** — não bloqueia este plano, bloqueia o Plano 3 inteiro. KYC de CNPJ novo leva dias úteis.
- **Custo unitário do kit** — a R$ 1.000,00 com até 20% de comissão e ~4% de gateway, são R$ 240 antes do custo do produto, frete e tributo. A conta de margem continua sem resposta.
- **Política de frete e número ANVISA** — os dois "em breve" deste plano.
