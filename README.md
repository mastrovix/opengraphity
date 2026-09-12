# OpenGraphity

[![CI](https://github.com/mastrovix/opengraphity/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mastrovix/opengraphity/actions/workflows/ci.yml)

ITSM platform built on a graph database (Neo4j), with a React frontend, self-service portal, and GraphQL API.

## Quick Start (Docker)

### 1. Add tenant subdomains to `/etc/hosts`

Nginx routes traffic on port 80 using `Host` headers, so your machine needs to resolve `*.localhost` subdomains.
Add the following lines (replace `c-one` with your tenant slug):

```
127.0.0.1  c-one.localhost
127.0.0.1  portal.c-one.localhost
```

> **macOS shortcut:** `echo "127.0.0.1 c-one.localhost portal.c-one.localhost" | sudo tee -a /etc/hosts`

### 2. Start all services

```bash
git clone <repo>
cd opengraphity
cp infra/.env.example infra/.env   # then REPLACE every change-me-* placeholder
docker compose -f infra/docker-compose.yml up -d --build
```

The compose file has no default secrets: `docker compose` refuses to start until
`JWT_SECRET`, `NEO4J_PASSWORD`, `REDIS_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`,
`GRAFANA_ADMIN_PASSWORD`, `TAILSCALE_HOST` and `VITE_KEYCLOAK_URL` are set in
`infra/.env` (`./infra/start.sh` stops with the same list when it has just
created the file). Redis runs with `--requirepass`; api and worker reach it
through `REDIS_URL` + `REDIS_PASSWORD`. Only nginx (`:80`) listens on all
interfaces; every other port below is bound to `127.0.0.1`. GraphQL
introspection is off by default (`GRAPHQL_INTROSPECTION=true` in `infra/.env`
enables the Apollo Sandbox locally).

Every third-party image is pinned by tag **and** digest, the API image runs as
the unprivileged `node` user with production dependencies only, and nginx reads
the Tailscale hostname from `infra/.env` (`infra/nginx/default.conf.template`).
**The full procedure — prerequisites, first start, tenant onboarding, upgrade
(including the one-off volume `chown` when coming from an older root image),
rollback, backup/restore, exposed ports, production hardening — is in
[`docs/DEPLOY.md`](docs/DEPLOY.md).**

`infra/.env.example` documents every variable the code reads, with a comment
each; `node scripts/check-env-example.mjs` (also a CI step) fails when the code
and the example drift. With `NODE_ENV=production` the API validates its whole
configuration at boot (`apps/api/src/lib/config.ts`) and lists every missing
variable in one error — the localhost/`./data` defaults exist only in development.

Wait ~60 seconds for all services to come up, then open:

| Service                 | URL                                  |
|-------------------------|--------------------------------------|
| App (agent)             | http://c-one.localhost               |
| Portal (self-service)   | http://portal.c-one.localhost        |
| API health              | http://localhost:4000/health         |
| Neo4j                   | http://localhost:7474                |
| Keycloak                | http://localhost:8080                |
| Grafana                 | http://localhost:3001                |
| Prometheus              | http://localhost:9090                |
| Jaeger                  | http://localhost:16686               |

Or use the helper script:

```bash
./infra/start.sh
```

### Deploy web (build locale, poi immagine)

L'immagine `web` **non compila**: `apps/web/Dockerfile` copia `apps/web/dist`. Le variabili `VITE_*` vanno quindi date al build locale (le `args` del compose valgono solo per il portal), e `apps/web/.env.local` — se presente — ha la precedenza:

```bash
set -a; . infra/.env; set +a
pnpm --filter @opengraphity/web build
grep -o 'localhost:8080' apps/web/dist/assets/index-*.js | wc -l   # deve dare 0 se punti a un Keycloak remoto
docker compose -f infra/docker-compose.yml build web && docker compose -f infra/docker-compose.yml up -d web
```

`KEYCLOAK_PUBLIC_URL` (API) accetta una lista separata da virgola quando la stessa API serve più front-door (es. locale + Tailscale): il token è accettato solo se il suo `iss` è tra quegli origin.

### Verify everything is running

```bash
# All containers should be Up
docker compose -f infra/docker-compose.yml ps

# API health check
curl http://localhost:4000/health

# Neo4j node counts (requires cypher-shell or docker exec; NEO4J_PASSWORD = the value in infra/.env;
# the container is <project>-neo4j-1, project = compose directory name → infra-neo4j-1)
docker exec -it infra-neo4j-1 \
  cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
  "MATCH (n) RETURN labels(n)[0] AS type, count(n) ORDER BY count(n) DESC"
```

### Stop / restart

```bash
# Stop without removing volumes (data is preserved)
docker compose -f infra/docker-compose.yml down

# Rebuild and restart after code changes
docker compose -f infra/docker-compose.yml up -d --build
```

---

## Development (hot-reload)

For local development with hot-reload, start only the infrastructure services with Docker and run the apps locally:

```bash
# 1. Start infrastructure only
docker compose -f infra/docker-compose.yml up -d neo4j redis keycloak

# 2. Install dependencies (first time)
pnpm install

# 3. Build shared packages
pnpm --filter "./packages/**" build

# 4. Start apps with hot-reload
pnpm dev   # runs api (port 4000) + web (port 5173) + portal (port 5174) in parallel
```

The apps read their env vars from `apps/api/.env` — copy from `infra/.env.example`: the example already points `NEO4J_URI`, `REDIS_URL`, `KEYCLOAK_URL` at `localhost`; set `REDIS_PASSWORD` to the value the `redis` container was started with (or the same `REDIS_URL=redis://:<password>@localhost:6379`).

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  Browser                                                          │
│  c-one.localhost:80          portal.c-one.localhost:80            │
└───────────────────────────────────────────────────────────────────┘
                               │
                   ┌───────────▼───────────┐
                   │  nginx (port 80)      │
                   │  subdomain routing    │
                   │  *.localhost → web    │
                   │  portal.* → portal   │
                   │  /graphql → api      │
                   │  /api/* → api        │
                   └──┬──────────────┬────┘
                      │              │
          ┌───────────▼──┐  ┌────────▼──────┐
          │  web (80)    │  │ portal (80)   │
          │  React SPA   │  │ React SPA     │
          └──────────────┘  └───────────────┘
                      │              │
                      └──────┬───────┘
                             │
                  ┌──────────▼──────────┐
                  │  api (node:4000)    │
                  │  Express + Apollo   │
                  │  BullMQ workers     │
                  └──┬──────┬───────────┘
                     │      │
             ┌───────▼┐  ┌──▼──────┐
             │ neo4j  │  │  redis  │
             └────────┘  └─────────┘
```

Stack: Neo4j 5, Redis 7, Keycloak 24, Node 20, React 19, Vite 7, Apollo GraphQL, pnpm workspaces.

## Documentation

| Page | What it covers |
|---|---|
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Prerequisites, first start, upgrade, rollback, backup/restore, production hardening |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Day-two: tenant onboarding, seeds, migrations, secret rotation, runbooks |
| [`docs/API.md`](docs/API.md) | GraphQL schema, REST v1, inbound webhooks and connectors, CSV import |
| [`docs/CUSTOMIZATION.md`](docs/CUSTOMIZATION.md) | What a customer can change and what stays factory: shared vs per-tenant, reserved names, renaming a workflow step, the closed vocabularies |

## Testing

- `pnpm test` — unit tests across the workspace (vitest, fully mocked)
- `pnpm test:e2e` — Playwright smoke tests against the local Docker stack (requires `docker compose -f infra/docker-compose.yml up -d`)
- `pnpm lint && pnpm typecheck` — static checks, same gates as CI
