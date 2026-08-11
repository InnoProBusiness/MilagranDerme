-- migrations/1754900200000_representantes.sql
-- Up Migration
CREATE TABLE representantes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text        NOT NULL,
  codigo               text        NOT NULL,
  nome                 text        NOT NULL,
  email                text        NOT NULL,
  whatsapp             text        NOT NULL DEFAULT '',
  cidade               text        NOT NULL DEFAULT '',
  estado               char(2)     NOT NULL DEFAULT '',
  foto_url             text,
  -- Percentual configuravel POR representante (spec 8). Guardado como
  -- numeric para permitir 12,5% sem perder precisao no cadastro; o calculo
  -- em si acontece em centavos inteiros (ver src/lib/money.ts).
  percentual_comissao  numeric(5,2) NOT NULL DEFAULT 20.00,
  ativo                boolean     NOT NULL DEFAULT true,
  criado_em            timestamptz NOT NULL DEFAULT now(),
  atualizado_em        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rep_percentual_valido CHECK (percentual_comissao >= 0 AND percentual_comissao <= 100),
  -- Slug entra na URL publica: minusculas, numeros e hifen apenas.
  CONSTRAINT rep_slug_formato CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
);

-- Slug NUNCA e reutilizado, nem apos desligamento: o link antigo continua
-- circulando. Por isso a unicidade nao filtra por ativo.
CREATE UNIQUE INDEX rep_slug_unico   ON representantes (slug);
CREATE UNIQUE INDEX rep_codigo_unico ON representantes (codigo);
CREATE UNIQUE INDEX rep_email_unico  ON representantes (lower(email));

-- Down Migration
DROP TABLE representantes;
