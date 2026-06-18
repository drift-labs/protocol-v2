# CLI Usage

This repo has a simple CLI for interacting with the vault (run from this `package.json`):

This CLI utility requires an RPC node and keypair to sign transactions. You can either provide these as environment variables, in a `.env` file, or use cli flags (like `--keypair` and `--url`).

Required Environment Variables or Flags:

Environment Variable| command line flag | Description
--------------------|-------------------|------------
RPC_URL             | --url             | The RPC node to connect to for transactions
KEYPAIR_PATH        | --keypair         | Path to keypair (file or base58) to sign transactions. This may also be a ledger filepath (e.g. `usb://ledger/<wallet_id>?key=0/0`)
ENV                 | --env             | 'devnet' or 'mainnet' (default: 'mainnet')


View available commands, run with `--help` in nested commands to get available options for each command
```
yarn cli --help
```

## Manager Commands

The following commands are menat to be run by Vault Managers. `KEYPAIR_PATH` should be the manager's keypair.

### Initialize a new vault

Init a new vault. This will initialize a new vault and update you (the manager) as the delegate, unless `--delegate` is specified.
```
$ yarn cli init-vault --help
Usage: cli init-vault [options]

Initialize a new vault

Options:
  -n, --name <string>               Name of the vault to create
  -i, --market-index <number>       Spot market index to accept for deposits (default 0 == USDC) (default: "0")
  -r, --redeem-period <number>      The period (in seconds) depositors must wait after requesting a withdraw (default: 7 days) (default: "604800")
  -x, --max-tokens <number>         The max number of spot marketIndex tokens the vault can accept (default 0 == unlimited) (default: "0")
  -m, --management-fee <percent>    The annualized management fee to charge depositors (default: "0")
  -s, --profit-share <percent>      The percentage of profits charged by manager (default: "0")
  -p, --permissioned                Provide this flag to make the vault permissioned, vault-depositors will need to be initialized by the manager
                                    (default: false)
  -a, --min-deposit-amount <number  The minimum token amount allowed to deposit (default: "0")
  -d, --delegate <publicKey>        The address to make the delegate of the vault
  -h, --help                        display help for command
```

### Update Vault Params

To update params in a vault:
```
$ yarn cli manager-update-vault --help
Usage: cli manager-update-vault [options]

Update vault params for a manager

Options:
  --vault-address <address>         Address of the vault to update
  -r, --redeem-period <number>      The new redeem period (can only be lowered)
  -x, --max-tokens <number>         The max tokens the vault can accept
  -a, --min-deposit-amount <number  The minimum token amount allowed to deposit
  -m, --management-fee <percent>    The new management fee (can only be lowered)
  -s, --profit-share <percent>      The new profit share percentage (can only be lowered)
  -p, --permissioned <boolean>      Set the vault as permissioned (true) or open (false) (default: false)
  -h, --help                        display help for command
```

### Update Margin Trading Enabled

If you wish to trade with spot margin on the vault, you must enable margin trading:
```
yarn cli manager-update-margin-trading-enabled --vault-address=<VAULT_ADDRESS> --enabled=<true|false>
```

### Manager Deposit

Make a deposit into a vault as the manager (`DEPOSIT_AMOUNT` in human precision, e.g. 5 for 5 USDC):
```
yarn cli manager-deposit --vault-address=<VAULT_ADDRESS> --amount=<DEPOSIT_AMOUNT>
```

### Manager Withdraw

Make a withdraw request from a vault as the manager (`SHARES` in raw precision):
```
yarn cli manager-request-withdraw --vault-address=<VAULT_ADDRESS> --amount=<SHARES>
```

After the redeem period has passed, the manager can complete the withdraw:
```
yarn cli manager-withdraw --vault-address=<VAULT_ADDRESS>
```

### Apply Profit Share
Manager can trigger a profit share calculation (this looks up all `VaultDepositors` for a vault eligible for profit share and batch processes them):
```
yarn cli apply-profit-share-all --vault-address=<VAULT_ADDRESS>
```

## Depositor Commands


### Deposit into a vault

#### Permissioned Vaults

Permissioned vaults require the __manager__ to initialize the `VaultDepositor` account before a depositor can deposit.

Initialize a `VaultDepositor` account for `AUTHORITY_TO_ALLOW_DEPOSIT` to deposit:
```
yarn cli init-vault-depositor --vault-address=<VAULT_ADDRESS> --deposit-authority=<AUTHORITY_TO_ALLOW_DEPOSIT>
```


#### Permissioneless Vaults

Permissionless vaults allow anyone to deposit. The `deposit` instruction will initialize a `VaultDepositor` account if one does not exist.
`DEPOSIT_AMOUNT` in human precision of the deposit token (e.g. 5 for 5 USDC).

```
yarn cli deposit --vault-address=<VAULT_ADDRESS> --deposit-authority=<DEPOSIT_AUTHORITY> --amount=<DEPOSIT_AMOUNT>
```

Alternatively, you can pass in the `VaultDepositor` address directly:
```
yarn cli deposit --vault-depositor-address=<VAULT_DEPOSITOR_ADDRESS> --amount=<DEPOSIT_AMOUNT>
```

### Withdraw from a vault

Request a withdraw from a vault:
```
yarn cli request-withdraw --vault-address=<VAULT_ADDRESS> --authority=<AUTHORITY> --amount=<WITHDRAW_AMOUNT>
```

After the redeem period has passed, the depositor can complete the withdraw:
```
yarn cli withdraw --vault-address=<VAULT_ADDRESS> --authority=<AUTHORITY>
```

## View only commands

To print out the current state of a `Vault`:
```
yarn cli view-vault --vault-address=<VAULT_ADDRESS>
```

To print out the current state of a `VaultDepositor`:
```
yarn cli view-vault-depositor --vault-depositor-address=<VAULT_DEPOSITOR_ADDRESS>
```

