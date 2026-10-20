# Multi-stage build for efficient container size
FROM node:22-alpine AS builder

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .

# Stamp the release VERSION (the reusable release pipeline passes it as a build
# arg) into package.json before the build, the same way autotask-mcp does.
# semantic-release doesn't commit its bump back to protected main, so the
# checked-in package.json stays at 0.0.0. The production stage copies this
# stamped package.json, and src/version.ts reads it for serverInfo.version.
# Skipped for local builds (VERSION="unknown") so the checked-in value isn't
# clobbered with a placeholder.
RUN if [ "${VERSION}" != "unknown" ] && [ -n "${VERSION}" ]; then \
      npm pkg set version="${VERSION}" && \
      echo "Stamped package.json version -> ${VERSION}"; \
    fi

RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS production

RUN apk -U upgrade --no-cache

RUN addgroup -g 1001 -S marketsharp && \
    adduser -S marketsharp -u 1001 -G marketsharp

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

RUN mkdir -p /app/logs && chown -R marketsharp:marketsharp /app

# Remove bundled npm/npx from the runtime image - not needed at runtime; CMD
# runs node directly, and this trims a class of Trivy findings against npm's
# own bundled dependencies in the base image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER marketsharp

EXPOSE 8080

# Only the HTTP transport (MCP_TRANSPORT=http, the image default) serves
# /health. Under any other transport (stdio) the probe passes trivially so a
# working stdio container isn't marked unhealthy.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD [ "${MCP_TRANSPORT:-http}" != "http" ] || wget --no-verbose --tries=1 --spider "http://localhost:${MCP_HTTP_PORT:-8080}/health" || exit 1

# 0.0.0.0 is safe here only because startup refuses to listen without a real
# CONDUIT_S2S_SECRET. AUTH_MODE=gateway never falls back to image env credentials.
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=gateway

CMD ["node", "dist/http.js"]

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/marketsharp-mcp"
LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL description="MarketSharp MCP Server - Model Context Protocol server for the MarketSharp CRM REST API"
LABEL org.opencontainers.image.title="marketsharp-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for MarketSharp contacts, inquiries, appointments, jobs, notes and activities"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/marketsharp-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/WYRE-AI/marketsharp-mcp/blob/main/README.md"
LABEL org.opencontainers.image.url="https://github.com/WYRE-AI/marketsharp-mcp/pkgs/container/marketsharp-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"
