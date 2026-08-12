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
DELETE FROM kits WHERE slug = 'kit-milagran';
