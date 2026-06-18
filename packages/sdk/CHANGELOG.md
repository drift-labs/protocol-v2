# @velocity-exchange/sdk

## 0.2.2

### Patch Changes

- [#97](https://github.com/drift-labs/protocol-v2-shadow/pull/97) [`022a949`](https://github.com/drift-labs/protocol-v2-shadow/commit/022a949cb1802171ca57a61260f86c8908f94f34) Thanks [@ChewingGlass](https://github.com/ChewingGlass)! - Re-export `PriceUpdateAccount` from the package root and declare `@types/node` as a devDependency (fixes the SDK build under isolated installs). Enables downstream apps (dlob-server, keeper-bots-v2) to consume the velocity SDK without reaching into subpaths.

## 0.2.1

### Patch Changes

- [`4fd7462`](https://github.com/drift-labs/protocol-v2-shadow/commit/4fd7462bfa3c55e31e3457b1b65f519cf052a6fa) Thanks [@ChewingGlass](https://github.com/ChewingGlass)! - Testing new changelog based package publishing flow
