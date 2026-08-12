# Pendências carregadas do Plano 1

Achados que as revisões do Plano 1 classificaram como menores e adiaram deliberadamente,
mais decisões tomadas que os planos seguintes precisam respeitar.

**Por que este arquivo existe.** Durante o Plano 1, o risco de o `slug` de um representante
ser mutável foi parqueado como "quem escrever a tela de edição resolve". A revisão final teve
que promovê-lo de volta a bloqueante — a nota estava num diretório ignorado pelo git, num
plano que a tarefa futura não teria motivo para abrir. Estas pendências ficam versionadas
para não repetir isso.

---

## Bloqueia o Plano 2 (loja, cupom, checkout)

| Item | Por quê |
|---|---|
| **Cupom de representante desativado** | `origem = 'rep_inativo'` degrada o caminho do *link* quando o representante saiu. Nada faz o equivalente para o caminho do *cupom*. O resgate do cupom precisa reconsultar `ativo`, espelhando `buscarRepresentanteAtivoPorSlug`. Sem isso, um cupom de alguém desligado credita comissão a quem não está mais na operação. |
| **Pedido de valor zero** | Um pedido com total zero, só frete, ou 100% de desconto satisfaz todas as CHECK atuais. Não é errado hoje porque `pedido_itens` não existe. Quando os itens entrarem, amarre `subtotal_centavos` à soma dos itens e exija `> 0`. |
| **Não mutar o retorno do resolver** | `resolverAtribuicaoDoPedido` devolve `Readonly` e um objeto novo por chamada, justamente porque a prioridade do cupom sobre o last click é a próxima coisa a ser escrita. Construa um objeto novo; não altere o retornado. |
| **`fimDoMesBR` e intervalos em SQL** | O limite é "início do mês seguinte − 1ms", seguro apenas em precisão de milissegundo. `timestamptz` guarda microssegundos. Toda consulta por período deve usar a forma semiaberta `>= inicio AND < proximoInicio`. |

## Bloqueia o Plano 3 (gateway, webhook, comissão)

| Item | Por quê |
|---|---|
| **O trigger de imutabilidade permite `status`** | `pedido_atribuicao_imutavel_trg` congela representante, percentual, origem, UTMs, valores, `numero` e `criado_em`, mas deixa `status`, `pago_em` e `entregue_em` livres — de propósito, para a máquina de estados e o webhook funcionarem. Se precisar mudar mais alguma coluna, altere o trigger conscientemente. |
| **Parser global de `INT8`** | `src/lib/db.ts` converte todo `bigint` para `number`. Seguro para dinheiro (`int4`) e ids (`uuid`), mas `COUNT`/`SUM` de agregação também passam por ele. Nenhum problema até 2⁵³; vale saber ao escrever os relatórios do livro-razão. |
| **`Pedido.status` é `PedidoStatus`** | Tipado a partir do ENUM gerado justamente para o `switch` da máquina de estados ter checagem de exaustividade. Não afrouxe para `string`. |

## Bloqueia o Plano 4 (autenticação)

| Item | Por quê |
|---|---|
| **`rep_email_unico` indexa `lower(email)`** | O valor armazenado mantém a caixa original. O login por e-mail precisa consultar `lower(email)` ou normalizar na escrita, senão a busca falha silenciosamente. |

## Bloqueia o Plano 5 (admin)

| Item | Por quê |
|---|---|
| **`slug` e `codigo` são imutáveis** | `rep_antes_de_atualizar_trg` rejeita alteração nos dois. A tela de edição deve escondê-los ou desabilitá-los, não tentar salvá-los. Todo o resto do cadastro é editável. |
| **Pedido não é editável** | Corrigir um pedido significa lançamento novo, nunca `UPDATE` nas colunas congeladas. |

---

## Endurecimento pendente, sem dono

- **Limite superior em `em`** no cookie de atribuição: um payload com carimbo futuro verifica. Inalcançável hoje (só quem tem o segredo assina, e o único signatário usa o relógio do servidor), mas a checagem correta é `Number.isSafeInteger(d.em) && d.em <= agora.getTime()` — `typeof d.em === 'number'` aceita `Infinity`, o que tornaria o cookie eterno.
- **`kits_unidades_positiva`, `kits_sku_unico`, `rep_codigo_unico`, `rep_email_unico`, `pedido_valores_nao_negativos` e `pedido_atribuicao_coerente`** existem no banco mas não têm teste. As duas últimas são constraints de dinheiro.
- **`produtos.test.ts`** ainda faz `deleteFrom('kits')` sem escopo — o último arquivo que limpa uma tabela inteira. Inofensivo hoje; vira armadilha quando o Plano 2 escrever os testes da vitrine.
- **Estouro de `int4`** (acima de ~R$ 21,4 milhões) aparece como erro cru `22003` do Postgres em vez de erro de domínio. O banco falha seguro; é lacuna de mensagem.
- **`centavos()`** usa tolerância de 1e-6, que só se comporta mal em valores acima de dezenas de milhões de reais. Irrelevante por pedido; documentar se for reusado para agregados.
- ~~**Sem CI.**~~ **Resolvido.** `.github/workflows/ci.yml` roda typecheck, migrations, os 127 testes
  e o `next build` contra um Postgres 14 de serviço, em todo push e todo PR para a main. Push na
  main que passe no portão faz deploy automático na VPS. Ver [`DEPLOY.md`](../../../DEPLOY.md).

## Ponto em aberto fora do código

**Resolvido:** a dúvida sobre a Production Branch da Vercel deixou de existir. O projeto
passou a ter um alvo único de deploy — VPS em Docker Swarm — e a Serverless Function
`api/candidatura.js` virou `src/app/api/candidatura/route.ts`. O mapa de URLs está em
[`DEPLOY.md`](../../../DEPLOY.md).

**Ainda aberto:** `milagranoficial.com.br` está registrado no registro.br mas sem
delegação de zona (só NS placeholder, nenhum registro A). Enquanto o domínio não apontar
para o IP da VPS, o Traefik não emite o certificado — o Let's Encrypt valida por
HTTP-01 — e o site não é alcançável pelo domínio. É bloqueio de painel, não de código.
