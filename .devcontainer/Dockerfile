#
# Docker image to generate deterministic, verifiable builds of Anchor programs.
# This must be run *after* a given ANCHOR_CLI version is published and a git tag
# is released on GitHub.
#

FROM rust:1.75

ARG DEBIAN_FRONTEND=noninteractive

ARG SOLANA_CLI="1.16.27"
ARG ANCHOR_CLI="0.26.0"
ARG NODE_VERSION="v18.16.0"

ENV HOME="/root"
ENV PATH="${HOME}/.cargo/bin:${PATH}"
ENV PATH="${HOME}/.local/share/solana/install/active_release/bin:${PATH}"
ENV PATH="${HOME}/.nvm/versions/node/${NODE_VERSION}/bin:${PATH}"

# Install base utilities.
RUN mkdir -p /workdir && mkdir -p /tmp && \
    apt-get update -qq && apt-get upgrade -qq && apt-get install -qq \
    build-essential git curl wget jq pkg-config python3-pip \
    libssl-dev libudev-dev

RUN wget http://nz2.archive.ubuntu.com/ubuntu/pool/main/o/openssl/libssl1.1_1.1.1f-1ubuntu2_amd64.deb
RUN dpkg -i libssl1.1_1.1.1f-1ubuntu2_amd64.deb

# Install rust.
RUN curl "https://sh.rustup.rs" -sfo rustup.sh && \
    sh rustup.sh -y && \
    rustup component add rustfmt clippy

# Install node / npm / yarn.
RUN curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.11/install.sh | bash
ENV NVM_DIR="${HOME}/.nvm"
RUN . $NVM_DIR/nvm.sh && \
    nvm install ${NODE_VERSION} && \
    nvm use ${NODE_VERSION} && \
    nvm alias default node && \
    npm install -g yarn && \
    yarn add ts-mocha

# Install Solana tools from GitHub release
RUN mkdir -p ${HOME}/.local/share/solana/install/releases/${SOLANA_CLI} && \
    curl -L https://github.com/solana-labs/solana/releases/download/v${SOLANA_CLI}/solana-release-x86_64-unknown-linux-gnu.tar.bz2 -o /tmp/solana.tar.bz2 && \
    tar -xjf /tmp/solana.tar.bz2 -C ${HOME}/.local/share/solana/install/releases/${SOLANA_CLI} --strip-components=1 && \
    rm /tmp/solana.tar.bz2 && \
    ln -sf ${HOME}/.local/share/solana/install/releases/${SOLANA_CLI} ${HOME}/.local/share/solana/install/active_release

# Install anchor directly without avm (for compatibility with Rust 1.75)
RUN cargo install --git https://github.com/coral-xyz/anchor --tag v0.29.0 anchor-cli --locked --force

WORKDIR /workdir
