# Factory edge: build from this exact source, no cloud credentials embedded.
FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --bin-links=true
COPY . .
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts && node scripts/verify-runtime-dependencies.mjs

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=5000 PUPPETEER_PREWARM=false
COPY --from=builder --chown=node:node /app /app
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 5000
CMD ["node", "--expose-gc", "--import", "./server/startupPreload.mjs", "--import", "./server/runtimeMemoryGuard.mjs", "dist/index.js"]
