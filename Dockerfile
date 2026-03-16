# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN apt-get update && apt-get install -y git --no-install-recommends && rm -rf /var/lib/apt/lists/*
RUN GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown) \
    && BUILD_TIME=$(TZ=America/Chicago date '+%m/%d %H:%M CST') \
    && VITE_GIT_SHA=$GIT_SHA VITE_BUILD_TIME="$BUILD_TIME" npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src/ ./src/
COPY tsconfig.json ./

CMD ["npx", "tsx", "src/server.ts"]
