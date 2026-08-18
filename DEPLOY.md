# Deploy — o que serve o que

**Existe um unico deploy: a VPS, em Docker Swarm.** Nao ha Vercel, nao ha
Serverless Function, nao ha build alternativo. Quem serve tudo — HTML
estatico, rotas do App Router e a API — e um processo `node server.js`
(build standalone do Next) dentro de um container.

> Historico, porque ainda aparece em comentarios e no `git log`: ate agosto
> de 2026 este repositorio teve dois alvos simultaneos na Vercel (um site
> estatico servindo a raiz do repo, depois uma app Next.js), e o
> `/api/candidatura` era uma Serverless Function em `api/candidatura.js`,
> fora do build do Next. Os dois alvos e a function foram removidos; a
> function virou `src/app/api/candidatura/route.ts` sobre
> `src/lib/candidatura.ts`, preservando os mesmos codigos de erro HTTP.

## O que serve cada URL

| URL | Origem | Acesso |
|---|---|---|
| `/` | `src/app/page.tsx` — **a loja de lancamento** | publico |
| `/comprar` | `src/app/comprar/page.tsx` (vitrine) | publico |
| `/checkout` | `src/app/checkout/page.tsx` | publico |
| `/pedido/<token>` | `src/app/pedido/[token]/page.tsx` — token uuid, nunca o numero | publico |
| `/seja-representante.html` | `public/seja-representante.html` — **precisa continuar 200** | publico |
| `/privacidade.html` | `public/privacidade.html` — **URL nao pode mudar** | publico |
| `/styles.css`, `/script.js`, `/assets/*` | `public/` | publico |
| `/r/<slug>` | `src/app/r/[slug]/page.tsx` + `src/proxy.ts` (cookie de atribuicao) | publico |
| `/entrar` | `src/app/entrar/page.tsx` | publico |
| `/venda` | `src/app/venda/page.tsx` — balcao do evento | sessao de vendedor |
| `/admin/*` | `src/app/admin/*` — §17 do documento de lancamento | sessao de admin |
| `/api/candidatura` | `src/app/api/candidatura/route.ts` (POST) | publico |
| `/api/pedidos`, `/api/pagamentos` | checkout online | publico |
| `/api/estoque`, `/api/frete`, `/api/cep/<cep>`, `/api/leads` | apoio da loja | publico |
| `/api/sessao` | POST entra, DELETE sai | publico / sessao |
| `/api/vendas-presenciais` | venda de balcao | sessao de vendedor |
| `/api/admin/*` | painel | sessao de admin |
| `/api/webhooks/mercadopago` | conciliacao de pagamento | assinatura HMAC |
| `/api/health` | `src/app/api/health/route.ts` — liveness do container | publico |

- **`/privacidade.html` e um compromisso de LGPD.** A URL esta linkada no
  rodape da LP e no consentimento do formulario de candidatura. Nao mova,
  nao renomeie, nao troque por rota do App Router sem redirect.
- **`/` deixou de ser rewrite em 16/08/2026.** Ate entao `next.config.ts`
  reescrevia `/` para `public/seja-representante.html`, e a home do site era a
  landing page de recrutamento. O documento de lancamento (§14, §18) inverteu a
  prioridade: a raiz e a LOJA, e representante virou um link discreto no rodape.
  O rewrite saiu e `src/app/page.tsx` passou a existir de verdade.
- **`/seja-representante.html` continua respondendo 200, e isso NAO e opcional.**
  Duas razoes independentes: (1) §14 manda manter o formulario disponivel, e ha
  campanha em circulacao apontando para la; (2) **`deploy/milagran-ci-deploy.sh`
  aprova ou REVERTE o deploy inteiro com base num `curl` nessa URL.** Se um dia
  ela deixar de responder 200, `verificar_borda()` precisa ser atualizada no
  MESMO commit — senao todo deploy seguinte se auto-reverte, e o sintoma
  (rollback silencioso, aplicacao velha no ar) nao aponta para a causa.
- **O `<link rel="canonical">` da LP mudou junto.** Ele apontava para `/`,
  declarando que a pagina de recrutamento era a home; agora aponta para a
  propria URL de recrutamento. Sem essa troca, os buscadores continuariam
  indexando o recrutamento como identidade da marca no lugar da loja.
- **`src/app/globals.css` e `public/styles.css` divergiram de proposito.**
  `globals.css` e o dono do design system da loja (App Router) e ganhou todo o
  visual novo do lancamento; `public/styles.css` serve APENAS a LP estatica de
  recrutamento. Eram quase identicos ate 16/08/2026; estilo novo vai para um
  lado so, e a divergencia e assumida.

## Onde as coisas moram

VPS `$VPS_HOST`, porta SSH fora do padrao, autenticacao por chave. O projeto
divide a maquina com as stacks `traefik`, `portainer`, `postgres`,
`innotalk`, `innofin` e `evolution`, e segue as convencoes ja usadas por
elas (o molde foi `/opt/innofin`).

> **Este repositorio e publico.** Por isso o IP e a porta nao aparecem aqui:
> `$VPS_HOST` e `$VPS_PORT` sao placeholders. Os valores reais estao nos
> GitHub Secrets do repositorio (`VPS_HOST`, `VPS_PORT`) e devem ficar
> tambem no gerenciador de senhas do time. Publicar IP + porta SSH de uma
> maquina que aceita login de root e entregar metade de um ataque de forca
> bruta pronto.

| Recurso | Onde |
|---|---|
| Codigo | `/opt/milagran` |
| Stack real (com segredos, chmod 600) | `/opt/milagran/milagran-stack.yml` |
| Modelo versionado do stack | `milagran-stack.example.yml` |
| Gerador do stack | `deploy/make-milagran-stack.sh` → `/root/` na VPS |
| Migrations | `deploy/milagran-migrate.sh` → `/root/` na VPS |
| Deploy automatico | `deploy/milagran-ci-deploy.sh` → `/root/` na VPS (forced command) |
| Chave de deploy | `/root/.ssh/milagran-ci` (privada vai para o secret `VPS_SSH_KEY`) |
| Segredos | `/root/.milagran-db-pass`, `/root/.milagran-atribuicao-secret` |
| Resend (opcional) | `/root/.milagran-resend-key`, `.milagran-email-from`, `.milagran-email-to` |
| Mercado Pago | `/root/.milagran-mp-access-token`, `.milagran-mp-public-key`, `.milagran-mp-webhook-secret` |
| Frete (Clube Envios) | `/root/.milagran-clube-envios-token`, `.milagran-clube-envios-cliente-id`, `.milagran-cep-origem` (e `.milagran-clube-envios-base-url` para homologacao) |
| Banco | database `milagran` no Postgres **14** compartilhado do swarm |
| Roteamento | Traefik, `https://milagranoficial.com.br` |

Os dois scripts sao versionados em `deploy/` e **copiados** para `/root/` da
VPS (e de la que rodam, porque leem os segredos em `/root/.milagran-*`). Se
editar um deles, reenvie: `scp -P $VPS_PORT deploy/*.sh root@$VPS_HOST:/root/`.

## Checklist do lancamento de 25/08/2026

Ordem importa: os tres primeiros itens sao pre-requisito para vender.

1. **Mercado Pago no container.** Ate 16/08/2026 `MERCADOPAGO_*` e `APP_URL`
   **nao existiam** no `milagran-stack.example.yml` nem no gerador. O efeito era
   silencioso e total: o container subia, a loja aparecia, e a tela de pagamento
   dizia "o pagamento ainda esta sendo liberado" porque a chave publica vinha
   vazia — sem um erro em log sequer. Cadastre os tres arquivos em `/root/`,
   rode `make-milagran-stack.sh` e **leia o relatorio que ele imprime no fim**:
   ele diz se o token e de sandbox (`TEST-`) ou de producao (`APP_USR-`).
2. **Frete.** `CLUBE_ENVIOS_TOKEN`, `CLUBE_ENVIOS_CLIENTE_ID` e
   `CEP_ORIGEM_EXPEDICAO`. Sem eles `/api/frete` responde 503 e o checkout
   online **para** no passo do endereco, de proposito — nunca cai para frete
   zero. A venda presencial do evento nao depende disso (nao tem frete).
   Faca a PRIMEIRA chamada apontando `CLUBE_ENVIOS_BASE_URL` para a homologacao
   (`https://apishmg.clubeenvios.com.br`): o corpo de sucesso de `POST /cotacao`
   nao esta na documentacao publica, e `src/lib/frete.ts` le preco e prazo por
   uma lista de apelidos. Se os nomes reais forem outros, o erro
   `CotacaoIlegivelError` diz exatamente quais chaves chegaram — e o unico lugar
   a corrigir.
3. **Operadores.** Nao ha senha em variavel de ambiente nem em migration. Crie
   cada pessoa com, de dentro do container ou com `DIRECT_URL` apontando para o
   banco:
   ```
   docker exec -it $(docker ps -qf name=milagran_app) \
     npm run usuario:criar -- --nome "Fulano" --email fulano@exemplo.com --papel vendedor
   ```
   A senha e pedida pelo terminal, com eco desligado. Rodar de novo para o mesmo
   e-mail TROCA a senha e derruba as sessoes abertas daquela pessoa — e o
   caminho de "esqueci a senha as 9h do dia 25".

   **O `-it` nao e opcional.** Sem TTY o comando nao consegue ler a senha; ate
   17/08/2026 ele imprimia o prompt, nao criava ninguem e encerrava com codigo
   de SUCESSO — o operador so descobriria no dia, com a fila formada, que o
   vendedor nao consegue entrar. Hoje ele recusa com mensagem explicita, mas o
   `-it` continua sendo o jeito certo de chamar.
4. **Conferir peso e dimensoes do kit.** `migrations/1755300600000_kit_dimensoes.sql`
   semeia 500 g / 12 x 16 x 20 cm como **palpite declarado**, nao medida. Valor
   errado = frete cotado abaixo do custo real, e a diferenca sai da margem em
   todo pedido online. Nao ha conserto depois: `frete_centavos` e congelado pelo
   trigger de imutabilidade no momento do INSERT.
5. **Estoque presencial.** `migrations/1755300700000_seed_estoque.sql` lanca a
   entrada de 50 unidades. Conferir o numero real antes do evento; ajuste depois
   e um movimento novo (`ajustarEstoque`), nunca uma edicao de linha.
6. **Resend.** Continua opcional no gerador, mas para o lancamento deixa de ser:
   sem ele o comprador paga e nao recebe confirmacao nenhuma. Verificar o
   dominio e publicar SPF/DKIM tem prazo de DNS — nao deixe para o dia 24.
7. **QR Code no APEX, nunca em `www`.** O cookie de atribuicao usa o prefixo
   `__Host-`, que nao atravessa subdominio: um QR apontando para
   `www.milagranoficial.com.br` faz toda venda do evento perder o representante.
8. **Rate limit.** `/api/pedidos` limita 10 requisicoes por 10 min **por IP**, em
   memoria de um processo, com `replicas: 1`. No evento dezenas de pessoas ficam
   atras de um IP so (WiFi do local ou CGNAT da operadora) e o 11o comprador leva
   429. Decidir antes do dia 25: contador em Redis (a VPS ja roda um na stack
   `evolution`) ou isencao para o IP do local. So aumentar o numero nao resolve
   o caso de 200 pessoas. Ver `src/lib/rate-limit.ts`.
9. **ANVISA — resolvido por dispensa em 18/08/2026.** O cliente declarou o
   enquadramento na Lei n. 15.154/2025 (producao artesanal, dispensada de
   registro previo) e `kits.anvisa_dispensado = true` foi gravado por migration
   (`1755500000000_anvisa_dispensa.sql`). Home e vitrine exibem a frase da lei,
   vinda de `src/lib/anvisa.ts` (fonte unica).
   O QUE MANTER DE OLHO: a isencao vale "na forma de regulamento" da Anvisa
   (RDC + IN com a lista de produtos elegiveis — consultas publicas 1352/1353
   de out/2025). Conferir, quando o regulamento sair, se os produtos do kit
   estao na lista e se as condicoes (pequena escala, processo manual, venda
   direta ao consumidor) continuam atendidas. A fiscalizacao sanitaria e as
   regras de rotulagem CONTINUAM valendo — a dispensa e so do registro previo.

## Deploy automatico (push na main)

**Nao ha passo manual no caminho normal.** `.github/workflows/ci.yml` roda
em todo push e todo PR para a main:

```
push/PR  ->  quality-gate   npm ci -> typecheck -> migrations -> 728 testes
                            -> next build          (Postgres 14 de servico)
                                   |
push na main apenas  ------------->+
                                   v
             deploy          tar da arvore  ->  ssh  ->  VPS
```

Na VPS a conexao cai numa *forced command*: a chave de deploy executa
`/root/milagran-ci-deploy.sh` e **nada mais**, com o sha do commit em
`SSH_ORIGINAL_COMMAND` e a arvore do repo no stdin. O script:

1. valida o sha (so hex — o valor vem da rede e vira tag de imagem);
2. pega o `flock` (dois merges seguidos nao viram dois deploys simultaneos);
3. aborta se o disco tiver menos de 2.2GB livres — encher o disco derruba o
   Postgres dos outros quatro projetos, nao so este deploy;
4. extrai em `/opt/milagran.staging` e builda **de la**: se o build falhar,
   a arvore que gerou a versao no ar continua intacta;
5. so entao substitui `/opt/milagran` (`rsync --delete`, preservando
   `milagran-stack.yml`, que so existe na VPS e guarda os segredos);
6. aplica migrations — se falharem, aborta e a versao no ar nao muda;
7. `docker stack deploy --resolve-image never`;
8. espera a task convergir **e** confere `/seja-representante.html` pela
   borda, com retry — ver abaixo por que o retry nao e frescura;
9. **reverte sozinho** (`docker service rollback` + stack file de volta a
   tag anterior) se a verificacao reprovar, e sai com erro;
10. limpa o cache de build (via `trap`, inclusive quando falha) e guarda as
    3 imagens mais recentes para rollback manual.

> **Por que a verificacao pela borda tem retry.** A task virar `Running` no
> Swarm nao significa que o Traefik ja registrou o container novo. Nessa
> janela o router existe sem backend e o **Traefik responde 404** — que,
> numa unica tentativa, e indistinguivel de uma imagem realmente quebrada
> (`public/` ou `.next/static` ausentes dao exatamente o mesmo 404). O
> primeiro teste deste script reprovou por isso, com a imagem intacta. Sao
> 12 tentativas a cada 5s antes de declarar falha.
>
> E por que ela existe: o `HEALTHCHECK` do container so pergunta se
> `/api/health` responde, e ele responde mesmo com o site inteiro em 404.

### Segredos que o workflow precisa

Em *Settings -> Secrets and variables -> Actions*:

| Secret | Conteudo |
|---|---|
| `VPS_HOST` | IP da VPS |
| `VPS_PORT` | porta SSH |
| `VPS_SSH_KEY` | chave privada de `/root/.ssh/milagran-ci` (a **inteira**, com as linhas BEGIN/END) |
| `VPS_KNOWN_HOSTS` | host key da VPS — fixada, nao aceita na primeira conexao |

A chave publica correspondente ja esta em `/root/.ssh/authorized_keys` com
`restrict,command="/root/milagran-ci-deploy.sh"`. Se ela vazar, o estrago
fica em disparar um deploy: nao abre shell, nao le
`/root/.milagran-*`, nao encaminha porta. Testado — `whoami` e
`cat /root/.milagran-db-pass` pela chave sao recusados.

`VPS_KNOWN_HOSTS` existe para nao usar `StrictHostKeyChecking=accept-new`:
um deploy carrega a aplicacao inteira, e aceitar quem responder no IP e
confiar demais. Regerar com
`ssh-keyscan -p $VPS_PORT -t ed25519 $VPS_HOST`.

## Deploy manual (quando o Actions esta fora)

```bash
tar -czf - --exclude=node_modules --exclude=.git --exclude=.next . \
  | ssh -p $VPS_PORT root@$VPS_HOST 'tar -xzf - -C /opt/milagran'

# na VPS
cd /opt/milagran
docker build -t milagran:v2 .
/root/milagran-migrate.sh v2
/root/make-milagran-stack.sh v2
docker stack deploy --resolve-image never -c /opt/milagran/milagran-stack.yml milagran
docker builder prune -af
```

`--resolve-image never` nao e opcional: a imagem so existe no daemon local,
nao ha registry. Sem a flag o Swarm tenta resolver o digest no Docker Hub,
nao acha `milagran` e o deploy falha.

Rollback: as 3 imagens mais recentes ficam na maquina.
`/root/make-milagran-stack.sh <sha-anterior> && docker stack deploy
--resolve-image never -c /opt/milagran/milagran-stack.yml milagran` volta.
Migration aplicada **nao** volta sozinha — cada arquivo em `migrations/`
tem a secao `Down Migration`, mas rodar `down` e decisao manual e
consciente.

## Detalhes que custam caro descobrir de novo

- **`.next/static` e `public/` sao copiados a mao no Dockerfile.** O build
  standalone os deixa de fora por design. Esquece-los faz o site subir sem
  CSS/JS e a LP inteira (HTML estatico em `public/`) devolver 404 — com o
  container reportando `healthy`, porque `/api/health` continua respondendo.
- **`/api/health` nao consulta o Postgres, de proposito.** Um healthcheck
  acoplado ao banco faz o Swarm matar e recriar a aplicacao em loop
  exatamente quando ela ainda serviria bem as paginas estaticas.
- **A VPS nao tinha swap.** Com 3.8GB de RAM e sete stacks, um `next build`
  no host aciona o OOM killer, que pode derrubar container de *outro*
  projeto. Foi criado `/swapfile` de 2GB (ativo, **nao** persistido em
  `/etc/fstab` — depois de um reboot, `swapon /swapfile` de novo). No
  primeiro build o swap chegou a 1.7GB em uso: sem ele o build nao passava.
- **Disco e o recurso escasso da maquina, nao CPU nem RAM.** Sao 19GB no
  total e o primeiro build chegou a deixar 251MB livres (99%). Duas
  consequencias praticas: rode `docker builder prune -af` depois de todo
  build (o cache sozinho ficou com 1.6GB), e note que
  **`milagran-build:<tag>` nao fica residente** — pesa 1.5GB e
  `milagran-migrate.sh` a reconstroi sozinha quando falta. Um Postgres sem
  espaco para escrever derruba quatro projetos de uma vez; um rebuild de
  quatro minutos numa operacao manual e rara nao derruba ninguem.
- **`netInnotalk` nao e `--attachable`.** `docker run --network netInnotalk`
  e recusado; por isso `milagran-migrate.sh` usa
  `--network container:<postgres>` e fala com o banco em `127.0.0.1:5432`.
- **Producao roda Postgres 14, nao 17.** O Postgres e compartilhado com os
  outros projetos da VPS e nao vai subir de versao por causa deste. O
  `docker-compose.yml` local foi alinhado ao 14 para nao desenvolver contra
  recurso que producao nao tem. As 728 verificacoes da suite passam nos dois.
- **`replicas: 1` nao e arbitrario.** O rate limit de `/api/candidatura`
  conta em memoria do processo. Com N replicas o limite efetivo vira N x 5
  por janela; antes de escalar, mover o contador para Redis.
- **`DATABASE_URL` aponta direto ao Postgres, sem pooler.** A aplicacao e um
  processo de vida longa com pool proprio de 5 conexoes contra
  `max_connections=500`. Pooler externo aqui nao teria o que fazer.
- **Trocar `ATRIBUICAO_SECRET` invalida o cookie de todos os visitantes**
  em atribuicao aberta — ate 30 dias de comissao em disputa. Nao rotacione
  sem motivo.
- **`www` redireciona para o apex por causa do cookie, nao por SEO.** O
  cookie de atribuicao usa o prefixo `__Host-`, que proibe o atributo
  `Domain`: o cookie gravado em `www.milagranoficial.com.br` nao e enviado
  para `milagranoficial.com.br`. Sem o redirect, quem entra por
  `www/r/<slug>` e compra no apex perde a atribuicao.
- **Sem as variaveis do Resend, `POST /api/candidatura` responde 500
  `server_not_configured`** e o resto do site sobe normal. E deliberado: e
  melhor a LP no ar sem formulario do que a stack inteira fora.

## DNS e certificado

Resolvido. `milagranoficial.com.br` e `www` apontam para a VPS e o Traefik
emitiu certificado do Let's Encrypt para os dois (certificados separados,
nao um com SAN).

### O certificado nao sai depois de acertar o DNS — o que olhar

Aconteceu e vai acontecer de novo numa troca de dominio. A ordem importa: o
Traefik so tenta o desafio ACME quando *recebe uma configuracao*, e nao
fica repetindo em loop curto. Se o DNS propagou **depois** da ultima
tentativa, ele fica com o certificado padrao ate a proxima mudanca de
configuracao.

**O log nao esta onde se procura.** A stack do Traefik usa
`--log.filePath=/var/log/traefik/traefik.log`: com isso `docker service logs
traefik_traefik` volta **vazio**, e a leitura errada e concluir que o
Traefik nem tentou. O log de verdade:

```bash
TR=$(docker ps -q -f name=traefik_traefik)
docker exec "$TR" sh -c 'grep -i milagranoficial /var/log/traefik/traefik.log | tail -20'
```

O erro util e explicito — `urn:ietf:params:acme:error:dns :: no valid A
records found`. Para forcar nova tentativa, basta gerar configuracao nova:

```bash
docker service update --force milagran_app
```

Cuidado com repeticao as cegas: o Let's Encrypt limita **5 validacoes
falhas por hostname por hora**. Conferir o log antes de tentar de novo custa
menos que queimar a cota e esperar.

Conferir o resultado:

```bash
echo | openssl s_client -connect milagranoficial.com.br:443 \
  -servername milagranoficial.com.br 2>/dev/null | openssl x509 -noout -issuer -dates
```
