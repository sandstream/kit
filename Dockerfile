# ─── kit CLI Container ────────────────────────────────────────────────
# Multi-stage build for production-ready CLI executable
# Final image: Node 22 Alpine (~100MB)

# Stage 1: Builder
FROM node:22-alpine AS builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./
COPY packages ./packages

# Install dependencies
RUN npm install

# Copy source code
COPY src ./src
COPY tsconfig*.json ./
COPY .kit ./.kit

# Build TypeScript → JavaScript
RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine

WORKDIR /app

# Install dumb-init for proper signal handling.
# Remove bundled npm (ships with a vulnerable picomatch and isn't needed at
# runtime — kit CLI shells out to `node`, never `npm`). Saves ~30MB.
RUN apk add --no-cache dumb-init \
 && rm -rf /usr/local/lib/node_modules/npm \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx

# Create non-root user
RUN addgroup -g 1001 -S kit && \
    adduser -S kit -u 1001

# Copy built application from builder
COPY --from=builder --chown=kit:kit /build/dist ./dist
COPY --from=builder --chown=kit:kit /build/node_modules ./node_modules
COPY --from=builder --chown=kit:kit /build/package.json ./

# Set environment
ENV NODE_ENV=production
ENV NODE_OPTIONS="--enable-source-maps"

# Switch to non-root user
USER kit

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node /app/dist/cli.js --version || exit 1

# Entrypoint with dumb-init for proper signal handling.
# Bake `node dist/cli.js` into ENTRYPOINT so `docker run kit --help` works
# (args after the image name pass straight to the CLI, not replacing CMD).
ENTRYPOINT ["/usr/bin/dumb-init", "--", "node", "/app/dist/cli.js"]
CMD ["--help"]

# Metadata
LABEL maintainer="kit Team"
LABEL description="kit CLI - Automated developer environment setup"
LABEL version="0.1.0"
