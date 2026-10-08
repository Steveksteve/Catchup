# syntax=docker/dockerfile:1

# ---- 1. dependances de production uniquement ---------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- 2. assemblage : code + repertoire de logs appartenant a l'utilisateur non-root
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY tools ./tools
RUN mkdir -p /app/logs

# ---- 3. execution : distroless (ni shell, ni npm, ni gestionnaire de paquets) --
FROM gcr.io/distroless/nodejs22-debian13:nonroot AS runtime
ARG BUILD=dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="game-telemetry" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${BUILD}"
ENV NODE_ENV=production \
    PORT=8080 \
    LOG_FILE=/app/logs/telemetry.log
WORKDIR /app
# 65532 = utilisateur "nonroot" de l'image distroless
COPY --from=build --chown=65532:65532 /app /app
USER 65532:65532
EXPOSE 8080
VOLUME ["/app/logs"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# l'entrypoint de l'image est deja "node"
CMD ["src/server.js"]
