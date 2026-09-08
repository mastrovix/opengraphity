#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Variables docker-compose.yml refuses to start without (${VAR:?...}): the stack
# has no default secrets, a freshly copied .env.example still holds placeholders.
REQUIRED_VARS=(
  JWT_SECRET
  NEO4J_PASSWORD
  KEYCLOAK_ADMIN_PASSWORD
  REDIS_PASSWORD
  MINIO_ROOT_USER
  MINIO_ROOT_PASSWORD
)

# Create .env from example if it doesn't exist — and STOP: starting with the
# example's placeholders would boot a "production" stack with known secrets.
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo "Creating infra/.env from .env.example ..."
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo ""
  echo "infra/.env has just been created from the example and contains placeholders."
  echo "Set real values for these variables, then run ./infra/start.sh again:"
  for v in "${REQUIRED_VARS[@]}"; do
    echo "  - $v"
  done
  echo ""
  exit 2
fi

echo "Starting OpenGraphity ..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" --env-file "$SCRIPT_DIR/.env" up -d --build

echo ""
echo "Services started. Waiting for health checks ..."
sleep 10

echo ""
echo "==================================================="
echo "  OpenGraphity is up"
echo "==================================================="
echo "  App          http://c-one.localhost"
echo "  Portal       http://portal.c-one.localhost"
echo "  (the ports below are bound to 127.0.0.1 only)"
echo "  App (direct) http://localhost:5173"
echo "  Portal       http://localhost:5174"
echo "  API          http://localhost:4000/health"
echo "  GraphQL      http://localhost:4000/graphql"
echo "  Neo4j        http://localhost:7474"
echo "  Keycloak     http://localhost:8080"
echo "  Grafana      http://localhost:3001"
echo "  Jaeger       http://localhost:16686"
echo "==================================================="
