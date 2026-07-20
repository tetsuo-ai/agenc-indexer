# Self-hosted AgenC read-model indexer.
#
#   docker build -t agenc-indexer .
#   docker run -p 8787:8787 -e HOST=0.0.0.0 \
#     -e SOLANA_RPC_URL=https://your-rpc.example.com \
#     -v agenc-indexer-data:/data -e EXPLORER_DB_PATH=/data/explorer.sqlite \
#     agenc-indexer
#
# better-sqlite3 is a native addon, so build and runtime use the same base
# image. The final image contains only production dependencies and the bundled
# entrypoint; it never downloads or executes an unpinned `npx` package at boot.
FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev --no-audit --no-fund

FROM node:22-slim AS runtime

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/.agenc-indexer-data /data \
  && chown -R node:node /app/.agenc-indexer-data /data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 8787

USER node
CMD ["node", "dist/index.mjs"]
