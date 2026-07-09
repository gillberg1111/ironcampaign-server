# IronCampaign sync node.
# Build context must be the REPO ROOT: the server imports ../questlog-critical by relative path,
# and argon2 resolves from the root node_modules (the documented resolution gotcha).
#
#   docker compose up -d --build
#
# Multi-stage: native modules (better-sqlite3, argon2) compile in the builder; the runtime stage
# carries no toolchain.

FROM node:20-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --ignore-scripts=false \
 && cd server && npm ci --ignore-scripts=false

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/ironcampaign.db
WORKDIR /app
# Runtime user: files in /data owned by node (uid 1000)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY package.json ./
COPY questlog-critical ./questlog-critical
COPY server ./server
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
# No curl in slim — probe with node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/src/app.js"]
