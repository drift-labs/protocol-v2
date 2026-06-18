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
    cargo build --release --locked --manifest-path rust/Cargo.toml -p ${APP_BIN} \
 && cp rust/target/release/${APP_BIN} /usr/local/bin/app

FROM debian:bookworm-slim AS runner
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/bin/app /usr/local/bin/app
ENTRYPOINT ["/usr/local/bin/app"]
