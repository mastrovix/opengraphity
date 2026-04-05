# ── Stage 1: builder ─────────────────────────────────────────────────────────
# node:20-slim (glibc/Debian) is required — isolated-vm 4.7.x fails to compile
# on Alpine/musl due to a known node-gyp incompatibility.
FROM node:20-slim AS builder

# Native modules (isolated-vm, msgpackr-extract, esbuild)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

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
RUN pnpm --filter "./packages/**" build
RUN pnpm --filter @opengraphity/api build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
# Keep slim: the compiled isolated-vm .node binary needs glibc at runtime
FROM node:20-slim AS runtime

WORKDIR /app

# Only what's needed to run
COPY --from=builder /app/node_modules              ./node_modules
COPY --from=builder /app/apps/api/node_modules     ./apps/api/node_modules
COPY --from=builder /app/apps/api/dist             ./apps/api/dist
COPY --from=builder /app/apps/api/package.json     ./apps/api/package.json
COPY --from=builder /app/packages                  ./packages
COPY --from=builder /app/package.json              ./package.json

RUN mkdir -p /data/attachments /data/backups

EXPOSE 4000

# Env vars are injected by docker compose — no --env-file needed
CMD ["node", "apps/api/dist/index.js"]
