# ── Stage 1: builder ─────────────────────────────────────────────────────────
# slim (glibc/Debian) e non Alpine: isolated-vm non compila su musl per una
# incompatibilita' nota di node-gyp. Questa parte non e' cambiata.
#
# NODE 24, e il vincolo si e' INVERTITO (21 set 2026). Qui c'era scritto
# «node:20 … isolated-vm 4.7.x», e per mesi la ragione di restare a Node 20 e'
# stata «isolated-vm non compila contro il V8 di Node 22». Quella frase parlava
# della 4.7, che e' la versione che avevamo. Oggi il vincolo e' all'incontrario:
#
#   isolated-vm 5 → node >= 18      (girava gia' sul nostro Node 20)
#   isolated-vm 6 → node >= 22
#   isolated-vm 7 → node >= 24      ← questa
#
# Cioe' non era «Node 20 per sempre»: era una scala, e nessuno l'aveva salita.
# Provato prima di cambiare: isolated-vm 7 compilato su node:24-slim, e tutta
# l'API che il sandbox usa funziona identica — contesto, `Reference` per i log,
# `ExternalCopy`, il TIMEOUT che interrompe un ciclo infinito, `dispose`.
# Pinned tag + digest (G-16): `docker buildx imagetools inspect node:24.11.1-bookworm-slim`
FROM node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57 AS builder

# Native modules (isolated-vm, msgpackr-extract, esbuild)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# pnpm 11+ requires Node 22 (node:sqlite) — pin to the 10.x line used locally
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# Copy manifests first — maximises layer cache reuse
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json ./

# apps/api
COPY apps/api/package.json apps/api/

# packages (all manifests only)
COPY packages/discovery/package.json        packages/discovery/
COPY packages/events/package.json           packages/events/
COPY packages/neo4j/package.json            packages/neo4j/
COPY packages/notifications/package.json   packages/notifications/
COPY packages/schema-generator/package.json packages/schema-generator/
COPY packages/scripting/package.json        packages/scripting/
COPY packages/sla/package.json              packages/sla/
COPY packages/types/package.json            packages/types/
COPY packages/workflow/package.json         packages/workflow/

RUN pnpm install --frozen-lockfile

# Copy source after install (separate layer so install is cached)
COPY apps/api/   apps/api/
COPY packages/   packages/

# Build packages then API
# web-core è un package browser (keycloak-js/react/apollo): non serve all'API e le sue dipendenze non sono installate qui
RUN pnpm --filter "./packages/**" --filter "!@opengraphity/web-core" build
RUN pnpm --filter @opengraphity/api build

# Production-only tree (G-05): `pnpm deploy --prod` copies apps/api and every
# workspace package it depends on (packages/*/dist included — built above) into
# /out with ONLY `dependencies`. devDependencies (vitest, tsx, typescript,
# coverage, @types) never reach the runtime image. `--legacy` because the
# pnpm 10 default implementation needs `inject-workspace-packages=true` in .npmrc.
RUN pnpm --filter @opengraphity/api deploy --prod --legacy /out

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
# Keep slim: the compiled isolated-vm .node binary needs glibc at runtime
FROM node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57 AS runtime

WORKDIR /app

# Only what's needed to run: the deploy output minus src/scripts/tests.
# package.json stays: dist/scripts/backup-neo4j.js reads ../../package.json (version stamp).
COPY --from=builder --chown=node:node /out/package.json  ./package.json
COPY --from=builder --chown=node:node /out/node_modules  ./node_modules
COPY --from=builder --chown=node:node /out/dist          ./dist

# Liveness probe for the `worker` service (same image, no HTTP endpoint):
# BullMQ workers register their connection name in Redis (CLIENT SETNAME) and
# Queue.getWorkersCount() lists them — exit 0 only while an `embeddings` worker
# is connected. Used by the compose healthcheck: `node worker-healthcheck.mjs`.
RUN printf '%s\n' \
  'import { Queue } from "bullmq";' \
  'import { getRedisConnection } from "@opengraphity/events";' \
  'const timer = setTimeout(() => { console.error("worker healthcheck: timeout"); process.exit(1); }, 4000);' \
  'const queue = new Queue(process.env.HEALTHCHECK_QUEUE || "embeddings", { connection: getRedisConnection() });' \
  'queue.on("error", () => {});' \
  'let workers = 0;' \
  'try {' \
  '  workers = await queue.getWorkersCount();' \
  '} catch (err) {' \
  '  console.error("worker healthcheck: " + (err instanceof Error ? err.message : String(err)));' \
  '}' \
  'try { await queue.close(); } catch {}' \
  'clearTimeout(timer);' \
  'process.exit(workers > 0 ? 0 : 1);' \
  > /app/worker-healthcheck.mjs && chown node:node /app/worker-healthcheck.mjs

# Writable data dirs for the unprivileged user. NB: an api_data volume created
# by an older (root) image keeps root-owned files — see docs/DEPLOY.md
# ("Aggiornamento") for the one-off chown.
RUN mkdir -p /data/attachments /data/backups /data/reports /data/models && chown -R node:node /data

USER node

EXPOSE 4000

# Env vars are injected by docker compose — no --env-file needed
# --no-node-snapshot: isolated-vm su Node >= 20 termina il processo senza output
# alla prima `new Isolate` se il flag manca (scripting engine, webhook transform).
CMD ["node", "--no-node-snapshot", "dist/index.js"]
