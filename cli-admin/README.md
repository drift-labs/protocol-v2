# @velocity-exchange/admin-cli

CLI for Drift v2 admin operations. Sign with the right key (or pass a Squads
V4 multisig); the on-chain program enforces which tier of authority is
required for the action.

## Install

```sh
npm install -g @velocity-exchange/admin-cli
# or, one-off:
npx @velocity-exchange/admin-cli --help
```

## Usage

```sh
drift-admin --help
```

## Commands

```
drift-admin show config

drift-admin auth set-admin <pubkey>
drift-admin auth set-warm-admin <pubkey>
drift-admin auth set-hot-admin <role> <pubkey>
drift-admin auth init-config [--initial-warm <pk>]

drift-admin perp-market set-status <market> <status>
drift-admin spot-market set-status <market> <status>
drift-admin spot-market set-guard-threshold <market> <threshold>

drift-admin exchange set-status <bitfield>

drift-admin user set-special-status <user> <flags>
drift-admin user admin-deposit <market> <amount> --user <pk> --user-token-account <pk>

drift-admin call <ixName> <payloadFile>     # generic IDL escape hatch
```

## Routing through a Squads V4 multisig

Append `--multisig <multisigPda>` to any subcommand. The CLI submits a single
transaction that creates a `vault_transaction` + `proposal` against the
multisig with your wallet as the proposer. Members then approve + execute via
the Squads UI.

```sh
drift-admin auth set-warm-admin <newWarmAdmin> \
  --multisig <multisigPda> \
  --keypair ~/cold-proposer.json
```

## Generic dispatcher

For any drift instruction without a dedicated wrapper:

```sh
drift-admin call <camelCaseIxName> <payloadFile.json>
```

Example payload:

```json
{
	"args": { "withdrawGuardThreshold": "1000000000" },
	"accounts": {
		"spotMarket": "…",
		"state": "…",
		"adminAuthorityConfig": "…",
		"admin": "…"
	}
}
```

The dispatcher does no PDA derivation — every account must be supplied.

## Global options

| Flag                      | Default                               |
| ------------------------- | ------------------------------------- |
| `-u, --url <url>`         | `https://api.mainnet-beta.solana.com` |
| `-k, --keypair <path>`    | `~/.config/solana/id.json`            |
| `-e, --env <env>`         | `mainnet-beta` (or `devnet`)          |
| `-m, --multisig <pubkey>` | (none — direct send)                  |

## Local development

```sh
cd cli-admin
bun install
bun run start --help    # run from src directly via bun
bun run build           # tsc → lib/
./lib/index.js --help   # run the compiled binary as the published package would
```

The committed `package.json` keeps `"@velocity-exchange/sdk": "file:../sdk"` so
local edits to the SDK are picked up immediately. Publishing rewrites that
to a real semver range based on `sdk/package.json`'s version (see
`scripts/prepare-publish.js`) and restores the `file:` ref afterwards. CI
handles this automatically; for a manual publish:

```sh
bun run publish-cli
```
