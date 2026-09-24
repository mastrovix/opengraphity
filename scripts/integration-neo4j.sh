#!/usr/bin/env bash
#
# THE CHECKS AGAINST A REAL NEO4J (wave 7 · C2) — the same command in the CI
# and on a developer's machine.
#
#   scripts/integration-neo4j.sh          # start, check, remove the containers
#   scripts/integration-neo4j.sh --keep   # leave them up: a second run reuses
#                                         # them and the two tenants already made
#
# A throwaway Neo4j — the image AND digest of infra/docker-compose.yml, read
# from there so the two never drift — and a throwaway Redis, on ports of their
# own: the local stack keeps running untouched, and the events of the test
# tenants never reach its queues. Then, in order:
#
#   1. the schema and EVERY migration on an empty database: a broken migration
#      stops here, not at a deploy;
#   2. the shared metamodels, as a new stack gets them (docs/DEPLOY.md);
#   3. check-cypher: every query of the code through EXPLAIN;
#   4. the integration suite (apps/api/src/__integration__): two tenants born
#      like a customer's and filled by the demo generator, and the queries of
#      one tenant must never return an id of the other;
#   5. no relationship between two tenants (lib/crossTenantEdges.ts).
#
# The API's packages must be built (`pnpm --filter "./packages/*" build`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KEEP=false
[ "${1:-}" = "--keep" ] && KEEP=true

NEO4J_NAME=og-integration-neo4j
REDIS_NAME=og-integration-redis
NEO4J_PORT=17687
REDIS_PORT=16379

NEO4J_IMAGE="$(awk '/^  neo4j:/{s=1} s && /image:/{print $2; exit}' infra/docker-compose.yml)"
REDIS_IMAGE="$(awk '/^  redis:/{s=1} s && /image:/{print $2; exit}' infra/docker-compose.yml)"
case "$NEO4J_IMAGE" in neo4j:*@sha256:*) ;; *) echo "✖ the neo4j image of infra/docker-compose.yml was not found (got '$NEO4J_IMAGE')" >&2; exit 1 ;; esac
case "$REDIS_IMAGE" in redis:*@sha256:*) ;; *) echo "✖ the redis image of infra/docker-compose.yml was not found (got '$REDIS_IMAGE')" >&2; exit 1 ;; esac

cleanup() {
  if [ "$KEEP" = false ]; then
    docker rm -f "$NEO4J_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }

if running "$NEO4J_NAME"; then
  echo "▶ reusing $NEO4J_NAME"
else
  docker rm -f "$NEO4J_NAME" >/dev/null 2>&1 || true
  # A password of this run only: the database lives as long as the run.
  NEO4J_PASSWORD_RUN="$(openssl rand -hex 16)"
  echo "▶ starting $NEO4J_IMAGE as $NEO4J_NAME"
  # Heap and page cache sized for a runner (7 GB): the limits of a transaction
  # are the stack's own (A2), the queries must pass under them here too.
  docker run -d --name "$NEO4J_NAME" --memory 2560m \
    -p "127.0.0.1:${NEO4J_PORT}:7687" \
    -e "NEO4J_AUTH=neo4j/${NEO4J_PASSWORD_RUN}" \
    -e 'NEO4J_PLUGINS=["apoc"]' \
    -e 'NEO4J_dbms_security_procedures_unrestricted=apoc.*' \
    -e NEO4J_server_memory_heap_initial__size=1G \
    -e NEO4J_server_memory_heap_max__size=1536m \
    -e NEO4J_server_memory_pagecache_size=512m \
    -e NEO4J_db_transaction_timeout=120s \
    -e NEO4J_db_memory_transaction_max=1g \
    "$NEO4J_IMAGE" >/dev/null
fi
if ! running "$REDIS_NAME"; then
  docker rm -f "$REDIS_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$REDIS_NAME" -p "127.0.0.1:${REDIS_PORT}:6379" "$REDIS_IMAGE" >/dev/null
fi

echo "▶ waiting for Neo4j"
for _ in $(seq 1 90); do
  docker logs "$NEO4J_NAME" 2>&1 | grep -q 'Started\.' && break
  sleep 2
done
docker logs "$NEO4J_NAME" 2>&1 | grep -q 'Started\.' || { docker logs "$NEO4J_NAME" 2>&1 | tail -30; echo "✖ Neo4j did not start" >&2; exit 1; }

# The password is the container's: read it from there, never printed.
NEO4J_PASSWORD="$(docker exec "$NEO4J_NAME" sh -c 'printf %s "${NEO4J_AUTH#neo4j/}"')"
export NEO4J_PASSWORD
export NEO4J_URI="neo4j://localhost:${NEO4J_PORT}"
export NEO4J_USER=neo4j
export REDIS_URL="redis://localhost:${REDIS_PORT}"
export NODE_ENV=test
export OG_INTEGRATION_NEO4J=throwaway
export NODE_OPTIONS=--no-node-snapshot

api() { pnpm --silent --filter @opengraphity/api exec tsx "$@"; }

echo "▶ 1/5 schema and every migration, on an empty database"
api src/scripts/migrate.ts --init-schema

echo "▶ 2/5 the shared metamodels"
api src/scripts/seed-metamodel.ts
api src/scripts/seed-itil-metamodel.ts

echo "▶ 3/5 check-cypher"
NEO4J_CONTAINER="$NEO4J_NAME" node scripts/check-cypher.mjs

echo "▶ 4/5 the integration suite"
api src/__integration__/prepare.ts
pnpm --filter @opengraphity/api exec vitest run --config vitest.integration.config.ts

echo "▶ 5/5 no relationship between two tenants"
api src/scripts/check-cross-tenant-edges.ts

echo "✓ the checks against a real Neo4j passed"
