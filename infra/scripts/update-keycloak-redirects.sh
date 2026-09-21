#!/bin/bash
# Aggiorna redirect URIs e webOrigins dei client di un'organizzazione su
# Keycloak locale — il web E il portale, per il realm che si indica.
#
# Uso:
#   set -a; . infra/.env; set +a
#   bash infra/scripts/update-keycloak-redirects.sh <slug> [host-pubblico]
#
#   <slug>            realm/organizzazione (es. c-one, c-test, acme)
#   [host-pubblico]    hostname extra da ammettere oltre a <slug>.localhost
#                      (es. l'host Tailscale, o c-one.opengrafo.pi). Opzionale.
#
# Richiede KEYCLOAK_ADMIN_PASSWORD nell'ambiente (la stessa di infra/.env):
# la password admin non è cablata nel repo.
#
# Revisione totale · H-30: realm `c-one`, client `opengrafo-web` e l'host
# `c-one.opengrafo.pi` erano CABLATI, il portale non veniva toccato affatto
# (quindi via Tailscale restava senza redirect) e il `grep "$CLIENT_ID"` era
# per sottostringa, quindi avrebbe preso anche `opengrafo-web-2`. DEPLOY §5 lo
# indica come passo standard: per un'organizzazione `acme` aggiornava `c-one`.

set -euo pipefail

CONTAINER="opengrafo-keycloak"
REALM="${1:?Uso: update-keycloak-redirects.sh <slug> [host-pubblico] — es. c-one}"
PUBLIC_HOST="${2:-}"
KEYCLOAK_ADMIN_USER="${KEYCLOAK_ADMIN_USER:-admin}"
: "${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD non impostata: esporta le variabili di infra/.env (set -a; . infra/.env; set +a)}"

# I client dei bundle: gli stessi id che il compose passa all'API in
# KEYCLOAK_APP_CLIENT_IDS (infra/docker-compose.yml).
WEB_CLIENT="${VITE_KEYCLOAK_CLIENT_ID:-opengrafo-web}"
PORTAL_CLIENT="${VITE_KEYCLOAK_CLIENT_ID_PORTAL:-opengrafo-portal}"

echo "→ Autenticazione su Keycloak..."
docker exec -e KEYCLOAK_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" "$CONTAINER" \
  sh -c '/opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8080 \
    --realm master \
    --user "$1" \
    --password "$KEYCLOAK_ADMIN_PASSWORD"' sh "$KEYCLOAK_ADMIN_USER"

# UUID interno del client, con confronto ESATTO sul clientId (non per
# sottostringa: `opengrafo-web` non deve prendere `opengrafo-web-2`).
client_uuid() {
  docker exec "$CONTAINER" /opt/keycloak/bin/kcadm.sh get clients \
    --target-realm "$REALM" \
    --query "clientId=$1" \
    --fields id \
    --format csv 2>/dev/null \
    | tr -d '"' \
    | grep -E '^[0-9a-f-]{36}$' \
    | head -1
}

update_client() {
  local client_id="$1"; shift
  local redirects="$1"; shift
  local origins="$1"

  local uuid
  uuid="$(client_uuid "$client_id")"
  if [ -z "$uuid" ]; then
    echo "✗ Client $client_id non trovato nel realm $REALM" >&2
    return 1
  fi
  echo "→ $client_id ($uuid)"
  docker exec "$CONTAINER" /opt/keycloak/bin/kcadm.sh update "clients/$uuid" \
    --target-realm "$REALM" \
    -s "redirectUris=$redirects" \
    -s "webOrigins=$origins"
}

# Gli indirizzi: il sottodominio dell'organizzazione, il jolly *.localhost per
# lo sviluppo e — se indicato — l'host pubblico.
web_redirects="[\"http://${REALM}.localhost/*\",\"http://*.localhost/*\""
web_origins="[\"http://${REALM}.localhost\""
portal_redirects="[\"http://portal.${REALM}.localhost/*\",\"http://*.localhost/*\""
portal_origins="[\"http://portal.${REALM}.localhost\""
if [ -n "$PUBLIC_HOST" ]; then
  # Il portale via front-door Tailscale sta sotto /portal/ dello stesso host (H-33).
  web_redirects="${web_redirects},\"https://${PUBLIC_HOST}/*\""
  web_origins="${web_origins},\"https://${PUBLIC_HOST}\""
  portal_redirects="${portal_redirects},\"https://${PUBLIC_HOST}/portal/*\""
  portal_origins="${portal_origins},\"https://${PUBLIC_HOST}\""
fi
web_redirects="${web_redirects}]";    web_origins="${web_origins}]"
portal_redirects="${portal_redirects}]"; portal_origins="${portal_origins}]"

update_client "$WEB_CLIENT"    "$web_redirects"    "$web_origins"
update_client "$PORTAL_CLIENT" "$portal_redirects" "$portal_origins"

echo "✓ Realm $REALM aggiornato: $WEB_CLIENT e $PORTAL_CLIENT"
