# midprice_pino devnet build/deploy (run from this directory or: make -f deploy-scripts/midprice_pino/Makefile)
SHELL := /bin/bash

MIDPRICE_MK_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
# protocol-v2-deploy repo root (contains programs/midprice_pino, target/deploy)
PROTOCOL_V2_ROOT ?= $(abspath $(MIDPRICE_MK_DIR)../..)

SOLANA_URL ?= https://api.devnet.solana.com

# Optional for deploy-devnet (override on CLI: make deploy-devnet DEPLOYER_KEYPAIR=...)
DEPLOYER_KEYPAIR ?=
PROGRAM_KEYPAIR ?=
SOLANA_PATH ?=
DEVNET_ADMIN ?=
IDL_JSON ?=

.PHONY: help build-devnet deploy-devnet update-devnet-idl

help:
	@echo "midprice_pino devnet"
	@echo "  make build-devnet        Build with cargo build-sbf, copy artifacts to target/deploy"
	@echo "  make deploy-devnet       solana program deploy (requires wallet — see below)"
	@echo "  make update-devnet-idl   npx @solana-program/program-metadata write idl (needs idl.json)"
	@echo ""
	@echo "Variables:"
	@echo "  PROTOCOL_V2_ROOT=$(PROTOCOL_V2_ROOT)  (repo root with programs/; override if different)"
	@echo "  SOLANA_URL=$(SOLANA_URL)"
	@echo "  IDL_JSON=$(IDL_JSON)  (empty = deploy-scripts/midprice_pino/idl.json)"
	@echo "Deploy keypairs:"
	@echo "  Program id: tests/fixtures/midprice_pino-keypair.json (override: PROGRAM_KEYPAIR=...)"
	@echo "  Payer: DEPLOYER_KEYPAIR=...  or  SOLANA_PATH + DEVNET_ADMIN"
	@echo "IDL upload: default idl path is deploy-scripts/midprice_pino/idl.json (override: IDL_JSON=...)"

build-devnet:
	PROTOCOL_V2_ROOT="$(PROTOCOL_V2_ROOT)" bash ./build-devnet.sh

deploy-devnet:
	PROTOCOL_V2_ROOT="$(PROTOCOL_V2_ROOT)" SOLANA_URL="$(SOLANA_URL)" \
	DEPLOYER_KEYPAIR="$(DEPLOYER_KEYPAIR)" PROGRAM_KEYPAIR="$(PROGRAM_KEYPAIR)" \
	SOLANA_PATH="$(SOLANA_PATH)" DEVNET_ADMIN="$(DEVNET_ADMIN)" \
	bash ./deploy-devnet.sh

update-devnet-idl:
	PROTOCOL_V2_ROOT="$(PROTOCOL_V2_ROOT)" SOLANA_URL="$(SOLANA_URL)" \
	DEPLOYER_KEYPAIR="$(DEPLOYER_KEYPAIR)" PROGRAM_KEYPAIR="$(PROGRAM_KEYPAIR)" \
	SOLANA_PATH="$(SOLANA_PATH)" DEVNET_ADMIN="$(DEVNET_ADMIN)" \
	IDL_JSON="$(IDL_JSON)" \
	bash ./update-devnet-idl.sh
