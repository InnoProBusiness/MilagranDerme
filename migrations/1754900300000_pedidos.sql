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
  -- representantes.rep_percentual_valido NAO cobre esta coluna: o snapshot
  -- vem da aplicacao, nao e copiado pelo banco. Sem este CHECK o banco
  -- aceitava 500.00 — e como pedido_atribuicao_imutavel_trg proibe UPDATE
  -- nesta coluna, um valor errado gravado aqui fica permanentemente
  -- incorrigivel.
  CONSTRAINT pedido_percentual_snapshot_valido CHECK (
    percentual_comissao_snapshot IS NULL
    OR (percentual_comissao_snapshot >= 0 AND percentual_comissao_snapshot <= 100)
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

-- A ATRIBUICAO CONGELADA e uma promessa de escrita (o repositorio so grava
-- uma vez), nao uma garantia do banco: um UPDATE direto na linha, fora do
-- repositorio, conseguia reatribuir um pedido ja feito para outro
-- representante e reescrever o percentual — e, pior, ao mudar o
-- representante_id para outra pessoa, o ON DELETE RESTRICT parava de
-- enxergar o pedido como dependente do representante original, liberando a
-- exclusao dele e apagando o historico da venda. Este trigger fecha os dois
-- problemas de uma vez: nenhuma coluna congelada pode mudar depois da
-- criacao, entao o representante original nunca fica sem pedido para o
-- RESTRICT proteger. status/pago_em/entregue_em ficam de fora de proposito:
-- a maquina de estados do pedido e o webhook de pagamento (Plano 3) tem que
-- poder mudar essas colunas livremente.
CREATE FUNCTION pedido_impedir_alteracao_congelada() RETURNS trigger AS $$
BEGIN
  IF NEW.representante_id IS DISTINCT FROM OLD.representante_id THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna representante_id nao pode ser alterada apos a criacao do pedido';
  END IF;
  IF NEW.percentual_comissao_snapshot IS DISTINCT FROM OLD.percentual_comissao_snapshot THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna percentual_comissao_snapshot nao pode ser alterada apos a criacao do pedido';
  END IF;
  IF NEW.origem IS DISTINCT FROM OLD.origem THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna origem nao pode ser alterada apos a criacao do pedido';
  END IF;
  IF NEW.utm_source IS DISTINCT FROM OLD.utm_source THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna utm_source nao pode ser alterada apos a criacao do pedido';
  END IF;
  IF NEW.utm_medium IS DISTINCT FROM OLD.utm_medium THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna utm_medium nao pode ser alterada apos a criacao do pedido';
  END IF;
  IF NEW.utm_campaign IS DISTINCT FROM OLD.utm_campaign THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna utm_campaign nao pode ser alterada apos a criacao do pedido';
  END IF;
  IF NEW.subtotal_centavos IS DISTINCT FROM OLD.subtotal_centavos THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna subtotal_centavos nao pode ser alterada apos a criacao do pedido';
  END IF;
  IF NEW.desconto_centavos IS DISTINCT FROM OLD.desconto_centavos THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna desconto_centavos nao pode ser alterada apos a criacao do pedido';
  END IF;
  IF NEW.frete_centavos IS DISTINCT FROM OLD.frete_centavos THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna frete_centavos nao pode ser alterada apos a criacao do pedido';
  END IF;
  IF NEW.total_centavos IS DISTINCT FROM OLD.total_centavos THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna total_centavos nao pode ser alterada apos a criacao do pedido';
  END IF;
  IF NEW.numero IS DISTINCT FROM OLD.numero THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna numero nao pode ser alterada apos a criacao do pedido';
  END IF;
  IF NEW.criado_em IS DISTINCT FROM OLD.criado_em THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna criado_em nao pode ser alterada apos a criacao do pedido';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pedido_atribuicao_imutavel_trg
  BEFORE UPDATE ON pedidos
  FOR EACH ROW
  EXECUTE FUNCTION pedido_impedir_alteracao_congelada();

-- Down Migration
DROP TABLE pedidos;
DROP FUNCTION pedido_impedir_alteracao_congelada();
DROP TYPE origem_atribuicao;
DROP TYPE pedido_status;
