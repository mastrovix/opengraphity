#!/bin/bash
# Aggiorna i redirect URIs del client opengrafo-web su Keycloak locale
# Uso:
#   set -a; . infra/.env; set +a
#   bash infra/scripts/update-keycloak-redirects.sh
# Richiede KEYCLOAK_ADMIN_PASSWORD nell'ambiente (la stessa di infra/.env):
# la password admin non è cablata nel repo.

set -euo pipefail

CONTAINER="opengrafo-keycloak"
REALM="c-one"
CLIENT_ID="opengrafo-web"
KEYCLOAK_ADMIN_USER="${KEYCLOAK_ADMIN_USER:-admin}"
: "${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD non impostata: esporta le variabili di infra/.env (set -a; . infra/.env; set +a)}"

echo "→ Autenticazione su Keycloak..."
docker exec -e KEYCLOAK_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" "$CONTAINER" \
  sh -c '/opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8080 \
    --realm master \
    --user "$1" \
    --password "$KEYCLOAK_ADMIN_PASSWORD"' sh "$KEYCLOAK_ADMIN_USER"

echo "→ Recupero ID interno del client $CLIENT_ID..."
CLIENT_UUID=$(docker exec "$CONTAINER" /opt/keycloak/bin/kcadm.sh get clients \
  --target-realm "$REALM" \
  --fields id,clientId \
  --format csv \
  | grep "$CLIENT_ID" \
  | head -1 \
  | cut -d',' -f1 \
  | tr -d '"')

if [ -z "$CLIENT_UUID" ]; then
  echo "✗ Client $CLIENT_ID non trovato nel realm $REALM" >&2
  exit 1
fi
echo "   Client UUID: $CLIENT_UUID"

echo "→ Aggiornamento redirectUris e webOrigins..."
docker exec "$CONTAINER" /opt/keycloak/bin/kcadm.sh update "clients/$CLIENT_UUID" \
  --target-realm "$REALM" \
  -s 'redirectUris=["http://c-one.localhost/*","http://*.localhost/*","https://c-one.opengrafo.pi/*"]' \
  -s 'webOrigins=["http://c-one.localhost","https://c-one.opengrafo.pi"]'

echo "✓ Client $CLIENT_ID aggiornato nel realm $REALM"
