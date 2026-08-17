-- migrations/1755300100000_pedidos_canal_logistica.sql
-- Up Migration
--
-- CANAL DA VENDA E RASTREIO DA ENTREGA.
--
-- CONFLITO com o Plano 1. `pedidos.origem` PARECE ser "de onde veio a venda"
-- (o requisito §17 pede exatamente isso), e o caminho curto seria acrescentar
-- 'presencial' ao ENUM origem_atribuicao. NAO E a mesma coisa. `origem` e
-- ATRIBUICAO DE COMISSAO: o CHECK pedido_origem_coerente
-- (migrations/1754900300000_pedidos.sql) amarra cada valor a presenca ou
-- ausencia de representante_id ('link'/'cupom' exigem representante,
-- 'casa'/'rep_inativo' proibem), e quem decide o valor e src/lib/atribuicao.ts
-- a partir do cookie e do cupom. Um 'presencial' nesse ENUM nao teria lado
-- nenhum nesse CHECK e obrigaria a afrouxa-lo — quer dizer, afrouxar a unica
-- garantia de banco que impede pedido com representante sem percentual
-- congelado, e vice-versa.
--
-- Canal e um eixo PROPRIO e ORTOGONAL: uma venda no balcao do evento pode
-- perfeitamente ser atribuida a um representante ('link') ou a casa ('casa'),
-- e uma venda online tambem. Os dois eixos convivem na mesma linha sem se
-- tocar.
--
-- DEFAULT 'online': todo pedido que existe hoje nasceu no checkout web, entao
-- o backfill das linhas antigas ja esta correto por construcao. O DEFAULT
-- tambem e o que permite o NOT NULL sem reescrever a tabela (Postgres 11+
-- guarda o default de coluna nova no catalogo; ver docker-compose.yml, que
-- fixa a versao 14 igual a de producao).
--
-- O DEFAULT PERMANECE depois do backfill, e a escolha do valor importa:
-- criarPedido (src/repositories/pedidos.ts) sempre informa o canal, mas um
-- INSERT que esquecesse cai em 'online' — que e de onde vem todo pedido de
-- todo caminho de escrita que existia antes deste plano. O canal de balcao e
-- o novo, e o novo e o que tem que declarar o que e; e ele que puxa do
-- estoque de teto rigido de 50 unidades e que aparece separado no relatorio
-- de §17, entao ninguem deve conseguir cair nele por omissao.
ALTER TABLE pedidos ADD COLUMN canal canal_venda NOT NULL DEFAULT 'online';

-- LOGISTICA. Estas quatro colunas sao o oposto das colunas congeladas abaixo:
-- elas nascem vazias e sao preenchidas DEPOIS da criacao do pedido, conforme a
-- entrega anda. Sao escritas por registrarRastreio/avancarStatusDoPedido
-- (src/repositories/pedidos.ts) a partir da tela /admin/logistica.
--
-- prazo_dias_estimado e a excecao parcial: ele ja chega preenchido na criacao,
-- vindo da cotacao do Clube Envios (src/lib/frete.ts), mas continua editavel —
-- transportadora troca de prazo, e um numero errado na tela de logistica tem
-- que poder ser corrigido. E ESTIMATIVA, nao promessa contratual: nao ha CHECK
-- amarrando ele a enviado_em nem a entregue_em de proposito.
ALTER TABLE pedidos ADD COLUMN rastreio_codigo          text;
ALTER TABLE pedidos ADD COLUMN rastreio_transportadora  text;
-- Carimbado por avancarStatusDoPedido na ENTRADA em 'enviado'. Fica NULL para
-- venda presencial, que vai de 'pago' direto a 'entregue' sem Correios (§2).
ALTER TABLE pedidos ADD COLUMN enviado_em               timestamptz;
ALTER TABLE pedidos ADD COLUMN prazo_dias_estimado      smallint;

-- Prazo zero ou negativo e sempre erro de leitura da resposta da cotacao —
-- src/lib/frete.ts prefere lancar CotacaoIlegivelError a chutar um numero, e
-- este CHECK e a rede embaixo dessa decisao: se algum dia um caminho novo
-- gravar 0 aqui, a pagina do pedido mostraria "entrega em 0 dias" ao
-- comprador. Esta constraint NAO e NOT VALID (ao contrario da de baixo): a
-- coluna acabou de nascer, toda linha existente tem NULL, e a varredura de
-- validacao encontra a tabela ja em conformidade.
ALTER TABLE pedidos ADD CONSTRAINT pedido_prazo_valido
  CHECK (prazo_dias_estimado IS NULL OR prazo_dias_estimado > 0);

-- NOT VALID DE PROPOSITO, e nao por preguica.
--
-- endereco_id nasceu opcional em migrations/1755000100000_clientes.sql, entao
-- existem pedidos antigos com endereco_id NULL. Um ADD CONSTRAINT normal varre
-- a tabela inteira e ABORTA a migration na primeira linha violadora — o deploy
-- inteiro cairia por causa de dado historico que ninguem vai voltar a
-- consertar, e a migration ficaria impossivel de aplicar em producao enquanto
-- essas linhas existissem.
--
-- NOT VALID pula so a varredura do passado. A regra passa a valer para toda
-- linha NOVA e para todo UPDATE de linha antiga, que e exatamente o que
-- importa daqui para frente: a partir de agora, pedido online sem endereco de
-- entrega e recusado pelo banco, nao apenas pela rota.
--
-- Se um dia a operacao limpar o historico, `ALTER TABLE pedidos VALIDATE
-- CONSTRAINT pedido_online_tem_endereco` promove a constraint a validada sem
-- reescrever a tabela e sem bloquear escrita.
ALTER TABLE pedidos ADD CONSTRAINT pedido_online_tem_endereco
  CHECK (canal = 'presencial' OR endereco_id IS NOT NULL) NOT VALID;

-- FUNCAO REESCRITA INTEIRA, nao estendida.
--
-- A versao original vive em migrations/1754900300000_pedidos.sql (que ja foi
-- aplicada em producao e por isso NUNCA e editada — mesma regra registrada em
-- migrations/1755100000000_pedido_token.sql). CREATE OR REPLACE substitui o
-- corpo; o trigger pedido_atribuicao_imutavel_trg continua apontando para o
-- mesmo nome de funcao e passa a executar este corpo sem ser recriado.
-- Copiar TODAS as verificacoes antigas nao e redundancia: o que nao estiver
-- aqui deixa de ser protegido no instante em que esta migration roda.
--
-- O QUE MUDA: `canal` entra na lista de colunas congeladas. Canal e fato
-- consumado da venda, igual a origem — um UPDATE trocando 'presencial' por
-- 'online' num pedido ja fechado reescreveria o relatorio por canal (§17),
-- mudaria de qual estoque aquela unidade saiu (o presencial tem teto rigido de
-- 50, o online nao tem teto) e faria a constraint pedido_online_tem_endereco
-- passar a exigir um endereco que a venda de balcao nunca teve.
--
-- O QUE NAO ENTRA: rastreio_codigo, rastreio_transportadora, enviado_em e
-- prazo_dias_estimado. A logistica precisa escreve-los depois da criacao; se
-- entrassem aqui, /admin/logistica nao conseguiria gravar um codigo de
-- rastreio nenhum.
CREATE OR REPLACE FUNCTION pedido_impedir_alteracao_congelada() RETURNS trigger AS $$
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
  IF NEW.canal IS DISTINCT FROM OLD.canal THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna canal nao pode ser alterada apos a criacao do pedido';
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

-- Down Migration
--
-- A funcao volta a ser EXATAMENTE a de migrations/1754900300000_pedidos.sql —
-- sem a verificacao de `canal`, que nem coluna e mais depois dos DROPs abaixo.
-- Ela vem PRIMEIRO: enquanto o corpo antigo nao estiver instalado, qualquer
-- UPDATE em pedidos executaria um trigger que le NEW.canal numa tabela que
-- acabou de perder a coluna, e o erro seria "record new has no field canal",
-- nao um erro de negocio.
CREATE OR REPLACE FUNCTION pedido_impedir_alteracao_congelada() RETURNS trigger AS $$
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

ALTER TABLE pedidos DROP CONSTRAINT pedido_online_tem_endereco;
ALTER TABLE pedidos DROP CONSTRAINT pedido_prazo_valido;
ALTER TABLE pedidos DROP COLUMN prazo_dias_estimado;
ALTER TABLE pedidos DROP COLUMN enviado_em;
ALTER TABLE pedidos DROP COLUMN rastreio_transportadora;
ALTER TABLE pedidos DROP COLUMN rastreio_codigo;
ALTER TABLE pedidos DROP COLUMN canal;
