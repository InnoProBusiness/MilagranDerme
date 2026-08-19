# Migrar o Pix para a API de Orders do Mercado Pago

**Data:** 19/08/2026 · **Lançamento:** 25/08/2026 · **Urgência:** a loja não cobra nada hoje.

Este documento é um handoff. Tudo abaixo foi **medido contra a API de produção**, não lido em
documentação. Onde algo não foi provado, está escrito que não foi.

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
