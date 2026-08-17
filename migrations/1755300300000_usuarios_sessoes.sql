-- migrations/1755300300000_usuarios_sessoes.sql
-- Up Migration
--
-- LOGIN PROPRIO POR PESSOA (decisao do cliente em 16/08/2026). Ate aqui o
-- projeto nao tinha autenticacao nenhuma: representantes sao cadastro, nao
-- conta de acesso. O evento de 25/08 precisa de dois papeis distintos — quem
-- vende no balcao e quem ve o faturamento inteiro (§17) — e precisa saber QUEM
-- vendeu cada kit, o que so existe se cada vendedor entrar com a propria
-- credencial.
--
-- 'admin' NAO e um papel a parte de 'vendedor' na hora de checar acesso: quem
-- e admin pode tudo que o vendedor pode. Essa hierarquia mora em exigirPapel
-- (src/lib/guarda.ts), nao aqui — o banco guarda o fato, a aplicacao guarda a
-- regra. Um papel novo ('expedicao', por exemplo) e um ALTER TYPE ADD VALUE
-- depois, sem reescrever tabela.
CREATE TYPE papel_usuario AS ENUM ('admin', 'vendedor');

CREATE TABLE usuarios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text        NOT NULL,
  email         text        NOT NULL,
  -- NUNCA a senha, nem cifrada: hash com sal, sem volta.
  -- Formato: scrypt$N$r$p$<salt b64>$<hash b64>, produzido e conferido por
  -- src/lib/senha.ts. O formato carrega os PROPRIOS parametros de custo — e
  -- por isso que a coluna e text e nao bytea: subir o custo depois (hoje
  -- N=16384, limitado pelos 3.8GB da VPS) nao exige migration nenhuma, os
  -- hashes antigos continuam conferindo com os parametros que trazem escritos
  -- e podem ser regravados no proximo login de cada pessoa.
  senha_hash    text        NOT NULL,
  papel         papel_usuario NOT NULL,
  -- Desligar e mudar isto para false, nunca apagar a linha: pedidos.vendedor_id
  -- e ON DELETE RESTRICT (abaixo) e o historico de quem vendeu o que no evento
  -- tem que sobreviver ao desligamento da pessoa. autenticar()
  -- (src/repositories/usuarios.ts) recusa usuario inativo.
  ativo         boolean     NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),

  -- Mesmo regex de cliente_email_formato (migrations/1755000100000_clientes.sql).
  -- Deliberadamente identico: duas validacoes de e-mail diferentes no mesmo
  -- banco viram duas nocoes de "e-mail valido" e alguem descobre a divergencia
  -- no pior momento. Nao valida existencia — valida forma, que e o que impede
  -- um erro de digitacao virar uma conta em que ninguem consegue entrar.
  CONSTRAINT usuario_email_formato CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

-- lower(email) pelo mesmo motivo de cliente_email_unico: o valor armazenado
-- mantem a caixa que a pessoa digitou, mas login e case-insensitive. Sem o
-- lower() no indice, "Maria@milagran" e "maria@milagran" seriam duas contas
-- distintas e o "esqueci a senha" da operacao acertaria a errada.
-- E indice, e nao so unicidade: e por ele que autenticar() encontra a linha.
CREATE UNIQUE INDEX usuario_email_unico ON usuarios (lower(email));

-- Mesmo raciocinio de clientes_tocar_atualizado_em
-- (migrations/1755000100000_clientes.sql): sem o trigger, "atualizado_em NOT
-- NULL DEFAULT now()" congela na criacao e a coluna mente para sempre. Aqui
-- ela responde "quando esta senha ou este papel mudaram pela ultima vez", que
-- e pergunta de auditoria de acesso, nao enfeite. Ao contrario de
-- rep_antes_de_atualizar (representantes), nada em usuarios e imutavel: nome,
-- e-mail, papel, senha e ativo sao todos editaveis pelo admin.
CREATE FUNCTION usuarios_tocar_atualizado_em() RETURNS trigger AS $$
BEGIN
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER usuarios_atualizado_em_trg
  BEFORE UPDATE ON usuarios
  FOR EACH ROW
  EXECUTE FUNCTION usuarios_tocar_atualizado_em();

-- SESSAO OPACA GUARDADA NO SERVIDOR. Nao ha JWT: o servidor precisa poder
-- encerrar uma sessao no meio do evento (celular do vendedor perdido, por
-- exemplo), e token auto-contido assinado so morre quando expira.
CREATE TABLE sessoes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE, ao contrario do RESTRICT de pedidos.vendedor_id: sessao
  -- nao e historico de negocio, e chave de acesso. Se a conta deixar de
  -- existir, as chaves dela tem que sumir junto — nao ha nada a preservar.
  usuario_id  uuid NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  -- SO O HASH (sha256 hex, hashDoToken em src/lib/sessao.ts). O token cru vive
  -- exclusivamente no cookie do navegador e nunca toca o banco. E a diferenca
  -- entre um vazamento de backup ser um incidente de dados e ser uma sessao
  -- ativa de administrador na mao de quem vazou: com o hash, nao da para
  -- montar o cookie de volta.
  token_hash  text        NOT NULL,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  expira_em   timestamptz NOT NULL,
  -- Logout CARIMBA o instante em vez de apagar a linha: "esta sessao existiu e
  -- foi encerrada as 14h32" e informacao de auditoria, "nao ha linha nenhuma"
  -- nao e. sessaoValida (src/repositories/sessoes.ts) exige
  -- revogada_em IS NULL, entao revogar tem efeito imediato na proxima
  -- requisicao.
  revogada_em timestamptz,

  -- Uma sessao que nasce vencida seria um login que "da certo" e derruba a
  -- pessoa na tela seguinte, sem mensagem de erro em lugar nenhum — o tipo de
  -- bug que so aparece no dia do evento, com fila na frente do balcao. Um erro
  -- de sinal em DURACAO_SESSAO_MS (src/lib/sessao.ts) produz exatamente isso,
  -- e este CHECK o transforma em erro imediato e legivel no login.
  CONSTRAINT sessao_janela_coerente CHECK (expira_em > criado_em)
);

-- Unicidade E caminho de leitura ao mesmo tempo: toda requisicao autenticada
-- busca a sessao por token_hash, entao este indice e percorrido em cada
-- request. A unicidade tambem garante que uma colisao de token (ou um bug que
-- reaproveitasse o mesmo valor) falhe no INSERT em vez de dar a duas pessoas a
-- mesma sessao.
CREATE UNIQUE INDEX sessao_token_unico ON sessoes (token_hash);
-- Para revogarSessoesDoUsuario: "derrubar todas as sessoes desta pessoa" e a
-- acao de emergencia, e ela nao pode depender de varredura da tabela inteira.
CREATE INDEX sessoes_usuario ON sessoes (usuario_id);

-- QUEM VENDEU. Nullable porque venda online nao tem vendedor: o comprador se
-- atende sozinho. ON DELETE RESTRICT pelo mesmo motivo de representante_id em
-- migrations/1754900300000_pedidos.sql — vendedor com venda registrada nao
-- pode ser apagado, so desativado (usuarios.ativo), senao o relatorio de §17
-- perde a referencia de quem fez a venda.
--
-- Nao confundir com representante_id: representante e ATRIBUICAO DE COMISSAO
-- (quem trouxe o cliente, pode nem estar presente); vendedor e quem operou o
-- balcao. A mesma venda presencial pode ter os dois, e sao pessoas diferentes.
ALTER TABLE pedidos ADD COLUMN vendedor_id uuid REFERENCES usuarios (id) ON DELETE RESTRICT;

-- NOT VALID, igual ao par dela pedido_online_tem_endereco
-- (migrations/1755300100000_pedidos_canal_logistica.sql). As duas descrevem
-- juntas "o que cada canal exige", e deixar uma validada e a outra nao seria
-- uma pegadinha para quem lesse `\d pedidos` daqui a seis meses.
--
-- O motivo tecnico e o mesmo: ADD CONSTRAINT validado varre a tabela inteira
-- segurando ACCESS EXCLUSIVE e ABORTA a migration na primeira linha
-- violadora. E verdade que hoje toda linha antiga tem canal = 'online' (o
-- DEFAULT da migration anterior) e passaria na varredura — mas isso e uma
-- afirmacao sobre o estado do banco no dia em que este arquivo foi escrito, e
-- migration de producao nao pode depender disso: basta uma linha corrigida a
-- mao no console para o deploy inteiro cair por causa de dado que ninguem vai
-- mais consertar. A regra precisa valer daqui para frente, e NOT VALID a
-- aplica a toda linha nova e a todo UPDATE de linha antiga.
--
-- `ALTER TABLE pedidos VALIDATE CONSTRAINT pedido_presencial_tem_vendedor`
-- promove a constraint depois, sem reescrever a tabela, quando a operacao
-- quiser afirmar que o passado tambem esta limpo.
ALTER TABLE pedidos ADD CONSTRAINT pedido_presencial_tem_vendedor
  CHECK (canal = 'online' OR vendedor_id IS NOT NULL) NOT VALID;

-- FUNCAO REESCRITA INTEIRA PELA SEGUNDA VEZ. A versao anterior (com `canal`,
-- sem `vendedor_id`) esta em
-- migrations/1755300100000_pedidos_canal_logistica.sql, e a original em
-- migrations/1754900300000_pedidos.sql — nenhuma das duas pode ser editada,
-- ja foram aplicadas (regra registrada em
-- migrations/1755100000000_pedido_token.sql). CREATE OR REPLACE substitui o
-- corpo; o trigger pedido_atribuicao_imutavel_trg continua apontando para este
-- mesmo nome e nao precisa ser recriado. Verificacao que nao for copiada para
-- ca deixa de existir no instante em que esta migration roda — por isso a
-- funcao aparece inteira, e nao "so a parte nova".
--
-- O QUE MUDA: `vendedor_id` entra na lista de colunas congeladas, pelo mesmo
-- par de razoes de representante_id. Primeiro, e credito de venda: um UPDATE
-- passando a venda de um vendedor para outro reescreve o relatorio de §17
-- depois do fato, e no balcao esse numero costuma ter premiacao amarrada.
-- Segundo, e o furo silencioso do ON DELETE RESTRICT: se vendedor_id pudesse
-- ser trocado, bastaria reapontar os pedidos de alguem para outra pessoa e o
-- RESTRICT deixaria de enxergar dependencia — a conta original ficaria
-- apagavel e o historico de quem vendeu sumiria junto.
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
  IF NEW.vendedor_id IS DISTINCT FROM OLD.vendedor_id THEN
    RAISE EXCEPTION 'pedido_atribuicao_imutavel: coluna vendedor_id nao pode ser alterada apos a criacao do pedido';
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

-- NAO EXISTE SEED DE USUARIO AQUI, e nao e esquecimento: senha em SQL
-- versionado vaza para sempre no historico do git, inclusive depois de
-- trocada. O primeiro admin nasce por `npm run usuario:criar`
-- (scripts/criar-usuario.mjs), que le a senha do ambiente e grava so o hash.

-- Down Migration
--
-- A funcao volta a ser EXATAMENTE a de
-- migrations/1755300100000_pedidos_canal_logistica.sql: com `canal`, sem
-- `vendedor_id`. Ela vem PRIMEIRO, antes do DROP COLUMN — enquanto o corpo
-- antigo nao estiver instalado, qualquer UPDATE em pedidos executaria um
-- trigger lendo NEW.vendedor_id numa tabela que acabou de perder a coluna, e o
-- erro seria "record new has no field vendedor_id", nao um erro de negocio.
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

ALTER TABLE pedidos DROP CONSTRAINT pedido_presencial_tem_vendedor;
-- pedidos.vendedor_id sai antes de usuarios: enquanto a FK existir, o DROP
-- TABLE abaixo falha.
ALTER TABLE pedidos DROP COLUMN vendedor_id;
DROP TABLE sessoes;
DROP TRIGGER usuarios_atualizado_em_trg ON usuarios;
DROP FUNCTION usuarios_tocar_atualizado_em();
DROP TABLE usuarios;
DROP TYPE papel_usuario;
