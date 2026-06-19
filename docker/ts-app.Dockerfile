# syntax=docker/dockerfile:1
# Shared multi-stage build for any TypeScript app in the monorepo.
# Build context MUST be the repo root. Driven by build args from docker-info.json:
#   APP_PATH  e.g. apps/dlob-server                  (location of the app)
#   APP_SCOPE e.g. @velocity-exchange/dlob-server    (turbo --filter target)
#   APP_OUT   e.g. dist | lib                         (the app's build output dir)
#   APP_START e.g. lib/index.js                       (entrypoint inside APP_OUT's parent)
#
# Full-context build (the de-risked path vs `turbo prune` + bun lockfile, which has
# known correctness bugs). `bun install` resolves the whole workspace once; turbo
# builds only the requested package + its workspace deps. The runner copies just the
# app's emitted output and installs the native deps esbuild marks external.

ARG APP_PATH
ARG APP_SCOPE
ARG APP_OUT=dist
ARG APP_START=dist/index.js

FROM oven/bun:1.3.13 AS builder
WORKDIR /app
# Disable Turborepo anonymous telemetry for the image build.
ENV TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
# bunfig.toml carries the supply-chain install policy (exact pins,
# minimumReleaseAge) — copy it so the image build is governed by it too.
COPY package.json bun.lock bunfig.toml turbo.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
# Frozen: install exactly what the committed lockfile pins, never re-resolve.
RUN bun install --frozen-lockfile
ARG APP_SCOPE
RUN bunx turbo run build --filter="${APP_SCOPE}"

FROM node:24-alpine AS runner
ENV NODE_ENV=production
ARG APP_PATH
ARG APP_OUT
ARG APP_START
WORKDIR /app
# Native deps esbuild leaves external (union across apps; harmless extras).
RUN apk add --no-cache --virtual .build python3 make g++ \
 && npm install --no-save --no-audit --no-fund \
      bigint-buffer@1.1.5 \
      @triton-one/yellowstone-grpc@5.0.5 \
      helius-laserstream@0.1.8 \
      rpc-websockets@7.5.1 \
 && apk del .build
COPY --from=builder /app/${APP_PATH}/${APP_OUT} ./${APP_OUT}
ENV APP_START=${APP_START}
CMD ["sh", "-c", "node ${APP_START}"]
