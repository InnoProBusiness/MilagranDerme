-- migrations/1755400000000_kit_medidas_reais.sql
-- Up Migration

-- MEDIDA REAL, NAO MAIS PALPITE.
--
-- migrations/1755300600000_kit_dimensoes.sql semeou 500 g e 12x16x20 cm com o
-- comentario dizendo, com todas as letras, que era palpite declarado e que o
-- numero certo tinha que vir da balanca antes do lancamento. Veio em
-- 17/08/2026: o kit embalado pesa 760 g e a caixa fechada mede 18 x 23 x 6 cm.
--
-- A caixa e ACHATADA, nao cubica: 6 cm de altura contra os 20 do palpite. O
-- volume real (2.484 cm3) e MENOR que o suposto (3.840 cm3), enquanto o peso e
-- MAIOR. O palpite errava para os dois lados ao mesmo tempo e, no saldo,
-- cobrava de MENOS — cotacoes reais feitas no mesmo dia, do CEP de origem
-- 74693158:
--
--                     Sao Paulo     Belo Horizonte   Manaus
--   palpite           R$ 29,39      R$ 26,35         R$ 34,99
--   medida real       R$ 31,50      R$ 28,22         R$ 34,99
--
-- Cerca de R$ 2 por pedido saindo da margem, em silencio, porque
-- pedidos.frete_centavos e congelado no INSERT pelo trigger de imutabilidade e
-- nao tem correcao depois da venda.
--
-- COMO OS TRES EIXOS FORAM ATRIBUIDOS: comprimento recebe a maior medida (23),
-- largura a intermediaria (18) e altura a menor (6). Para o preco isso e
-- indiferente — a transportadora cobra pelo produto das tres, o peso cubado —,
-- mas os Correios validam minimos por eixo (comprimento >= 16, largura >= 11,
-- altura >= 2) e uma atribuicao invertida poderia reprovar a postagem no
-- balcao com a etiqueta ja emitida.
--
-- O DEFAULT DA COLUNA MUDA JUNTO com a linha existente, de proposito: sem
-- isso, um kit novo cadastrado amanha nasceria com o palpite de volta, e o
-- banco de CI (que nasce vazio a cada rodada) continuaria testando contra um
-- numero que nao existe mais no mundo.
ALTER TABLE kits ALTER COLUMN peso_gramas    SET DEFAULT 760;
ALTER TABLE kits ALTER COLUMN altura_cm      SET DEFAULT 6;
ALTER TABLE kits ALTER COLUMN largura_cm     SET DEFAULT 18;
ALTER TABLE kits ALTER COLUMN comprimento_cm SET DEFAULT 23;

-- Escopado ao kit do lancamento pelo slug: um kit futuro com medida propria
-- nao pode ser sobrescrito por esta migration ao rodar num banco ja povoado.
UPDATE kits
   SET peso_gramas    = 760,
       altura_cm      = 6,
       largura_cm     = 18,
       comprimento_cm = 23,
       atualizado_em  = now()
 WHERE slug = 'kit-milagran';

-- Down Migration
ALTER TABLE kits ALTER COLUMN peso_gramas    SET DEFAULT 500;
ALTER TABLE kits ALTER COLUMN altura_cm      SET DEFAULT 12;
ALTER TABLE kits ALTER COLUMN largura_cm     SET DEFAULT 16;
ALTER TABLE kits ALTER COLUMN comprimento_cm SET DEFAULT 20;

UPDATE kits
   SET peso_gramas    = 500,
       altura_cm      = 12,
       largura_cm     = 16,
       comprimento_cm = 20,
       atualizado_em  = now()
 WHERE slug = 'kit-milagran';
