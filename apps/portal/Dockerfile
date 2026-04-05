# ── Stage 1: builder ─────────────────────────────────────────────────────────
# node:20-slim (glibc) required — isolated-vm (workspace dep) fails on Alpine/musl
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

ARG VITE_GRAPHQL_URL=/graphql
ARG VITE_API_URL=/graphql
ARG VITE_KEYCLOAK_URL=http://localhost:8080
ARG VITE_KEYCLOAK_CLIENT_ID=opengrafo-portal
ARG VITE_TENANT_SLUG=

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/portal/package.json apps/portal/

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

COPY apps/portal/ apps/portal/

ENV VITE_GRAPHQL_URL=$VITE_GRAPHQL_URL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL
ENV VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID
ENV VITE_TENANT_SLUG=$VITE_TENANT_SLUG

RUN pnpm --filter @opengraphity/portal build

# ── Stage 2: nginx ────────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

COPY --from=builder /app/apps/portal/dist /usr/share/nginx/html

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
        proxy_set_header X-Real-IP $remote_addr;\n\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
        proxy_set_header X-Forwarded-Proto $scheme;\n\
    }\n\
\n\
    location /api/sse {\n\
        proxy_pass http://api:4000;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header Host $host;\n\
        proxy_set_header Connection "";\n\
        proxy_cache off;\n\
        proxy_buffering off;\n\
        proxy_read_timeout 86400s;\n\
    }\n\
\n\
    location /api {\n\
        proxy_pass http://api:4000;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header Host $host;\n\
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
