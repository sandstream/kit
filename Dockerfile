# ─── kit CLI Container ────────────────────────────────────────────────
# Multi-stage build for production-ready CLI executable
# Final image: Node 22 Alpine, 376MB (arm64, `docker images`).
#
# The size claim is measured, not estimated: it read "~100MB" while the image
# actually shipped 460MB, because the runtime copied the BUILDER's node_modules.
# That tree is `npm ci` with devDependencies, so the published CLI image carried
# typescript, eslint and esbuild: 170 packages, 93.6MB, none of them reachable at
# runtime. kit has four runtime dependencies, which now come from a dedicated
# prod-deps stage: 114 packages, 27.2MB (MR-1).

# Stage 1: Builder
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder

WORKDIR /build

# Copy package files
COPY package*.json ./
COPY packages ./packages

# Install dependencies (npm ci = reproducible from the committed lockfile)
RUN npm ci

# Copy source code
COPY src ./src
COPY tsconfig*.json ./
COPY .kit ./.kit
COPY scripts ./scripts
COPY skills ./skills

# Build TypeScript → JavaScript
RUN npm run build

# Stage 2: Production dependencies only.
# Resolved from the same committed lockfile as the builder, so the runtime tree is
# reproducible rather than a pruned leftover of the build tree. Scripts are ignored:
# all four runtime deps are pure JS, and an install script in the image build is
# exactly the supply-chain surface kit's own install gate exists to refuse.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS prod-deps

WORKDIR /deps

COPY package*.json ./
COPY packages ./packages

RUN npm ci --omit=dev --ignore-scripts

# Stage 3: Runtime
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

WORKDIR /app

# Plugin installation needs npm; its mandatory triage gate needs Python and the
# bundled triage skill copied below. Keep npm on the triaged, Node 22-compatible
# release instead of inheriting whichever version ships in the base image.
RUN apk add --no-cache --upgrade \
        bash=5.3.9-r1 \
        dumb-init=1.2.5-r4 \
        libcrypto3=3.5.8-r0 \
        libssl3=3.5.8-r0 \
        python3=3.14.7-r1 \
    && npm install -g npm@11.19.1 --ignore-scripts \
    && npm cache clean --force

# Create non-root user
RUN addgroup -g 1001 -S kit && \
    adduser -S kit -u 1001

# Copy built application from builder
COPY --from=builder --chown=kit:kit /build/dist ./dist
COPY --from=prod-deps --chown=kit:kit /deps/node_modules ./node_modules
COPY --from=builder --chown=kit:kit /build/package.json ./
COPY --from=builder --chown=kit:kit /build/skills ./skills
COPY --from=builder --chown=kit:kit /build/scripts ./scripts
RUN chown kit:kit /app

# Set environment
ENV NODE_ENV=production
ENV NODE_OPTIONS="--enable-source-maps"

# Switch to non-root user
USER 1001:1001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["node", "/app/dist/cli.js", "--version"]

# Entrypoint with dumb-init for proper signal handling.
# Bake `node dist/cli.js` into ENTRYPOINT so `docker run kit --help` works
# (args after the image name pass straight to the CLI, not replacing CMD).
ENTRYPOINT ["/usr/bin/dumb-init", "--", "node", "/app/dist/cli.js"]
CMD ["--help"]

# Metadata (version comes from the image tag, not a hardcoded label)
LABEL maintainer="kit Team"
LABEL description="kit CLI - Automated developer environment setup"
