-- migrations/1755000100000_clientes.sql
-- Up Migration
CREATE TABLE clientes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text        NOT NULL,
  email         text        NOT NULL,
  cpf           text        NOT NULL,
  whatsapp      text        NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cliente_email_formato CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- Guardado so com digitos. A formatacao e responsabilidade da interface.
  CONSTRAINT cliente_cpf_digitos    CHECK (cpf ~ '^[0-9]{11}$')
);

-- Identidade do cliente para o limite de uso de cupom por pessoa.
-- lower(email) porque o valor armazenado mantem a caixa que a pessoa digitou.
CREATE UNIQUE INDEX cliente_email_unico ON clientes (lower(email));
CREATE INDEX cliente_cpf ON clientes (cpf);

-- Mesmo raciocinio de kits_tocar_atualizado_em (migrations/1754900100000_produtos.sql):
-- sem este trigger, "atualizado_em NOT NULL DEFAULT now()" congela na data
-- de criacao e a coluna passa a mentir para sempre. clientes guarda CPF,
-- e-mail, telefone e endereco de uma pessoa real e agora e mutavel por mais
-- de um caminho (ver salvarClienteComEndereco), entao "quando isso mudou" e
-- informacao que precisa continuar verdadeira. Ao contrario de
-- rep_antes_de_atualizar (representantes), nada em clientes e imutavel —
-- este trigger nao tem a metade de trava de identidade.
CREATE FUNCTION clientes_tocar_atualizado_em() RETURNS trigger AS $$
BEGIN
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clientes_atualizado_em_trg
  BEFORE UPDATE ON clientes
  FOR EACH ROW
  EXECUTE FUNCTION clientes_tocar_atualizado_em();

CREATE TABLE enderecos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  uuid NOT NULL REFERENCES clientes (id) ON DELETE CASCADE,
  cep         text        NOT NULL,
  rua         text        NOT NULL,
  numero      text        NOT NULL,
  complemento text        NOT NULL DEFAULT '',
  bairro      text        NOT NULL,
  cidade      text        NOT NULL,
  estado      varchar(2)  NOT NULL,
  criado_em   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT endereco_cep_digitos CHECK (cep ~ '^[0-9]{8}$'),
  CONSTRAINT endereco_uf_valida   CHECK (estado ~ '^[A-Z]{2}$')
);

CREATE INDEX enderecos_cliente ON enderecos (cliente_id);

ALTER TABLE pedidos ADD COLUMN cliente_id  uuid REFERENCES clientes (id) ON DELETE RESTRICT;
ALTER TABLE pedidos ADD COLUMN endereco_id uuid REFERENCES enderecos (id) ON DELETE RESTRICT;

-- Down Migration
ALTER TABLE pedidos DROP COLUMN endereco_id;
ALTER TABLE pedidos DROP COLUMN cliente_id;
DROP TABLE enderecos;
DROP TRIGGER clientes_atualizado_em_trg ON clientes;
DROP FUNCTION clientes_tocar_atualizado_em();
DROP TABLE clientes;
