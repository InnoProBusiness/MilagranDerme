-- migrations/1755000300000_seed_kit.sql
-- Up Migration
--
-- Preco definido pelo cliente em 12/08/2026: R$ 1.000,00 por kit, linear
-- por quantidade (3 kits = R$ 3.000,00, sem desconto por volume).
--
-- anvisa_registro fica NULL de proposito. O numero real ainda nao foi
-- fornecido, e a pagina do produto mostra "em breve" enquanto for NULL.
-- Cosmetico sem regularizacao exibida nao pode ser vendido no Brasil: isto
-- e divida visivel, nao um campo esquecido.
INSERT INTO kits (slug, nome, descricao, preco_centavos, unidades, sku, anvisa_registro, ativo, ordem)
VALUES (
  'kit-milagran',
  'Kit Milagran',
  'Kit de limpeza de pele instantanea.',
  100000,
  1,
  'MG-KIT-001',
  NULL,
  true,
  1
)
ON CONFLICT (slug) DO NOTHING;

-- Down Migration
--
-- Isto so roda limpo antes da primeira venda real. pedido_itens.kit_id
-- referencia kits sem CASCADE, entao assim que existir um pedido com este
-- kit, este DELETE levanta uma violacao de chave estrangeira e o rollback
-- inteiro falha aqui. Isso e o comportamento correto (apagar um kit vendido
-- silenciosamente destruiria o historico do pedido) — se voce esta lendo
-- isto durante um rollback as 2h da manha, o erro nao e uma migration
-- quebrada: e o sistema recusando apagar um produto que ja foi vendido.
-- A saida nesse caso e desativar o kit (ativo = false), nao apagar a linha.
DELETE FROM kits WHERE slug = 'kit-milagran';
