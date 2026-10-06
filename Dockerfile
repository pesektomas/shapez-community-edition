# syntax=docker/dockerfile:1
# Tvarovna: co-op server with the web build of the game.
#   docker build -t tvarovna .
#   docker run -p 8080:8080 -v tvarovna-data:/data tvarovna
# The Electron builder image is in Dockerfile.builder.

########## 1) Build the game (needs ffmpeg and Java for the texture packer)
FROM node:22-bookworm-slim AS game
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg default-jre-headless git \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
COPY gulp ./gulp
COPY src ./src
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/tmp/jar-cache \
    (cp /tmp/jar-cache/runnable-texturepacker.jar gulp/ 2>/dev/null || true) && \
    npm ci && \
    (cp gulp/runnable-texturepacker.jar /tmp/jar-cache/ 2>/dev/null || true)

COPY . .
# Set GAME_BUILD=web-dev for a build with test hooks (used by the E2E tests)
ARG GAME_BUILD=web
RUN npm run build:${GAME_BUILD} && \
    mkdir -p /out && cp -r build_output/${GAME_BUILD}/. /out/ && \
    (git rev-parse --short HEAD > /out/build-id.txt 2>/dev/null || true)

########## 2) Server dependencies
FROM node:22-bookworm-slim AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

########## 3) Runtime
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    STATIC_DIR=/app/web
WORKDIR /app

COPY --from=server /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/
COPY server/src ./server/src
COPY shared ./shared
COPY --from=game /out ./web

RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.ts"]
