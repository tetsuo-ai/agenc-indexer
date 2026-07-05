# Self-hosted AgenC read-model indexer.
#
#   docker build -t agenc-indexer .
#   docker run -p 8787:8787 -e HOST=0.0.0.0 \
#     -e SOLANA_RPC_URL=https://your-rpc.example.com \
#     -v agenc-indexer-data:/data -e EXPLORER_DB_PATH=/data/explorer.sqlite \
#     agenc-indexer
#
# better-sqlite3 is a native addon, so dependencies are installed inside the
# image (no bind-mounted node_modules).
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 8787

CMD ["npx", "tsx", "src/index.ts"]
