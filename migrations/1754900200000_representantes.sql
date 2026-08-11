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
  estado               varchar(2)  NOT NULL DEFAULT '',
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
  CONSTRAINT rep_slug_formato CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  -- Sem limite, o formato acima aceita um slug de 300 caracteres — que vira
  -- um link impossivel de ditar por telefone ou escrever num story, que e
  -- exatamente como esses links circulam.
  CONSTRAINT rep_slug_tamanho CHECK (length(slug) BETWEEN 2 AND 40)
);

-- Slug NUNCA e reutilizado, nem apos desligamento: o link antigo continua
-- circulando. Por isso a unicidade nao filtra por ativo.
CREATE UNIQUE INDEX rep_slug_unico   ON representantes (slug);
CREATE UNIQUE INDEX rep_codigo_unico ON representantes (codigo);
CREATE UNIQUE INDEX rep_email_unico  ON representantes (lower(email));

-- O indice unico acima garante apenas que duas linhas nao compartilhem o
-- mesmo slug NO MESMO INSTANTE. Ele nao garante o que o comentario acima
-- promete: que o slug nunca seja REUTILIZADO. Um UPDATE renomeando o slug de
-- um representante desligado libera o valor antigo, e o proximo cadastro
-- pode toma-lo — os links que continuam circulando no Instagram passam a
-- creditar outra pessoa, silenciosamente. O mesmo vale para "codigo", que e
-- a chave do cupom do representante (Plano 2).
--
-- Espelha pedido_atribuicao_imutavel_trg (1754900300000_pedidos.sql): a
-- identidade publica e imutavel, todo o resto do cadastro continua editavel
-- pelo admin (nome, email, whatsapp, percentual_comissao, ativo, foto_url,
-- cidade, estado). IS DISTINCT FROM, e nao <>, porque <> devolve NULL quando
-- um dos lados e NULL e a comparacao passaria batida.
CREATE FUNCTION rep_impedir_alteracao_identidade() RETURNS trigger AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'rep_identidade_imutavel: coluna slug nao pode ser alterada apos o cadastro (o link antigo continua circulando)';
  END IF;
  IF NEW.codigo IS DISTINCT FROM OLD.codigo THEN
    RAISE EXCEPTION 'rep_identidade_imutavel: coluna codigo nao pode ser alterada apos o cadastro (o cupom antigo continua circulando)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rep_identidade_imutavel_trg
  BEFORE UPDATE ON representantes
  FOR EACH ROW
  EXECUTE FUNCTION rep_impedir_alteracao_identidade();

-- Down Migration
DROP TABLE representantes;
DROP FUNCTION rep_impedir_alteracao_identidade();
