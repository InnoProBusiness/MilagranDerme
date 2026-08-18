-- migrations/1755500000000_anvisa_dispensa.sql
-- Up Migration

-- DISPENSA DE REGISTRO ANVISA POR PRODUCAO ARTESANAL (Lei n. 15.154/2025).
--
-- Ate aqui o dado tinha dois estados: `anvisa_registro` preenchido (mostra o
-- numero) ou NULL (a vitrine prometia "em breve"). Em 18/08/2026 o cliente
-- declarou o enquadramento do kit na Lei 15.154/2025, que isenta de registro
-- previo cosmeticos produzidos de maneira artesanal — e "em breve" virou uma
-- promessa de numero que nunca vai existir. Este terceiro estado registra a
-- dispensa como FATO DECLARADO, nao como ausencia de dado.
--
-- POR QUE UMA COLUNA NOVA, e nao um valor magico dentro de anvisa_registro:
-- o registro e um NUMERO emitido pela agencia; a dispensa e um STATUS legal.
-- Misturar os dois na mesma coluna faria "DISPENSADO" parecer um numero de
-- registro para qualquer consulta, exportacao ou tela futura que nao conheca
-- a convencao.
--
-- DEFAULT false DE PROPOSITO: dispensa e afirmacao juridica, e um kit novo
-- cadastrado amanha NAO pode nascer fazendo essa afirmacao em silencio. Quem
-- cadastrar um produto novo decide conscientemente entre registrar, declarar
-- a dispensa ou deixar o "em breve" honesto no ar.
--
-- O QUE A LEI REALMENTE DIZ (para quem reler isto depois): a Lei 15.154/2025
-- acrescenta o par. 2 ao art. 27 da Lei 6.360/76 — isencao de registro "na
-- forma de regulamento" da Anvisa, que define os criterios de enquadramento
-- (RDC + IN com a lista de grupos de produtos elegiveis; consultas publicas
-- 1352 e 1353 de out/2025). A minuta define artesanal como pequena escala,
-- processo predominantemente manual e baixo risco microbiologico, com venda
-- direta ao consumidor final. A fiscalizacao sanitaria CONTINUA. O
-- enquadramento e declaracao do cliente, nao verificacao deste sistema.
ALTER TABLE kits ADD COLUMN anvisa_dispensado boolean NOT NULL DEFAULT false;

-- Escopado ao kit do lancamento pelo slug, como toda alteracao de dado deste
-- projeto: um kit futuro nao herda a declaracao.
UPDATE kits
   SET anvisa_dispensado = true,
       atualizado_em     = now()
 WHERE slug = 'kit-milagran';

-- Down Migration
ALTER TABLE kits DROP COLUMN anvisa_dispensado;
