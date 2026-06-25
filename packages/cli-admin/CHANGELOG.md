# @velocity-exchange/admin-cli

## 0.2.0

### Minor Changes

- [`ec502c6`](https://github.com/velocity-exchange/velocity-v1/commit/ec502c6535e3ce2105f3df5b94bb005b7364c555) Thanks [@ChewingGlass](https://github.com/ChewingGlass)! - Add `perp-market set-oracle-slot-delay <market> <slots>` command to set a perp
  market's `oracle_slot_delay_override`. Lets operators raise the "stale for amm
  immediate" tolerance above the default `-1` (which clamps to a 0-slot threshold
  and makes a healthy multi-slot oracle crank read as perpetually stale).

### Patch Changes

- Updated dependencies [[`15073bc`](https://github.com/velocity-exchange/velocity-v1/commit/15073bc0b740b2d1cad471126a00368e72655bd5)]:
  - @velocity-exchange/sdk@0.2.5

## 0.1.5

### Patch Changes

- Updated dependencies [[`4f8e7aa`](https://github.com/velocity-exchange/velocity-v1/commit/4f8e7aaef0e35b190fc0b91cd29314d902d1ccab)]:
  - @velocity-exchange/sdk@0.2.4

## 0.1.4

### Patch Changes

- Updated dependencies [[`ae78769`](https://github.com/velocity-exchange/velocity-v1/commit/ae78769ef58355202c030435c2796ef045fe30a0)]:
  - @velocity-exchange/sdk@0.2.3

## 0.1.3

### Patch Changes

- Updated dependencies [[`022a949`](https://github.com/velocity-exchange/velocity-v1/commit/022a949cb1802171ca57a61260f86c8908f94f34)]:
  - @velocity-exchange/sdk@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [[`4fd7462`](https://github.com/velocity-exchange/velocity-v1/commit/4fd7462bfa3c55e31e3457b1b65f519cf052a6fa)]:
  - @velocity-exchange/sdk@0.2.1
