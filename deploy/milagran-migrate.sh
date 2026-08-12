#!/usr/bin/env bash
# Aplica migrations/*.sql no banco `milagran` do Postgres do swarm.
#
# Uso: milagran-migrate.sh [tag-da-imagem-de-build]   (default: v1)
#
# Roda a partir do build stage da imagem (milagran-build:<tag>), que e o
# unico lugar onde o node-pg-migrate existe -- ele e devDependency e o
# estagio de runtime da imagem nao tem node_modules completo (o Next
# standalone so embala o que o servidor importa).
set -euo pipefail

TAG="${1:-v1}"
DBPASS=$(cat /root/.milagran-db-pass)
PG=$(docker ps -q -f name=postgres_postgres)

if [ -z "$PG" ]; then
  echo "ERRO: container do postgres_postgres nao encontrado." >&2
  exit 1
fi

# A imagem de build pesa ~1.5GB e a VPS opera perto do limite de disco, entao
# ela NAO fica residente: e reconstruida aqui quando falta. O custo e alguns
# minutos numa operacao que ja e rara e manual; o beneficio e 1.5GB livres
# durante todo o resto do tempo, num disco onde o Postgres de quatro projetos
# precisa conseguir escrever.
if ! docker image inspect "milagran-build:${TAG}" >/dev/null 2>&1; then
  echo "milagran-build:${TAG} ausente -- reconstruindo a partir de /opt/milagran..."
  docker build --target build -t "milagran-build:${TAG}" /opt/milagran
  echo
fi

# A netInnotalk e swarm-scoped e nao foi criada como --attachable, entao
# `docker run --network netInnotalk` e recusado. Compartilhar o network
# namespace do proprio container do Postgres resolve sem alterar a rede
# (que e usada pela producao): o banco fica em 127.0.0.1:5432 la dentro.
DBURL="postgres://milagran:${DBPASS}@127.0.0.1:5432/milagran"

# DIRECT_URL, nao DATABASE_URL: o script "db:migrate" do package.json aponta
# o node-pg-migrate explicitamente para essa variavel (-d DIRECT_URL). Ver o
# comentario no .env.example -- DDL nunca deve passar por pooler.
docker run --rm \
  --network "container:${PG}" \
  -e DIRECT_URL="$DBURL" \
  "milagran-build:${TAG}" \
  npm run db:migrate

echo
echo "=== tabelas no banco milagran ==="
docker exec "$PG" psql -U postgres -d milagran -c '\dt'
