# Pendencias do Plano 4 — loja de lancamento (25/08/2026)

Handoff de 16/08, **atualizado em 17/08/2026**. As secoes marcadas RESOLVIDO
ficam registradas de proposito: elas explicam por que uma decisao mudou.

O plano de referencia e `docs/superpowers/plans/2026-08-16-milagran-lancamento-25-08.md`.

---

## 1. Estado verificavel agora

| Gate | Resultado em 17/08 |
|---|---|
| `npm run typecheck` | passa |
| `npm run db:migrate` | **19 migrations aplicadas** contra Postgres real |
| `npx vitest run` | **763 passam**, 45 arquivos, COM banco |
| `npm run build` | passa |
| CI + deploy na VPS | verdes, `main` em producao |

### RESOLVIDO — o que o handoff de 16/08 pedia como primeira tarefa

1. **`src/lib/db-types.ts` escrito a mao.** Regenerado com `npm run db:types`
   contra o banco real: as declaracoes sao **identicas, linha por linha**, as
   que tinham sido escritas a mao. Zero divergencia. O aviso de excecao saiu do
   cabecalho porque a excecao deixou de existir.
2. **Migrations nunca executadas.** As 19 aplicam limpo.
3. **Suite de banco nunca rodada.** Rodou e achou exatamente um defeito que
   nenhuma checagem estatica pegaria: `pedido_online_tem_endereco` recusava o
   `INSERT` cru do teste de concorrencia de cupom, escrito antes da constraint
   existir. Corrigido no teste, que agora carrega `cliente_id`/`endereco_id`
   como o resto do arquivo — e nao driblando a regra pelo canal.

---

## 2. Achados da revisao adversarial — RESOLVIDOS

Os quatro sustentados e as quatro suspeitas nao verificadas foram todos
tratados em 17/08.

### Corrigidos

1. **[ALTO] Bloco pos-COMMIT fora do `try`** (`vendas-presenciais/route.ts`).
   Confirmado e corrigido. A rota devolvia 500 sem corpo, e a tela do balcao
   caia no desfecho "nao da para saber" — o mais caro, com fila na frente e a
   unidade ja baixada. Agora devolve `vendaRegistrada`, `numero`, `token` e um
   campo novo, **`cobrancaCriada`**, que separa dois 500 que pedem acoes
   OPOSTAS: sem cobranca criada, "cobre de novo" e certo; com cobranca criada,
   cobrar de novo debita o comprador duas vezes pelo mesmo kit.
2. **[ALTO] Cupom de 100% travava a conciliacao.** Confirmado, e pior do que o
   relatado: base de comissao zero fazia `creditarComissao` lancar, a transacao
   inteira rolava para tras e o webhook devolvia 503 — que o Mercado Pago
   reenvia em laco. O pedido ficava pago no provedor e eternamente `pendente`
   aqui, com o estoque nunca baixado. `pedido_desconto_nao_excede` e `<=`, entao
   o banco aceita o pedido; so virou alcancavel quando o frete passou a ser
   real. Comissao zero agora e desfecho, nao erro. O `throw` de
   `creditarComissao` continua como guarda contra chamada indevida.
3. **[MEDIO] Tela descartava opcao de frete sem nome de transportadora.**
   Confirmado. `src/lib/frete.ts` diz que o nome e cosmetico e nao derruba a
   cotacao; a tela era mais estrita. Como a resposta de sucesso do Clube Envios
   **nao esta documentada** e o nome e lido por lista de apelidos, um apelido
   nao previsto esvaziaria TODAS as opcoes e travaria o checkout online no dia
   do lancamento por causa de um rotulo. Opcao sem nome agora aparece como
   "Envio".
4. **[ALTO] Cancelar pedido presencial nao estornava estoque.** Confirmado.
   No balcao a unidade sai na CRIACAO; quem gera Pix e vai embora tem o pedido
   cancelado no painel e o kit volta para a caixa — mas o sistema seguia
   contando como vendido. Com teto de 50, cada desistencia encolhia o lote de
   verdade. `avancarStatusDoPedido` agora estorna, na mesma transacao e sob o
   mesmo lock, na ordem `pedidos -> estoques`.
5. **[MEDIO] Contador da home contradizia a si mesmo.** Confirmado. A frase
   citava o lote e o numero grande ao lado mostrava o saldo vivo: depois da
   primeira venda a home exibia "42" ao lado de "Apenas 50 kits disponiveis".
   Pior, o numero e `aria-hidden` sob o argumento de que a frase o repete —
   entao o saldo vivo nao existia para leitor de tela. §5 pede a contagem viva
   na pagina; a manchete de lote e copy do hero (§6) e continua la.
6. **[MEDIO] Sessao expirada no balcao.** Confirmado. A frase prometia que os
   dados digitados continuavam na tela (e continuam — sao estado do React), mas
   nao havia link de login: seguir a instrucao significava sair pela navegacao,
   desmontar o componente e perder tudo. Agora ha link que **abre em aba nova**,
   entao a aba do balcao nao se mexe.
7. **[BAIXO] "Total" da vitrine.** Confirmado. Imprimia "Total: R$ 1.000,00"
   logo abaixo de "Frete: calculado no checkout" — fechando uma conta que nao
   fechou. Agora le "+ frete".

### Verificado e SEM defeito

- **[BAIXO] Classificacao do 500 na tela do balcao.** A revisao marcou como
  sustentado por 2 de 3, mas o codigo atual ja esta certo:
  `ERROS_ANTES_DO_COMMIT` e lista FECHADA, entao qualquer 500 fora dela ja cai
  em "incerto", nunca em "venda nao registrada". Nada a mudar.

### Refutados pelos ceticos (mantidos como estao)
- Ordem de lock divergente entre baixa e estorno (`estoque.ts`).
- Teto do stepper da vitrine aplicando saldo presencial a compra online.
- Um achado sobre o rotulo 'Em preparacao'.

---

## 3. BLOQUEIO REAL — a plataforma nao fecha uma venda hoje

Sondado em producao em 17/08. **As duas integracoes pagas estao sem
credenciais**, e cada uma sozinha ja impede a compra online de terminar:

| Integracao | Estado | Efeito |
|---|---|---|
| Mercado Pago | `POST /api/webhooks/mercadopago` responde **503** | Nao ha como cobrar. Nem Pix, nem cartao, nem balcao. |
| Clube Envios | `POST /api/frete` responde **503** | O checkout online trava no passo 3: sem cotacao, o comprador nao avanca. |
| ViaCEP | 200 | Autofill de endereco funciona (nao exige credencial). |

O comportamento nos dois casos e **falha fechada, de proposito**: sem segredo
de webhook nao ha como distinguir notificacao legitima de POST forjado (um
forjado marcaria pedido como pago), e sem cotacao o pedido nao segue com frete
zero. Nada disso e defeito a corrigir no codigo — e configuracao que falta.

### O que precisa chegar, e de onde

1. **Mercado Pago** — painel do desenvolvedor, sua aplicacao:
   - `MERCADOPAGO_ACCESS_TOKEN` (segredo de servidor)
   - `MERCADOPAGO_PUBLIC_KEY` (vai para o navegador, tokeniza cartao)
   - `MERCADOPAGO_WEBHOOK_SECRET` (Webhooks -> Configurar notificacoes ->
     Assinatura secreta)
   - URL de notificacao: `https://milagranoficial.com.br/api/webhooks/mercadopago`
   - **As credenciais de TESTE (`TEST-...`) ja destravam tudo.** O prefixo do
     token decide o ambiente; trocar pelas de producao depois e mudar uma
     variavel. Nao e preciso esperar KYC para validar o fluxo inteiro.
2. **Clube Envios** — token, `cliente_id` e **CEP de origem da expedicao**.
   A primeira chamada tem que ser em homologacao
   (`CLUBE_ENVIOS_BASE_URL=https://apishmg.clubeenvios.com.br`), porque a
   resposta de sucesso nao esta documentada e `src/lib/frete.ts` a le por lista
   de apelidos — se nenhum casar, ele lanca `CotacaoIlegivelError` com as chaves
   recebidas em vez de chutar um numero. O ajuste, se preciso, e num arquivo so.
3. **Peso e dimensoes reais do kit.** Semeados como palpite declarado (500 g,
   12x16x20 cm), com comentario na migration. **Este e o item mais caro da
   lista:** medida errada = frete cotado abaixo do custo, e a diferenca sai da
   margem em TODO pedido online. Sem conserto depois — `frete_centavos` e
   congelado no INSERT pelo trigger de imutabilidade.
4. ~~**Registro ANVISA.**~~ **Resolvido por dispensa em 18/08/2026:** o cliente
   declarou o enquadramento na Lei n. 15.154/2025 (producao artesanal) e a
   migration `1755500000000_anvisa_dispensa.sql` gravou a flag. As telas
   mostram a frase da lei via `src/lib/anvisa.ts`. Ressalva registrada no
   checklist do DEPLOY.md: a isencao depende do regulamento da Anvisa (RDC+IN
   em consulta publica out/2025) e a fiscalizacao sanitaria continua.

---

## 4. Decisoes do cliente ja tomadas (nao reabrir)

1. Autenticacao por tabela `usuarios` + sessao em cookie, um login por vendedor.
2. Frete pela API do Clube Envios.
3. Estoque online **sem teto**, baixado no **pagamento**. Presencial com teto
   rigido de 50, baixado na **criacao** da venda.
4. Venda presencial cobra pelo mesmo Mercado Pago, confirmada por webhook.

## 5. Riscos operacionais conhecidos

- **Rate limit no evento**: 10 req/10 min por IP, em memoria, uma replica.
  Dezenas de pessoas atras do WiFi do local compartilham um IP — o checkout
  ONLINE pode barrar visitantes no salao. O balcao NAO tem esse freio (a porta
  la e a sessao do vendedor), entao a venda do evento nao para.
- `deploy/milagran-ci-deploy.sh` reverte o deploy inteiro se
  `/seja-representante.html` nao responder 200. A URL foi mantida viva de
  proposito; nao mexer nela sem atualizar `verificar_borda()` no mesmo commit.
- O checklist do dia do evento esta em `DEPLOY.md`, secao
  "Checklist do lancamento de 25/08/2026".
