-- migrations/1755300500000_pagamentos_atualizado_em.sql
-- Up Migration
--
-- CORRIGE UM DESVIO REAL DA CONVENCAO DA CASA.
--
-- Toda tabela deste banco que tem atualizado_em tem tambem um trigger BEFORE
-- UPDATE que carimba a coluna: kits_tocar_atualizado_em
-- (migrations/1754900100000_produtos.sql), clientes_tocar_atualizado_em
-- (1755000100000_clientes.sql) e rep_antes_de_atualizar
-- (1754900200000_representantes.sql, que faz isso alem da trava de
-- identidade). pagamentos (1755200000000_pagamentos.sql) era a UNICA excecao:
-- ganhou a coluna com DEFAULT now() e ficou sem trigger nenhum.
--
-- E justamente a tabela onde "quando mudou" mais importa. A linha de
-- pagamento nasce 'pendente' e e reescrita ao longo do ciclo de vida pelo
-- webhook do Mercado Pago — 'em_analise' quando o antifraude do cartao
-- segura, 'aprovado', 'recusado', 'estornado' depois de um chargeback. O
-- resto do banco so guarda o estado FINAL: quando um pagamento nao bate com
-- o pedido, "a que horas este pagamento virou aprovado" e a primeira
-- pergunta do diagnostico, e sem o carimbo a resposta e um encolher de
-- ombros.
--
-- Hoje a aplicacao compensa a mao: vincularAoProvedor e
-- atualizarStatusPorProvedorId (src/repositories/pagamentos.ts) passam
-- `atualizado_em: new Date()` em cada .set(). Isso funciona exatamente
-- enquanto todo caminho de escrita futuro lembrar de repetir o campo — e o
-- proximo que esquecer nao quebra teste nenhum, so faz a coluna comecar a
-- mentir em silencio, que e o pior modo de falha possivel para um dado de
-- auditoria. Com o trigger, a coluna passa a ser do BANCO e nao da
-- aplicacao: ele sobrescreve inclusive um valor informado na propria UPDATE,
-- igual ao molde de kits. As chamadas existentes continuam validas e podem
-- ficar como estao; elas simplesmente deixam de ser a garantia.
--
-- Efeito colateral desejado: o instante passa a vir do relogio do Postgres
-- (now() = inicio da transacao) e nao do relogio do container Node. Duas
-- linhas escritas na mesma transacao de conciliacao passam a carregar o
-- mesmo instante, e a linha do tempo reconstruida no diagnostico deixa de
-- depender de dois relogios concordarem.
--
-- NAO ha backfill aqui de proposito. As linhas ja existentes tem
-- atualizado_em = criado_em, o que e honesto: nao sabemos quando elas
-- mudaram. Um UPDATE de correcao carimbaria todas com o instante desta
-- migration e inventaria uma data de alteracao que nunca existiu — trocar
-- "nao sei" por um numero errado e pior do que a ausencia.
CREATE FUNCTION pagamentos_tocar_atualizado_em() RETURNS trigger AS $$
BEGIN
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pagamentos_atualizado_em_trg
  BEFORE UPDATE ON pagamentos
  FOR EACH ROW
  EXECUTE FUNCTION pagamentos_tocar_atualizado_em();

-- Down Migration
DROP TRIGGER pagamentos_atualizado_em_trg ON pagamentos;
DROP FUNCTION pagamentos_tocar_atualizado_em();
