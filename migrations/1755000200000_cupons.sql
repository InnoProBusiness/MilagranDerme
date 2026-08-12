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
