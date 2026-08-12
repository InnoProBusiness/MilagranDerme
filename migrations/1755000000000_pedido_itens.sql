-- migrations/1755000000000_pedido_itens.sql
-- Up Migration
CREATE TABLE pedido_itens (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id                uuid NOT NULL REFERENCES pedidos (id) ON DELETE CASCADE,
  kit_id                   uuid NOT NULL REFERENCES kits (id) ON DELETE RESTRICT,
  -- Snapshot do catalogo no momento da compra. Nunca recalculado.
  nome_snapshot            text        NOT NULL,
  preco_unitario_centavos  integer     NOT NULL,
  quantidade               smallint    NOT NULL,
  total_centavos           integer     NOT NULL,
  criado_em                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT item_quantidade_positiva CHECK (quantidade > 0),
  CONSTRAINT item_preco_positivo      CHECK (preco_unitario_centavos > 0),
  CONSTRAINT item_total_confere       CHECK (total_centavos = preco_unitario_centavos * quantidade)
);

CREATE INDEX pedido_itens_pedido ON pedido_itens (pedido_id);
-- Um kit aparece uma vez por pedido; quantidade e coluna, nao linha repetida.
CREATE UNIQUE INDEX pedido_itens_kit_unico ON pedido_itens (pedido_id, kit_id);

-- Pedido sem item nao existe, e subtotal e a soma dos itens — nao um numero
-- que a aplicacao mandou. A comissao incide sobre este valor.
ALTER TABLE pedidos ADD CONSTRAINT pedido_subtotal_positivo CHECK (subtotal_centavos > 0);

CREATE FUNCTION pedido_conferir_subtotal() RETURNS trigger AS $$
DECLARE
  soma integer;
  esperado integer;
BEGIN
  SELECT subtotal_centavos INTO esperado
    FROM pedidos WHERE id = COALESCE(NEW.pedido_id, OLD.pedido_id);

  -- ON DELETE CASCADE apaga o pedido primeiro e SO DEPOIS os seus itens
  -- (a acao de cascade e um trigger AFTER DELETE na tabela referenciada);
  -- quando este trigger, deferido ao COMMIT, finalmente dispara para os
  -- itens apagados em cascata, o SELECT acima ja nao encontra o pedido e
  -- "esperado" vem NULL. Isso NAO e uma divergencia de subtotal — e apagar
  -- o pedido levando os itens junto, o comportamento esperado (ver teste
  -- "apagar o pedido leva os itens junto"). Sem este IF, toda exclusao de
  -- um pedido com itens dispararia esta excecao.
  IF esperado IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(total_centavos), 0) INTO soma
    FROM pedido_itens WHERE pedido_id = COALESCE(NEW.pedido_id, OLD.pedido_id);

  IF soma IS DISTINCT FROM esperado THEN
    RAISE EXCEPTION
      'pedido_subtotal_confere: subtotal do pedido e % mas a soma dos itens e %',
      esperado, soma;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- CONSTRAINT TRIGGER DEFERRABLE: a checagem roda no COMMIT, nao a cada
-- INSERT. Sem isso seria impossivel inserir o pedido e depois seus itens
-- dentro da mesma transacao — o primeiro INSERT ja falharia.
CREATE CONSTRAINT TRIGGER pedido_subtotal_confere_trg
  AFTER INSERT OR UPDATE OR DELETE ON pedido_itens
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pedido_conferir_subtotal();

-- Down Migration
DROP TRIGGER pedido_subtotal_confere_trg ON pedido_itens;
DROP FUNCTION pedido_conferir_subtotal();
ALTER TABLE pedidos DROP CONSTRAINT pedido_subtotal_positivo;
DROP TABLE pedido_itens;
