-- migrations/1755100000000_pedido_token.sql
-- Up Migration
--
-- pedidos.numero e um bigint sequencial e /pedido/<numero> (Tarefa 9) e
-- publica, sem autenticacao nenhuma. Sem uma chave nao adivinhavel, andar
-- /pedido/1, /pedido/2, /pedido/3... expõe a contagem de pedidos e o
-- faturamento inteiro da empresa a qualquer visitante — e o Plano 3 vai
-- colocar status de pagamento nessa mesma pagina.
--
-- A tabela "pedidos" ja esta em producao (Plano 1); por isso este e um
-- ALTER TABLE numa migration NOVA, e nao uma edicao em
-- migrations/1754900300000_pedidos.sql ou 1755000000000_pedido_itens.sql,
-- que ja foram aplicadas la.
--
-- numero continua existindo e continua sendo a referencia humana mostrada
-- NA pagina de confirmacao (o "numero do pedido" citado no atendimento) —
-- so deixa de aparecer na URL. token e so a chave de acesso publica.
ALTER TABLE pedidos ADD COLUMN token uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX pedido_token_unico ON pedidos (token);

-- Down Migration
DROP INDEX pedido_token_unico;
ALTER TABLE pedidos DROP COLUMN token;
