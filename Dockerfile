# Milagran — plataforma (Next.js 16 + Kysely/Postgres)
#
# Imagem do unico deploy do projeto: Docker Swarm na VPS (ver DEPLOY.md).
#
# ---------- build stage ----------
# Tambem serve de imagem para rodar as migrations e a suite de testes:
# node-pg-migrate e vitest sao devDependencies e so existem aqui. O
# deploy/milagran-migrate.sh tagueia este estagio como milagran-build:<tag>,
# sob demanda — a imagem pesa 1.5GB e nao fica residente na VPS.
FROM node:22-alpine AS build
WORKDIR /app

# A VPS tem 3.8GB de RAM e roda outras seis stacks. Sem teto explicito o V8
# dimensiona o heap pela memoria total da maquina, comeca a crescer e o OOM
# killer derruba o build — ou pior, algum container vizinho. O /swapfile de
# 2GB (ver DEPLOY.md) cobre o resto; nos builds observados ele chegou a
# 1.7GB em uso.
ENV NODE_OPTIONS=--max-old-space-size=1024

COPY package.json package-lock.json ./
# `npm ci` completo (com devDependencies): o build precisa de typescript e
# @types/*, e este mesmo estagio roda as migrations.
RUN npm ci

COPY . .

# Os valores de banco/segredo aqui sao placeholders de build, inline no
# comando em vez de ENV para nao ficarem gravados na imagem nem vazarem para
# o runtime. Nenhuma pagina abre conexao durante o `next build` (a unica
# rota de banco, /r/[slug], e force-dynamic), mas o modulo de atribuicao
# valida o tamanho do segredo no import e derrubaria o build com
# "ATRIBUICAO_SECRET ausente". Os valores reais chegam em runtime, pelo stack.
RUN DATABASE_URL="postgres://build:build@localhost:5432/build" \
    ATRIBUICAO_SECRET="placeholder-de-build-sem-valor-real-0123456789" \
    npx next build

# ---------- runtime stage ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TZ=America/Sao_Paulo

# tzdata: a imagem alpine nao traz o banco de fusos, e sem ele TZ e
# ignorada silenciosamente — o rodape do PDF da candidatura (formatado com
# timeZone America/Sao_Paulo) sairia em UTC, tres horas adiantado.
RUN apk add --no-cache tzdata

# Usuario sem privilegio: o processo nao precisa de root e o container
# monta o socket de nada. Cria antes do COPY para os arquivos ja nascerem
# com o dono certo.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# O standalone traz server.js e apenas as dependencias que o servidor
# importa de fato — nao ha `npm ci` neste estagio. .next/static e public/
# ficam de fora do standalone por design e precisam ser copiados a mao:
# sem eles o site sobe sem CSS/JS e a LP inteira (que e HTML estatico em
# public/) devolve 404.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Consulta /api/health, que de proposito nao toca no banco (ver a rota):
# um healthcheck acoplado ao Postgres transformaria "banco fora" em
# "aplicacao em restart loop".
HEALTHCHECK --interval=30s --timeout=10s --start-period=25s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
