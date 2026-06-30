# syntax=docker/dockerfile:1
# Shared build for the Rust apps (keep-rs, swift) in the `rust/` workspace.
# Build context MUST be the repo root (the crates path-dep ../../programs/velocity).
# Driven by build arg APP_BIN from docker-info.json (the cargo package == main binary):
#   keep-rs -> keeprs,  swift -> swift-server
#
# NOTE: drift-ffi-sys is gone on the imported `next`/rebrand branches (the program is
# linked directly as the `drift` (velocity) path-dep), so there is no libdrift_ffi_sys
# download here — unlike the pre-velocity keep-rs Dockerfile.

ARG APP_BIN

FROM rust:1.91.1 AS builder
WORKDIR /repo
RUN rustup component add rustfmt
COPY . .
ARG APP_BIN
RUN --mount=type=cache,target=/repo/rust/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    # Bump every source mtime before building. cargo fingerprints path crates by
    # source mtime, but BuildKit `COPY . .` can stamp sources older-or-equal to the
    # compiled artifacts already in the `rust/target` cache mount. When that happens
    # cargo's mtime fast-path decides a *changed* crate is up to date and skips it —
    # most dangerously the out-of-workspace `velocity` / `velocity-rs` path-deps
    # (../../programs/velocity, ../velocity-rs) — so the binary links STALE object
    # code and a merged source fix silently never ships (e.g. the off-chain
    # zero-copy alignment fix → `TargetAlignmentGreaterAndInputNotAligned` at runtime).
    # Touching all sources forces cargo to recompile our crates while the heavy
    # registry deps (separate cache mount, content-addressed) stay cached.
    find . \( -path ./target -o -path ./rust/target \) -prune -o -name '*.rs' -exec touch {} + \
 && cargo build --release --locked --manifest-path rust/Cargo.toml -p ${APP_BIN} \
 && cp rust/target/release/${APP_BIN} /usr/local/bin/${APP_BIN}

FROM debian:bookworm-slim AS runner
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
ARG APP_BIN
# Build provenance baked as runtime ENV. Each app logs these at startup (target
# "startup"), so the running build is identifiable from line one of the logs —
# the fast tell for a stale-image / build-cache deploy. Passed by the workflow
# from `github.sha` / the parsed tag version; default to dev/unknown for local builds.
ARG GIT_SHA=unknown
ARG BUILD_VERSION=dev
ENV BUILD_GIT_SHA=${GIT_SHA}
ENV BUILD_VERSION=${BUILD_VERSION}
# Install the binary under its real name (keeprs, swift-server) — the k8s
# manifests invoke it explicitly (e.g. `/usr/local/bin/swift-server --server …`).
# Keep `/usr/local/bin/app` as a symlink so the default ENTRYPOINT still resolves.
COPY --from=builder /usr/local/bin/${APP_BIN} /usr/local/bin/${APP_BIN}
RUN ln -s /usr/local/bin/${APP_BIN} /usr/local/bin/app
ENTRYPOINT ["/usr/local/bin/app"]
