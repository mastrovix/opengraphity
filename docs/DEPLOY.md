# Deploy di OpenGraphity (stack Docker Compose)

Procedura di riferimento per installare, aggiornare, salvare e ripristinare la
stack single-host definita in `infra/docker-compose.yml`. Le decisioni di
sicurezza/riproducibilità (Ondata 4) sono riassunte in fondo, con i vincoli
noti e i prerequisiti per un ambiente di produzione vero.

Indice

1. [Architettura e immagini](#1-architettura-e-immagini)
2. [Prerequisiti](#2-prerequisiti)
3. [Configurazione `infra/.env`](#3-configurazione-infraenv)
4. [Build del web (locale, con le variabili Tailscale)](#4-build-del-web-locale-con-le-variabili-tailscale)
5. [Primo avvio](#5-primo-avvio)
6. [Porte esposte](#6-porte-esposte)
7. [Osservabilità](#7-osservabilità)
8. [Aggiornamento](#8-aggiornamento)
9. [Rollback](#9-rollback)
10. [Backup e restore](#10-backup-e-restore)
11. [Vincolo single-replica](#11-vincolo-single-replica)
12. [Hardening per la produzione](#12-hardening-per-la-produzione)
13. [Verifiche e troubleshooting](#13-verifiche-e-troubleshooting)

---

## 1. Architettura e immagini

```
browser ──► nginx :80 (front door, template envsubst)
              ├─ {tenant}.localhost        → web (nginx, SPA agenti)      → /graphql, /api → api
              ├─ portal.{tenant}.localhost → portal (nginx, self-service) → /graphql, /api → api
              └─ $TAILSCALE_HOST (HTTPS via tailscale serve) → web + keycloak same-origin
api :4000 (Express + Apollo, USER node) ── neo4j :7687 ── redis :6379 ── keycloak :8080
worker (stessa immagine dell'api, `dist/worker.js`: embedding ONNX off event-loop)
prometheus ← api:/metrics      promtail (docker socket) → loki ← grafana      jaeger (OTLP)
```

Tutte le immagini di terze parti sono pinnate **tag + digest** (digest della
manifest list multi-arch: vale per arm64 e amd64). Per aggiornarne una si
cambiano tag e digest insieme:

```bash
docker buildx imagetools inspect neo4j:5.26.22-community | grep Digest
```

| Servizio | Immagine pinnata |
|---|---|
| neo4j | `neo4j:5.26.21-community@sha256:409728716bc239f9fa046368ac6ce6ef280f9e5f0bcb7cdd75031a4465cc192d` |
| redis | `redis:7.4.8-alpine@sha256:7aec734b2bb298a1d769fd8729f13b8514a41bf90fcdd1f38ec52267fbaa8ee6` |
| keycloak | `quay.io/keycloak/keycloak:24.0.5@sha256:f8ade94c1d0ad2f2fa7734a455fee5392764f402c43ca35e9af6bf63a2541dc9` |
| nginx (front door, web, portal) | `nginx:1.28.3-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236` |
| grafana | `grafana/grafana:12.4.0@sha256:b0ae311af06228bcfd4a620504b653db80f5b91e94dc3dc2a5b7dab202bcde20` |
| prometheus | `prom/prometheus:v2.55.1@sha256:2659f4c2ebb718e7695cb9b25ffa7d6be64db013daba13e05c875451cf51b0d3` |
| loki | `grafana/loki:2.9.0@sha256:b025a0220f390baaab01578aea2fe0ba677584d9f248c3fe5af15f84dd1de60d` |
| promtail | `grafana/promtail:2.9.0@sha256:c2c423196c75a2c9c26f6fe0ba7200c3167334b14975747f5dcff678bd1a32e9` |
| jaeger | `jaegertracing/all-in-one:1.56@sha256:d2cd4c226624bdc116decd3106091b4df9882da8db42f8550293596cab79b8ea` |
| node (builder + runtime di api/portal) | `node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0` |

Immagini costruite dal repo:

- **api** (`apps/api/Dockerfile`, immagine `opengrafo-api:local`, usata anche dal
  `worker`): stage builder che installa il workspace, compila `packages/*` e
  l'API, poi `pnpm --filter @opengraphity/api deploy --prod --legacy /out`
  produce un albero con le **sole `dependencies`** (niente vitest/tsx/typescript
  a runtime). Lo stage runtime copia `dist/`, `node_modules/`, `package.json` e
  gira come utente `node`; `/data/{attachments,backups,reports,models}` sono
  di proprietà di `node`. Il flag `--no-node-snapshot` resta obbligatorio
  (isolated-vm su Node 20).
- **web** (`apps/web/Dockerfile`): **copia** `apps/web/dist` costruito in locale
  (vedi §4). Non compila: così il bundle in produzione è identico a quello
  testato in locale e le `VITE_*` (URL Keycloak, Tailscale) sono quelle del
  build locale.
- **portal** (`apps/portal/Dockerfile`): compila nel container con
  `pnpm install --filter @opengraphity/portal... --filter @opengraphity/web-core... --ignore-scripts`
  (solo il grafo del portal, nessuna toolchain C++) e riceve le `VITE_*` da
  `build.args` del compose.

`.dockerignore` tiene fuori dal contesto `**/node_modules`, `**/.env*` (tranne
`.env.example`), `.claude/`, `e2e/`, `test-results/`, `**/coverage`,
`apps/api/dist`, `apps/portal/dist`, `packages/*/dist` — e **lascia**
`apps/web/dist`, che il Dockerfile del web copia.

## 2. Prerequisiti

- Docker Engine ≥ 24 con Compose v2 (`docker compose version`; la stack è
  validata con v5.x). Su macOS: Docker Desktop, che espone
  `/var/run/docker.sock` (promtail lo monta in sola lettura).
- Node 20 + pnpm 10.30.x in locale (solo per costruire `apps/web/dist` e per
  gli script di onboarding/backup): `corepack enable && corepack prepare pnpm@10.30.3 --activate`.
- Risoluzione dei sottodomini tenant in `/etc/hosts`
  (`127.0.0.1 c-one.localhost portal.c-one.localhost`).
- Facoltativo, accesso remoto HTTPS: Tailscale con `tailscale serve --bg 80`
  sull'host (termina TLS e inoltra a nginx:80). Vedi la memoria di progetto
  "Accesso app locale + iPad via Tailscale HTTPS".
- ~4 GB di RAM liberi (Neo4j è limitato a 2 GB, Jaeger a 512 MB).

## 3. Configurazione `infra/.env`

```bash
cp infra/.env.example infra/.env   # poi sostituire OGNI change-me-*
```

`infra/.env.example` documenta ogni variabile con un commento;
`node scripts/check-env-example.mjs` (anche in CI) fallisce se codice ed
esempio divergono. Il compose **non ha default per i segreti** (`${VAR:?}`):
senza questi valori `docker compose` si rifiuta di partire.

| Variabile | Uso |
|---|---|
| `JWT_SECRET` | firma dei JWT legacy (`ALLOW_LEGACY_JWT`, solo dev/script) |
| `NEO4J_PASSWORD` | password `neo4j` (servizio + client api/worker) |
| `REDIS_PASSWORD` | `redis-server --requirepass` + client api/worker |
| `KEYCLOAK_ADMIN_PASSWORD` | admin del realm master (createUser, onboarding, script kcadm) |
| `GRAFANA_ADMIN_PASSWORD` | admin Grafana (applicata al **primo** avvio del volume `grafana_data`) |
| `TAILSCALE_HOST` | hostname del front-door HTTPS (server_name nginx + CSP) |
| `VITE_KEYCLOAK_URL` | URL Keycloak raggiungibile dal browser (build del portal e del web) |

Con default sicuri, da cambiare consapevolmente:

- `KEYCLOAK_PUBLIC_ORIGIN` (default `http://localhost:8080`): origine Keycloak
  ammessa nella CSP `connect-src` dei blocchi `*.localhost`.
  `KEYCLOAK_PUBLIC_URL` (API) può elencare più origini separate da virgola
  (locale + Tailscale): il token è accettato solo se il suo `iss` è tra quelle.
- `TAILSCALE_TENANT_HOST` (default `c-one.localhost`): tenant che il front-door
  Tailscale inoltra come `X-Forwarded-Host` (l'hostname Tailscale non porta lo
  slug).
- `GRAPHQL_INTROSPECTION` (default `false`): `true` abilita l'Apollo Sandbox
  sulla stack locale. Mai `true` su un deploy raggiungibile da terzi.
- `METRICS_TOKEN` (vuoto): se valorizzato, `GET /metrics` richiede
  `Authorization: Bearer <token>`; il servizio `prometheus` lo legge dalla
  stessa variabile. Se vuoto, l'API risponde solo a socket loopback/RFC1918
  (la rete Docker lo è), quindi Prometheus funziona anche senza token.
- `CORS_ORIGIN`, `APP_URL`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, ecc.: vedi
  i commenti in `.env.example`.

Le variabili "solo compose" (`GRAFANA_ADMIN_PASSWORD`, `TAILSCALE_HOST`,
`KEYCLOAK_PUBLIC_ORIGIN`, `TAILSCALE_TENANT_HOST`) sono nell'allowlist
`COMPOSE_ONLY` di `scripts/check-env-example.mjs`.

## 4. Build del web (locale, con le variabili Tailscale)

L'immagine `web` copia `apps/web/dist`; le `VITE_*` devono quindi essere
nell'ambiente del build **locale** (le `args` del compose valgono solo per il
portal). `apps/web/.env.local`, se presente, ha la precedenza.

```bash
set -a; . infra/.env; set +a
pnpm install --frozen-lockfile
pnpm --filter "./packages/*" build
pnpm --filter @opengraphity/web build
# se punti a un Keycloak remoto (Tailscale) il bundle non deve citare localhost:8080:
grep -o 'localhost:8080' apps/web/dist/assets/index-*.js | wc -l   # atteso 0
```

`pnpm deploy:web` (root `package.json`) concatena build + `compose up -d --build web`.

## 5. Primo avvio

```bash
docker compose -f infra/docker-compose.yml config --quiet   # valida compose + .env
docker compose -f infra/docker-compose.yml up -d --build      # oppure ./infra/start.sh
docker compose -f infra/docker-compose.yml ps                 # tutti "healthy" in ~90 s
```

Poi, una tantum:

```bash
# 1. Indici e constraint Neo4j (idempotente; sorgente unica: packages/neo4j/src/init.ts)
set -a; . infra/.env; set +a
NEO4J_URI=bolt://localhost:7687 pnpm neo4j:init

# 2. Tenant + admin (realm Keycloak, nodo :Tenant, workflow di default). Password
#    admin da stdin o generata e stampata una volta — mai in argv.
KEYCLOAK_URL=http://localhost:8080 NEO4J_URI=bolt://localhost:7687 \
  pnpm --filter @opengraphity/api onboard-tenant -- \
  --slug c-one --admin-email admin@example.com \
  --admin-first-name Nome --admin-last-name Cognome --name "C-One"

# 3. (Tailscale) redirect URI / web origins del client opengrafo-web
bash infra/scripts/update-keycloak-redirects.sh
```

Apri `http://c-one.localhost` (agenti) e `http://portal.c-one.localhost`
(self-service). Le porte dirette (`:5173`, `:5174`, `:4000`, …) sono solo su
`127.0.0.1`.

## 6. Porte esposte

| Porta host | Servizio | Bind | Note |
|---|---|---|---|
| 80 | nginx | `0.0.0.0` | unico ingresso pubblico (LAN/Tailscale) |
| 4000 | api | `127.0.0.1` | `/health`, `/graphql`, `/metrics` — senza header nginx |
| 5173 / 5174 | web / portal | `127.0.0.1` | accesso diretto alle SPA |
| 7474 / 7687 | neo4j | `127.0.0.1` | browser + bolt |
| 6379 | redis | `127.0.0.1` | con `requirepass` |
| 8080 | keycloak | `127.0.0.1` | console admin |
| 3001 | grafana | `127.0.0.1` | admin / `GRAFANA_ADMIN_PASSWORD` |
| 9090 | prometheus | `127.0.0.1` | UI + API |
| 3100 | loki | `127.0.0.1` | |
| 16686 / 4318 | jaeger | `127.0.0.1` | UI / OTLP HTTP |

Per esporre la stack oltre `localhost` passare **solo** da nginx (o da
`tailscale serve` che lo inoltra); non aprire le altre porte.

## 7. Osservabilità

- **Log → Loki**: promtail scopre i container tramite il socket Docker
  (`docker_sd_configs`, montato `:ro`) e spedisce stdout/stderr di ogni
  container del progetto compose. Label: `job`/`service` = nome del servizio
  (`api`, `worker`, `nginx`, …), `container`, `stream`; per api/worker anche
  `level` (pino: 30 info, 40 warn, 50 error). Esempio in Grafana → Explore:
  `{job="api", level="50"}`. Il vecchio scrape del file su `/tmp` (che l'API
  non scriveva) è stato rimosso.
- **Metriche → Prometheus**: scrape di `api:4000/metrics` ogni 15 s, retention
  15 giorni (`prometheus_data`). Metriche disponibili
  (`apps/api/src/middleware/metrics.ts`): `http_requests_total`,
  `http_request_duration_seconds`, `graphql_resolver_duration_seconds`,
  `neo4j_query_duration_seconds`, `bullmq_queue_depth`,
  `opengrafo_backup_runs_total{result}`,
  `opengrafo_backup_last_success_timestamp_seconds`.
- **Grafana**: datasource Loki e Prometheus provisionate
  (`infra/grafana/provisioning/datasources`) e dashboard "OpenGraphity API"
  nella cartella OpenGraphity (`infra/grafana/dashboards/opengraphity-api.json`:
  richieste/s per status, 5xx/s, latenza p50/p95/p99 di `/graphql`, resolver più
  lenti, code BullMQ, Neo4j p95 + query lente, ore dall'ultimo backup verificato
  e backup per esito). Le modifiche dalla UI non sono
  persistite: si edita il JSON nel repo. **Gap noto**: gli errori per resolver
  non sono esportati verso Prometheus (esistono solo nel pannello admin
  GraphQL); il pannello "errori" usa gli HTTP 5xx.
- **Tracce → Jaeger**: `OTEL_ENABLED=true` in `.env`; endpoint interno
  `http://jaeger:4318/v1/traces`.
- **Healthcheck**: tutti i servizi ne hanno uno. Il `worker` non espone HTTP:
  il probe (`worker-healthcheck.mjs`, generato nell'immagine) chiede a Redis se
  un worker BullMQ della coda `embeddings` è connesso (`CLIENT LIST` via
  `Queue.getWorkersCount()`). È un controllo per-coda, non per-container: con
  più repliche del worker resta verde finché almeno una è connessa.

## 8. Aggiornamento

```bash
git pull
# 0. (consigliato) conservare le immagini correnti per il rollback — §9
docker tag opengrafo-api:local opengrafo-api:prev
docker tag infra-web:latest infra-web:prev && docker tag infra-portal:latest infra-portal:prev

# 1. nuove variabili? confrontare .env.example con .env
diff <(grep -o '^[A-Z_]*=' infra/.env.example | sort) <(grep -o '^[A-Z_]*=' infra/.env | sort)

# 2. web: build locale (§4), poi immagini + restart
set -a; . infra/.env; set +a
pnpm install --frozen-lockfile && pnpm --filter "./packages/*" build && pnpm --filter @opengraphity/web build
docker compose -f infra/docker-compose.yml build
docker compose -f infra/docker-compose.yml up -d

# 3. schema Neo4j (idempotente)
NEO4J_URI=bolt://localhost:7687 pnpm neo4j:init
```

**Passaggio da un'immagine api precedente (processo root) — una tantum.** Il
volume `api_data` creato dalla vecchia immagine contiene file di proprietà di
root; il nuovo processo gira come `node` e non potrebbe scrivere allegati,
modelli e report. Prima del `up -d` dell'api:

```bash
docker compose -f infra/docker-compose.yml build api
docker compose -f infra/docker-compose.yml run --rm --no-deps --user root \
  --entrypoint sh api -c 'chown -R node:node /data'
```

(`run` monta gli stessi volumi del servizio `api`: `api_data` e il nuovo
`api_backups`.) Altri cambi di questa tranche da conoscere:

- il comando del `worker` è `node --no-node-snapshot dist/worker.js` (prima
  `apps/api/dist/worker.js`): il compose è già aggiornato;
- i backup vanno sul volume dedicato `api_backups` (§10): i tar.gz già
  presenti in `api_data:/data/backups` restano nel vecchio volume, mascherati
  dal mount — copiarli via una tantum se servono:
  `docker run --rm -v infra_api_data:/old:ro -v infra_api_backups:/new alpine sh -c 'cp -a /old/backups/. /new/ && chown -R 1000:1000 /new'`;
- il servizio **MinIO è stato rimosso** (nessun uso nel codice). Il volume
  `infra_minio_data` resta orfano e non viene toccato; per eliminarlo a mano,
  dopo aver verificato che non contenga nulla di utile:
  `docker volume rm infra_minio_data`.

I nomi dei volumi hanno il prefisso del progetto compose (= nome della
directory, `infra`): `docker volume ls | grep infra_`.

## 9. Rollback

Il rollback è **di codice e immagini**, non di dati: le migrazioni Neo4j
(`init.ts` + `packages/neo4j/src/migrations.ts`) sono additive e non vengono
annullate; se il nuovo codice ha scritto dati incompatibili, ripristinare dal
backup (§10).

```bash
git checkout <tag-o-sha-precedente>
docker tag opengrafo-api:prev opengrafo-api:local
docker tag infra-web:prev infra-web:latest && docker tag infra-portal:prev infra-portal:latest
docker compose -f infra/docker-compose.yml up -d --no-build api worker web portal
```

Senza immagini `:prev`, ricostruire dal commit precedente (`build` + `up -d`,
web compreso via §4). Per le immagini di terze parti il pin per digest
garantisce che un `pull` non cambi versione: un rollback del compose riporta
esattamente le immagini precedenti.

## 10. Backup e restore

**Cosa fa il backup oggi** (`apps/api/src/scripts/backup-neo4j.ts`, lanciato
dal maintenance worker dell'API ogni giorno a mezzanotte, retention degli
ultimi N archivi): export via Cypher di **tutti i nodi e le relazioni** in
JSONL, compresso in `backup_<stamp>.tar.gz` sotto `BACKUP_DIR`
(`/data/backups` → volume `api_backups`). Non è un `neo4j-admin dump`: non è
transazionalmente consistente e non contiene indici/constraint (che
`neo4j:init` ricrea). **Non include**: allegati (`api_data:/data/attachments`),
Keycloak (`keycloak_data`, realm e utenti), Redis (code BullMQ — ricostruibili),
Grafana/Prometheus/Loki. Un altro intervento sta estendendo lo script agli
allegati e a Keycloak: fino ad allora vanno salvati a parte (sotto).

Backup manuale e copia **off-host** (obbligatoria: un volume Docker non è un
backup):

```bash
# archivio Neo4j on-demand
docker compose -f infra/docker-compose.yml exec api node --no-node-snapshot dist/scripts/backup-neo4j.js --output-dir /data/backups

# copia locale dei tre volumi rilevanti, poi off-host con rsync/rclone
mkdir -p offsite && docker compose -f infra/docker-compose.yml cp api:/data/backups offsite/neo4j
docker compose -f infra/docker-compose.yml cp api:/data/attachments offsite/attachments
docker run --rm -v infra_keycloak_data:/kc:ro -v "$PWD/offsite":/out alpine sh -c 'cp -a /kc/. /out/keycloak/'
rsync -a --delete offsite/ user@backup-host:/srv/opengraphity/   # oppure:
rclone sync offsite remote:opengraphity-backups
```

Export **logico** di Keycloak (portabile tra versioni/DB; a differenza della
copia del volume `dev-file`, va fatto a server fermo):

```bash
docker compose -f infra/docker-compose.yml stop keycloak
docker compose -f infra/docker-compose.yml run --rm keycloak export --dir /opt/keycloak/data/export --users realm_file
docker run --rm -v infra_keycloak_data:/kc:ro -v "$PWD/offsite":/out alpine cp -r /kc/export /out/keycloak-export
docker compose -f infra/docker-compose.yml start keycloak
```

**Restore Neo4j** (`restore-neo4j.ts`: idempotente e additivo — MERGE per id;
per un ripristino da zero svuotare prima il DB esplicitamente; esce ≠ 0 se una
relazione non è ricostruibile):

```bash
docker compose -f infra/docker-compose.yml cp offsite/neo4j/backup_<stamp>.tar.gz api:/data/backups/
docker compose -f infra/docker-compose.yml exec api node --no-node-snapshot dist/scripts/restore-neo4j.js --input /data/backups/backup_<stamp>.tar.gz --dry-run
docker compose -f infra/docker-compose.yml exec api node --no-node-snapshot dist/scripts/restore-neo4j.js --input /data/backups/backup_<stamp>.tar.gz --yes-restore
NEO4J_URI=bolt://localhost:7687 pnpm neo4j:init      # indici e constraint
```

Allegati: ricopiare `offsite/attachments` in `api_data:/data/attachments`
(`docker compose cp offsite/attachments/. api:/data/attachments/`, poi lo stesso
`chown -R node:node /data` di §8). Keycloak: `kc.sh import --dir …` con lo stesso
DB configurato, oppure ricopiare il volume a container fermo. Testare il
restore periodicamente su una stack vuota: un backup mai ripristinato non è un
backup.

## 11. Vincolo single-replica

La stack presuppone **una sola replica** di `api` e una di `worker`. Lo stato
seguente è in-process e non è condiviso:

| Componente | Dove | Effetto con 2+ repliche |
|---|---|---|
| Client SSE (`/api/sse`) | `packages/notifications/src/sse.ts` (`Map` in memoria) | un evento raggiunge solo i client connessi alla replica che lo pubblica |
| Cache schema/metamodello | `apps/api/src/lib/schemaCache.ts`, `lib/cache.ts` | invalidazione su una sola replica, divergenza fino al TTL |
| Rate limit GraphQL / API key | `middleware/graphqlRateLimiter.ts`, `apiKeyAuth.ts` (bucket in memoria) | limite moltiplicato per il numero di repliche |
| Scheduler BullMQ (backup, report, anomaly scan, digest, discovery, SLA, workflow timer) | avviati in `apps/api/src/index.ts` dentro il processo HTTP | ogni replica registra/esegue i job ripetibili → backup e scansioni duplicati |

Per scalare orizzontalmente servirebbero: pub/sub Redis per SSE e per
l'invalidazione delle cache (o cache su Redis), `rate-limit-redis` (o
equivalente) per i limiti, e un **entrypoint `scheduler.js` separato**
(come già fatto per `worker.js`) che sia l'unico a registrare i job ripetibili,
lasciando alle repliche HTTP solo i consumer. Finché non c'è, `deploy.replicas`
> 1 per `api` è un errore di configurazione, non un'ottimizzazione.

## 12. Hardening per la produzione

La stack locale gira con `NODE_ENV=production` per l'API, ma resta una stack
single-host. Prima di esporla a utenti reali:

1. **Keycloak: `start` + PostgreSQL** (oggi `start-dev` con `KC_DB=dev-file`:
   niente cache distribuita, hostname non verificato, DB H2 su file poco adatto
   al backup). Procedura:
   - esportare i realm a server fermo (§10, export logico);
   - aggiungere un servizio `postgres` (immagine pinnata, volume dedicato) e
     configurare Keycloak con `KC_DB=postgres`, `KC_DB_URL=jdbc:postgresql://postgres:5432/keycloak`,
     `KC_DB_USERNAME`/`KC_DB_PASSWORD`, `KC_HOSTNAME=<dominio pubblico>`,
     `KC_PROXY_HEADERS=xforwarded`, `KC_HTTP_ENABLED=true` (TLS terminato da
     nginx/tailscale), comando `start` (o `build` + `start --optimized`);
   - importare: copiare l'export in `/opt/keycloak/data/import` e avviare una
     volta con `start --import-realm`, oppure `kc.sh import --dir …` a server
     fermo; verificare login web e portal, poi rimuovere il volume `dev-file`.
2. **TLS**: terminare HTTPS davanti a nginx (tailscale serve, o un reverse
   proxy con certificati) e passare `X-Forwarded-Proto https`; il blocco
   Tailscale del template ha già HSTS. Aggiornare `KEYCLOAK_PUBLIC_URL`,
   `KEYCLOAK_PUBLIC_ORIGIN`, `VITE_KEYCLOAK_URL`, `APP_URL`, `CORS_ORIGIN` al
   dominio pubblico (`https://…`).
3. **CORS**: `CORS_ORIGIN` con le sole origini reali (niente wildcard
   `*.localhost` in produzione).
4. **Introspection**: `GRAPHQL_INTROSPECTION=false` (default).
5. **Metriche**: `METRICS_TOKEN` valorizzato se `/metrics` è raggiungibile da
   fuori la rete Docker; comunque la porta 4000 resta su loopback.
6. **JWT legacy**: `ALLOW_LEGACY_JWT=false` (default); ruotare `JWT_SECRET` se
   è mai stato usato con token committati.
7. **Segreti**: `infra/.env` fuori dal repo (già in `.gitignore` e
   `.dockerignore`), permessi `600`, rotazione documentata; per Docker Swarm o
   Kubernetes passare a `secrets:`.
8. **Grafana**: `GRAFANA_ADMIN_PASSWORD` robusta; login SSO se disponibile.
9. **Docker socket**: promtail monta `/var/run/docker.sock:ro` e gira come root
   nel suo container (lettura dei log via API Docker). Se la policy non lo
   consente, alternativa: driver di logging `loki` di Docker o promtail con
   `static_configs` su `/var/lib/docker/containers` (solo Linux).
10. **Immagini**: rinnovare i pin (tag + digest) con un processo (Renovate/
    Dependabot per Docker) e non con `latest`; ricostruire l'immagine api dopo
    ogni `pnpm audit` risolto.
11. **Multi-replica**: vedi §11 — non aumentare le repliche senza gli
    interventi elencati.

## 13. Verifiche e troubleshooting

```bash
# compose + .env coerenti, senza avviare nulla
docker compose -f infra/docker-compose.yml config --quiet
node scripts/check-env-example.mjs
bash -n infra/start.sh

# nginx: config renderizzata dal template (server_name Tailscale, CSP)
docker compose -f infra/docker-compose.yml exec nginx sh -c 'nginx -t && grep -n "server_name\|connect-src" /etc/nginx/conf.d/default.conf'

# api come utente node, sole dependencies di produzione
docker compose -f infra/docker-compose.yml exec api sh -c 'id && ls node_modules/.bin | grep -c vitest'   # uid 1000, 0

# metriche: target UP e dashboard
curl -s http://127.0.0.1:9090/api/v1/targets | grep -o '"health":"[a-z]*"'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/metrics     # 200 (loopback) o 401 con METRICS_TOKEN

# log: promtail vede i container e Loki riceve
docker compose -f infra/docker-compose.yml logs --tail 20 promtail
curl -s 'http://127.0.0.1:3100/loki/api/v1/labels' | head -c 300

# worker healthy (probe BullMQ)
docker compose -f infra/docker-compose.yml ps worker
```

Problemi ricorrenti:

- `TAILSCALE_HOST mancante in infra/.env` / `GRAFANA_ADMIN_PASSWORD mancante`:
  variabili introdotte con questa tranche, aggiungerle a `.env` (§3).
- `EACCES … /data/attachments` nei log dell'api dopo l'aggiornamento: volume
  con file di root, eseguire il `chown` di §8.
- L'api termina senza output alla prima esecuzione di uno script: manca
  `--no-node-snapshot` (già nel `CMD` e nel comando del worker).
- `nginx: [emerg] unknown "upstream_api" variable` o CSP con `${…}` letterali:
  il template non è stato renderizzato — verificare il mount
  `./nginx:/etc/nginx/templates:ro` e `NGINX_ENVSUBST_FILTER` nel compose.
- Grafana non accetta `GRAFANA_ADMIN_PASSWORD`: il volume `grafana_data` esiste
  da prima, la variabile vale solo alla prima inizializzazione; reset con
  `docker compose exec grafana grafana cli admin reset-admin-password '<nuova>'`.
- Prometheus target `DOWN` con 401: `METRICS_TOKEN` diverso tra `.env` e il
  container (ricreare `prometheus` con `up -d --force-recreate prometheus`).
