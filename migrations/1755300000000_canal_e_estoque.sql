-- migrations/1755300000000_canal_e_estoque.sql
-- Up Migration

-- CANAL DA VENDA. Eixo PROPRIO, deliberadamente separado de pedidos.origem.
--
-- `pedidos.origem` (migrations/1754900300000_pedidos.sql) parece "de onde veio
-- a venda", mas nao e: e ATRIBUICAO DE COMISSAO. O CHECK
-- pedido_origem_coerente amarra cada valor daquele ENUM a presenca ou
-- ausencia de representante_id ('casa' e 'rep_inativo' sem representante,
-- 'link' e 'cupom' com). Acrescentar 'presencial' la dentro obrigaria a
-- afrouxar esse CHECK e a comissao pararia de ser garantida pelo banco.
--
-- Canal responde outra pergunta: por qual balcao o kit saiu. Uma venda
-- presencial de um representante e 'presencial' NO CANAL e 'link' NA ORIGEM
-- ao mesmo tempo, e as duas coisas precisam ser verdade juntas.
CREATE TYPE canal_venda AS ENUM ('presencial', 'online');

-- Os quatro fatos que mexem em estoque:
--   entrada  reposicao / carga inicial (positivo, sem pedido)
--   baixa    unidade saiu por uma venda paga (negativo, sempre com pedido)
--   estorno  a venda caiu (reembolso/cancelamento) e a unidade voltou
--            (positivo, sempre com o mesmo pedido da baixa)
--   ajuste   correcao de inventario feita a mao pelo admin (qualquer sinal,
--            sem pedido) — perda, quebra, contagem que nao bateu
CREATE TYPE movimento_estoque AS ENUM ('entrada', 'baixa', 'estorno', 'ajuste');

CREATE TABLE estoques (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE RESTRICT: kit com estoque nao pode ser apagado, so desativado
  -- (ativo = false). Apagar levaria junto o historico de movimentos.
  kit_id        uuid NOT NULL REFERENCES kits (id) ON DELETE RESTRICT,
  canal         canal_venda NOT NULL,
  -- true = pre-venda sem teto (canal online, decisao do cliente em
  -- 16/08/2026). Quando true, baixarEstoque (src/repositories/estoque.ts) NAO
  -- recusa por saldo: registra o movimento para o painel e segue. Quando
  -- false, o saldo e teto rigido e a baixa que passaria de zero levanta
  -- EstoqueInsuficienteError.
  --
  -- O DEFAULT e false de proposito: um estoque criado sem ninguem pensar no
  -- assunto nasce com teto, porque prometer unidade que nao existe custa
  -- caro e vender de menos so custa uma venda.
  ilimitado     boolean NOT NULL DEFAULT false,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- UM estoque por kit e canal. E tambem a chave do ON CONFLICT do seed
-- (migrations/1755300700000_seed_estoque.sql): sem este indice, aquele
-- INSERT ... ON CONFLICT (kit_id, canal) nem compila, e rodar o seed duas
-- vezes duplicaria a linha de estoque presencial — o saldo do evento passaria
-- a depender de qual das duas linhas a consulta pegou primeiro.
CREATE UNIQUE INDEX estoque_kit_canal_unico ON estoques (kit_id, canal);

-- Mesmo motivo de kits_tocar_atualizado_em
-- (migrations/1754900100000_produtos.sql): sem o trigger, "atualizado_em
-- NOT NULL DEFAULT now()" congela na criacao e a coluna mente para sempre.
-- Aqui ela responde "quando alguem virou o teto deste canal", que e
-- exatamente a pergunta que se faz quando o painel mostra um numero
-- inesperado no dia do evento. Funcao propria, e nao reuso da de kits, para
-- que o rollback de produtos nao arraste o trigger desta tabela junto.
CREATE FUNCTION estoques_tocar_atualizado_em() RETURNS trigger AS $$
BEGIN
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER estoques_atualizado_em_trg
  BEFORE UPDATE ON estoques
  FOR EACH ROW
  EXECUTE FUNCTION estoques_tocar_atualizado_em();

-- LIVRO-RAZAO DE ESTOQUE, no mesmo molde do livro-razao de comissao
-- (migrations/1755200100000_comissoes.sql).
--
-- NAO existe coluna de saldo em lugar nenhum. Disponivel e SUM(quantidade)
-- sobre estas linhas — sempre derivado, nunca guardado. Um contador mantido a
-- mao e a origem classica do estoque que nao fecha: basta um caminho de
-- escrita esquecer de atualiza-lo (o webhook do Mercado Pago tem varios) e o
-- numero corrompe em silencio, sem ninguem conseguir dizer depois qual dos
-- dois esta certo. No dia 25/08 esse numero e o que decide se o proximo
-- comprador da fila leva kit ou nao.
CREATE TABLE estoque_movimentos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estoque_id  uuid NOT NULL REFERENCES estoques (id) ON DELETE RESTRICT,
  -- NULL em entrada e em ajuste: esses lancamentos nao nascem de uma venda.
  -- Obrigatorio em baixa e estorno — ver movimento_pedido_coerente abaixo,
  -- que e o que sustenta os indices de idempotencia.
  pedido_id   uuid REFERENCES pedidos (id) ON DELETE RESTRICT,
  tipo        movimento_estoque NOT NULL,
  -- ASSINADO. entrada/estorno/ajuste positivo sobe, baixa e sempre negativo.
  -- Assim o saldo e uma soma direta, sem CASE por tipo espalhado por toda
  -- consulta. Corrigir um lancamento errado = lancar o oposto ('ajuste'),
  -- nunca editar a linha (ver o trigger append-only no fim do arquivo).
  quantidade  integer NOT NULL,
  -- Texto curto para o painel ("Estoque de lancamento presencial",
  -- "Pedido #1042", "Quebra na conferencia"). Nao e chave de nada.
  motivo      text NOT NULL DEFAULT '',
  criado_em   timestamptz NOT NULL DEFAULT now(),

  -- Movimento de zero unidade nao e fato nenhum: so sujaria o extrato e
  -- deixaria o painel mostrando linha sem efeito.
  CONSTRAINT movimento_quantidade_nao_zero CHECK (quantidade <> 0),

  -- O SINAL E PARTE DO TIPO, igual a comissao_sinal_confere. A perna que
  -- carrega a regra e a primeira: baixa SEMPRE negativa. Sem ela, um bug de
  -- sinal na aplicacao viraria uma "baixa" que AUMENTA o disponivel, e o
  -- painel mostraria kits que ja sairam da caixa.
  CONSTRAINT movimento_baixa_negativa CHECK (
    (tipo = 'baixa' AND quantidade < 0) OR (tipo <> 'baixa' AND quantidade <> 0)
  ),
  -- Entrada que nao soma nao e entrada. Carga inicial e reposicao entram por
  -- aqui; perda entra como 'ajuste' negativo, com motivo escrito.
  CONSTRAINT movimento_entrada_positiva CHECK (
    tipo <> 'entrada' OR quantidade > 0
  ),
  -- Estorno devolve a unidade a prateleira, entao sobe. Um estorno negativo
  -- baixaria o kit duas vezes pelo mesmo pedido: a venda caiu e o estoque
  -- ficaria devendo duas unidades que estao paradas no estoque fisico.
  CONSTRAINT movimento_estorno_positivo CHECK (
    tipo <> 'estorno' OR quantidade > 0
  ),
  -- baixa e estorno SEMPRE pertencem a um pedido; entrada e ajuste nunca.
  --
  -- Este CHECK e pre-requisito dos dois indices unicos parciais abaixo: em
  -- Postgres, NULLs sao distintos entre si num indice unico, entao se uma
  -- baixa pudesse ter pedido_id NULL a idempotencia simplesmente nao valeria
  -- para ela — cada reentrega do webhook criaria mais uma linha e o indice
  -- nao reclamaria. Afrouxar isto aqui desliga aquilo la embaixo em silencio.
  CONSTRAINT movimento_pedido_coerente CHECK (
    (tipo IN ('baixa', 'estorno') AND pedido_id IS NOT NULL)
    OR
    (tipo IN ('entrada', 'ajuste') AND pedido_id IS NULL)
  )
);

-- Toda leitura de saldo e "os movimentos deste estoque". E a consulta mais
-- quente do evento: a vitrine e o contador de escassez (§11, polling de 15s)
-- passam por ela.
CREATE INDEX estoque_movimentos_estoque ON estoque_movimentos (estoque_id);

-- IDEMPOTENCIA NO BANCO, nao na aplicacao. O Mercado Pago reenvia a mesma
-- notificacao ate receber 2xx, e duas entregas concorrentes do mesmo
-- "approved" chegam as duas ao INSERT — o SELECT de checagem de uma nao
-- enxerga a linha ainda nao commitada da outra. Sem estes dois indices, cada
-- reenvio de um "approved" baixaria uma unidade a mais do mesmo pedido: 50
-- kits fisicos virariam 40 no painel e o evento fecharia as vendas com kit
-- sobrando na caixa.
--
-- Mesma logica do lado do estorno: um pedido reembolsado duas vezes nao
-- devolve duas unidades ao estoque. E o par exato de
-- comissao_um_credito_por_pedido (migrations/1755200100000_comissoes.sql).
--
-- Sao DOIS indices, e nao um sobre (estoque_id, pedido_id, tipo): a baixa e o
-- estorno do MESMO pedido tem que poder coexistir (vendeu, depois foi
-- reembolsado). O que nao pode e a segunda baixa, ou o segundo estorno.
CREATE UNIQUE INDEX estoque_baixa_unica_por_pedido
  ON estoque_movimentos (estoque_id, pedido_id) WHERE tipo = 'baixa';
CREATE UNIQUE INDEX estoque_estorno_unico_por_pedido
  ON estoque_movimentos (estoque_id, pedido_id) WHERE tipo = 'estorno';

-- LIVRO-RAZAO E APPEND-ONLY, igual a comissoes. Corrigir um movimento errado
-- significa lancar o oposto ('ajuste'), nunca reescrever o original — e o que
-- mantem o historico auditavel e o que impede que o saldo mude por baixo de
-- um numero que a operacao ja viu na tela.
--
-- Sem isto, um UPDATE direto na linha (um script de correcao as pressas no
-- dia do evento, por exemplo) mudaria o disponivel sem deixar rastro de quem
-- mudou nem de quanto era antes, e a conferencia com o estoque fisico no fim
-- do dia perderia a unica fonte confiavel.
--
-- Vale inclusive para a tela de admin: ajustar estoque e INSERT de um
-- movimento 'ajuste', nao edicao da linha antiga.
CREATE FUNCTION estoque_movimento_impedir_alteracao() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'estoque_movimento_append_only: movimento de estoque nao pode ser % — lance um movimento ajuste com o sinal oposto',
    lower(TG_OP);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER estoque_movimento_append_only_trg
  BEFORE UPDATE OR DELETE ON estoque_movimentos
  FOR EACH ROW EXECUTE FUNCTION estoque_movimento_impedir_alteracao();

-- Down Migration
--
-- Ordem obrigatoria: o trigger depende da funcao, a funcao nao pode cair
-- antes dele; estoque_movimentos referencia estoques, entao cai primeiro.
--
-- DROP TYPE canal_venda so passa depois que nenhuma outra tabela usa o tipo.
-- pedidos.canal (migrations/1755300100000_pedidos_canal_logistica.sql) usa —
-- mas o node-pg-migrate desfaz na ordem inversa, entao aquela coluna ja saiu
-- quando este arquivo roda. Se este DROP TYPE falhar reclamando de
-- dependencia, o problema nao e aqui: e uma migration posterior que criou uso
-- do tipo e nao o desfaz.
DROP TRIGGER estoque_movimento_append_only_trg ON estoque_movimentos;
DROP FUNCTION estoque_movimento_impedir_alteracao();
DROP TABLE estoque_movimentos;
DROP TRIGGER estoques_atualizado_em_trg ON estoques;
DROP FUNCTION estoques_tocar_atualizado_em();
DROP TABLE estoques;
DROP TYPE movimento_estoque;
DROP TYPE canal_venda;
