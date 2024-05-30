#
# Docker image to generate deterministic, verifiable builds of Anchor programs.
# This must be run *after* a given ANCHOR_CLI version is published and a git tag
# is released on GitHub.
#

FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive

ARG SOLANA_CLI="1.14.7"
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

# Install Solana tools.
RUN sh -c "$(curl -sSfL https://release.solana.com/v${SOLANA_CLI}/install)"

# Install anchor.
RUN cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
RUN avm install ${ANCHOR_CLI} && avm use ${ANCHOR_CLI}

RUN solana-keygen new --no-bip39-passphrase

WORKDIR /workdir
#be sure to add `/root/.avm/bin` to your PATH to be able to run the installed binaries
