-- migrations/1755300600000_kit_dimensoes.sql
-- Up Migration
--
-- Peso e dimensoes do kit. A cotacao de frete do Clube Envios (secao 13 do
-- documento de 16/08/2026) exige os quatro valores no corpo da requisicao, e
-- o cadastro de kits (1754900100000_produtos.sql) nunca os teve. Sem estas
-- colunas a rota de cotacao teria que inventar numeros no lugar do cadastro
-- — que e exatamente o que este projeto nao faz com nada que vire dinheiro.
--
-- =====================================================================
-- OS DEFAULTS ABAIXO SAO PALPITE DECLARADO, NAO MEDIDA.
--
-- Ninguem pesou nem mediu o kit. 500 g, 12 x 16 x 20 cm sao estimativas
-- escritas em 16/08/2026 para que o sistema funcione de ponta a ponta, e
-- nao dados de expedicao.
--
-- PESO E DIMENSOES PRECISAM SER CONFERIDOS COM A EXPEDICAO ANTES DE
-- 25/08/2026. Nao "quando der": antes do lancamento, porque a partir dele
-- todo pedido online e cotado com o que estiver gravado aqui.
--
-- O que quebra se ninguem conferir: valor errado nestas colunas e frete
-- errado saindo do bolso da Milagran em TODO pedido online. Se o kit real
-- for mais pesado ou maior que o palpite, a cotacao mostrada ao comprador
-- sai abaixo do custo real, o comprador paga o valor menor, a
-- transportadora cobra o valor verdadeiro e a diferenca some da margem —
-- por pedido, em silencio, sem nenhum erro em nenhum log. Se for menor, o
-- frete sai caro e derruba conversao. Os dois lados custam dinheiro; so um
-- deles da para descobrir olhando a tela.
--
-- E nao ha conserto depois: pedidos.frete_centavos e total_centavos sao
-- congelados por pedido_atribuicao_imutavel_trg
-- (1754900300000_pedidos.sql), entao um pedido cotado com dimensao errada
-- fica errado para sempre. O unico momento de acertar e antes do INSERT.
--
-- Mesmo estilo de divida deliberada visivel do anvisa_registro em
-- 1755000300000_seed_kit.sql: preferimos um valor explicito, comentado e
-- rastreavel a um campo vazio que ninguem sabe que existe.
-- =====================================================================
--
-- A UNIDADE ESTA NO NOME DA COLUNA de proposito, e ela e contrato com
-- src/lib/frete.ts: o corpo da cotacao manda peso em GRAMAS e medidas em
-- CENTIMETROS. Uma coluna chamada so "peso" convida a gravar 0,5 (kg) onde
-- o consumidor espera 500 (g) — um fator de mil no frete, sem erro de tipo
-- nem de compilacao. E a mesma familia de armadilha que o tipo Centavos de
-- src/lib/money.ts existe para fechar.
--
-- NOT NULL com DEFAULT, e nao NULL, tambem de proposito: um kit sem
-- dimensao obrigaria a cotacao a escolher entre falhar ou assumir zero, e
-- zero produziria um frete falsamente barato. Palpite visivel e melhor que
-- buraco. Vale hoje mesmo para o kit ja semeado ('kit-milagran',
-- 1755000300000_seed_kit.sql), que herda os quatro valores nesta migration:
-- e o kit que sera vendido em 25/08 e ele esta, neste instante, carregando o
-- palpite.
ALTER TABLE kits ADD COLUMN peso_gramas    integer  NOT NULL DEFAULT 500;
ALTER TABLE kits ADD COLUMN altura_cm      smallint NOT NULL DEFAULT 12;
ALTER TABLE kits ADD COLUMN largura_cm     smallint NOT NULL DEFAULT 16;
ALTER TABLE kits ADD COLUMN comprimento_cm smallint NOT NULL DEFAULT 20;

-- Positividade estrita, nunca >= 0. Zero nao e uma medida plausivel de
-- caixa: seria um erro de digitacao (ou um campo de formulario vazio virando
-- 0) chegando ate a transportadora como se fosse dado, e uma dimensao zerada
-- e justamente a que zera o calculo de peso cubado sem levantar suspeita.
ALTER TABLE kits ADD CONSTRAINT kits_peso_positivo        CHECK (peso_gramas > 0);
ALTER TABLE kits ADD CONSTRAINT kits_altura_positiva      CHECK (altura_cm > 0);
ALTER TABLE kits ADD CONSTRAINT kits_largura_positiva     CHECK (largura_cm > 0);
ALTER TABLE kits ADD CONSTRAINT kits_comprimento_positivo CHECK (comprimento_cm > 0);

-- Down Migration
--
-- DROP COLUMN leva junto o CHECK que depende da coluna, entao nao ha
-- ALTER TABLE ... DROP CONSTRAINT aqui: escrever os dois faria o segundo
-- falhar por constraint inexistente e derrubar o rollback inteiro.
ALTER TABLE kits DROP COLUMN comprimento_cm;
ALTER TABLE kits DROP COLUMN largura_cm;
ALTER TABLE kits DROP COLUMN altura_cm;
ALTER TABLE kits DROP COLUMN peso_gramas;
