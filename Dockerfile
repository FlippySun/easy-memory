# =============================================================================
# Easy Memory — Multi-stage Dockerfile
# =============================================================================
# Build:  docker build -t easy-memory .
# Run:    docker run -e EASY_MEMORY_MODE=http -e QDRANT_URL=http://qdrant:6333 \
#           -e HTTP_AUTH_TOKEN=your-secret -p 3080:3080 easy-memory
# =============================================================================

# --------------- Stage 1: Build ---------------
FROM node:20-alpine AS builder

# CI mode: prevent TTY prompts from pnpm
ENV CI=true

# pnpm via corepack
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Install dependencies (layer cache)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile --prod=false

# Copy source & build backend
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# Build frontend (Web UI)
COPY web/ ./web/
RUN cd web && pnpm build

# Prune dev dependencies
RUN pnpm prune --prod

# --------------- Stage 2: Runtime ---------------
FROM node:20-alpine AS runtime

# Security: non-root user
RUN addgroup -g 1001 -S easymem && \
    adduser -S easymem -u 1001 -G easymem

WORKDIR /app

# Copy production artifacts only
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Metadata
LABEL org.opencontainers.image.title="Easy Memory" \
      org.opencontainers.image.description="MCP persistent memory service powered by Qdrant + Ollama" \
      org.opencontainers.image.source="https://github.com/FlippySun/easy-memory" \
      org.opencontainers.image.licenses="MIT"

# Default to HTTP mode for container deployments
ENV EASY_MEMORY_MODE=http \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=3080 \
    NODE_ENV=production

EXPOSE 3080

USER easymem

# Health check (HTTP mode)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3080/health || exit 1

CMD ["node", "dist/index.js"]
