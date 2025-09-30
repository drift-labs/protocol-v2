#
# Docker image to generate deterministic, verifiable builds of Anchor programs.
# This must be run *after* a given ANCHOR_CLI version is published and a git tag
# is released on GitHub.
#

FROM --platform=linux/amd64 rust:1.70.0

ARG DEBIAN_FRONTEND=noninteractive

ARG SOLANA_CLI="1.16.27"
ARG ANCHOR_CLI="0.29.0"
ARG NODE_VERSION="20.18.x"

# Create a non-root user
ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID

RUN groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m $USERNAME \
    && apt-get update \
    && apt-get install -y sudo \
    && echo $USERNAME ALL=\(root\) NOPASSWD:ALL > /etc/sudoers.d/$USERNAME \
    && chmod 0440 /etc/sudoers.d/$USERNAME

ENV HOME="/home/$USERNAME"
ENV PATH="${HOME}/.cargo/bin:${PATH}"
ENV PATH="${HOME}/.local/share/solana/install/active_release/bin:${PATH}"

# Install base utilities.
RUN mkdir -p /workdir && mkdir -p /tmp && \
    apt-get update -qq && apt-get upgrade -qq && apt-get install -qq \
    build-essential git curl wget jq pkg-config python3-pip \
    libssl-dev libudev-dev

# libssl1.1 is not needed for newer versions

# Install rust.
RUN curl "https://sh.rustup.rs" -sfo rustup.sh && \
    sh rustup.sh -y && \
    rustup component add rustfmt clippy

# Install node / npm / yarn.
RUN apt-get install -y nodejs npm && \
    npm install -g yarn && \
    npm install -g ts-mocha && \
    npm install -g typescript && \
    npm install -g mocha

# Install Solana tools (x86_64 version).
RUN curl -sSfL https://github.com/solana-labs/solana/releases/download/v${SOLANA_CLI}/solana-release-x86_64-unknown-linux-gnu.tar.bz2 | tar -xjC /tmp && \
    mv /tmp/solana-release/bin/* /usr/local/bin/ && \
    rm -rf /tmp/solana-release

# Install anchor.
RUN cargo install --git https://github.com/coral-xyz/anchor --tag v${ANCHOR_CLI} anchor-cli --locked

# Switch to the non-root user for the remaining setup
USER $USERNAME

RUN solana-keygen new --no-bip39-passphrase

# Set up Solana config for local development
RUN solana config set --url localhost

# Create necessary directories
RUN mkdir -p $HOME/.config/solana

WORKDIR /workdir
