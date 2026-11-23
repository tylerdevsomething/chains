# Chains: one service for the follower, the explorer API (/api), the renderer (/chain/<id>.svg|json)
# and the site. Node runs the TypeScript directly; there is no build step.
#
#   docker build -t chains . && docker run -p 8080:8080 -e RPC_URL=... chains
#
# Env: RPC_URL (keep a private RPC server-side), CLUSTER (devnet | mainnet-beta), PUBLIC_ORIGIN,
# SNAPSHOT_FILE (default deploy/snapshot.<CLUSTER>.csv).
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY idl ./idl
COPY tools ./tools
COPY renderer ./renderer
COPY indexer ./indexer
COPY site ./site
COPY deploy ./deploy
ENV NODE_ENV=production PORT=8080 CLUSTER=devnet
EXPOSE 8080
CMD ["node", "indexer/server.ts"]
