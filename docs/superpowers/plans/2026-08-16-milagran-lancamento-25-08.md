# Plano 4 — Loja de lancamento Milagran (evento 25/08/2026)

Origem: documento de requisitos do cliente recebido em 16/08/2026 (secoes §1..§18
citadas ao longo deste plano).

Este plano REESCREVE decisoes dos Planos 1-3 onde o documento novo diverge. Cada
divergencia esta marcada como CONFLITO e diz o que era antes.

## Decisoes tomadas pelo cliente em 16/08/2026

1. **Autenticacao**: tabela `usuarios` com hash de senha + `sessoes` em cookie
   assinado. Cada vendedor tem login proprio, entao a venda fica rastreada por
   vendedor (`pedidos.vendedor_id`).
2. **Frete**: API do Clube Envios (`https://apis.clubeenvios.com.br`).
3. **Estoque online**: SEM teto rigido. A unidade e baixada no PAGAMENTO, nunca
   na criacao do pedido — carrinho abandonado nao segura estoque.
   O estoque presencial TEM teto rigido de 50.
4. **Pagamento presencial**: PIX/cartao pelo mesmo Mercado Pago, confirmado por
   webhook. Nao existe venda "declarada" pelo vendedor sem confirmacao do
   provedor.

## Premissas que precisam de confirmacao antes de 25/08

Estao implementadas com valor visivel e marcadas no codigo. Nenhuma inventa
dinheiro em silencio.

- **Peso e dimensoes do kit**: nao existiam no cadastro. Semeados em
  `1755300600000_kit_dimensoes.sql` com valores explicitos e comentario dizendo
  que precisam ser conferidos com a expedicao. Peso/dimensao errados = frete
  errado = prejuizo por pedido.
- **CEP de origem da expedicao**: variavel `CEP_ORIGEM_EXPEDICAO`. Sem ela nao
  ha cotacao — a rota devolve erro legivel, nunca frete zero.
- **Token e cliente_id do Clube Envios**: `CLUBE_ENVIOS_TOKEN` e
  `CLUBE_ENVIOS_CLIENTE_ID`.
- **Registro ANVISA**: continua NULL. Divida legal ja visivel na vitrine.

---

# 1. Migrations (bloco 1755300000000)

Convencoes obrigatorias (ver `docs/.../2026-08-12-*.md` e as migrations
existentes): SQL cru; primeira linha e um comentario com o proprio caminho do
arquivo; sentinelas `-- Up Migration` / `-- Down Migration`; Down real e
funcional; constraints sempre nomeadas; identificadores em portugues sem acento;
comentario longo explicando POR QUE e o que quebra.

## 1755300000000_canal_e_estoque.sql

```sql
CREATE TYPE canal_venda AS ENUM ('presencial', 'online');
CREATE TYPE movimento_estoque AS ENUM ('entrada', 'baixa', 'estorno', 'ajuste');

CREATE TABLE estoques (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kit_id        uuid NOT NULL REFERENCES kits (id) ON DELETE RESTRICT,
  canal         canal_venda NOT NULL,
  -- true = pre-venda sem teto (canal online, decisao do cliente em 16/08).
  -- Quando true, baixarEstoque NAO recusa por saldo: registra o movimento
  -- para o painel e segue. Quando false, o saldo e teto rigido.
  ilimitado     boolean NOT NULL DEFAULT false,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX estoque_kit_canal_unico ON estoques (kit_id, canal);
-- trigger estoques_atualizado_em_trg no molde de kits_tocar_atualizado_em

CREATE TABLE estoque_movimentos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estoque_id  uuid NOT NULL REFERENCES estoques (id) ON DELETE RESTRICT,
  pedido_id   uuid REFERENCES pedidos (id) ON DELETE RESTRICT,
  tipo        movimento_estoque NOT NULL,
  -- ASSINADO. entrada/estorno/ajuste positivo sobe, baixa e sempre negativo.
  -- SEM coluna de saldo: o saldo e SUM(quantidade), igual ao livro-razao de
  -- comissao (migrations/1755200100000_comissoes.sql). Corrigir = lancar o
  -- oposto, nunca editar a linha.
  quantidade  integer NOT NULL,
  motivo      text NOT NULL DEFAULT '',
  criado_em   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT movimento_quantidade_nao_zero CHECK (quantidade <> 0),
  CONSTRAINT movimento_baixa_negativa CHECK (
    (tipo = 'baixa' AND quantidade < 0) OR (tipo <> 'baixa' AND quantidade <> 0)
  ),
  CONSTRAINT movimento_entrada_positiva CHECK (
    tipo <> 'entrada' OR quantidade > 0
  ),
  CONSTRAINT movimento_estorno_positivo CHECK (
    tipo <> 'estorno' OR quantidade > 0
  ),
  -- baixa e estorno SEMPRE pertencem a um pedido; entrada e ajuste nunca.
  CONSTRAINT movimento_pedido_coerente CHECK (
    (tipo IN ('baixa', 'estorno') AND pedido_id IS NOT NULL)
    OR
    (tipo IN ('entrada', 'ajuste') AND pedido_id IS NULL)
  )
);

CREATE INDEX estoque_movimentos_estoque ON estoque_movimentos (estoque_id);
-- IDEMPOTENCIA NO BANCO, nao na aplicacao: o Mercado Pago reenvia a mesma
-- notificacao ate receber 2xx. Sem estes dois indices, cada reenvio de um
-- "approved" baixaria uma unidade a mais do mesmo pedido.
CREATE UNIQUE INDEX estoque_baixa_unica_por_pedido
  ON estoque_movimentos (estoque_id, pedido_id) WHERE tipo = 'baixa';
CREATE UNIQUE INDEX estoque_estorno_unico_por_pedido
  ON estoque_movimentos (estoque_id, pedido_id) WHERE tipo = 'estorno';

-- APPEND-ONLY, molde de comissoes: trigger BEFORE UPDATE OR DELETE que sempre
-- levanta excecao.
```

## 1755300100000_pedidos_canal_logistica.sql

```sql
-- CONFLITO com o Plano 1: `pedidos.origem` PARECE "origem da venda" (§17) mas
-- e ATRIBUICAO DE COMISSAO. O CHECK pedido_origem_coerente amarra cada valor a
-- presenca/ausencia de representante_id — acrescentar 'presencial' ali
-- quebraria a comissao. Canal e um eixo PROPRIO.
ALTER TABLE pedidos ADD COLUMN canal canal_venda NOT NULL DEFAULT 'online';
ALTER TABLE pedidos ADD COLUMN rastreio_codigo text;
ALTER TABLE pedidos ADD COLUMN rastreio_transportadora text;
ALTER TABLE pedidos ADD COLUMN enviado_em timestamptz;
ALTER TABLE pedidos ADD COLUMN prazo_dias_estimado smallint;

CONSTRAINT pedido_prazo_valido CHECK (prazo_dias_estimado IS NULL OR prazo_dias_estimado > 0)

-- NOT VALID de proposito: pedidos criados antes desta migration podem ter
-- endereco_id NULL, e uma constraint validada retroativamente falharia a
-- migration inteira em producao. Vale para toda linha NOVA, que e o que
-- importa daqui para frente.
ALTER TABLE pedidos ADD CONSTRAINT pedido_online_tem_endereco
  CHECK (canal = 'presencial' OR endereco_id IS NOT NULL) NOT VALID;
```

E `CREATE OR REPLACE FUNCTION pedido_impedir_alteracao_congelada()` acrescentando
`canal` a lista de colunas congeladas — canal e fato da venda, igual a origem.
`rastreio_*`, `enviado_em` e `prazo_dias_estimado` NAO sao congelados: a
logistica precisa escreve-los depois.

## 1755300200000_status_em_transito.sql

```sql
ALTER TYPE pedido_status ADD VALUE IF NOT EXISTS 'em_transito' AFTER 'enviado';
```
Migration SOZINHA. node-pg-migrate envolve a execucao em transacao e um valor
adicionado por `ALTER TYPE ADD VALUE` nao pode ser USADO na mesma execucao.
Down: Postgres nao remove valor de ENUM — escrever isso por extenso no Down em
vez de fingir que desfaz.

## 1755300300000_usuarios_sessoes.sql

```sql
CREATE TYPE papel_usuario AS ENUM ('admin', 'vendedor');

CREATE TABLE usuarios (
  id, nome text NOT NULL, email text NOT NULL,
  -- NUNCA a senha. Formato: scrypt$N$r$p$<salt b64>$<hash b64> (src/lib/senha.ts)
  senha_hash text NOT NULL,
  papel papel_usuario NOT NULL, ativo boolean NOT NULL DEFAULT true,
  criado_em, atualizado_em
);
CONSTRAINT usuario_email_formato CHECK (regex, mesmo de cliente_email_formato)
CREATE UNIQUE INDEX usuario_email_unico ON usuarios (lower(email));
-- trigger usuarios_atualizado_em_trg

CREATE TABLE sessoes (
  id uuid PK,
  usuario_id uuid NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  -- SO O HASH. O token cru vive apenas no cookie do navegador: um vazamento
  -- de backup do banco nao pode virar sessao ativa de administrador.
  token_hash text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL,
  revogada_em timestamptz,
  CONSTRAINT sessao_janela_coerente CHECK (expira_em > criado_em)
);
CREATE UNIQUE INDEX sessao_token_unico ON sessoes (token_hash);
CREATE INDEX sessoes_usuario ON sessoes (usuario_id);

ALTER TABLE pedidos ADD COLUMN vendedor_id uuid REFERENCES usuarios (id) ON DELETE RESTRICT;
ALTER TABLE pedidos ADD CONSTRAINT pedido_presencial_tem_vendedor
  CHECK (canal = 'online' OR vendedor_id IS NOT NULL) NOT VALID;
```
E `CREATE OR REPLACE FUNCTION pedido_impedir_alteracao_congelada()` de novo,
agora com `canal` E `vendedor_id` na lista. Reescrever a funcao INTEIRA (a
versao anterior nao e "estendida", e substituida) — o Down restaura a versao
da migration 1755300100000.

## 1755300400000_leads.sql

```sql
CREATE TYPE tipo_lead AS ENUM ('interessado', 'representante', 'distribuidor');

CREATE TABLE leads (
  id, tipo tipo_lead NOT NULL,
  nome text NOT NULL, email text NOT NULL, whatsapp text NOT NULL DEFAULT '',
  cidade text NOT NULL DEFAULT '', estado varchar(2) NOT NULL DEFAULT '',
  mensagem text NOT NULL DEFAULT '',
  -- LGPD: o formulario ja coletava o aceite, mas nada era gravado — o
  -- consentimento era incomprovavel. Agora tem carimbo de tempo.
  consentimento_lgpd boolean NOT NULL DEFAULT false,
  consentido_em timestamptz,
  origem text NOT NULL DEFAULT '',
  criado_em timestamptz NOT NULL DEFAULT now()
);
CONSTRAINT lead_email_formato CHECK (regex)
CONSTRAINT lead_uf_valida CHECK (estado = '' OR estado ~ '^[A-Z]{2}$')
CONSTRAINT lead_consentimento_coerente CHECK (
  (consentimento_lgpd = false AND consentido_em IS NULL)
  OR (consentimento_lgpd = true AND consentido_em IS NOT NULL)
)
CREATE INDEX leads_tipo_data ON leads (tipo, criado_em DESC);
```
COMPRADORES (§17) nao ficam aqui: sao derivados de `clientes` + `pedidos`. So os
tres tipos que nao compraram viram lead.

## 1755300500000_pagamentos_atualizado_em.sql

Trigger `pagamentos_atualizado_em_trg` no molde de `kits_tocar_atualizado_em`.
Corrige o desvio apontado na analise: `pagamentos` era a unica tabela com a
coluna e sem o trigger — justamente aquela onde "quando mudou" importa para
diagnostico, porque o webhook atualiza o status ao longo do ciclo de vida.

## 1755300600000_kit_dimensoes.sql

```sql
ALTER TABLE kits ADD COLUMN peso_gramas integer NOT NULL DEFAULT 500;
ALTER TABLE kits ADD COLUMN altura_cm smallint NOT NULL DEFAULT 12;
ALTER TABLE kits ADD COLUMN largura_cm smallint NOT NULL DEFAULT 16;
ALTER TABLE kits ADD COLUMN comprimento_cm smallint NOT NULL DEFAULT 20;
-- CHECKs de positividade em todas.
```
Os DEFAULTs sao PALPITE DECLARADO, nao medida. Comentario obrigatorio na
migration dizendo que precisam ser conferidos com a expedicao antes de 25/08 e
que frete errado sai do bolso da Milagran em todo pedido.

## 1755300700000_seed_estoque.sql

```sql
-- §2 e §4: 50 kits presenciais, teto rigido.
INSERT INTO estoques (kit_id, canal, ilimitado)
  SELECT id, 'presencial', false FROM kits WHERE slug = 'kit-milagran'
  ON CONFLICT (kit_id, canal) DO NOTHING;
INSERT INTO estoques (kit_id, canal, ilimitado)
  SELECT id, 'online', true FROM kits WHERE slug = 'kit-milagran'
  ON CONFLICT (kit_id, canal) DO NOTHING;

-- A entrada de 50 unidades e um MOVIMENTO, nao uma coluna de saldo.
INSERT INTO estoque_movimentos (estoque_id, tipo, quantidade, motivo)
  SELECT e.id, 'entrada', 50, 'Estoque de lancamento presencial 25/08/2026'
  FROM estoques e JOIN kits k ON k.id = e.kit_id
  WHERE k.slug = 'kit-milagran' AND e.canal = 'presencial'
  AND NOT EXISTS (SELECT 1 FROM estoque_movimentos m WHERE m.estoque_id = e.id AND m.tipo = 'entrada');
```
Canal online NAO recebe entrada: `ilimitado = true` e o saldo nao e teto.

---

# 2. src/lib/db-types.ts

Gerado por `kysely-codegen`, que exige banco vivo. Nao ha Postgres na maquina de
desenvolvimento onde este plano foi implementado, entao o arquivo foi editado A
MAO seguindo exatamente o formato do gerador (chaves em ordem alfabetica,
`Generated<T>` nas colunas com DEFAULT, `Timestamp`, `Numeric`).
**Rodar `npm run db:migrate && npm run db:types` e conferir o diff antes do
deploy.** O CI roda as migrations de verdade; uma divergencia entre este arquivo
e o banco aparece la como erro de typecheck ou de teste.

Tipos novos: `CanalVenda`, `MovimentoEstoque`, `PapelUsuario`, `TipoLead`.
`PedidoStatus` ganha `"em_transito"`.
Interfaces novas: `Estoques`, `EstoqueMovimentos`, `Usuarios`, `Sessoes`, `Leads`.
`Pedidos` ganha `canal`, `vendedor_id`, `rastreio_codigo`,
`rastreio_transportadora`, `enviado_em`, `prazo_dias_estimado`.
`Kits` ganha `peso_gramas`, `altura_cm`, `largura_cm`, `comprimento_cm`.

---

# 3. Contratos de src/lib (puros, sem banco)

## src/lib/senha.ts (NOVO)
```ts
export async function gerarHashDeSenha(senha: string): Promise<string>
export async function conferirSenha(senha: string, hash: string): Promise<boolean>
```
`node:crypto` scrypt, sem dependencia nova. Formato `scrypt$N$r$p$salt$hash`.
Comparacao com `timingSafeEqual`. `conferirSenha` devolve false (nunca lanca)
para hash malformado. Custo N=16384 — subir mais estoura os 3.8GB da VPS.

## src/lib/sessao.ts (NOVO)
```ts
export const NOME_COOKIE_SESSAO = '__Host-milagran_sessao'
export const DURACAO_SESSAO_MS: number  // 12h
export function gerarTokenDeSessao(): string        // 32 bytes, base64url
export function hashDoToken(token: string): string  // sha256 hex
export function cookieDeSessao(token: string, expiraEm: Date): string
export function cookieDeLogout(): string
export function tokenDoCookie(cabecalhoCookie: string | null): string | null
```
Prefixo `__Host-`: obriga Secure, Path=/ e proibe Domain — o mesmo motivo
documentado em `src/lib/atribuicao.ts`. `SameSite=Lax`, `HttpOnly`.
`tokenDoCookie` separa por `/;\s*/`, nunca por `'; '` (mesma armadilha ja
documentada em `src/app/api/pedidos/route.ts`).

## src/lib/escassez.ts (NOVO) — §5, §11
```ts
export const LIMIAR_POUCOS_KITS = 10
export const LIMIAR_ULTIMOS_KITS = 5
export type NivelEscassez = 'normal' | 'poucos' | 'ultimos' | 'esgotado'
export type AvisoEscassez = { nivel: NivelEscassez; mensagem: string }
export function avisoDeEscassez(disponivel: number, total: number): AvisoEscassez
```
Mensagens exatas do documento:
- `esgotado` (0): `Os ${total} kits disponiveis para compra presencial foram esgotados.`
- `ultimos` (1..5): `Ultimos ${disponivel} kits disponiveis para compra presencial.`
- `poucos` (6..10): `Restam apenas ${disponivel} kits disponiveis para levar hoje.`
- `normal`: `Apenas ${total} kits disponiveis para levar na hora.`
(com acentuacao completa nas strings — sao voltadas ao usuario)

## src/lib/tempo.ts (ESTENDER)
```ts
export const DATA_LANCAMENTO: Date          // 25/08/2026 00:00 America/Sao_Paulo
export function lancamentoJaOcorreu(agora?: Date): boolean
export const AVISO_PRE_VENDA: string
```
`AVISO_PRE_VENDA` = "Os pedidos online serao enviados apos o lancamento oficial
da Milagran, realizado em 25/08/2026." (§3, com acentos).
CONSTANTE NOMEADA, nao variavel de ambiente — convencao registrada no Plano 1
para janela de negocio. Testes congelam o relogio com `vi.setSystemTime`.

## src/lib/pedido-status.ts (ESTENDER)
`TRANSICOES` passa a ser:
```
pendente:             ['aguardando_pagamento', 'pago', 'cancelado'],
aguardando_pagamento: ['pago', 'pendente', 'cancelado'],
pago:                 ['em_preparacao', 'enviado', 'entregue', 'reembolsado'],
em_preparacao:        ['enviado', 'reembolsado'],
enviado:              ['em_transito', 'entregue', 'reembolsado'],
em_transito:          ['entregue', 'reembolsado'],
entregue:             ['reembolsado'],
cancelado: [], reembolsado: [],
```
CONFLITO com o Plano 3: `pago -> entregue` era proibido. §2 exige
"comprou → pagou → levou na hora": a venda presencial vai de `pago` direto a
`entregue`, sem separacao nem Correios. Comentar isso na tabela.
`geraEstornoDeComissao`: `em_transito` entra na lista de estados "estava pago".
NOVO:
```ts
export const ROTULOS_STATUS: Record<PedidoStatus, { titulo: string; descricao: string }>
```
Exatamente os sete rotulos de §12 mais `cancelado` e `reembolsado`. Ele
substitui o mapa `ROTULOS` local de `src/app/pedido/[token]/page.tsx` — verdade
compartilhada vira uma constante so, mesmo principio de `LinhaFrete`.

## src/lib/carrinho.ts (ESTENDER) — paga a divida documentada
```ts
export type ResumoCarrinho = { linhas; subtotal; desconto; frete: Centavos; total }
export function montarCarrinho(itens, desconto = deInteiro(0), frete = deInteiro(0)): ResumoCarrinho
```
`total = subtotal - desconto + frete`. Reescrever o comentario "SEM CAMPO DE
FRETE, de proposito" contando que a politica foi definida em 16/08 (Clube
Envios) e o campo passou a existir — ATUALIZAR o comentario de divida, nunca
apagar.

## src/lib/frete.ts (NOVO) — §13
Cliente do Clube Envios, no molde de `src/lib/mercadopago.ts`.
```ts
export class ClubeEnviosError extends Error { constructor(readonly status: number, readonly corpo: string) }
export class CotacaoIlegivelError extends Error { constructor(readonly chavesRecebidas: string[]) }
export class FreteNaoConfiguradoError extends Error {}

export type OpcaoDeFrete = {
  idServico: number
  idTransportadora: number | null
  transportadora: string
  valor: Centavos
  prazoDias: number
}
export type CotacaoDeFrete = { idCotacao: number | null; opcoes: OpcaoDeFrete[] }
export type VolumeDaCotacao = {
  alturaCm: number; larguraCm: number; comprimentoCm: number
  pesoGramas: number; quantidade: number
}
export async function cotarFrete(e: {
  cepDestino: string
  valorDeclarado: Centavos
  volumes: VolumeDaCotacao[]
}): Promise<CotacaoDeFrete>
export function opcaoMaisBarata(c: CotacaoDeFrete): OpcaoDeFrete | null
```
- BASE: `process.env.CLUBE_ENVIOS_BASE_URL ?? 'https://apis.clubeenvios.com.br'`
  (homologacao: `https://apishmg.clubeenvios.com.br`).
- Cabecalhos: `Authorization: <CLUBE_ENVIOS_TOKEN>` (sem `Bearer` — a
  documentacao usa o token cru) e `Content-Type: application/json`.
- Corpo de `POST /cotacao`, campos EXATOS da documentacao:
  `cliente_id`, `cep_origem`, `cep_destino`, `seguro_correios: 'N'`,
  `valor_declarado` (DECIMAL EM REAIS — unica conversao centavos→decimal do
  arquivo, no molde de `mercadopago.ts`), `volumes: [{altura, largura,
  comprimento, peso /* GRAMAS */, quantidade_volumes}]`.
- `AbortSignal.timeout(TIMEOUT_MS)`; erro sem resposta vira status 0.
- Envelope de erro documentado: `{ result: false, messages: ... }` → `ClubeEnviosError`.
- **A documentacao publica NAO traz o corpo de sucesso de `/cotacao`.** A
  normalizacao aceita a lista de servicos em qualquer um dos containers
  plausiveis e le valor/prazo por lista de apelidos. Se nao achar valor OU prazo,
  lanca `CotacaoIlegivelError` com as chaves que chegaram — **NUNCA assume zero.**
  Isso e o mesmo principio do `LinhaFrete`: preferir erro legivel a inventar
  dinheiro. O comentario do arquivo precisa dizer que a primeira chamada real em
  homologacao confirma ou corrige os apelidos, e que este e o unico lugar a
  mudar.
- Sem token/cliente_id/CEP de origem: `FreteNaoConfiguradoError`. Ler as
  variaveis DENTRO da funcao (padrao `mercadopago.ts`), nunca no import — senao
  `next build` quebra sem placeholder.

## src/lib/cep.ts (NOVO) — §13 "identificar localizacao"
```ts
export type EnderecoDoCep = { cep: string; rua: string; bairro: string; cidade: string; estado: string }
export async function buscarEnderecoPorCep(cep: string): Promise<EnderecoDoCep | null>
```
ViaCEP (`https://viacep.com.br/ws/<cep>/json/`), sem credencial. Devolve null
para CEP inexistente (`{ erro: true }`) e para falha de rede — autofill e
conveniencia, nunca bloqueio: o comprador sempre pode digitar a mao.

---

# 4. Contratos de src/repositories

## src/repositories/estoque.ts (NOVO)
```ts
export type { CanalVenda }
export class EstoqueInsuficienteError extends Error {
  constructor(readonly canal: CanalVenda, readonly disponivel: number, readonly solicitado: number)
}
export type SaldoEstoque = {
  estoqueId: string; kitId: string; canal: CanalVenda; ilimitado: boolean
  total: number      // SUM(entrada)
  vendido: number    // -SUM(baixa)
  disponivel: number // SUM(quantidade) de todos os movimentos
}
export async function saldoDoEstoque(kitId: string, canal: CanalVenda, trx?: Transaction<DB>): Promise<SaldoEstoque | null>
export async function saldosPorKit(): Promise<SaldoEstoque[]>
export async function baixarEstoque(
  e: { kitId: string; canal: CanalVenda; pedidoId: string; quantidade: number; motivo?: string },
  trx: Transaction<DB>,
): Promise<boolean>
export async function estornarEstoque(pedidoId: string, trx: Transaction<DB>): Promise<boolean>
export async function ajustarEstoque(e: { kitId; canal; quantidade; motivo }): Promise<void>
```
- `baixarEstoque` PRECISA de transacao (nao existe versao sem), trava a linha de
  `estoques` com `FOR UPDATE`.
  **ORDEM DE LOCK OBRIGATORIA**: `conciliarPagamento` ja trava `pedidos` como
  PRIMEIRO statement; o lock de `estoques` vem SEMPRE DEPOIS. Duas entregas
  concorrentes do mesmo webhook deadlockariam se a ordem invertesse em algum
  caminho. Comentar isso no arquivo.
- Devolve `false` quando ja existe baixa para aquele pedido (reenvio de webhook)
  — mesma convencao de "nada a fazer" do `pedidoAposPagamento` devolvendo null.
- Lanca `EstoqueInsuficienteError` so quando `ilimitado = false` e a baixa
  levaria o saldo abaixo de zero.
- `estornarEstoque` devolve `false` quando nao ha baixa a estornar.

## src/repositories/usuarios.ts (NOVO)
```ts
export type { PapelUsuario }
export type Usuario = { id: string; nome: string; email: string; papel: PapelUsuario; ativo: boolean }
export async function criarUsuario(e: { nome; email; senha; papel }): Promise<Usuario>
export async function autenticar(email: string, senha: string): Promise<Usuario | null>
export async function buscarUsuarioPorId(id: string): Promise<Usuario | null>
export async function listarUsuarios(): Promise<Usuario[]>
```
`autenticar` devolve null para: e-mail inexistente, usuario inativo, senha
errada. **Um unico null para os tres**, sem distinguir — distinguir e oraculo de
existencia de conta (mesmo raciocinio ja documentado para `CpfDivergenteError`).
Conferir a senha mesmo quando o usuario nao existe (hash descartavel) para nao
vazar a diferenca pelo tempo de resposta.
`Usuario` NUNCA carrega `senha_hash`.

## src/repositories/sessoes.ts (NOVO)
```ts
export type SessaoAtiva = { usuario: Usuario; expiraEm: Date }
export async function abrirSessao(usuarioId: string, agora?: Date): Promise<{ token: string; expiraEm: Date }>
export async function sessaoValida(token: string, agora?: Date): Promise<SessaoAtiva | null>
export async function revogarSessao(token: string, agora?: Date): Promise<void>
export async function revogarSessoesDoUsuario(usuarioId: string): Promise<void>
```
Grava so `hashDoToken(token)`. `sessaoValida` exige `revogada_em IS NULL`,
`expira_em > agora` e `usuarios.ativo = true`.

## src/repositories/leads.ts (NOVO)
```ts
export type { TipoLead }
export type Lead = { id; tipo; nome; email; whatsapp; cidade; estado; mensagem; consentimentoLgpd; consentidoEm; origem; criadoEm }
export async function registrarLead(e: {...}): Promise<Lead>
export async function listarLeads(tipo?: TipoLead): Promise<Lead[]>
```

## src/repositories/pedidos.ts (ESTENDER)
- `EntradaPedido` ganha `canal: CanalVenda` e `vendedorId?: string | null`.
- `Pedido` ganha `canal: CanalVenda`, `vendedorId: string | null`,
  `rastreioCodigo`, `rastreioTransportadora`, `enviadoEm`, `prazoDiasEstimado`.
- NOVO:
```ts
export async function avancarStatusDoPedido(
  pedidoId: string, novo: PedidoStatus, trx: Transaction<DB>, agora?: Date,
): Promise<{ mudou: boolean; de: PedidoStatus; para: PedidoStatus }>
```
  `FOR UPDATE` primeiro, valida com `transicaoPermitida`, carimba `enviado_em`
  na entrada em `enviado` e `entregue_em` na entrada em `entregue` (hoje
  `entregue_em` nao tem escritor nenhum em todo o codigo). Lanca
  `TransicaoInvalidaError` (classe exportada) quando a transicao nao existe.
```ts
export async function registrarRastreio(
  pedidoId: string, e: { codigo: string; transportadora: string },
): Promise<void>
```
- Leituras administrativas (§17). Todas devolvem exatamente as colunas que a
  tela mostra — nada de `selectAll` espalhando CPF por engano:
```ts
export type VendaAdmin = {
  id; numero; token; criadoEm; canal; status
  clienteNome: string | null; clienteEmail: string | null; clienteWhatsapp: string | null
  itens: string          // "2x Kit Milagran"
  quantidade: number
  subtotalCentavos; descontoCentavos; freteCentavos; totalCentavos: Centavos
  metodoPagamento: MetodoPagamento | null
  vendedorNome: string | null
  representanteNome: string | null
}
export async function listarVendasAdmin(f?: { canal?: CanalVenda; status?: PedidoStatus }): Promise<VendaAdmin[]>

export type LogisticaAdmin = {
  id; numero; status; criadoEm
  clienteNome: string | null
  cep; rua; numero_; complemento; bairro; cidade; estado: string | null
  rastreioCodigo: string | null; rastreioTransportadora: string | null
  prazoDiasEstimado: number | null; enviadoEm: Date | null
}
export async function listarLogisticaAdmin(): Promise<LogisticaAdmin[]>

export type ResumoDeVendas = {
  pedidosPagos: number; faturamentoCentavos: Centavos
  porCanal: Array<{ canal: CanalVenda; pedidos: number; totalCentavos: Centavos }>
  porMetodo: Array<{ metodo: MetodoPagamento; pedidos: number; totalCentavos: Centavos }>
}
export async function resumoDeVendas(): Promise<ResumoDeVendas>

export type CompradorAdmin = { clienteId; nome; email; whatsapp; pedidos: number; totalCentavos: Centavos; ultimoPedidoEm: Date }
export async function listarCompradores(): Promise<CompradorAdmin[]>
```

## src/repositories/clientes.ts (ESTENDER)
`salvarClienteComEndereco(cliente, endereco: EntradaEndereco | null, trx)` →
`{ clienteId: string; enderecoId: string | null }`. Endereco `null` = venda
presencial (§10: o balcao nao pede endereco). O INSERT em `enderecos` passa a
ser condicional. Nenhuma outra regra muda — `CpfDivergenteError` continua igual.

## src/repositories/produtos.ts (ESTENDER)
`Kit` ganha `pesoGramas`, `alturaCm`, `larguraCm`, `comprimentoCm` — a cotacao
de frete precisa deles e eles nao podem ser inventados na rota.

## src/repositories/conciliacao.ts (ESTENDER)
`ResultadoConciliacao` ganha `estoqueBaixado: boolean` e `estoqueEstornado: boolean`.
Depois de mover o status, DENTRO da mesma transacao e DEPOIS do lock do pedido:
- entrou em `pago` → `baixarEstoque` para cada item, no canal do pedido;
- entrou em `reembolsado`/`cancelado` → `estornarEstoque`.
Um `EstoqueInsuficienteError` aqui NAO pode derrubar a conciliacao de um
pagamento ja aprovado — o dinheiro entrou, o pedido tem que ficar pago. Registrar
o erro no log e seguir com `estoqueBaixado: false`; o painel mostra a divergencia
para a operacao resolver. Comentar isso: e uma escolha, nao um esquecimento.

---

# 5. Rotas HTTP

Todas seguem o padrao da casa: `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`,
schema Zod de modulo chamado `Corpo` com `.strict()`,
`safeParse(await req.json().catch(() => null))`, erro `{error:'<snake_case>'}`,
handler explicito de 405 com header `Allow` para os outros verbos.

## src/lib/guarda.ts (NOVO)
```ts
export async function usuarioDaRequisicao(req: Request): Promise<Usuario | null>
export async function exigirPapel(req: Request, papeis: readonly PapelUsuario[]): Promise<Usuario | Response>
export async function usuarioDaSessaoNoServidor(): Promise<Usuario | null>  // next/headers, para Server Components
```
`exigirPapel` devolve `Response` 401/403 pronta quando recusa. `admin` tem acesso
a tudo que `vendedor` tem.

## Rotas novas
| Rota | Metodo | Acesso | Contrato |
|---|---|---|---|
| `/api/sessao` | POST | publico | `{email, senha}` → 204 + cookie. 401 `credenciais_invalidas`. Rate-limited. |
| `/api/sessao` | DELETE | sessao | revoga + cookie de logout → 204 |
| `/api/estoque` | GET | publico | `?kit=slug` → `{presencial:{disponivel,total,esgotado}, aviso:{nivel,mensagem}, online:{ilimitado}}`. §5/§11. |
| `/api/frete` | POST | publico | `{cep, kitSlug, quantidade}` → `{opcoes:[{idServico,transportadora,valorCentavos,prazoDias}]}`. 422 `cep_invalido`, 503 `frete_indisponivel`. Rate-limited. |
| `/api/cep/[cep]` | GET | publico | autofill do wizard → `EnderecoDoCep` ou 404 |
| `/api/leads` | POST | publico | `{tipo, nome, email, whatsapp?, cidade?, estado?, mensagem?, lgpd}` → 201. Rate-limited. |
| `/api/vendas-presenciais` | POST | vendedor/admin | `{kitSlug, quantidade, metodo, nome, email, whatsapp, cpf?}` → 201 `{numero, token, pagamento}` |
| `/api/admin/vendas` | GET | admin | `listarVendasAdmin` + `resumoDeVendas` |
| `/api/admin/estoque` | GET | admin | `saldosPorKit` + reservados (pedidos aguardando pagamento) |
| `/api/admin/logistica` | GET | admin | `listarLogisticaAdmin` |
| `/api/admin/leads` | GET | admin | `?tipo=` → leads + compradores |
| `/api/admin/pedidos/[id]` | PATCH | admin | `{status?, rastreioCodigo?, rastreioTransportadora?}` → 200 |

### POST /api/vendas-presenciais (§10)
Fluxo, tudo em UMA transacao: valida sessao de vendedor → le kit → **checa e
baixa o estoque presencial NA CRIACAO** (aqui a reserva e imediata: o comprador
esta na frente do vendedor e vai levar o kit agora — diferente do online, onde a
baixa e no pagamento) → `salvarClienteComEndereco(cliente, null, trx)` →
`criarPedido({canal:'presencial', vendedorId, frete: deInteiro(0), ...})` →
cria o pagamento no Mercado Pago. Estoque esgotado → 409 `estoque_esgotado`,
com mensagem propria para a tela do vendedor.
Frete zero aqui NAO e politica indefinida: venda presencial nao tem frete, e o
comentario tem que dizer isso.

### Alteracoes em rotas existentes
- **POST /api/pedidos**: `Corpo` ganha `idServico: z.number().int().positive()`
  (a opcao de frete que o comprador escolheu). O VALOR do frete continua vindo
  do servidor — recotado dentro da rota a partir do CEP submetido, nunca aceito
  do corpo (`.strict()` ja garante que dinheiro no corpo e 422). Cota, acha a
  opcao pelo `idServico`, e passa `frete: opcao.valor` e
  `prazoDiasEstimado: opcao.prazoDias` para `criarPedido`. `canal: 'online'`.
  Cotacao falhou → 503 `frete_indisponivel`, pedido NAO e criado. Sem estoque
  online rigido, nao ha reserva na criacao.
  MOTIVO DE RECOTAR: `pedidos.frete_centavos` e `total_centavos` sao CONGELADOS
  pelo trigger de imutabilidade — o valor precisa estar certo no INSERT, porque
  nao ha UPDATE possivel depois.
- **POST /api/webhooks/mercadopago** e **POST /api/pagamentos**: nenhuma mudanca
  de contrato. A baixa de estoque entra por dentro de `conciliarPagamento`, que
  os dois ja chamam — e exatamente por isso que ela mora la e nao nas rotas.

---

# 6. Front-end

## Rotas
| Rota | O que e |
|---|---|
| `/` | **NOVA** — loja de lancamento (§6, §7, §8, §18). Server Component `force-dynamic` (le estoque ao vivo). |
| `/seja-representante.html` | continua 200 (§14) — ha campanha em circulacao E o verificador de deploy depende dela |
| `/comprar` | vitrine (mantida) |
| `/checkout` | wizard (estendido) |
| `/pedido/[token]` | confirmacao (estendida) |
| `/entrar` | **NOVA** — login de admin/vendedor |
| `/venda` | **NOVA** — balcao do evento (sessao de vendedor) |
| `/admin`, `/admin/vendas`, `/admin/estoque`, `/admin/logistica`, `/admin/leads` | **NOVAS** — §17 |

## CONFLITO a resolver com cuidado: `/`
`next.config.ts:45-49` faz rewrite de `/` para `/seja-representante.html`.
Remover o rewrite E, no MESMO commit:
1. repontar `<link rel="canonical">` de `public/seja-representante.html:8` para
   `https://milagranoficial.com.br/seja-representante.html` (hoje ele declara que
   a pagina de recrutamento e a home);
2. conferir `deploy/milagran-ci-deploy.sh:137-153` — `verificar_borda()` aprova o
   deploy inteiro por `curl` em `/seja-representante.html`. Como §14 manda manter
   essa URL viva, ela continua 200 e o verificador continua valido. **Nao mexer
   nessa URL sem atualizar o script no mesmo commit, senao todo deploy futuro se
   auto-reverte.**
3. atualizar a tabela "O que serve cada URL" do `DEPLOY.md`.

## Componentes
- `src/components/linha-frete.tsx` — **CONFLITO com o Plano 2**: deixa de ser
  texto fixo e passa a RECEBER o valor.
  ```tsx
  type Props = { valor: Centavos | null; prazoDias?: number | null }
  export const TEXTO_FRETE_A_COTAR = 'Calculado no checkout, a partir do seu CEP'
  ```
  `valor === null` → texto de "ainda nao cotado" (a vitrine nao conhece o CEP).
  **Nunca "R$ 0,00" quando nao ha valor** — a razao de existir do componente.
  Atualizar o comentario de divida contando que a politica foi decidida.
- `src/components/vitrine.tsx` — recebe `escassez: { disponivel, total, aviso } | null`.
  Mostra "Kits disponiveis: N", o aviso, e troca a CTA por "COMPRAR ONLINE"
  quando esgotado. Clamp da quantidade contra `QUANTIDADE_MAXIMA` **e** contra o
  disponivel presencial (numeros independentes). Linha "Valor unitario" (§9).
- `src/components/checkout-wizard.tsx` — passo 1 ganha "Valor unitario"; passo 3
  ganha autofill por CEP (`/api/cep/[cep]`) e a **escolha da opcao de frete**
  (`/api/frete`), com prazo estimado; passo 4 mostra Frete e Total reais e
  anuncia PIX/CARTAO (§9). Envia `idServico` no POST. Os testes existentes
  travam o corpo exato do POST (`toEqual` + `CAMPOS_PROIBIDOS`): atualizar
  conscientemente, mantendo a garantia de que nenhum campo monetario e enviado.
- `src/components/venda-presencial.tsx` — **NOVO**. Tela de balcao: Kit →
  Quantidade → dados minimos → Pagamento → "Confirmar venda" → "VENDA APROVADA"
  em bloco grande + contador de kits restantes. Estados de erro explicitos e
  legiveis para estoque esgotado e falha de pagamento: e uma tela operada em pe,
  com fila, e um estado ambiguo ali vira kit entregue sem venda registrada.
- `src/components/contador-estoque.tsx` — **NOVO**. Client component que faz
  polling de `/api/estoque` (15s) para o painel e para a home (§11 "em tempo
  real"). Primeiro padrao de polling do projeto — todas as telas de hoje sao
  server render.

## Layout e chrome
`src/app/layout.tsx` ganha metadata (title/description/OG), favicon, header com
logo e footer. O footer carrega o link discreto de §14: "Quer representar a
Milagran?" → "Conheca as oportunidades" → `/seja-representante.html`.
Fontes por `next/font` (self-hosted; nada de request a CDN externo).
Estilos novos vao para `src/app/globals.css` — que passa a ser o dono do design
system da loja. `public/styles.css` continua servindo so a LP estatica de
recrutamento; a divergencia entre os dois e assumida e documentada.

---

# 7. Testes

Convencoes obrigatorias: nomes em portugues sem acento, prefixos
`DINHEIRO:`/`SEGURANCA:`/`LGPD:` para o que e critico; `.test.ts` roda em node,
`.test.tsx` em jsdom; importar `describe/it/expect` explicitamente (sem globals);
isolamento por NAMESPACE proprio de slug/email/SKU por arquivo, limpando apenas
as proprias linhas (os arquivos rodam em paralelo contra o mesmo banco);
`afterAll(closeDb)`; garantia do banco asseverada pelo NOME da constraint em
regex, erro de aplicacao asseverado pela CLASSE.

Cobertura minima nova:
- `src/lib/__tests__/escassez.test.ts` — os quatro niveis e as fronteiras (0, 1,
  5, 6, 10, 11).
- `src/lib/__tests__/senha.test.ts` — hash != senha, confere, rejeita errada,
  rejeita hash malformado sem lancar.
- `src/lib/__tests__/sessao.test.ts` — cookie tem `__Host-`, `HttpOnly`,
  `Secure`; `tokenDoCookie` acha o token com e sem espaco depois do `;`.
- `src/lib/__tests__/frete.test.ts` — corpo enviado tem os nomes EXATOS da API;
  centavos viram decimal uma vez so; envelope `{result:false}` vira erro;
  resposta sem valor/prazo lanca `CotacaoIlegivelError` **e nao devolve zero**.
- `src/lib/__tests__/tempo.test.ts` — estender: `lancamentoJaOcorreu` antes e
  depois de 25/08/2026 com `vi.setSystemTime`.
- `src/lib/__tests__/pedido-status.test.ts` — estender: `pago -> entregue`
  permitido (presencial), `em_transito` no caminho dos Correios, estorno de
  comissao a partir de `em_transito`.
- `src/repositories/__tests__/estoque.test.ts` — **o arquivo mais importante do
  plano**: baixa reduz o disponivel; baixa repetida do mesmo pedido devolve
  false e NAO baixa duas vezes (reenvio de webhook); estoque presencial recusa a
  51a unidade com `EstoqueInsuficienteError`; canal ilimitado nao recusa; canal
  online NAO consome o presencial (§4); estorno devolve; movimento e append-only
  (UPDATE e DELETE levantam excecao pelo nome do trigger); **teste de
  concorrencia com barreira explicita** — duas baixas simultaneas do ultimo kit,
  so uma passa (a versao sem barreira continuava verde com o `.forUpdate()`
  removido, armadilha ja documentada no projeto).
- `src/repositories/__tests__/usuarios.test.ts` — autentica; senha errada,
  usuario inativo e e-mail inexistente devolvem o MESMO null;
  `Usuario` nao carrega `senha_hash`.
- `src/repositories/__tests__/sessoes.test.ts` — sessao expirada e revogada nao
  valem; o banco guarda o hash, nunca o token.
- `src/repositories/__tests__/conciliacao.test.ts` — estender: aprovar baixa o
  estoque; reenvio nao baixa de novo; reembolso estorna.
- `src/app/api/__tests__/vendas-presenciais-route.test.ts` — sem sessao 401;
  vendedor cria venda presencial; estoque esgotado 409.
- `src/app/api/__tests__/admin-guarda.test.ts` — **SEGURANCA:** toda rota
  `/api/admin/*` responde 401 sem sessao e 403 com sessao de vendedor.
- `src/components/__tests__/venda-presencial.test.tsx` e a extensao de
  `vitrine.test.tsx` (esgotado troca a CTA; clamp contra o disponivel).

---

# 8. Configuracao e deploy

Variaveis novas — **entram no mesmo commit** em `.env.example`, no bloco `env:`
do CI, nos placeholders de build do `Dockerfile` e do workflow, no
`milagran-stack.example.yml`, no `deploy/make-milagran-stack.sh` e na tabela do
`DEPLOY.md`:

| Variavel | Para que |
|---|---|
| `SESSAO_SECRET` | reservada para assinatura futura; a sessao de hoje e opaca no banco |
| `CLUBE_ENVIOS_TOKEN` | `Authorization` da API de frete |
| `CLUBE_ENVIOS_CLIENTE_ID` | `cliente_id` do corpo da cotacao |
| `CLUBE_ENVIOS_BASE_URL` | opcional; homologacao |
| `CEP_ORIGEM_EXPEDICAO` | `cep_origem` da cotacao |

Todas lidas DENTRO da funcao, nunca no import — variavel validada no import
quebra `next build` sem placeholder (padrao ja documentado em `mercadopago.ts`
vs `atribuicao.ts`).

`scripts/criar-usuario.mjs` + `npm run usuario:criar` para semear o primeiro
admin. **Nao existe seed de senha em migration**: senha em SQL versionado vaza
para sempre no historico do git.

## Pendencias operacionais fora deste plano (§ nenhuma — sao do dia do evento)
1. **Mercado Pago nao chega ao container em producao.** `milagran-stack.example.yml`
   e `deploy/make-milagran-stack.sh` nao passam `MERCADOPAGO_*` nem `APP_URL`.
   Bloqueio de lancamento anterior a este plano.
2. **Rate limit de 10 req/10min por IP, em memoria, replicas:1.** No evento
   dezenas de pessoas ficam atras de UM IP (WiFi do local ou CGNAT). O 11o
   comprador leva 429.
3. **Resend**: `RESEND_API_KEY`/`EMAIL_FROM` sao opcionais no gerador de stack —
   o comprador paga e nao recebe nada. Verificar dominio e publicar SPF/DKIM
   antes do primeiro envio.
4. **QR Code no APEX, nunca em `www`** — o prefixo `__Host-` faz `www` perder a
   atribuicao do representante.
