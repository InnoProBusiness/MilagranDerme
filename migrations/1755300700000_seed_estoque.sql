-- migrations/1755300700000_seed_estoque.sql
-- Up Migration
--
-- Estoque de lancamento definido pelo cliente em 16/08/2026 (§2 e §4):
--
--   presencial  50 kits, TETO RIGIDO. O que esta na caixa do evento e o que
--               existe. A 51a venda presencial tem que ser recusada, e nao
--               virar kit prometido para alguem que veio pessoalmente.
--   online      SEM teto. E pre-venda: o pedido online e enviado depois do
--               lancamento (AVISO_PRE_VENDA em src/lib/tempo.ts), entao nao
--               ha caixa fisica limitando a venda.
--
-- As duas linhas existem mesmo com politicas opostas porque o canal online
-- ainda precisa de um lugar onde os movimentos dele sejam registrados: o
-- painel de §17 mostra "quanto ja foi vendido online" lendo exatamente esses
-- movimentos. `ilimitado = true` desliga a RECUSA por saldo em
-- baixarEstoque (src/repositories/estoque.ts), nao a contabilidade.
--
-- O SELECT ... FROM kits WHERE slug = 'kit-milagran' amarra ao seed de
-- migrations/1755000300000_seed_kit.sql. Se aquele kit nao existir, estes
-- INSERTs inserem zero linhas sem erro — e o seed do movimento abaixo
-- tambem, porque ele parte de `estoques`. Nada de estoque orfao.
INSERT INTO estoques (kit_id, canal, ilimitado)
  SELECT id, 'presencial', false FROM kits WHERE slug = 'kit-milagran'
  ON CONFLICT (kit_id, canal) DO NOTHING;

INSERT INTO estoques (kit_id, canal, ilimitado)
  SELECT id, 'online', true FROM kits WHERE slug = 'kit-milagran'
  ON CONFLICT (kit_id, canal) DO NOTHING;

-- A entrada de 50 unidades e um MOVIMENTO, nao uma coluna de saldo: o
-- disponivel do presencial e SUM(quantidade) sobre estoque_movimentos
-- (migrations/1755300000000_canal_e_estoque.sql). Semear um numero em coluna
-- de saldo seria criar justamente o contador paralelo que aquela migration
-- existe para nao ter.
--
-- A idempotencia aqui NAO pode ser ON CONFLICT: nao ha chave unica para
-- entrada, e nem deve haver — reposicao e uma segunda entrada legitima no
-- mesmo estoque. O guarda e "este estoque ainda nao teve entrada nenhuma",
-- que e verdade uma unica vez na vida da linha. Rodar a migration de novo
-- depois de uma reposicao real nao re-semeia os 50; rodar de novo antes de
-- qualquer movimento tambem nao, porque a propria entrada do seed ja conta.
--
-- Trocar este NOT EXISTS por um ON CONFLICT DO NOTHING sem chave, ou
-- remove-lo achando que "a migration so roda uma vez", coloca 50 kits
-- fantasmas no painel no dia do evento — o node-pg-migrate garante uma
-- execucao por banco, e um banco restaurado de dump antes da tabela de
-- migrations nao garante nada.
INSERT INTO estoque_movimentos (estoque_id, tipo, quantidade, motivo)
  SELECT e.id, 'entrada', 50, 'Estoque de lancamento presencial 25/08/2026'
  FROM estoques e JOIN kits k ON k.id = e.kit_id
  WHERE k.slug = 'kit-milagran' AND e.canal = 'presencial'
  AND NOT EXISTS (
    SELECT 1 FROM estoque_movimentos m
    WHERE m.estoque_id = e.id AND m.tipo = 'entrada'
  );

-- O canal online NAO recebe entrada, de proposito. `ilimitado = true` faz o
-- saldo deixar de ser teto, entao uma entrada la seria um numero sem
-- significado nenhum — e pior, apareceria no painel como "total disponivel
-- online", que e uma quantidade que ninguem prometeu e ninguem tem.

-- Down Migration
--
-- Desfaz o SEED, e recusa quando o que esta no banco ja nao e so o seed.
--
-- estoque_movimentos e append-only: o trigger
-- estoque_movimento_append_only_trg levanta excecao em qualquer DELETE, e
-- isso e o comportamento certo para o codigo da aplicacao. Um rollback de
-- migration e o unico lugar do projeto autorizado a desliga-lo, porque aqui
-- a intencao nao e corrigir um lancamento (isso se faz com um movimento
-- 'ajuste'), e sim remover linhas que esta migration inventou. DISABLE
-- TRIGGER exige ser dono da tabela: roda com o mesmo papel do DIRECT_URL que
-- criou tudo em 1755300000000_canal_e_estoque.sql, e so com ele.
--
-- Antes de desligar qualquer coisa, o bloco abaixo conta os movimentos que
-- NAO sao o seed. Se existir algum, o rollback para com erro legivel: essas
-- linhas sao vendas, estornos e conferencias reais, e apaga-las destruiria o
-- historico que o livro-razao existe para guardar. A saida correta nesse
-- caso e zerar o estoque com um movimento 'ajuste', nunca reverter esta
-- migration.
--
-- Vale dizer o que esta recusa NAO cobre, para nao dar falsa seguranca: o
-- DROP TABLE do Down de 1755300000000_canal_e_estoque.sql leva o historico
-- inteiro junto sem reclamar. Este bloco e o ponto do rollback em que a
-- decisao ainda pode ser tomada com o tamanho do estrago na frente.
DO $$
DECLARE
  movimentos_reais integer;
BEGIN
  SELECT count(*) INTO movimentos_reais
    FROM estoque_movimentos m
    JOIN estoques e ON e.id = m.estoque_id
    JOIN kits     k ON k.id = e.kit_id
   WHERE k.slug = 'kit-milagran'
     AND NOT (
       m.tipo = 'entrada'
       AND m.pedido_id IS NULL
       AND m.motivo = 'Estoque de lancamento presencial 25/08/2026'
     );

  IF movimentos_reais > 0 THEN
    RAISE EXCEPTION
      'seed_estoque_rollback_recusado: % movimento(s) de estoque alem do seed — desfazer apagaria historico de venda; zere o saldo com um movimento ajuste em vez de reverter esta migration',
      movimentos_reais;
  END IF;
END;
$$;

ALTER TABLE estoque_movimentos DISABLE TRIGGER estoque_movimento_append_only_trg;

DELETE FROM estoque_movimentos m
  USING estoques e, kits k
  WHERE m.estoque_id = e.id AND e.kit_id = k.id AND k.slug = 'kit-milagran';

ALTER TABLE estoque_movimentos ENABLE TRIGGER estoque_movimento_append_only_trg;

-- Segundo guarda, este vindo do banco e nao de contagem nossa: estoques e
-- referenciada por estoque_movimentos com ON DELETE RESTRICT. Se por algum
-- caminho ainda restar movimento, este DELETE falha com violacao de chave
-- estrangeira em vez de deixar linha orfa para tras.
DELETE FROM estoques e
  USING kits k
  WHERE e.kit_id = k.id AND k.slug = 'kit-milagran';
