# ── Stage 1: builder ─────────────────────────────────────────────────────────
# Pinned tag + digest (G-16): `docker buildx imagetools inspect node:20.20.2-bookworm-slim`
FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder

# pnpm 11+ requires Node 22 (node:sqlite) — pin to the 10.x line used locally
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# Only the manifests of the projects this SPA needs. The lockfile still lists
# every workspace importer; pnpm ignores the absent ones ("Scope: 2 of N").
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json ./
COPY apps/portal/package.json       apps/portal/
COPY packages/web-core/package.json packages/web-core/

# Lean install (G-05): just the portal + web-core dependency graph, and no
# lifecycle scripts — the previous full-workspace install compiled isolated-vm
# (C++ toolchain, minutes) for a static bundle that never uses it.
# esbuild/rollup ship prebuilt binaries as optional deps: no postinstall needed.
RUN pnpm install --frozen-lockfile --ignore-scripts \
      --filter @opengraphity/portal... \
      --filter @opengraphity/web-core...

# @opengraphity/web-core (auth/tenant/apollo shared with apps/web) is consumed
# from its dist/, which .dockerignore excludes: build it in the container.
COPY packages/web-core/ packages/web-core/
RUN pnpm --filter @opengraphity/web-core build

COPY apps/portal/ apps/portal/

# ── Build-time vars (baked into the JS bundle at compile time) ────────────────
# These must be reachable from the BROWSER, not from inside Docker.
# VITE_TENANT_SLUG: tenant slug used when accessing via plain localhost:5174
#   (no subdomain). Set to your tenant name, e.g. "c-one".
#   Leave empty if you always access via portal.{tenant}.localhost.
ARG VITE_API_URL=/graphql
ARG VITE_KEYCLOAK_URL=http://localhost:8080
ARG VITE_KEYCLOAK_CLIENT_ID=opengrafo-portal
ARG VITE_TENANT_SLUG=

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL
ENV VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID
ENV VITE_TENANT_SLUG=$VITE_TENANT_SLUG

RUN pnpm --filter @opengraphity/portal build

# ── Stage 2: nginx ────────────────────────────────────────────────────────────
# Same image as the front-door nginx (infra/docker-compose.yml), pinned by digest.
FROM nginx:1.28.3-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236 AS runtime

COPY --from=builder /app/apps/portal/dist /usr/share/nginx/html

# Inline nginx config: SPA fallback + reverse-proxy to API. Only reachable from
# the front-door nginx and 127.0.0.1:5174; X-Forwarded-Host is still forced to
# $host so the API never sees a client-chosen tenant header.
RUN printf 'server {\n\
    listen 80;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
\n\
    large_client_header_buffers 4 32k;\n\
    proxy_buffer_size           128k;\n\
    proxy_buffers               4 256k;\n\
    proxy_busy_buffers_size     256k;\n\
\n\
    location /graphql {\n\
        proxy_pass http://api:4000;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header Host $host;\n\
        proxy_set_header X-Forwarded-Host $host;\n\
        proxy_set_header X-Real-IP $remote_addr;\n\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
        proxy_set_header X-Forwarded-Proto $scheme;\n\
    }\n\
\n\
    location /api/sse {\n\
        proxy_pass http://api:4000;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header Host $host;\n\
        proxy_set_header X-Forwarded-Host $host;\n\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
        proxy_set_header X-Forwarded-Proto $scheme;\n\
        proxy_set_header Connection "";\n\
        proxy_cache off;\n\
        proxy_buffering off;\n\
        proxy_read_timeout 86400s;\n\
    }\n\
\n\
    location /api {\n\
        client_max_body_size 11m;\n\
        proxy_pass http://api:4000;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header Host $host;\n\
        proxy_set_header X-Forwarded-Host $host;\n\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
        proxy_set_header X-Forwarded-Proto $scheme;\n\
    }\n\
\n\
    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {\n\
        expires 30d;\n\
        add_header Cache-Control "public, no-transform";\n\
    }\n\
\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
