#
# Velocity Protocol Dev Container
#

FROM --platform=linux/amd64 ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG SOLANA_CLI="2.3.11"
ARG ANCHOR_CLI="1.0.0"
ARG NODE_VERSION="24.0.0"

ENV HOME="/root"
ENV PATH="/usr/local/cargo/bin:${PATH}"
ENV PATH="/root/.local/share/solana/install/active_release/bin:${PATH}"

RUN mkdir -p /workdir /tmp \
    && apt-get update -qq \
    && apt-get upgrade -qq \
    && apt-get install -y --no-install-recommends \
    build-essential git curl wget jq pkg-config python3-pip xz-utils ca-certificates \
    libssl-dev libudev-dev bash software-properties-common \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.91.1 \
    && . "$HOME/.cargo/env" \
    && rustup component add rustfmt clippy --toolchain 1.91.1

ENV PATH="/root/.cargo/bin:${PATH}"

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && corepack enable \
    && npm install -g ts-mocha typescript mocha \
    && node -v && npm -v && yarn -v

# Solana CLI (x86_64 build, from anza-xyz/agave for 2.x+)
RUN curl -sSfL "https://github.com/anza-xyz/agave/releases/download/v${SOLANA_CLI}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
    | tar -xjC /tmp \
    && mv /tmp/solana-release/bin/* /usr/local/bin/ \
    && rm -rf /tmp/solana-release

# Anchor CLI (via avm)
RUN cargo install --git https://github.com/coral-xyz/anchor avm --force \
    && avm install ${ANCHOR_CLI} \
    && avm use ${ANCHOR_CLI}

# Set up Solana key + config for root
RUN solana-keygen new --no-bip39-passphrase --force \
    && solana config set --url localhost

RUN apt-get update && apt-get install -y zsh curl git \
    && sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended \
    && chsh -s /usr/bin/zsh root

WORKDIR /workdir
