# Migrar o Pix para a API de Orders do Mercado Pago

**Data:** 19/08/2026 · **Lançamento:** 25/08/2026 · **Urgência:** a loja não cobra nada hoje.

Este documento é um handoff. Tudo abaixo foi **medido contra a API de produção**, não lido em
documentação. Onde algo não foi provado, está escrito que não foi.

> ## ⚑ A MIGRAÇÃO NÃO FOI FEITA — porque deixou de ser necessária
>
> **Leia a §8 antes de agir com base neste documento.** Em 20/08/2026 o bloqueio descrito na §1
> foi remedido em produção e **não existe mais**: `/v1/payments` voltou a criar Pix, e o cartão
> também destravou. O Pix continua saindo por `/v1/payments`.
>
> As seções 1 a 7 continuam valendo como **registro fiel do que foi medido em 19/08** — inclusive
> porque o bloqueio pode voltar (a conta segue com `address_pending`). O código da Orders API foi
> escrito e testado e está no repositório como **saída de emergência**, desligado. A §8 diz o que
> existe, por que está desligado, e o que fazer para ligá-lo.

---

## 1. O problema

A conta do Mercado Pago (`milagranoficial@gmail.com`, CNPJ 68.232.977/0001-78, user id
`3618266030`) está com o endereço cadastral **vazio**:

```
GET /users/me
  status.billing : { "allow": false, "codes": ["address_pending"] }
  status.list    : { "allow": false, "codes": ["address_pending"] }
  address        : { "address": null, "city": null, "state": null, "zip_code": null }
```

Com isso, o PolicyAgent do Mercado Pago recusa **toda** criação de cobrança em `/v1/payments`:

```
POST /v1/payments  →  403
{"code":"PA_UNAUTHORIZED_RESULT_FROM_POLICIES","blocked_by":"PolicyAgent",
 "message":"At least one policy returned UNAUTHORIZED."}
```

Testado e reproduzido nos três métodos: **Pix, boleto e cartão**. Não é problema do nosso código.

> **Atenção:** a dona da conta já tentou resolver e caiu na tela errada. O card
> *"Endereços — Endereços salvos na sua conta"* é a **agenda de entrega** (o formulário diz
> "Dados de quem vai receber"), e preencher ali **não** muda `address_pending`. O endereço que o
> MP valida fica em *Seu perfil → Informações do seu perfil (Dados do negócio, da conta e
> fiscais)*, ou na aba *Negócio → Dados do seu negócio*. Confirmado por medição: depois de salvar
> na agenda de entrega, `address` continuou nulo e a cobrança continuou 403.

---

## 2. A descoberta

`POST /v1/orders` **não passa pelo mesmo bloqueio**. Pix funciona hoje, com a conta do jeito que
está.

```bash
curl -X POST https://api.mercadopago.com/v1/orders \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: <uuid>" \
  -d '{
    "type": "online",
    "total_amount": "814.94",
    "external_reference": "<pedidos.id>",
    "processing_mode": "automatic",
    "payer": { "email": "compradora@exemplo.com" },
    "transactions": { "payments": [{
      "amount": "814.94",
      "payment_method": { "id": "pix", "type": "bank_transfer" }
    }]}
  }'
```

Resposta (201), campos que importam:

```jsonc
{
  "id": "ORD01M0DW0CJ1QGRJP9KM4MHHFM8S",     // id da ORDER (ULID)
  "status": "action_required",
  "status_detail": "waiting_transfer",        // aguardando o Pix ser pago
  "external_reference": "diag2",
  "transactions": { "payments": [{
    "id": "PAY01M0DW0CJA5GXQ3M22H5JB1N84",   // id do PAGAMENTO (ULID)
    "amount": "1.00",
    "date_of_expiration": "2026-08-20T20:39:17.584+00:00",
    "status": "action_required",
    "status_detail": "waiting_transfer",
    "payment_method": {
      "id": "pix", "type": "bank_transfer",
      "qr_code": "00020126580014br.gov.bcb.pix0136 92d60646-…",  // copia e cola
      "qr_code_base64": "iVBORw0KGgo…",                          // PNG do QR
      "ticket_url": "https://www.mercadopago.com.br/payments/…/ticket?…"
    }
  }]}
}
```

O `qr_code` carrega a chave Pix `92d60646-2c97-4cf6-a96c-391b8086fbdf` — a que a cliente cadastrou.
Ou seja: o dinheiro cai na conta certa.

---

## 3. É só o Pix que precisa mudar?

**Sim — e por enquanto é só o Pix que *consegue* mudar.**

| Método | `/v1/payments` (hoje) | `/v1/orders` | Ação |
|---|---|---|---|
| **Pix** | 403 PolicyAgent | ✅ **funciona, provado** | migrar |
| Cartão | 403 PolicyAgent | ❌ `400 invalid_transaction_amount` | **não migrar agora** |
| Boleto | 403 PolicyAgent | não testado | não usamos |

Sobre o cartão: tentei R$ 1,00, R$ 10,00 e R$ 814,94, com e sem `payer.identification`,
`first_name`/`last_name` e `statement_descriptor`. Todas devolveram
`400 invalid_transaction_amount — "The transaction amount is outside the valid range for available
payment methods."` **Não é o valor**: `GET /v1/payment_methods` mostra `master/visa/elo credit_card`
com `min=0.5 max=60000`. Pode ser detalhe de payload que não descobri, ou limitação da conta.
**Não foi provado que funciona — não prometa que funciona.**

Consequência prática: depois desta migração a loja vende por **Pix**. Cartão volta quando o
endereço da conta for corrigido (aí `/v1/payments` destrava sozinho, sem mexer em código).

---

## 4. O que muda no nosso código

### 4.1 O que NÃO muda

- `pagamentos.provedor_id` é `text` — cabe o ULID `ORD01…` sem migration.
- `conciliarPagamento` (`src/repositories/conciliacao.ts`) — continua sendo o único caminho que
  move `pedidos.status` e escreve comissão. **Não toque.**
- `abrirPagamento` / a linha em `pagamentos` criada antes da chamada, que dá a chave de
  idempotência estável.
- Todo o checkout, cupom, frete, retirada.

### 4.2 Criar a cobrança

**Arquivo:** `src/lib/mercadopago.ts`

Hoje `criarPagamentoMP` monta o corpo de `/v1/payments` e faz `chamar('/v1/payments', …)`.
Acrescente uma função irmã para Pix — **não reescreva a de cartão**, ela continua valendo para
quando a conta destravar:

```ts
export async function criarOrderPixMP(
  e: { valor: Centavos; referenciaExterna: string; pagador: PagadorMP },
  chaveIdempotencia: string,
): Promise<{ orderId: string; qrCode: string; qrCodeBase64: string; ticketUrl: string; status: string }>
```

Pontos de atenção medidos:

- **`total_amount` e `amount` vão como STRING decimal** (`"814.94"`), não número, não centavos.
  A conversão de `Centavos` continua sendo a única fronteira onde dinheiro deixa de ser inteiro —
  hoje isso está documentado em `criarPagamentoMP`; repita lá.
- **`notification_url` NÃO é aceito no corpo.** Testado:
  `400 unsupported_properties — additionalProperties '$.notification_url' not allowed`.
  As notificações vão para a URL configurada no painel do Mercado Pago (já está configurada, com
  o segredo de assinatura). `urlDeNotificacao()` deixa de ser usada neste caminho.
- Mande `X-Idempotency-Key` igual hoje (`pagamentos.id`).
- Erros continuam caindo em `ErroMercadoPago` / `falhaDoProvedor` — o corpo de erro da Orders usa
  `errors: [{code, message}]`, e não `{message, code}`. **`chamar()` precisa aprender esse formato**,
  senão o log some (`'erro sem mensagem'`).

### 4.3 Ler o status de volta

**`GET /v1/orders/{id}` funciona.**
**`GET /v1/payments/{PAY01…}` NÃO funciona** — testado, devolve `resource not found`. O id ULID do
pagamento não existe na API de pagamentos.

Então `buscarPagamentoMP` não serve para uma cobrança criada via Orders. Precisa de
`buscarOrderMP(orderId)` batendo em `/v1/orders/{id}`.

### 4.4 O webhook — **a parte mais delicada**

**Arquivo:** `src/app/api/webhooks/mercadopago/route.ts`

Hoje ele lê `type` (query string ou corpo) e `data.id`, valida a assinatura HMAC
(`id:{data.id};request-id:{x-request-id};ts:{ts};`), grava em `webhook_eventos`, relê pela API e
chama `conciliarPagamento`.

O que muda:

1. O tópico da notificação passa a ser **`order`** (hoje tratamos `payment`). Mantenha os dois: o
   cartão, quando destravar, volta a notificar como `payment`.
2. `data.id` virá o id da **order**, e a releitura tem que ir em `/v1/orders/{id}`.
3. **A validação de assinatura provavelmente continua igual** — mas isso **NÃO foi testado**,
   porque não consegui gerar uma notificação real de order. Confira antes de confiar: se a
   assinatura falhar, o webhook responde 401 e o pedido nunca é conciliado.
4. `mapearStatusMP` (`src/lib/pedido-status.ts`) fala o vocabulário de `/v1/payments`
   (`approved`, `pending`, `rejected`, `cancelled`, `refunded`, `authorized`). A Orders usa
   **outro vocabulário**: vimos `action_required` / `waiting_transfer` para "aguardando pagamento".
   **Os valores de pagamento aprovado/recusado NÃO foram observados** — não deu para pagar um Pix
   de verdade em produção. Descubra na doc oficial ou pagando um Pix de R$ 0,01, e escreva um
   `mapearStatusOrder` separado. **Não adivinhe e não reaproveite `mapearStatusMP`.**

> Regra do repositório que vale aqui: `mapearStatusMP` é o único lugar que conhece strings do
> provedor. Se surgir um segundo vocabulário, ele ganha uma segunda função no mesmo módulo — não
> um `if` espalhado pelas rotas.

### 4.5 A tela

**Arquivo:** `src/components/pagamento.tsx`

Hoje o Pix já renderiza QR e copia-e-cola a partir da resposta de `/api/pagamentos`. Os campos
mudam de nome (`qr_code` / `qr_code_base64` dentro de `payment_method`), mas a tela em si continua
a mesma. **Não é preciso usar o `ticket_url`** — temos QR próprio, e mandar a compradora para uma
página do Mercado Pago no meio do checkout é pior.

---

## 5. Ordem sugerida

1. `criarOrderPixMP` + `buscarOrderMP` em `src/lib/mercadopago.ts`, com `chamar()` entendendo o
   formato de erro `errors: []`.
2. `/api/pagamentos` desvia para a Orders quando `metodo === 'pix'`; cartão fica onde está.
3. `mapearStatusOrder` — **depois de descobrir os valores reais**, não antes.
4. Webhook aceita o tópico `order` e relê por `/v1/orders/{id}`.
5. Testes: os de `/api/pagamentos` e do webhook, mais um do mapeamento novo.
6. Teste de ponta a ponta em produção: crie um pedido, pague o Pix de verdade com um valor baixo,
   confirme que o pedido vira `pago` e que a comissão foi lançada. **Faça isso antes do dia 25.**

---

## 6. O que não esquecer

- **Assinatura do webhook para o tópico `order` não foi verificada.** É o maior risco desta
  migração: se falhar, a cobrança acontece e o pedido nunca é marcado como pago.
- **Cartão continua bloqueado.** Enquanto o endereço da conta não entrar, a loja vende só por Pix.
  Isso precisa estar claro para a cliente.
- **Corrigir o endereço continua sendo o certo.** A migração para Orders é o desvio que permite
  vender no dia 25; ela não substitui arrumar a conta.
- As credenciais deste projeto já circularam em chat. **Rotacione depois do lançamento.**

## 7. Como reproduzir tudo isto

O access token de produção está nos secrets do deploy e no `.env` da VPS. Com ele:

```bash
# o bloqueio
curl -s -X POST https://api.mercadopago.com/v1/payments \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: t1" \
  -d '{"transaction_amount":1.00,"description":"t","payment_method_id":"pix",
       "payer":{"email":"t@e.com","identification":{"type":"CPF","number":"39053344705"}}}'
# → 403 PA_UNAUTHORIZED_RESULT_FROM_POLICIES

# o desvio que funciona
curl -s -X POST https://api.mercadopago.com/v1/orders \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: t2" \
  -d '{"type":"online","total_amount":"1.00","external_reference":"t",
       "processing_mode":"automatic","payer":{"email":"t@e.com"},
       "transactions":{"payments":[{"amount":"1.00",
         "payment_method":{"id":"pix","type":"bank_transfer"}}]}}'
# → 201 com qr_code, qr_code_base64 e ticket_url

# o estado da conta
curl -s https://api.mercadopago.com/users/me -H "Authorization: Bearer $TOKEN"
# → status.billing.allow === false enquanto o endereço não entrar
```

Desde 20/08/2026 há um script que faz tudo isto de uma vez, com relatório:

```bash
export MERCADOPAGO_ACCESS_TOKEN=$(cat /root/.milagran-mp-access-token)   # na VPS
node scripts/diagnostico-mercadopago.mjs
```

---

## 8. O que aconteceu em 20/08/2026

Tudo nesta seção foi **medido contra a produção**, com o token real, a partir da VPS. O comando
que reproduz é `node scripts/diagnostico-mercadopago.mjs`.

### 8.1 O bloqueio da §1 acabou

| Medição | Resultado |
|---|---|
| `GET /users/me` | `status.billing.allow = false`, `codes: ["address_pending"]`, `address` vazio — **igual a ontem** |
| `POST /v1/payments` Pix R$ 0,01 | ✅ **201**, `pending` / `pending_waiting_transfer`, com QR code utilizável |
| `POST /v1/payments` cartão (sonda) | ✅ **400 `Invalid card_token_id`** — e **não** 403 do PolicyAgent |
| `POST /v1/orders` Pix R$ 0,01 | ✅ 201, `action_required` / `waiting_transfer`, com QR |

A sonda de cartão é o dado que fecha a questão: manda-se um token deliberadamente inválido e
lê-se **de quem vem a recusa**. Se o PolicyAgent ainda bloqueasse, ele recusaria *antes* de olhar
o cartão (403 `PA_UNAUTHORIZED_RESULT_FROM_POLICIES`). Veio 400 falando do token. **O
PolicyAgent liberou.** A sonda não cria cobrança em nenhum dos dois desfechos.

> **`status.billing.allow` continua `false` e isso não impede vender.** O flag é cosmético; quem
> decide é a API respondendo. Não use esse campo para diagnosticar "a loja consegue cobrar?" —
> use o script.

### 8.2 O webhook está entregando — e a assinatura passa

Este era o maior risco em aberto de toda a §4.4, e ele foi resolvido por observação, não por
argumento. As duas cobranças de teste geraram notificação real, e o log do container mostrou:

```
[webhook-mp] pagamento sem pedido correspondente: 173837993235
[webhook-mp] pagamento sem pedido correspondente: 173839154781
```

Para chegar nessa linha a notificação teve que: chegar na URL certa, **passar na validação HMAC**
(senão seria 401), passar na deduplicação, e ser **relida pela API do Mercado Pago**. Só parou em
"sem pedido correspondente" — que é o comportamento correto para uma cobrança avulsa, sem pedido.

**O caminho `/v1/payments` está provado ponta a ponta em produção.** É o único que está.

### 8.3 A decisão: o Pix ficou onde estava

Com o bloqueio removido, migrar deixou de ser conserto e passou a ser risco. O Pix continua
saindo por `criarPagamentoMP` (`/v1/payments`), no checkout e no balcão.

**Por quê:** o tópico `payment` tem entrega comprovada nesta conta; o tópico `order` **não chega**.
Adotar a Orders a cinco dias do lançamento trocaria um risco conhecido e resolvido por um não
medido — e a forma de falhar é a pior possível: a cobrança acontece, o dinheiro entra, e o pedido
nunca vira `pago`.

Bônus da decisão: cartão e Pix voltam a falar **um vocabulário só**, e o cartão vende de novo.

#### E a decisão foi confirmada por medição, depois do deploy

Com o código novo já em produção — que **aceita** o tópico `order` e gravaria a linha em
`webhook_eventos` — uma order real foi criada em 20/08/2026 às 13:08. Resultado:

```
SELECT count(*) FROM webhook_eventos WHERE tipo = 'order';   -->  0
```

Nada, nem depois de dois minutos e meio. A notificação de `payment` da **mesma rodada** chegou em
menos de um segundo:

```
 payment | 173845163753 | 2026-08-20 13:08:22.973268-03
```

**O evento `order` não está marcado no painel do Mercado Pago.** Se a migração tivesse sido feita,
cada Pix teria sido criado e nunca confirmado: a compradora pagaria, o dinheiro entraria, e o
pedido ficaria em `aguardando_pagamento` para sempre — sem um erro em log sequer. Era exatamente o
risco que a §4.4 apontou como "o maior desta migração", e ele era real.

### 8.4 O que ficou no repositório, desligado

Escrito, testado e **fora do caminho crítico** — nenhuma rota chama:

| O quê | Onde |
|---|---|
| `criarOrderPixMP` / `buscarOrderMP` | `src/lib/mercadopago.ts` |
| `mapearStatusOrder(status, statusDetail)` | `src/lib/pedido-status.ts` |
| Testes do contrato da Orders (15) | `src/lib/__tests__/mercadopago-orders.test.ts` |
| Testes do vocabulário (13) | `src/lib/__tests__/pedido-status.test.ts` |
| Testes do webhook no tópico `order` (7) | `src/app/api/__tests__/webhook-mp-route.test.ts` |

O vocabulário de `mapearStatusOrder` saiu da documentação oficial (páginas *Status da order* e
*Status da transação*), com `action_required`/`waiting_transfer` confirmado por medição:

| Order | Vira | Por quê |
|---|---|---|
| `processed` / `accredited` | `aprovado` | o dinheiro entrou |
| `processed` / `partially_refunded` | `aprovado` | estorno parcial não desfaz a venda — é o que `/v1/payments` já faz |
| `created` | `pendente` | criada, não processada |
| `action_required` / `waiting_transfer`, `waiting_payment`, `waiting_retry`, `pending_challenge` | `pendente` | estado em que todo Pix nasce |
| `action_required` / `waiting_capture` | `em_analise` | autorizado e não capturado — não é dinheiro nosso |
| `processing`, `in_review` | `em_analise` | análise de risco / revisão manual |
| `charged_back` / `in_process` | `em_analise` | disputa aberta: segurar em vez de estornar |
| `charged_back` / `settled`, `reimbursed` | `estornado` | o valor voltou |
| `refunded` | `estornado` | — |
| `canceled` / `cancelled` | `cancelado` | a Orders escreve com um L; `/v1/payments` com dois |
| `expired`, `failed` | `recusado` | ver abaixo |
| qualquer outro | `null` | fila de `processado_em NULL`, inspeção humana |

**`expired` → `recusado`, e não `cancelado`.** `cancelado` é **terminal** (`TRANSICOES.cancelado`
é vazio) e `/api/pagamentos` só aceita pedido em `pendente` ou `aguardando_pagamento`. Um Pix
gerado à noite e não pago cancelaria o pedido, e a compradora que voltasse no dia seguinte
encontraria a loja recusando o próprio pedido dela, sem saída.

### 8.5 O que MUDOU no caminho que está no ar

Duas correções que valem independentemente da Orders, e que ficam:

1. **`chamar()` aprendeu o formato `errors: [{code, message}]`.** Antes, um erro nesse formato
   chegava ao log como `desconhecido: erro sem mensagem` — foi assim que a causa real da parada
   de 19/08 ficou invisível por horas. Os três formatos que o Mercado Pago usa agora são lidos.
2. **O webhook não entra mais em laço de reentrega com id ULID.** Uma order Pix contém um
   pagamento com id `PAY01…` que **não existe** em `/v1/payments/{id}`. Se o Mercado Pago
   notificar esse id no tópico `payment`, a releitura falha, o handler responde 503 pedindo
   reenvio, e o provedor reenvia **em laço por horas**, escondendo as notificações que importam.
   Agora o tópico `payment` só é tratado com `data.id` numérico (ids de `/v1/payments` sempre
   são); ULID responde 200 e é ignorado.

O webhook também passou a **aceitar** o tópico `order`. Ele não chega hoje; aceitar de antemão
evita que ligar a saída de emergência vire dois deploys encadeados com pagamento perdido no meio.

### 8.6 Para ligar a Orders API, se o bloqueio voltar

Nesta ordem. Pular o passo 1 é o erro caro.

1. **Marcar o evento `order`** no painel: *Suas integrações → a aplicação → Webhooks*. **Medido em
   20/08/2026: hoje ele NÃO está marcado.** Sem isso **nenhuma** notificação de Pix chega, e não há
   erro em lugar nenhum — só pedidos parados em `aguardando_pagamento`. Depois de marcar, confirme
   criando uma order e conferindo `SELECT * FROM webhook_eventos WHERE tipo = 'order'`.
2. Trocar `criarPagamentoMP` por `criarOrderPixMP` no ramo do Pix, **e `mapearStatusMP` por
   `mapearStatusOrder` junto**, nos **dois** arquivos: `src/app/api/pagamentos/route.ts` e
   `src/app/api/vendas-presenciais/route.ts`.
3. `node scripts/diagnostico-mercadopago.mjs --criar --aguardar`, pagar o Pix, e conferir que o
   par de status impresso é o que `mapearStatusOrder` lê como `aprovado`.
4. Fazer um pedido de verdade na loja, pagar, e confirmar **três coisas**: o pedido virou `pago`,
   a comissão foi lançada, e o e-mail de confirmação saiu.

### 8.7 O que continua pendente

- **Corrigir o endereço da conta.** `address_pending` continua lá. Hoje não bloqueia nada, mas
  foi ele que derrubou a loja em 19/08 e nada garante que o Mercado Pago não reaperte. A correção
  é em *Seu perfil → Informações do seu perfil (Dados do negócio)* — **não** na agenda de entrega
  ("Endereços salvos na sua conta"), que é outra tela.
- **Um pedido real pago ponta a ponta.** O webhook está provado até a releitura; o que ainda não
  foi visto é um pedido de verdade indo a `pago` com comissão lançada e e-mail enviado.
- **Rotacionar as credenciais.** Já circularam em chat.
- **Duas cobranças de R$ 0,01 pendentes** ficaram do diagnóstico (`173837993235` e
  `173839154781`, mais a order `ORD01M0FWG5SD5NYTAJY8CR1STYHB`). Expiram sozinhas.
