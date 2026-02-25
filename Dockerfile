# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src/ ./src/
COPY tsconfig.json ./

ENV FRONTEND_PORT=3000
ENV BACKEND_PORT=3001

CMD ["npx", "tsx", "src/server.ts"]
