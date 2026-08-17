-- migrations/1755300400000_leads.sql
-- Up Migration
--
-- Captura de interesse do documento de 16/08/2026 (secao 17). Sao os tres
-- publicos que ainda NAO compraram: quem so quer saber do produto, quem quer
-- representar a marca e quem quer distribuir.
--
-- COMPRADOR NAO ENTRA AQUI, de proposito. Quem comprou ja e uma linha
-- completa em clientes (com CPF, e-mail e whatsapp) ligada a pedidos, e a
-- lista de compradores do painel e DERIVADA desse par (listarCompradores em
-- src/repositories/pedidos.ts). Copiar a mesma pessoa para ca criaria duas
-- verdades sobre o mesmo nome, que divergem no primeiro caminho de escrita
-- que atualizar uma e esquecer a outra — e a de leads, sem CPF, seria a que
-- o atendimento acabaria olhando primeiro.
CREATE TYPE tipo_lead AS ENUM ('interessado', 'representante', 'distribuidor');

CREATE TABLE leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo               tipo_lead   NOT NULL,
  nome               text        NOT NULL,
  email              text        NOT NULL,

  -- DEFAULT '' em vez de NULL nos campos opcionais: o mesmo formato ja usado
  -- em representantes (1754900200000_representantes.sql) e em clientes. Um
  -- lead chega por mais de um formulario e nem todos pedem os mesmos campos;
  -- com '' a leitura do painel nunca precisa de coalesce e "nao informado"
  -- tem uma representacao unica, em vez de duas (NULL e '') que ordenam e
  -- comparam diferente.
  whatsapp           text        NOT NULL DEFAULT '',
  cidade             text        NOT NULL DEFAULT '',
  estado             varchar(2)  NOT NULL DEFAULT '',
  mensagem           text        NOT NULL DEFAULT '',

  -- PROVA DE CONSENTIMENTO. E a razao de esta tabela existir, nao um campo
  -- de enfeite ao lado do nome.
  --
  -- Ate hoje o aceite de LGPD era coletado e jogado fora. O formulario de
  -- representante exige a marcacao do checkbox "lgpd"
  -- (public/seja-representante.html, campo lgpd, obrigatorio no HTML) e
  -- processarCandidatura o trata como campo obrigatorio
  -- (src/lib/candidatura.ts, CAMPOS_OBRIGATORIOS) — mas o unico destino do
  -- aceite e a linha "Consentimento LGPD: Sim" desenhada no PDF e o e-mail
  -- que leva esse PDF em anexo. NADA era gravado. Nenhuma linha, em nenhuma
  -- tabela, dizia que aquela pessoa consentiu.
  --
  -- Na pratica isso significa que o consentimento era INCOMPROVAVEL: para
  -- responder a um titular que pede exclusao dos dados, ou a ANPD que
  -- pergunta com que base os dados foram tratados, alguem teria que
  -- vasculhar anexo por anexo numa caixa de entrada — e ainda assim sem
  -- instante confiavel, porque o carimbo impresso no PDF e "quando o PDF foi
  -- gerado", nao "quando a pessoa consentiu", e ele nao e consultavel por
  -- consulta nenhuma. Agora o aceite tem carimbo de tempo no banco.
  --
  -- O CHECK lead_consentimento_coerente (abaixo) recusa os dois estados que
  -- tornariam a linha inutil: true sem data (um "sim" sem quando nao prova
  -- nada perante um titular ou a ANPD) e false com data (registro pela
  -- metade, tipico de revogacao mal feita, que deixa duas leituras opostas
  -- na mesma linha). A regra mora no BANCO e nao na aplicacao justamente
  -- porque o caminho perigoso nao e a rota POST /api/leads: e a importacao
  -- de planilha, o seed e o UPDATE manual no psql as 2h da manha, que nao
  -- passam por validacao nenhuma de aplicacao.
  consentimento_lgpd boolean     NOT NULL DEFAULT false,
  consentido_em      timestamptz,

  -- De onde a pessoa veio ("instagram", "evento-25-08", "/seja-representante").
  -- Texto livre e sem CHECK: e informacao de marketing, nao chave de nada, e
  -- um valor novo nao pode falhar um cadastro. Sem parentesco com
  -- pedidos.origem, que apesar do nome parecido e ATRIBUICAO DE COMISSAO
  -- (1754900300000_pedidos.sql) e tem CHECK amarrando cada valor a presenca
  -- de representante_id.
  origem             text        NOT NULL DEFAULT '',
  criado_em          timestamptz NOT NULL DEFAULT now(),

  -- Mesmo regex de cliente_email_formato (1755000100000_clientes.sql). E de
  -- proposito que os dois sejam identicos: um e-mail que o checkout aceita e
  -- o cadastro de lead recusa (ou o contrario) e a mesma pessoa existindo
  -- com regras diferentes conforme a porta por onde entrou.
  CONSTRAINT lead_email_formato CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- '' e ausencia legitima; qualquer outro valor tem que ser UF em
  -- maiusculas. Sem o ramo do '', o DEFAULT da propria coluna violaria o
  -- CHECK e nenhum lead sem estado poderia ser gravado.
  CONSTRAINT lead_uf_valida CHECK (estado = '' OR estado ~ '^[A-Z]{2}$'),
  CONSTRAINT lead_consentimento_coerente CHECK (
    (consentimento_lgpd = false AND consentido_em IS NULL)
    OR
    (consentimento_lgpd = true  AND consentido_em IS NOT NULL)
  )
);

-- NAO existe indice unico por e-mail aqui, ao contrario de
-- cliente_email_unico. A mesma pessoa pode se cadastrar como 'interessado'
-- em agosto e como 'representante' em setembro, e cada envio e um EVENTO DE
-- CONSENTIMENTO proprio, com seu instante. Deduplicar por e-mail (ou pior,
-- fazer upsert) sobrescreveria o consentido_em anterior e destruiria
-- exatamente a prova que esta tabela existe para guardar. A deduplicacao
-- para efeito de contato e trabalho da tela, sobre os dados intactos.
--
-- A consulta do painel e sempre "leads deste tipo, mais recentes primeiro"
-- (GET /api/admin/leads?tipo=), na ordem em que ela filtra.
CREATE INDEX leads_tipo_data ON leads (tipo, criado_em DESC);

-- Down Migration
DROP TABLE leads;
DROP TYPE tipo_lead;
