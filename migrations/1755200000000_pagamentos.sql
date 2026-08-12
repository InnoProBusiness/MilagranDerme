-- migrations/1755200000000_pagamentos.sql
-- Up Migration

-- Metodos definidos com o cliente: Pix e cartao parcelado. Boleto ficou de
-- fora do lancamento (abandono alto e compensacao em ate 3 dias uteis, o que
-- atrasaria a liberacao da comissao do representante). Adicionar 'boleto'
-- aqui depois e um ALTER TYPE ... ADD VALUE, sem reescrever tabela.
CREATE TYPE metodo_pagamento AS ENUM ('pix', 'cartao');

-- Espelha os estados do Mercado Pago, traduzidos. O mapeamento de
-- payment.status do MP para este ENUM e unico e vive em
-- src/lib/pedido-status.ts — nunca espalhado por rota.
--
--   pending    -> pendente      (Pix emitido, aguardando o pagador)
--   in_process -> em_analise    (antifraude do cartao segurou)
--   approved   -> aprovado
--   rejected   -> recusado
--   cancelled  -> cancelado     (expirou ou foi cancelado antes de pagar)
--   refunded   -> estornado
--   charged_back -> estornado   (chargeback: mesmo efeito financeiro)
CREATE TYPE pagamento_status AS ENUM (
  'pendente', 'em_analise', 'aprovado', 'recusado', 'cancelado', 'estornado'
);

CREATE TABLE pagamentos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id     uuid NOT NULL REFERENCES pedidos (id) ON DELETE RESTRICT,

  provedor      text NOT NULL DEFAULT 'mercadopago',
  -- Id do pagamento no provedor. NULL apenas na janela entre criar esta
  -- linha (para ter uma chave de idempotencia estavel) e receber a resposta
  -- do provedor. Ver o comentario de idempotencia abaixo.
  provedor_id   text,

  metodo        metodo_pagamento NOT NULL,
  status        pagamento_status NOT NULL DEFAULT 'pendente',
  valor_centavos integer NOT NULL,
  -- 1 para Pix e para cartao a vista.
  parcelas      smallint NOT NULL DEFAULT 1,

  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pagamento_valor_positivo CHECK (valor_centavos > 0),
  CONSTRAINT pagamento_parcelas_validas CHECK (parcelas BETWEEN 1 AND 12),
  -- Pix nao parcela. Sem isto, um corpo malformado gravaria "Pix em 10x".
  CONSTRAINT pagamento_pix_nao_parcela CHECK (metodo <> 'pix' OR parcelas = 1)
);

-- A CHAVE DE IDEMPOTENCIA DO WEBHOOK. O Mercado Pago reenvia a mesma
-- notificacao ate receber 2xx, e reenvia tambem quando o status muda. Sem
-- este indice, dois reenvios simultaneos criariam duas linhas para o mesmo
-- pagamento — e o credito de comissao sairia duas vezes.
CREATE UNIQUE INDEX pagamento_provedor_unico
  ON pagamentos (provedor, provedor_id)
  WHERE provedor_id IS NOT NULL;

CREATE INDEX pagamentos_pedido ON pagamentos (pedido_id);

-- Um pedido pode ter varias tentativas (cartao recusado, cliente tenta Pix),
-- mas SO UMA aprovada. Este indice parcial e o que impede cobrar duas vezes
-- o mesmo pedido e, por consequencia, creditar comissao em dobro.
CREATE UNIQUE INDEX pagamento_um_aprovado_por_pedido
  ON pagamentos (pedido_id)
  WHERE status = 'aprovado';

-- Log cru das notificacoes recebidas. Existe por tres razoes: idempotencia
-- (o UNIQUE abaixo), auditoria (a spec, secao 33, pede log de eventos), e
-- diagnostico — quando um pagamento nao bate, o payload original e a unica
-- fonte que nao foi reinterpretada por nos.
CREATE TABLE webhook_eventos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provedor      text NOT NULL DEFAULT 'mercadopago',
  -- x-request-id do provedor. E o identificador da ENTREGA, nao do pagamento:
  -- duas notificacoes sobre o mesmo pagamento (pendente e depois aprovado)
  -- tem request-ids diferentes, e as duas precisam ser processadas.
  evento_id     text NOT NULL,
  tipo          text NOT NULL,
  recurso_id    text,
  payload       jsonb NOT NULL,
  recebido_em   timestamptz NOT NULL DEFAULT now(),
  processado_em timestamptz
);

-- Reentrega da MESMA notificacao (mesmo x-request-id) e descartada. E o que
-- torna o handler seguro para o retry automatico do Mercado Pago.
CREATE UNIQUE INDEX webhook_evento_unico ON webhook_eventos (provedor, evento_id);
CREATE INDEX webhook_eventos_recurso ON webhook_eventos (provedor, recurso_id);

-- Down Migration
DROP TABLE webhook_eventos;
DROP TABLE pagamentos;
DROP TYPE pagamento_status;
DROP TYPE metodo_pagamento;
