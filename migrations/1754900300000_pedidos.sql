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
