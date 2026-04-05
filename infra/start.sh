#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Create .env from example if it doesn't exist
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo "Creating infra/.env from .env.example ..."
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo "Review infra/.env and set your secrets before continuing."
  echo ""
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
echo "  App          http://localhost:5173"
echo "  Portal       http://localhost:5174"
echo "  API          http://localhost:4000/health"
echo "  GraphQL      http://localhost:4000/graphql"
echo "  Neo4j        http://localhost:7474"
echo "  Keycloak     http://localhost:8080"
echo "  Grafana      http://localhost:3001"
echo "  Jaeger       http://localhost:16686"
echo "==================================================="
