-- migrations/1755200100000_comissoes.sql
-- Up Migration

-- LIVRO-RAZAO DE COMISSAO.
--
-- Nao existe coluna "saldo" em lugar nenhum. Saldo e SUM(valor_centavos)
-- sobre estas linhas — sempre derivado, nunca guardado. Um campo de saldo
-- mantido a mao e a origem classica de extrato que nao fecha: qualquer
-- caminho de escrita que esqueca de atualiza-lo corrompe o numero em
-- silencio, e nao ha como saber depois qual dos dois esta certo.
--
-- Os valores sao ASSINADOS. Credito e positivo, estorno e saque sao
-- negativos. Assim o saldo e uma soma direta, sem CASE por tipo espalhado
-- por toda consulta.
CREATE TYPE lancamento_comissao AS ENUM ('credito', 'estorno', 'saque', 'ajuste');

CREATE TABLE comissoes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  representante_id uuid NOT NULL REFERENCES representantes (id) ON DELETE RESTRICT,
  -- NULL em saque e em ajuste manual: esses lancamentos nao nascem de uma
  -- venda especifica.
  pedido_id        uuid REFERENCES pedidos (id) ON DELETE RESTRICT,

  tipo             lancamento_comissao NOT NULL,
  valor_centavos   integer NOT NULL,

  -- Instante a partir do qual este lancamento conta como saldo DISPONIVEL.
  -- Para credito: pago_em + 30 dias (ver DIAS_PARA_LIBERAR_COMISSAO em
  -- src/lib/comissao.ts). Cobre os 7 dias de arrependimento do CDC e a
  -- janela de estorno do cartao.
  --
  -- Para estorno: COPIA o disponivel_em do credito que ele reverte, nunca
  -- now(). Se o credito ainda esta pendente, o estorno tem que anula-lo
  -- DENTRO do pendente; carimbar now() faria o disponivel ficar negativo e o
  -- pendente positivo ao mesmo tempo, para uma venda que simplesmente deixou
  -- de existir.
  disponivel_em    timestamptz NOT NULL,

  -- Texto curto para o extrato do representante ("Pedido #1042", "Saque
  -- solicitado em 12/08"). Nao e chave de nada.
  descricao        text NOT NULL DEFAULT '',
  criado_em        timestamptz NOT NULL DEFAULT now(),

  -- O SINAL E PARTE DO TIPO. Sem isto, um bug de sinal viraria um "estorno"
  -- que credita, e o extrato fecharia com o numero errado sem nada reclamar.
  CONSTRAINT comissao_sinal_confere CHECK (
    (tipo = 'credito' AND valor_centavos > 0) OR
    (tipo = 'estorno' AND valor_centavos < 0) OR
    (tipo = 'saque'   AND valor_centavos < 0) OR
    (tipo = 'ajuste'  AND valor_centavos <> 0)
  ),

  -- Credito e estorno nascem sempre de uma venda; saque, nunca.
  CONSTRAINT comissao_pedido_coerente CHECK (
    (tipo IN ('credito', 'estorno') AND pedido_id IS NOT NULL) OR
    (tipo = 'saque' AND pedido_id IS NULL) OR
    (tipo = 'ajuste')
  )
);

-- A PROTECAO CONTRA COMISSAO EM DOBRO. O webhook do Mercado Pago reenvia a
-- mesma notificacao ate receber 2xx; duas entregas concorrentes do "approved"
-- do mesmo pedido chegariam as duas ao INSERT. Este indice faz a segunda
-- falhar no banco, e nao depender de a aplicacao ter lembrado de checar.
-- Mesma logica para o estorno: um pedido reembolsado duas vezes nao debita
-- duas vezes.
CREATE UNIQUE INDEX comissao_um_credito_por_pedido
  ON comissoes (pedido_id, tipo)
  WHERE tipo IN ('credito', 'estorno');

-- A consulta de saldo e sempre "deste representante, ate/depois deste
-- instante". Indice composto na ordem em que ela filtra.
CREATE INDEX comissoes_saldo ON comissoes (representante_id, disponivel_em);
CREATE INDEX comissoes_pedido ON comissoes (pedido_id);

-- LIVRO-RAZAO E APPEND-ONLY. Corrigir um lancamento errado significa lancar
-- o oposto, nunca reescrever o original — e o que mantem o historico
-- auditavel (spec, secao 33: "logs de acoes administrativas") e o que impede
-- que um extrato ja visto pelo representante mude por baixo dele.
--
-- Vale inclusive para o admin do Plano 5: a tela de ajuste tem que inserir um
-- lancamento 'ajuste', nao editar a linha antiga.
CREATE FUNCTION comissao_impedir_alteracao() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'comissao_append_only: lancamento de comissao nao pode ser % — lance o oposto',
    lower(TG_OP);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER comissao_append_only_trg
  BEFORE UPDATE OR DELETE ON comissoes
  FOR EACH ROW EXECUTE FUNCTION comissao_impedir_alteracao();

-- Down Migration
DROP TRIGGER comissao_append_only_trg ON comissoes;
DROP FUNCTION comissao_impedir_alteracao();
DROP TABLE comissoes;
DROP TYPE lancamento_comissao;
