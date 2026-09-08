# ── Single-stage: copy pre-built dist into nginx ─────────────────────────────
# The web app is built locally (pnpm --filter @opengraphity/web build)
# and the dist/ folder is copied directly into the image.
# This ensures the deployed JS is identical to what was built and tested locally.
# Pinned tag + digest (G-16) — same image as the front-door nginx in compose.
# nginx alpine already runs its worker processes as the unprivileged `nginx`
# user (master as root only to bind :80): no USER directive needed.
FROM nginx:1.28.3-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236

COPY apps/web/dist /usr/share/nginx/html

# Inline nginx config: SPA fallback + reverse-proxy to API. Only reachable from
# the front-door nginx and 127.0.0.1:5173; X-Forwarded-Host is still forced to
# $host so the API never sees a client-chosen tenant header, and
# client_max_body_size matches the API's 10 MB attachment limit.
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
        add_header Cache-Control "no-cache, no-store, must-revalidate";\n\
        add_header Pragma "no-cache";\n\
        add_header Expires 0;\n\
        etag off;\n\
        if_modified_since off;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
