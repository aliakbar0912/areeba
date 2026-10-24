# Shifa License Server — zero npm dependencies, Node.js built-ins only.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    TRUST_PROXY=1 \
    COOKIE_SECURE=1

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public
COPY scripts/create-admin.js ./scripts/create-admin.js

# Persistent data (database, keys, uploaded installers) — mount a volume here.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
