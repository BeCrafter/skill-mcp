# Stage 1: Dependencies
FROM node:22-alpine AS deps

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

# Stage 2: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 3: Production Runtime
FROM node:22-alpine AS runner

RUN apk add --no-cache curl

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy built files from builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./

# Copy production dependencies
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules

# Create data directories
RUN mkdir -p /app/data /app/data/skills /app/data/cache && \
    chown -R nodejs:nodejs /app/data

# Switch to non-root user
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:${TRANSPORT_PORT:-3000}/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})" || exit 1

# Expose default ports
# 3000: HTTP/Storage service
# 4000: MCP gateway service
EXPOSE 3000 4000

# Default environment variables
ENV NODE_ENV=production \
    TRANSPORT_TYPE=http \
    TRANSPORT_PORT=3000 \
    STORAGE_TYPE=local-fs \
    STORAGE_BASE_PATH=/app/data/skills \
    DATABASE_PATH=/app/data/skill-mcp.db \
    CACHE_FILE_DIR=/app/data/cache \
    LOG_LEVEL=info

# Start the application
CMD ["node", "dist/index.js", "serve"]