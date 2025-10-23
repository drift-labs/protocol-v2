#
# Drift Protocol Dev Container
#

FROM --platform=linux/amd64 rust:1.70.0

ARG DEBIAN_FRONTEND=noninteractive
ARG SOLANA_CLI="1.16.27"
ARG ANCHOR_CLI="0.29.0"
ARG NODE_VERSION="20.18.1"

ENV HOME="/root"
ENV PATH="/usr/local/cargo/bin:${PATH}"
ENV PATH="/root/.local/share/solana/install/active_release/bin:${PATH}"

RUN mkdir -p /workdir /tmp && \
    apt-get update -qq && apt-get upgrade -qq && apt-get install -y --no-install-recommends \
      build-essential git curl wget jq pkg-config python3-pip xz-utils ca-certificates \
      libssl-dev libudev-dev bash && \
    rm -rf /var/lib/apt/lists/*

RUN rustup install 1.78.0 \
  && rustup component add rustfmt clippy --toolchain 1.78.0

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
  && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
  && rm /tmp/node.tar.xz \
  && corepack enable \
  && npm install -g ts-mocha typescript mocha \
  && node -v && npm -v && yarn -v

# Solana CLI (x86_64 build)
RUN curl -sSfL "https://github.com/solana-labs/solana/releases/download/v${SOLANA_CLI}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
  | tar -xjC /tmp \
  && mv /tmp/solana-release/bin/* /usr/local/bin/ \
  && rm -rf /tmp/solana-release

# Anchor CLI
RUN cargo install --git https://github.com/coral-xyz/anchor --tag "v${ANCHOR_CLI}" anchor-cli --locked

# Set up Solana key + config for root
RUN solana-keygen new --no-bip39-passphrase --force \
  && solana config set --url localhost

RUN apt-get update && apt-get install -y zsh curl git \
  && sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended \
  && chsh -s /usr/bin/zsh root

WORKDIR /workdir
