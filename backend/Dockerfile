# syntax=docker/dockerfile:1
# Targets:  dev  (hot reload, used by docker-compose)   |   prod  (small runtime image)

FROM node:22-bookworm-slim AS base
# Prisma needs OpenSSL; postgresql-client lets `docker compose exec api psql` work for debugging.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── deps: full install (dev + prod) ──
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ── dev: source is bind-mounted by compose; node_modules + Prisma client live in the image ──
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
RUN npx prisma generate
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ── build: compile TypeScript ──
FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build

# ── prod: production dependencies + compiled output only ──
FROM base AS prod
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
