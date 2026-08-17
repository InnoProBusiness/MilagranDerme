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

# Mercado Pago e Clube Envios. Tambem "opcionais" no sentido tecnico (a stack
# sobe sem eles), mas a consequencia e MUITO diferente da do Resend: sem estes
# a loja fica no ar sem conseguir receber dinheiro nem cotar frete. Por isso o
# relatorio no fim do script trata os dois grupos de forma diferente -- Resend
# vazio e um aviso, pagamento vazio e um alerta.
MP_ACCESS=$(ler_opcional /root/.milagran-mp-access-token)
MP_PUBLIC=$(ler_opcional /root/.milagran-mp-public-key)
MP_WEBHOOK=$(ler_opcional /root/.milagran-mp-webhook-secret)
CE_TOKEN=$(ler_opcional /root/.milagran-clube-envios-token)
CE_CLIENTE=$(ler_opcional /root/.milagran-clube-envios-cliente-id)
CE_BASE=$(ler_opcional /root/.milagran-clube-envios-base-url)
CEP_ORIGEM=$(ler_opcional /root/.milagran-cep-origem)

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
  -e "s|^\( *- MERCADOPAGO_ACCESS_TOKEN=\)$|\1$(escapar "$MP_ACCESS")|" \
  -e "s|^\( *- MERCADOPAGO_PUBLIC_KEY=\)$|\1$(escapar "$MP_PUBLIC")|" \
  -e "s|^\( *- MERCADOPAGO_WEBHOOK_SECRET=\)$|\1$(escapar "$MP_WEBHOOK")|" \
  -e "s|^\( *- CLUBE_ENVIOS_TOKEN=\)$|\1$(escapar "$CE_TOKEN")|" \
  -e "s|^\( *- CLUBE_ENVIOS_CLIENTE_ID=\)$|\1$(escapar "$CE_CLIENTE")|" \
  -e "s|^\( *- CLUBE_ENVIOS_BASE_URL=\)$|\1$(escapar "$CE_BASE")|" \
  -e "s|^\( *- CEP_ORIGEM_EXPEDICAO=\)$|\1$(escapar "$CEP_ORIGEM")|" \
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

# RELATORIO DE PRONTIDAO PARA O LANCAMENTO DE 25/08/2026.
#
# Nao aborta: subir a loja sem pagamento configurado e uma decisao legitima
# (foi o estado de producao ate 16/08). O que nao pode acontecer de novo e a
# pessoa que roda o deploy NAO SABER disso -- o modo de falha anterior era
# 100% silencioso, sem erro em log nenhum, e so aparecia quando um comprador
# real chegava na tela de pagamento e nao encontrava botao.
faltando_pagamento=""
[ -n "$MP_ACCESS" ]  || faltando_pagamento="$faltando_pagamento MERCADOPAGO_ACCESS_TOKEN"
[ -n "$MP_PUBLIC" ]  || faltando_pagamento="$faltando_pagamento MERCADOPAGO_PUBLIC_KEY"
[ -n "$MP_WEBHOOK" ] || faltando_pagamento="$faltando_pagamento MERCADOPAGO_WEBHOOK_SECRET"

if [ -n "$faltando_pagamento" ]; then
  echo "  Mercado Pago: INCOMPLETO --$faltando_pagamento"
  echo "    Efeito: a loja sobe, mas ninguem consegue pagar. Sem o webhook secret"
  echo "    nenhum pagamento e conciliado -- e sem conciliacao o estoque nao baixa"
  echo "    e a comissao nao e creditada."
  echo "    Cadastre em /root/.milagran-mp-access-token, .milagran-mp-public-key"
  echo "    e .milagran-mp-webhook-secret, depois rode este script de novo."
else
  case "$MP_ACCESS" in
    TEST-*)    echo "  Mercado Pago: configurado em SANDBOX (token TEST-) -- nenhum dinheiro real se move" ;;
    APP_USR-*) echo "  Mercado Pago: configurado em PRODUCAO (token APP_USR-)" ;;
    *)         echo "  Mercado Pago: configurado, mas o token nao comeca com TEST- nem APP_USR- -- confira o valor" ;;
  esac
fi

faltando_frete=""
[ -n "$CE_TOKEN" ]   || faltando_frete="$faltando_frete CLUBE_ENVIOS_TOKEN"
[ -n "$CE_CLIENTE" ] || faltando_frete="$faltando_frete CLUBE_ENVIOS_CLIENTE_ID"
[ -n "$CEP_ORIGEM" ] || faltando_frete="$faltando_frete CEP_ORIGEM_EXPEDICAO"

if [ -n "$faltando_frete" ]; then
  echo "  Frete (Clube Envios): INCOMPLETO --$faltando_frete"
  echo "    Efeito: /api/frete responde 503 e o CHECKOUT ONLINE PARA no passo do"
  echo "    endereco. A venda presencial do evento continua funcionando (nao tem frete)."
else
  [ -n "$CE_BASE" ] \
    && echo "  Frete (Clube Envios): configurado apontando para $CE_BASE" \
    || echo "  Frete (Clube Envios): configurado em PRODUCAO (apis.clubeenvios.com.br)"
fi
