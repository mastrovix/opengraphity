# OpenGraphity

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
cp infra/.env.example infra/.env   # review and edit secrets
docker compose -f infra/docker-compose.yml up -d --build
```

Wait ~60 seconds for all services to come up, then open:

| Service                 | URL                                  |
|-------------------------|--------------------------------------|
| App (agent)             | http://c-one.localhost               |
| Portal (self-service)   | http://portal.c-one.localhost        |
| API health              | http://localhost:4000/health         |
| Neo4j                   | http://localhost:7474                |
| Keycloak                | http://localhost:8080                |
| Grafana                 | http://localhost:3001                |
| Jaeger                  | http://localhost:16686               |

Or use the helper script:

```bash
./infra/start.sh
```

### Verify everything is running

```bash
# All containers should be Up
docker compose -f infra/docker-compose.yml ps

# API health check
curl http://localhost:4000/health

# Neo4j node counts (requires cypher-shell or docker exec)
docker exec -it opengraphity-neo4j-1 \
  cypher-shell -u neo4j -p opengraphity_local \
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

The apps read their env vars from `apps/api/.env` — copy from `infra/.env.example` and adjust `NEO4J_URI`, `REDIS_HOST` etc. to `localhost`.

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
