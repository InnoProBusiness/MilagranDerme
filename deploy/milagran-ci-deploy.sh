#!/usr/bin/env bash
# Deploy automatico do milagran, disparado pelo GitHub Actions em push na main.
#
# Este script e a *forced command* da chave de deploy: a entrada em
# /root/.ssh/authorized_keys e
#
#   restrict,command="/root/milagran-ci-deploy.sh" ssh-ed25519 AAAA... milagran-ci
#
# ou seja, qualquer conexao autenticada por essa chave executa ISTO e nada
# mais, independentemente do comando pedido pelo cliente. O repositorio e
# publico; se a chave privada vazar do GitHub Secrets, o estrago fica
# limitado a disparar um deploy — nao vira shell de root.
#
# Protocolo com o Actions:
#   stdin                  tarball .tar.gz da arvore do repo
#   SSH_ORIGINAL_COMMAND   sha do commit (validado abaixo)
#
#   tar -czf - . | ssh -i chave deploy@vps <sha>
set -euo pipefail

log() { echo "[ci-deploy] $*"; }
erro() { echo "[ci-deploy] ERRO: $*" >&2; exit 1; }

# --- 1. Valida a entrada, que vem da rede ------------------------------------
# Sem esta checagem o valor cairia direto em `docker build -t milagran:$SHA` e
# no sed do stack file. Aceita so hex: nada que possa virar flag, caminho,
# separador de comando ou padrao de sed.
SHA_BRUTO="${SSH_ORIGINAL_COMMAND:-}"
case "$SHA_BRUTO" in
  *[!0-9a-f]* | '') erro "sha invalido, recusado" ;;
esac
[ ${#SHA_BRUTO} -ge 7 ] || erro "sha curto demais"
SHA="${SHA_BRUTO:0:12}"

# --- 2. Serializa -------------------------------------------------------------
# Dois pushes seguidos na main chegariam juntos e os dois mexeriam no mesmo
# stack file e nas mesmas tags. -w 900: espera o anterior em vez de abortar,
# porque um deploy descartado em silencio e pior do que um deploy lento.
exec 9>/var/lock/milagran-deploy.lock
flock -w 900 9 || erro "outro deploy em andamento ha mais de 15min"

log "commit ${SHA}"

# --- 3. Pre-voo de disco ------------------------------------------------------
# A VPS tem 19GB e divide o Postgres com outros quatro projetos. Um build que
# enche o disco nao quebra so este deploy: o Postgres para de gravar e leva
# junto o CRM, o financeiro e a Evolution. Abortar aqui e barato; encher o
# disco, nao. O innotalk-disk-cleanup.sh (cron horario) costuma liberar
# espaco sozinho acima de 70%, entao a mensagem manda esperar antes de agir.
LIVRE_MB=$(df --output=avail -m / | tail -1 | tr -dc '0-9')
MINIMO_MB=2200
if [ "$LIVRE_MB" -lt "$MINIMO_MB" ]; then
  erro "disco com ${LIVRE_MB}MB livres, minimo ${MINIMO_MB}MB. O build precisa de ~1.5GB.
       Rode 'docker builder prune -af' ou espere o innotalk-disk-cleanup.sh (roda de hora em hora)."
fi
log "disco: ${LIVRE_MB}MB livres"

# O cache de build chegou a 1.6GB num unico build. Limpar sempre na saida —
# inclusive quando o deploy falha, que e justamente quando o disco esta pior.
trap 'docker builder prune -af >/dev/null 2>&1 || true' EXIT

# --- 4. Recebe o codigo em area de staging ------------------------------------
# Extrai fora de /opt/milagran de proposito: se o build falhar, a arvore que
# gerou a versao no ar continua intacta para diagnostico e para rollback.
STAGING=/opt/milagran.staging
rm -rf "$STAGING"
mkdir -p "$STAGING"
tar -xzf - -C "$STAGING" || erro "tarball invalido no stdin"
[ -f "$STAGING/Dockerfile" ] || erro "tarball sem Dockerfile — arvore errada?"

# --- 5. Build ------------------------------------------------------------------
log "build milagran:${SHA}"
docker build -t "milagran:${SHA}" "$STAGING"

# So depois do build bem-sucedido a arvore de producao e substituida.
# --delete remove o que saiu do repo (foi assim que index.html e api/ ficaram
# orfaos aqui na migracao manual). milagran-stack.yml e o unico arquivo que
# nasce na VPS e nao no repo — ele guarda os segredos e nao pode ser apagado.
rsync -a --delete --exclude=milagran-stack.yml "$STAGING/" /opt/milagran/
rm -rf "$STAGING"
chmod +x /opt/milagran/deploy/*.sh 2>/dev/null || true

# --- 6. Migrations -------------------------------------------------------------
# ANTES do stack deploy: a versao nova pode depender de coluna que a antiga
# nao tem. Migration em SQL puro aqui e sempre aditiva por convencao (ver
# migrations/), entao a versao antiga sobrevive ao esquema novo durante o
# rolling update. Se falhar, o `set -e` aborta e a versao no ar nao muda.
log "migrations"
/root/milagran-migrate.sh "${SHA}" >/dev/null || erro "migrations falharam — deploy abortado, versao no ar intacta"

# A imagem de build pesa 1.5GB e so serve para as migrations.
docker image rm "milagran-build:${SHA}" >/dev/null 2>&1 || true

# --- 7. Deploy -----------------------------------------------------------------
# Guarda a tag no ar ANTES de trocar: e para ela que o rollback volta se a
# verificacao pela borda reprovar.
TAG_ANTERIOR=$(docker service inspect milagran_app \
  --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null \
  | cut -d@ -f1 | cut -d: -f2 || true)
log "versao no ar antes desta: ${TAG_ANTERIOR:-nenhuma}"

# O GERADOR VEM DO REPOSITORIO A CADA DEPLOY, e isso conserta uma falha real
# observada em 17/08/2026.
#
# O `rsync` acima sincroniza /opt/milagran/, mas nunca /root/ — e a copia de
# /root/make-milagran-stack.sh era de 11/08, anterior aos Planos 3 e 4. Ela nao
# conhecia MERCADOPAGO_*, CLUBE_ENVIOS_* nem CEP_ORIGEM_EXPEDICAO, entao
# gerava a stack deixando essas variaveis VAZIAS — mesmo com os segredos
# gravados corretamente em /root/.milagran-*.
#
# O sintoma era cruel: pagamento e frete morriam no ar, o deploy passava verde,
# e um `docker service update --env-add` feito a mao "resolvia" ate o proximo
# deploy silenciosamente apagar tudo de novo, porque `stack deploy` substitui a
# spec inteira do servico.
#
# Copiar aqui elimina a classe do problema: a versao no repositorio e a que
# roda, sempre. As duas linhas ficam ANTES da chamada de proposito.
install -m 700 /opt/milagran/deploy/make-milagran-stack.sh /root/make-milagran-stack.sh
/root/make-milagran-stack.sh "${SHA}"

# --resolve-image never: a imagem so existe no daemon local, nao ha registry.
# Sem a flag o Swarm tenta resolver o digest no Docker Hub, nao acha
# "milagran" e o deploy falha.
log "docker stack deploy"
docker stack deploy --resolve-image never -c /opt/milagran/milagran-stack.yml milagran

# --- 8. Confere que subiu de verdade -------------------------------------------
# `stack deploy` volta assim que aceita a spec, nao quando a task esta no ar.
# Sem esta espera o Actions ficaria verde mesmo com o container em crash loop.
log "aguardando convergencia"
for i in $(seq 1 30); do
  ESTADO=$(docker service ps milagran_app --filter desired-state=running \
             --format '{{.CurrentState}}' 2>/dev/null | head -1)
  IMAGEM=$(docker service inspect milagran_app \
             --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null | cut -d@ -f1)
  case "$ESTADO" in
    Running*) [ "$IMAGEM" = "milagran:${SHA}" ] && { log "no ar: ${IMAGEM} (${ESTADO})"; break; } ;;
  esac
  [ "$i" -eq 30 ] && erro "nao convergiu em 60s — ultimo estado: ${ESTADO:-desconhecido}"
  sleep 2
done

# --- 8b. Verificacao pela borda, com retry -------------------------------------
# Busca a LP pelo Traefik, com o Host de producao. Nao e redundante com o
# healthcheck do container: aquele so pergunta se /api/health responde, e o
# site inteiro pode estar 404 com ele verde — e o caso de .next/static ou
# public/ ausentes (ver DEPLOY.md).
#
# O retry existe porque a task virar "Running" no Swarm nao significa que o
# Traefik ja registrou o container novo. Nessa janela o router existe sem
# backend e o Traefik responde 404 — indistinguivel, numa unica tentativa,
# de uma imagem realmente quebrada. Foi exatamente o que aconteceu no
# primeiro teste deste script.
verificar_borda() {
  local i codigo=000
  for i in $(seq 1 12); do
    codigo=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 \
      --resolve milagranoficial.com.br:443:127.0.0.1 \
      https://milagranoficial.com.br/seja-representante.html || echo 000)
    if [ "$codigo" = "200" ]; then
      log "verificacao pela borda: 200 (tentativa ${i})"
      return 0
    fi
    sleep 5
  done
  log "verificacao pela borda falhou: ultimo codigo ${codigo}"
  return 1
}

if ! verificar_borda; then
  # Deploy ruim nao pode ficar no ar so porque o processo terminou. O
  # `service rollback` do Swarm volta a spec anterior; o stack file tambem
  # volta, senao o proximo `stack deploy` manual reimplantaria a versao
  # quebrada sem ninguem perceber.
  log "revertendo para ${TAG_ANTERIOR:-versao anterior}"
  docker service rollback milagran_app >/dev/null 2>&1 || true
  if [ -n "${TAG_ANTERIOR:-}" ]; then
    /root/make-milagran-stack.sh "${TAG_ANTERIOR}" >/dev/null 2>&1 || true
  fi
  verificar_borda && log "rollback OK, site restaurado" || log "ATENCAO: site segue fora apos o rollback"
  erro "deploy de ${SHA} reprovado na verificacao pela borda e foi revertido"
fi

# --- 9. Retencao ---------------------------------------------------------------
# Guarda as 3 imagens mais recentes para rollback. O Docker recusa remover a
# que esta em uso, entao a versao no ar nunca corre risco.
docker image ls milagran --format '{{.Tag}}' | tail -n +4 | while read -r t; do
  docker image rm "milagran:${t}" >/dev/null 2>&1 || true
done

log "OK: milagran:${SHA}"
