# Factory edge: build from this exact source, no cloud credentials embedded.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY scripts/setup-git-hooks.mjs ./scripts/setup-git-hooks.mjs
# The Puppeteer Extra deepmerge file override must exist before npm ci.
COPY vendor/secure-deepmerge/ ./vendor/secure-deepmerge/
RUN npm ci --no-audit --bin-links=true
COPY . .
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts && node scripts/verify-runtime-dependencies.mjs

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
WORKDIR /app
ENV NODE_ENV=production PORT=5000 PUPPETEER_PREWARM=false
COPY --from=builder --chown=node:node /app /app
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 5000
CMD ["node", "--expose-gc", "--import", "./server/startupPreload.mjs", "--import", "./server/runtimeMemoryGuard.mjs", "dist/index.js"]
