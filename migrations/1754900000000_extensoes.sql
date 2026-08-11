-- migrations/1754900000000_extensoes.sql
-- Up Migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Down Migration
DROP EXTENSION IF EXISTS pgcrypto;
