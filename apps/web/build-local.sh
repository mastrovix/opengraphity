#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Costruisce il bundle del web con le variabili di `infra/.env`.
#
# ## Perché esiste
# `apps/web/Dockerfile` COPIA `apps/web/dist` (scelta voluta: il JS in
# produzione è identico a quello provato in locale). Quindi le variabili del
# bundle vengono dal comando di build locale — e scriverle a mano ogni volta è
# un errore che aspetta di succedere: il 18 set 2026 è successo. Il bundle è
# stato costruito senza `VITE_TENANT_SLUG`, quindi da un host Tailscale il
# tenant (e con lui il REALM di Keycloak) veniva dedotto dal nome host:
# `macbook-pro-di-vittorio`, un realm che non esiste. Keycloak rimandava
# all'endpoint di login annidando ogni volta il `redirect_uri`, finché l'URL
# non superava il limite di nginx: **414 Request-URI Too Large**, applicazione
# irraggiungibile. E la ricetta che avevo in memoria elencava una variabile che
# il codice non legge nemmeno (`VITE_KEYCLOAK_REALM`).
#
# ## Cosa fa
# 1. prende da `infra/.env` **solo** le righe `VITE_*` (i segreti restano lì);
# 2. mette il valore predefinito di `VITE_API_URL` (`/graphql`, relativo: vale
#    sia da `c-one.localhost` sia da Tailscale);
# 3. costruisce;
# 4. **verifica** che il bundle contenga lo slug del tenant quando `.env` lo
#    definisce: se manca, la build FALLISCE invece di produrre un bundle che
#    non si autentica.
#
# Uso:  ./apps/web/build-local.sh     (dalla radice del repo)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
envfile="$repo/infra/.env"

[ -f "$envfile" ] || { echo "build-local: $envfile non esiste" >&2; exit 1; }

# Solo le VITE_*: tutto il resto di .env (credenziali comprese) non entra
# nell'ambiente di build.
while IFS= read -r line; do
  export "$line"
done < <(grep -E '^VITE_[A-Z0-9_]+=' "$envfile" || true)

: "${VITE_API_URL:=/graphql}"
: "${VITE_KEYCLOAK_CLIENT_ID:=opengraphity-web}"
export VITE_API_URL VITE_KEYCLOAK_CLIENT_ID

echo "build-local: variabili del bundle"
for v in VITE_API_URL VITE_API_BASE_URL VITE_KEYCLOAK_URL VITE_KEYCLOAK_CLIENT_ID VITE_TENANT_SLUG; do
  printf '  %-28s %s\n' "$v" "${!v:-(non impostata)}"
done

( cd "$repo" && pnpm --filter @opengraphity/web build )

# ── La verifica che avrebbe fatto fallire il 18 settembre ────────────────────
if [ -n "${VITE_TENANT_SLUG:-}" ]; then
  if ! grep -rqF "$VITE_TENANT_SLUG" "$repo/apps/web/dist/assets/"*.js; then
    echo "build-local: ERRORE — il bundle non contiene lo slug del tenant \"$VITE_TENANT_SLUG\"." >&2
    echo "  Senza, il realm di Keycloak viene dedotto dal nome host e l'accesso da un host" >&2
    echo "  senza sottodominio del tenant (Tailscale) finisce in un ciclo di redirect (414)." >&2
    exit 1
  fi
  echo "build-local: slug del tenant \"$VITE_TENANT_SLUG\" presente nel bundle ✓"
fi
echo "build-local: fatto. Ora: cd infra && docker compose build web && docker compose up -d web"
