# ── Stage 1: builder ─────────────────────────────────────────────────────────
# Pinned tag + digest (G-16): `docker buildx imagetools inspect node:20.20.2-bookworm-slim`
FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder

# pnpm 11+ requires Node 22 (node:sqlite) — pin to the 10.x line used locally
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# Only the manifests of the projects this SPA needs. The lockfile still lists
# every workspace importer; pnpm ignores the absent ones ("Scope: 2 of N").
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json ./
COPY apps/console/package.json       apps/console/
COPY packages/web-core/package.json packages/web-core/
# @opengraphity/types: web-core lo importa, quindi il suo manifesto serve
# comunque — la console non lo usa direttamente.
COPY packages/types/package.json    packages/types/

# Lean install (G-05): just the portal + web-core dependency graph, and no
# lifecycle scripts — the previous full-workspace install compiled isolated-vm
# (C++ toolchain, minutes) for a static bundle that never uses it.
# esbuild/rollup ship prebuilt binaries as optional deps: no postinstall needed.
RUN pnpm install --frozen-lockfile --ignore-scripts \
      --filter @opengraphity/console... \
      --filter @opengraphity/web-core... \
      --filter @opengraphity/types...

# @opengraphity/web-core (auth/tenant/apollo shared with apps/web) is consumed
# from its dist/, which .dockerignore excludes: build it in the container.
# I tipi si costruiscono PRIMA di web-core: web-core li legge dal suo dist.
COPY packages/types/ packages/types/
RUN pnpm --filter @opengraphity/types build
COPY packages/web-core/ packages/web-core/
RUN pnpm --filter @opengraphity/web-core build

COPY apps/console/ apps/console/

# ── Build-time vars (baked into the JS bundle at compile time) ────────────────
# Devono essere raggiungibili dal BROWSER, non da dentro Docker.
#
# `VITE_PLATFORM_REALM` non ha un default, ed è voluto: senza, la console si
# ferma all'avvio con una frase leggibile invece di chiedere a Keycloak un
# realm inventato. Nessun `VITE_TENANT_SLUG`: la console non appartiene a un
# tenant, ed è tutto il punto.
ARG VITE_KEYCLOAK_URL=http://localhost:8080
ARG VITE_KEYCLOAK_CLIENT_ID=opengrafo-console
ARG VITE_PLATFORM_REALM=

ENV VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL
ENV VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID
ENV VITE_PLATFORM_REALM=$VITE_PLATFORM_REALM

RUN pnpm --filter @opengraphity/console build

# ── Stage 2: nginx ────────────────────────────────────────────────────────────
# Same image as the front-door nginx (infra/docker-compose.yml), pinned by digest.
FROM nginx:1.28.3-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236 AS runtime

COPY --from=builder /app/apps/console/dist /usr/share/nginx/html

# Inline nginx config: SPA fallback + reverse-proxy to API. Only reachable from
# the front-door nginx and 127.0.0.1:5174; X-Forwarded-Host is still forced to
# $host so the API never sees a client-chosen tenant header. Body sizes and
# timeouts as in apps/web/Dockerfile (revisione totale · H-11, H-20, H-21).
# index.html is served no-cache like the web's (H-15): with heuristic caching a
# browser kept an old index.html pointing at an asset hash that no longer
# exists, and the portal came up blank until a hard refresh.
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
    location /platform {\n\
        client_max_body_size 64k;\n\
        proxy_pass http://api:4000;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header Host $host;\n\
        proxy_set_header X-Forwarded-Host $host;\n\
        proxy_set_header X-Real-IP $remote_addr;\n\
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
        add_header Cache-Control "no-cache, no-store, must-revalidate";\n\
        add_header Pragma "no-cache";\n\
        add_header Expires 0;\n\
        etag off;\n\
        if_modified_since off;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
