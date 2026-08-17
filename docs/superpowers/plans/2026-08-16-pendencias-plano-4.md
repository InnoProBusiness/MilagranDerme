# Pendencias do Plano 4 — loja de lancamento (25/08/2026)

Sessao de 16/08/2026, interrompida deliberadamente. Este documento e o handoff:
o que foi entregue, o que foi verificado, e o que falta.

O plano de referencia e `docs/superpowers/plans/2026-08-16-milagran-lancamento-25-08.md`.
Ele tem os contratos completos (assinaturas, colunas, mensagens) e continua valendo.

**Nada foi commitado.** Todo o trabalho esta na arvore, sem stage.

---

## 1. Estado verificavel agora

| Gate | Resultado |
|---|---|
| `npm run typecheck` | **passa** |
| `npx vitest run --project jsdom` (componentes) | **139 passam** |
| Testes puros de `src/lib` (sem banco) | **247 passam** |
| `npm run build` | **passa**, 29 rotas emitidas |
| Testes de repositorio / rota (exigem Postgres) | **NAO RODARAM** — ver abaixo |

### O que NAO foi possivel verificar nesta maquina

Nao ha Docker nem Postgres aqui. Toda a suite que toca o banco (repositorios,
rotas, `resolver-pedido`, `db`) so roda no CI. Duas consequencias:

1. **`src/lib/db-types.ts` foi editado A MAO.** `npm run db:types`
   (kysely-codegen) exige banco vivo. O cabecalho do arquivo registra a excecao.
   **PRIMEIRA COISA A FAZER AMANHA:**
   ```
   npm run db:up && npm run db:migrate && npm run db:types && git diff src/lib/db-types.ts
   ```
   Qualquer linha nesse diff e um erro meu que o typecheck local nao pegou.
2. **Nenhuma migration foi executada de verdade.** Elas foram conferidas contra
   o parser do `node-pg-migrate`, nao contra o Postgres. `npm run db:migrate`
   e o teste real.

Ordem sugerida amanha: subir o banco, migrar, regenerar tipos, `npm test`
inteiro. So depois mexer em qualquer outra coisa desta lista.

---

## 2. O que foi entregue

### Schema — 8 migrations novas, bloco `1755300000000`
- `..._canal_e_estoque.sql` — tipos `canal_venda` e `movimento_estoque`; tabelas
  `estoques` e `estoque_movimentos` (livro-razao append-only assinado, molde de
  `comissoes`); dois indices unicos parciais que sao a idempotencia real contra
  reenvio de webhook.
- `..._pedidos_canal_logistica.sql` — `canal`, `rastreio_codigo`,
  `rastreio_transportadora`, `enviado_em`, `prazo_dias_estimado`; `canal` entra
  na lista de colunas congeladas do trigger de imutabilidade.
- `..._status_em_transito.sql` — `ALTER TYPE ... ADD VALUE`, sozinha de proposito.
- `..._usuarios_sessoes.sql` — `usuarios`, `sessoes`, `pedidos.vendedor_id`;
  trigger reescrito de novo, agora com `canal` e `vendedor_id`.
- `..._leads.sql` — persiste candidaturas e interessados, com consentimento LGPD
  carimbado (ate agora o aceite era coletado e nao gravado).
- `..._pagamentos_atualizado_em.sql` — corrige o desvio de convencao.
- `..._kit_dimensoes.sql` — peso e medidas para a cotacao de frete.
- `..._seed_estoque.sql` — 50 kits presenciais (teto rigido) + linha online ilimitada.

### Aplicacao
- **Estoque** (`src/repositories/estoque.ts`): baixa/estorno/ajuste sob
  `FOR UPDATE`, ordem de lock `pedidos` -> `estoques` documentada, idempotencia
  por indice unico parcial. Baixa entra na conciliacao de pagamento para o canal
  online e na criacao da venda para o presencial.
- **Autenticacao**: `usuarios` + `sessoes` com scrypt (`src/lib/senha.ts`, sem
  dependencia nova) e cookie `__Host-`. `src/lib/guarda.ts` protege rotas e
  Server Components. `npm run usuario:criar` semeia operadores.
- **Frete real**: `src/lib/frete.ts` (Clube Envios) + `src/lib/cep.ts` (ViaCEP).
  `LinhaFrete` deixou de ser texto fixo e passou a receber o valor. O checkout
  cota, o comprador escolhe o servico, e o servidor **recota** antes do INSERT
  (a coluna e congelada pelo trigger; nao ha UPDATE depois).
- **Venda presencial**: `POST /api/vendas-presenciais` (autenticada) + tela de
  balcao, com PIX/cartao pelo mesmo Mercado Pago.
- **Painel administrativo**: `/admin` com vendas, estoque, logistica e leads.
- **Loja em `/`**: `src/app/page.tsx` nova, rewrite removido, canonical da LP de
  recrutamento repontado, chrome de marca (header/footer/fontes/metadata).
- **Deploy**: `MERCADOPAGO_*` e `APP_URL` **passaram a chegar ao container** —
  ate hoje nao chegavam, e pagamento estava morto no ar em producao sem erro em
  log nenhum. O gerador de stack agora imprime um relatorio de prontidao.

---

## 3. Achados da revisao adversarial — TRIAGEM PENDENTE

Rodei uma revisao em seis dimensoes com tres ceticos por achado. **A revisao foi
interrompida antes de terminar**, entao a lista abaixo esta em tres estados.
Nada aqui foi corrigido.

### 3.1 Sustentados pelos ceticos — corrigir primeiro

1. **[ALTO] Bloco pos-COMMIT fora do `try`** —
   `src/app/api/vendas-presenciais/route.ts` (~linha 542). *(3 de 3 ceticos sustentaram)*
   Uma falha na conciliacao depois do COMMIT escapa como 500 generico, **sem**
   `vendaRegistrada`/`numero`/`token` no corpo. A tela do balcao le exatamente
   esse campo para decidir o que dizer ao vendedor — sem ele, o vendedor cai no
   estado "nao da para saber", com a unidade ja baixada. E o defeito mais caro
   da lista porque acontece com fila na frente.

2. **[ALTO] Cupom de 100% (ou fixo >= subtotal) trava a conciliacao** —
   `src/repositories/conciliacao.ts` (~linha 143). *(2 de 3 sustentaram)*
   O caminho ficou alcancavel agora que o frete e real: com desconto igual ao
   subtotal, a base de comissao vai a zero e o fluxo quebra. Conferir o que
   `creditarComissao` faz com base zero e se `pedido_total_confere` fecha quando
   so resta frete.

3. **[MEDIO] A tela descarta opcao de frete sem nome de transportadora** —
   `src/components/checkout-wizard.tsx` (~linha 179). *(3 de 3 sustentaram)*
   `src/lib/frete.ts` documenta que o nome e cosmetico e **nao** pode derrubar a
   cotacao; o cliente e mais estrito que o servidor e some com opcoes validas.

4. **[BAIXO] Classificacao do 500 na tela do balcao** —
   `src/components/venda-presencial.tsx` (~linha 200). *(2 de 3 sustentaram)*
   Um 500 generico e classificado como "venda NAO registrada", mas a rota nao
   sabe se o COMMIT passou. Deveria cair em "incerto".

### 3.2 Refutados pelos ceticos — provavelmente ignorar
- Ordem de lock divergente entre baixa e estorno (`estoque.ts`) — 3 de 3 refutaram.
- Teto do stepper da vitrine aplicando saldo presencial a compra online — 3 de 3 refutaram.
- Um achado sobre o rotulo 'Em preparacao' — 2 de 3 refutaram.

### 3.3 Levantados, NAO verificados (a revisao parou antes)
Trate como suspeitas, nao como defeitos confirmados:
- **[ALTO] Cancelar pedido presencial pelo painel nao estorna estoque** e ainda
  engoliria o estorno automatico do webhook — `src/repositories/pedidos.ts` (~625).
  Este merece ser o primeiro a investigar do grupo.
- [MEDIO] Sessao expirada no balcao: a tela promete que os dados ficam, mas nao
  ha caminho de reautenticar sem perde-los — `venda-presencial.tsx` (~358).
- [MEDIO] Contador da home mostra saldo vivo ao lado de frase que cita o tamanho
  do lote — `contador-estoque.tsx` (~224).
- [BAIXO] A vitrine imprime "Total" para um valor que exclui frete ainda nao
  cotado, na mesma caixa que diz que o frete vem depois — `vitrine.tsx` (~274).

Para retomar a revisao inteira:
`Workflow({scriptPath: '<sessao>/workflows/scripts/milagran-revisao-plano-4-wf_e82b790c-813.js', resumeFromRunId: 'wf_e82b790c-813'})`

---

## 4. Decisoes do cliente ja tomadas (nao reabrir)

Tomadas em 16/08/2026 e ja implementadas:
1. Autenticacao por tabela `usuarios` + sessao em cookie, um login por vendedor.
2. Frete pela API do Clube Envios.
3. Estoque online **sem teto**; a unidade e baixada no **pagamento**. O
   presencial tem teto rigido de 50 e baixa na **criacao** da venda.
4. Venda presencial cobra pelo mesmo Mercado Pago, confirmada por webhook.

## 5. Ainda precisa de resposta do cliente

- **Peso e dimensoes reais do kit.** Estao semeados como palpite declarado
  (500 g, 12x16x20 cm) com comentario na migration. Valor errado = frete cotado
  abaixo do custo, e a diferenca sai da margem em todo pedido online. Sem
  conserto depois: `frete_centavos` e congelado no INSERT.
- **CEP de origem da expedicao**, token e `cliente_id` do Clube Envios.
- **Credenciais do Mercado Pago** na VPS (ver checklist no `DEPLOY.md`).
- **Registro ANVISA** — continua NULL, e a vitrine exibe "em breve".
- **Rate limit no evento**: 10 req/10 min por IP, em memoria, uma replica.
  Dezenas de pessoas atras do WiFi do local compartilham um IP.

## 6. Riscos operacionais conhecidos

- **A resposta de sucesso de `POST /cotacao` do Clube Envios nao esta na
  documentacao publica.** `src/lib/frete.ts` le preco e prazo por lista de
  apelidos e lanca `CotacaoIlegivelError` com as chaves recebidas se nao achar —
  nunca devolve zero. **A primeira chamada tem que ser em homologacao**
  (`CLUBE_ENVIOS_BASE_URL=https://apishmg.clubeenvios.com.br`), e o ajuste, se
  necessario, e num arquivo so.
- `deploy/milagran-ci-deploy.sh` reverte o deploy inteiro se
  `/seja-representante.html` nao responder 200. A URL foi mantida viva de
  proposito; nao mexer nela sem atualizar `verificar_borda()` no mesmo commit.
- O checklist completo do dia do evento esta em `DEPLOY.md`, secao
  "Checklist do lancamento de 25/08/2026".
