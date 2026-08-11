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
