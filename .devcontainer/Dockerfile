#
# Docker image to generate deterministic, verifiable builds of Anchor programs.
#

FROM --platform=linux/amd64 rust:1.70.0

ARG DEBIAN_FRONTEND=noninteractive

ARG SOLANA_CLI="1.16.27"
ARG ANCHOR_CLI="0.29.0"
ARG NODE_VERSION="20.18.1"

# Create a non-root user
ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID

RUN groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m $USERNAME \
    && apt-get update \
    && apt-get install -y sudo \
    && echo "$USERNAME ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/$USERNAME \
    && chmod 0440 /etc/sudoers.d/$USERNAME

ENV HOME="/home/$USERNAME"
ENV PATH="${HOME}/.cargo/bin:${PATH}"
ENV PATH="${HOME}/.local/share/solana/install/active_release/bin:${PATH}"

# Install base utilities
RUN mkdir -p /workdir && mkdir -p /tmp && \
    apt-get update -qq && apt-get upgrade -qq && apt-get install -qq \
    build-essential git curl wget jq pkg-config python3-pip xz-utils \
    libssl-dev libudev-dev

# Install Rust (latest via rustup, ensures toolchain components are present)
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh && \
    sh /tmp/rustup.sh -y && \
    rustup component add rustfmt clippy && \
    rm /tmp/rustup.sh

# Install Node.js (pinned)
RUN curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && corepack enable \
    && npm install -g ts-mocha typescript mocha

RUN node -v && npm -v && yarn -v

# Install Solana tools (x86_64 version)
RUN curl -sSfL https://github.com/solana-labs/solana/releases/download/v${SOLANA_CLI}/solana-release-x86_64-unknown-linux-gnu.tar.bz2 \
    | tar -xjC /tmp && \
    mv /tmp/solana-release/bin/* /usr/local/bin/ && \
    rm -rf /tmp/solana-release

# Install Anchor
RUN cargo install --git https://github.com/coral-xyz/anchor --tag v${ANCHOR_CLI} anchor-cli --locked

# Switch to the non-root user for the remaining setup
USER $USERNAME

# Generate a default Solana keypair
RUN solana-keygen new --no-bip39-passphrase

# Set up Solana config for local development
RUN solana config set --url localhost

# Create necessary directories
RUN mkdir -p $HOME/.config/solana

WORKDIR /workdir
