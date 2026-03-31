#!/bin/bash
# Aggiorna i redirect URIs del client opengrafo-web su Keycloak locale
# Uso: bash infra/scripts/update-keycloak-redirects.sh

set -e

CONTAINER="opengrafo-keycloak"
REALM="c-one"
CLIENT_ID="opengrafo-web"

echo "→ Autenticazione su Keycloak..."
docker exec "$CONTAINER" /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user admin \
  --password opengrafo_local

echo "→ Recupero ID interno del client $CLIENT_ID..."
CLIENT_UUID=$(docker exec "$CONTAINER" /opt/keycloak/bin/kcadm.sh get clients \
  --target-realm "$REALM" \
  --fields id,clientId \
  --format csv \
  | grep "$CLIENT_ID" \
  | head -1 \
  | cut -d',' -f1 \
  | tr -d '"')

echo "   Client UUID: $CLIENT_UUID"

echo "→ Aggiornamento redirectUris e webOrigins..."
docker exec "$CONTAINER" /opt/keycloak/bin/kcadm.sh update "clients/$CLIENT_UUID" \
  --target-realm "$REALM" \
  -s 'redirectUris=["http://c-one.localhost/*","http://*.localhost/*","https://c-one.opengrafo.pi/*"]' \
  -s 'webOrigins=["http://c-one.localhost","https://c-one.opengrafo.pi"]'

echo "✓ Client $CLIENT_ID aggiornato nel realm $REALM"
