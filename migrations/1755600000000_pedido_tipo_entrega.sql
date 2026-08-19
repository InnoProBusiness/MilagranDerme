-- migrations/1755600000000_pedido_tipo_entrega.sql
-- Up Migration
--
-- RETIRADA NO LOCAL (pedido da cliente em 19/08/2026): alem das opcoes do
-- Clube Envios, quem preferir busca o kit em Goiania e nao paga frete.
--
-- POR QUE UMA COLUNA PROPRIA, e nao um valor emprestado de outra:
--
--   - NAO em `canal`. Canal decide de QUAL estoque a unidade sai (o presencial
--     tem teto rigido de 50 unidades) e exige vendedor_id pelo CHECK
--     pedido_presencial_tem_vendedor. Retirada e venda ONLINE com logistica
--     diferente: marca-la como 'presencial' furaria o teto do lote do evento e
--     reescreveria o relatorio por canal de §17 de uma vez so.
--   - NAO em `origem`. O CHECK pedido_origem_coerente amarra origem a comissao
--     (migrations/1754900300000_pedidos.sql); o cabecalho de
--     1755300100000_pedidos_canal_logistica.sql ja registra por extenso por que
--     um eixo de logistica nao cabe la.
--   - NAO por inferencia de `frete_centavos = 0`. Frete zero e indistinguivel
--     de uma futura promocao de frete gratis, e a fila de expedicao nao pode
--     recortar por heuristica: e ela que decide o que vai ao balcao dos
--     Correios.
--
-- CREATE TYPE e uso do valor no DEFAULT na MESMA transacao e permitido: a
-- proibicao do Postgres vale para valor acrescentado por ALTER TYPE ADD VALUE a
-- um tipo que ja existia. O par 1755300000000 (CREATE TYPE canal_venda) +
-- 1755300100000 (coluna com DEFAULT 'online') ja roda assim em producao.
--
-- NOME DO TIPO ≠ NOME DA COLUNA, seguindo pedido_status/status e
-- canal_venda/canal: o tipo carrega a entidade, a coluna fica curta. Um erro de
-- cast em log de producao ("column tipo_entrega is of type
-- pedido_tipo_entrega") so e legivel se os dois nomes forem distinguiveis.
CREATE TYPE pedido_tipo_entrega AS ENUM ('envio', 'retirada');

-- DEFAULT 'envio' faz o backfill do passado estar certo por construcao: todo
-- pedido ONLINE que existe hoje foi feito para ser despachado. O default
-- PERMANECE depois, apontando para o caminho ANTIGO — quem tem que se declarar
-- e o caminho NOVO, a mesma escolha ja registrada para `canal`. Postgres 11+
-- guarda o default de coluna nova no catalogo, entao o NOT NULL nao reescreve a
-- tabela.
--
-- SIGNIFICADO EXATO, para a coluna nao virar duas coisas:
--   'envio'    = o kit sai daqui por transportadora, para um endereco.
--   'retirada' = o kit e entregue EM MAOS, sem transportadora e sem frete.
ALTER TABLE pedidos ADD COLUMN tipo_entrega pedido_tipo_entrega NOT NULL DEFAULT 'envio';

-- VENDA DE BALCAO E RETIRADA, e o backfill precisa dize-lo.
--
-- O DEFAULT acertou o passado ONLINE e errou o passado PRESENCIAL: no balcao do
-- evento o comprador sai com o kit na mao (§2), que e a definicao de 'retirada'
-- escrita acima — nunca 'envio'. Deixar 'envio' ali seria criar, no mesmo
-- commit, a heuristica que esta coluna existe para eliminar: toda leitura de
-- tipo_entrega passaria a precisar de um "...exceto quando canal = presencial",
-- e a primeira que esquecesse mandaria uma venda de balcao para a fila dos
-- Correios.
UPDATE pedidos SET tipo_entrega = 'retirada' WHERE canal = 'presencial';

-- OBRIGATORIO, e a migration nao roda sem isto. `pedido_itens_obrigatorios_trg`
-- e DEFERRABLE INITIALLY DEFERRED (migrations/1755000000000_pedido_itens.sql): o
-- UPDATE acima enfileira um evento por linha para o fim da transacao, e o
-- Postgres recusa qualquer ALTER TABLE enquanto houver evento pendente na
-- tabela — "cannot ALTER TABLE pedidos because it has pending trigger events"
-- (SQLSTATE 55006). node-pg-migrate roda o arquivo inteiro numa transacao so,
-- entao os ALTER de baixo cairiam.
--
-- SET CONSTRAINTS ALL IMMEDIATE dispara os eventos agora e esvazia a fila. Nao
-- e um afrouxamento: o trigger RODA, e cada pedido presencial tocado passa pela
-- mesma verificacao de "pedido tem item" que passaria no COMMIT. Se algum nao
-- passasse, a migration falharia aqui em vez de falhar la — mais cedo e no
-- lugar certo.
SET CONSTRAINTS ALL IMMEDIATE;

-- E a regra que mantem isso valendo para o futuro. Sem ela, o backfill acima
-- seria verdade so ate a proxima venda de balcao.
--
-- NOT VALID, e a razao e a JANELA DO DEPLOY. DEPLOY.md fixa a ordem
-- `milagran-migrate.sh` primeiro, `docker stack deploy` depois — e o rolling
-- update do Swarm ainda serve requisicoes com a imagem ANTIGA por alguns
-- minutos. Nesse intervalo o INSERT de uma venda de balcao vem do codigo velho,
-- que nao conhece a coluna e cai no DEFAULT 'envio': com a constraint validada
-- de imediato, o Postgres recusaria a venda e o vendedor veria erro no balcao
-- por causa de um deploy. NOT VALID vale para toda linha nova ESCRITA PELO
-- CODIGO NOVO — que e quem precisa ser cobrado — sem varrer o passado.
--
-- (Na pratica a janela e teorica: o balcao so opera no evento de 25/08. A
-- constraint fica NOT VALID mesmo assim porque o custo e zero e o modo de falha
-- e uma venda perdida na frente do comprador.)
ALTER TABLE pedidos ADD CONSTRAINT pedido_presencial_e_retirada
  CHECK (canal <> 'presencial' OR tipo_entrega = 'retirada') NOT VALID;

-- A REDE EMBAIXO DO ZERO. frete_centavos e CONGELADO pelo trigger
-- pedido_atribuicao_imutavel_trg: valor errado no INSERT nao tem conserto
-- nunca, em nenhum caminho. Esta constraint garante que nem um caminho futuro
-- grave uma retirada cobrando transporte.
--
-- VALIDADA (nao NOT VALID), ao contrario de pedido_online_tem_endereco: aquela
-- precisou pular a varredura porque existiam linhas historicas violadoras.
-- Aqui nao ha violacao possivel — as unicas linhas 'retirada' sao as
-- presenciais recem-marcadas, e venda presencial grava FRETE_PRESENCIAL =
-- deInteiro(0) desde que existe (src/app/api/vendas-presenciais/route.ts).
ALTER TABLE pedidos ADD CONSTRAINT pedido_retirada_sem_frete
  CHECK (tipo_entrega <> 'retirada' OR frete_centavos = 0);

-- PRAZO DE TRANSPORTADORA NAO E PRAZO DE RETIRADA, e os dois significam o
-- CONTRARIO um do outro: `prazo_dias_estimado` e quanto tempo ELES levam para
-- trazer; o prazo de retirada e quanto tempo VOCE tem para buscar. Guardar 7
-- ali pareceria economico e faria a pagina do pedido imprimir "7 dias uteis
-- apos a postagem — depende do servico dos Correios" para quem vai buscar o kit
-- a pe. O prazo de retirada vive em PRAZO_RETIRADA_DIAS (src/lib/retirada.ts) e
-- nao tem coluna, porque nao varia por pedido.
ALTER TABLE pedidos ADD CONSTRAINT pedido_retirada_sem_prazo_de_transporte
  CHECK (tipo_entrega <> 'retirada' OR prazo_dias_estimado IS NULL);

-- UM PEDIDO DE RETIRADA NAO TEM FATO DE POSTAGEM. Esta e a rede de banco
-- embaixo da guarda de servidor em PATCH /api/admin/pedidos/[id]: uma aba
-- antiga aberta, um curl ou um bug de propagacao que tentasse mover uma
-- retirada para 'enviado' carimbaria enviado_em e faria a linha do tempo do
-- comprador afirmar "postado e ja saiu da nossa expedicao" sobre um kit que
-- esta na prateleira esperando ele. A tela recusa primeiro, com mensagem; isto
-- aqui e o que segura quando a tela nao esta no caminho.
-- NOT VALID, e esta e a unica das quatro em que o passado pode violar de
-- verdade. Ate hoje nada impedia um pedido PRESENCIAL de carregar postagem:
-- TRANSICOES permite 'pago' -> 'enviado' em qualquer canal (o comentario de
-- sequenciaDoPedido em src/components/linha-do-tempo-pedido.tsx registra que
-- isso e "raro mas possivel" — alguem compra no evento e pede para receber em
-- casa), e a versao anterior de registrarRastreio nao filtrava canal nenhum.
-- Como o backfill acima acabou de marcar TODA venda de balcao como 'retirada',
-- uma unica dessas linhas com rastreio derrubaria a migration inteira — no
-- deploy da semana do lancamento, com a loja no ar.
--
-- NOT VALID nao afrouxa o que interessa: toda linha NOVA e toda linha ALTERADA
-- e verificada. Um pedido de retirada criado a partir de agora nunca recebe
-- fato de postagem, e um UPDATE que tentasse por rastreio num pedido antigo
-- tambem seria recusado, porque UPDATE revalida a linha.
ALTER TABLE pedidos ADD CONSTRAINT pedido_retirada_sem_postagem
  CHECK (
    tipo_entrega <> 'retirada'
    OR (rastreio_codigo IS NULL AND rastreio_transportadora IS NULL AND enviado_em IS NULL)
  ) NOT VALID;

-- ENDERECO: EXIGIDO POR ENTREGA, NAO POR CANAL.
--
-- A constraint anterior (pedido_online_tem_endereco, 1755300100000) dizia
-- "canal = 'presencial' OR endereco_id IS NOT NULL". Ela era exata enquanto o
-- unico pedido sem destino era o de balcao. Com a retirada, passa a existir
-- pedido ONLINE que legitimamente nao tem endereco de entrega — e obrigar um
-- endereco ali significaria pedir a quem vem buscar o kit que digitasse seis
-- campos que ninguem vai ler.
--
-- A regra nova diz a mesma coisa que a antiga queria dizer, agora pelo eixo
-- certo: SE ha envio, TEM que haver destino. Ela e mais forte para o caso que
-- importa (um envio sem endereco continua impossivel) e para de cobrar destino
-- de quem nao tem entrega. Presencial fica coberto pelo backfill acima.
--
-- NOT VALID pelo mesmo motivo da antiga, e a razao NAO mudou: existem linhas
-- historicas anteriores ao checkout com endereco (endereco_id nasceu opcional).
-- Varre-las agora derrubaria a migration por causa de pedidos de 2026-08-11.
-- Vale daqui para frente, que e o que importa.
ALTER TABLE pedidos DROP CONSTRAINT pedido_online_tem_endereco;
ALTER TABLE pedidos ADD CONSTRAINT pedido_envio_tem_endereco
  CHECK (tipo_entrega <> 'envio' OR endereco_id IS NOT NULL) NOT VALID;

-- O QUE ESTA MIGRATION DELIBERADAMENTE NAO FAZ: nao acrescenta tipo_entrega a
-- lista de colunas congeladas do trigger pedido_atribuicao_imutavel
-- (4a reescrita da funcao em migrations/1755300300000_usuarios_sessoes.sql).
-- Tres razoes, nesta ordem:
--
--   1. REVERSIBILIDADE. Congelar exige copiar as verificacoes atuais UMA A UMA
--      — o que nao for copiado deixa de existir no instante em que a migration
--      roda — e o Down teria que reinstalar o corpo exato anterior antes do
--      DROP COLUMN, sob pena de todo UPDATE em pedidos quebrar com "record new
--      has no field tipo_entrega". E a peca mais arriscada possivel a seis dias
--      do lancamento, e a unica que nao se desfaz com um comando.
--   2. NAO HA MUTACAO A IMPEDIR. Nenhum caminho faz UPDATE nesta coluna:
--      criarPedido a escreve no INSERT e nada mais a toca. O estrago que
--      congelar preveniria (virar envio -> retirada para zerar o frete) ja e
--      impossivel, porque frete_centavos e congelado — o valor cobrado nao
--      muda junto.
--   3. CORRIGIVEL E DESEJAVEL. Quem clicou em retirada por engano e liga
--      pedindo envio pode ser atendido pela operacao, em vez de reembolso mais
--      pedido novo. Congelada, a correcao seria impossivel.
--
-- Se depois do lancamento a decisao mudar, o caminho e uma migration propria
-- que reescreva a funcao inteira — sem pressa e sem carona neste deploy.

-- Down Migration
--
-- Ordem obrigatoria: as constraints dependem da coluna, e a coluna depende do
-- tipo. A constraint antiga volta ANTES do DROP COLUMN, e no formato original —
-- reinstalar uma versao "melhorada" no Down deixaria o banco num estado que
-- nunca existiu. Nao ha funcao de trigger a reinstalar, consequencia direta de
-- nao ter congelado a coluna na subida.
-- O DOWN TEM QUE RECUSAR-SE A RODAR se ja existir pedido de retirada ONLINE.
--
-- A constraint antiga exige endereco de TODO pedido online, e um pedido de
-- retirada nasce sem endereco nenhum. Reinstala-la por cima seria uma armadilha
-- silenciosa: o ADD passa (NOT VALID nao varre o passado), a linha continua la,
-- e o proximo UPDATE naquele pedido — o do webhook do Mercado Pago confirmando
-- o pagamento — falha para sempre, porque UPDATE revalida a linha inteira. O
-- pedido ficaria eternamente 'aguardando_pagamento' com o dinheiro ja cobrado,
-- e o erro apareceria no log do webhook, nao aqui.
--
-- Falhar ALTO e agora e o comportamento certo: quem precisa reverter decide o
-- que fazer com esses pedidos (converte-los em envio com um endereco, ou
-- reembolsa-los) antes de descer a migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pedidos
    WHERE canal <> 'presencial' AND endereco_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Ha pedido online sem endereco (retirada no local). Reverter esta migration deixaria esses pedidos impossiveis de atualizar — inclusive pelo webhook de pagamento. Resolva-os antes de descer.';
  END IF;
END $$;

ALTER TABLE pedidos DROP CONSTRAINT pedido_envio_tem_endereco;
ALTER TABLE pedidos ADD CONSTRAINT pedido_online_tem_endereco
  CHECK (canal = 'presencial' OR endereco_id IS NOT NULL) NOT VALID;

ALTER TABLE pedidos DROP CONSTRAINT pedido_retirada_sem_postagem;
ALTER TABLE pedidos DROP CONSTRAINT pedido_retirada_sem_prazo_de_transporte;
ALTER TABLE pedidos DROP CONSTRAINT pedido_retirada_sem_frete;
ALTER TABLE pedidos DROP CONSTRAINT pedido_presencial_e_retirada;
ALTER TABLE pedidos DROP COLUMN tipo_entrega;
DROP TYPE pedido_tipo_entrega;
