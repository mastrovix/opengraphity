# ── Stage 1: builder ─────────────────────────────────────────────────────────
# node:20 slim (glibc/Debian) is required — isolated-vm 4.7.x fails to compile
# on Alpine/musl due to a known node-gyp incompatibility.
# Pinned tag + digest (G-16): `docker buildx imagetools inspect node:20.20.2-bookworm-slim`
FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder

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
FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime

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
