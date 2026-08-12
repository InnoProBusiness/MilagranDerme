#!/usr/bin/env bash
# Gera /opt/milagran/milagran-stack.yml a partir do modelo versionado
# (/opt/milagran/milagran-stack.example.yml), injetando os segredos do host.
#
# Uso: make-milagran-stack.sh [tag]        (default: v1)
#
# Diferenca proposital em relacao ao make-innofin-stack.sh: la o YAML inteiro
# vive dentro do script, entao editar o stack exige editar o script e o
# arquivo sai do controle de versao. Aqui o YAML e o .example.yml do repo e
# este script so substitui os placeholders -- uma fonte da verdade so, e um
# `git diff` mostra qualquer mudanca de infraestrutura.
#
# O dominio NAO e parametro: ele aparece em seis labels do modelo, incluindo
# uma regex com pontos escapados (www\.milagranoficial\.com\.br). Substituir
# isso por sed acertaria cinco lugares e corromperia a regex no sexto. Para
# trocar de dominio, edite o .example.yml e rode este script de novo.
set -euo pipefail

TAG="${1:-v1}"
MODELO=/opt/milagran/milagran-stack.example.yml
SAIDA=/opt/milagran/milagran-stack.yml

DBPASS=$(cat /root/.milagran-db-pass)
ATRIB=$(cat /root/.milagran-atribuicao-secret)

# Opcionais: enquanto nao existirem, as variaveis saem vazias e apenas o
# POST /api/candidatura responde 500 server_not_configured. O resto do site
# sobe normalmente.
ler_opcional() { [ -s "$1" ] && cat "$1" || echo ""; }
RESEND_KEY=$(ler_opcional /root/.milagran-resend-key)
EMAIL_FROM=$(ler_opcional /root/.milagran-email-from)
EMAIL_TO=$(ler_opcional /root/.milagran-email-to)

# `&` e o "texto casado" no replacement do sed e `|` e o delimitador usado
# aqui; sem escapar, um EMAIL_FROM com um deles gera um YAML errado em
# silencio. DBPASS e ATRIB sao hex puro e nao precisariam, mas passam pela
# mesma funcao para o dia em que alguem trocar o gerador.
escapar() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }

sed \
  -e "s|^\( *image: \)milagran:TAG$|\1milagran:${TAG}|" \
  -e "s|SENHA_DO_BANCO|$(escapar "$DBPASS")|" \
  -e "s|SEGREDO_DE_ATRIBUICAO|$(escapar "$ATRIB")|" \
  -e "s|^\( *- RESEND_API_KEY=\)$|\1$(escapar "$RESEND_KEY")|" \
  -e "s|^\( *- EMAIL_FROM=\)$|\1$(escapar "$EMAIL_FROM")|" \
  -e "s|^\( *- EMAIL_TO=\)$|\1$(escapar "$EMAIL_TO")|" \
  "$MODELO" > "$SAIDA"

chmod 600 "$SAIDA"

# Barreira contra o modo de falha silencioso: um placeholder que sobrou
# (por renomeacao no modelo, por exemplo) subiria uma stack que autentica
# no Postgres com a string literal "SENHA_DO_BANCO" e so falha em runtime.
if grep -qE 'SENHA_DO_BANCO|SEGREDO_DE_ATRIBUICAO|image: milagran:TAG' "$SAIDA"; then
  echo "ERRO: placeholder nao substituido em $SAIDA -- abortando." >&2
  rm -f "$SAIDA"
  exit 1
fi

echo "milagran-stack.yml gerado (imagem milagran:${TAG})"
[ -n "$RESEND_KEY" ] && echo "  Resend: configurado" || echo "  Resend: VAZIO -- POST /api/candidatura respondera 500 server_not_configured"
