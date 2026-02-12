# Client Crate Merge - Migration Guide

## Overview

The `switchboard-on-demand-client` crate has been successfully merged into `switchboard-on-demand` under the `client` feature flag. This consolidates the codebase and simplifies dependency management.

## What Changed

### For On-Chain/Program Users (No Changes Required)
If you only use the on-chain functionality (default features), **nothing changes**:

```toml
[dependencies]
switchboard-on-demand = "0.9.0"
```

### For Client Users (Import Path Changes)

**Old way (separate crate):**
```rust
use switchboard_on_demand_client::{Gateway, PullFeed, CrossbarClient};
```

**New way (unified crate with feature flag):**
```toml
[dependencies]
switchboard-on-demand = { version = "0.9.0", features = ["client"] }
```

```rust
use switchboard_on_demand::client::{Gateway, PullFeed, CrossbarClient};
```

## Feature Flags

- **Default**: `["cpi"]` - On-chain program functionality only
- **`client`**: Enables off-chain client functionality (Gateway, Crossbar, transaction builders, etc.)
- **`anchor`**: Anchor framework integration
- **`devnet`**: Use devnet program IDs
- **`solana-v2`**: Use Solana SDK 2.2.x instead of default 3.0+ (on-chain only)

### ⚠️ Feature Compatibility

**Important:** The `solana-v2` and `client` features are **mutually exclusive** and cannot be used together.

- ✅ `--features client` - Client with Solana v3 (default)
- ✅ `--features solana-v2` - On-chain with Solana v2
- ❌ `--features solana-v2,client` - **NOT SUPPORTED**

**Reason:** The client feature depends on `anchor-client` which uses Solana SDK 1.18+, while `solana-v2` uses Solana SDK 2.2.x. These versions have incompatible type signatures.

## Module Structure

### Client Module (`client` feature)
```
switchboard_on_demand::client::
├── Gateway                    // Gateway API client
├── CrossbarClient             // Crossbar API client
├── PullFeed                   // Pull feed utilities
├── oracle_job::OracleJob      // Oracle job definitions
├── accounts::                 // Client-specific account utilities
│   ├── OracleAccountData
│   ├── PullFeedAccountData
│   ├── QueueAccountData
│   └── State
├── instructions::             // Instruction builders
├── lut_owner::                // Lookup table utilities
├── secp256k1::                // Signature verification
├── gateway::                  // Gateway functions
└── utils::                    // Client utilities
```

## Migration Steps

### 1. Update Cargo.toml
```diff
[dependencies]
- switchboard-on-demand-client = "0.4.1"
+ switchboard-on-demand = { version = "0.9.0", features = ["client"] }
```

### 2. Update Imports
```diff
- use switchboard_on_demand_client::{Gateway, PullFeed};
+ use switchboard_on_demand::client::{Gateway, PullFeed};

- use switchboard_on_demand_client::oracle_job::OracleJob;
+ use switchboard_on_demand::client::oracle_job::OracleJob;

- use switchboard_on_demand_client::accounts::State;
+ use switchboard_on_demand::client::accounts::State;
```

### 3. Function and Type Changes

#### Program ID Helper
The client now has its own version that returns `anchor_lang::prelude::Pubkey`:
```rust
use switchboard_on_demand::get_switchboard_on_demand_program_id;

// Returns anchor-compatible Pubkey type
let program_id = get_switchboard_on_demand_program_id();
```

#### Constants
Client-specific constants are available at the crate root when `client` feature is enabled:
```rust
use switchboard_on_demand::{LUT_SIGNER_SEED, ORACLE_STATS_SEED};
```

## Key Technical Details

### Type Compatibility
- Client code uses `anchor_client::solana_sdk` types for compatibility with anchor ecosystem
- On-chain code uses `solana-program` types (version 3.0+ by default, 2.2+ with `solana-v2` feature)
- Helper functions bridge between type systems where needed

### No Namespace Pollution
Client types are **not** re-exported in the prelude to avoid naming conflicts. Always use explicit imports:
```rust
// ✅ Good
use switchboard_on_demand::client::{Gateway, PullFeed};

// ❌ Won't work - client types not in prelude
use switchboard_on_demand::prelude::*; // Only on-chain types
```

### Dependency Versions
Client-specific dependencies (when `client` feature is enabled):
- `anchor-client >= 0.31.1`
- `anchor-lang >= 0.31.1`
- `solana-client >= 1.18`
- `solana-sdk >= 1.18`
- `reqwest 0.11` (rustls)
- `tokio ^1.41` (full features)
- `prost 0.13.1`
- `dashmap 6.0.1`
- Plus utilities: `base64`, `hex`, `serde_json`, `switchboard-utils`

## Benefits of the Merge

1. **Single Dependency**: One crate instead of two
2. **Unified Versioning**: Client and on-chain code versioned together
3. **Reduced Duplication**: Shared types and utilities
4. **Better Maintenance**: Single codebase, simpler releases
5. **Cleaner Separation**: Feature flags provide clear on-chain vs off-chain distinction

## Compile Times

- **Without client feature**: ~same as before (on-chain only)
- **With client feature**: Includes additional dependencies but still reasonable

## Testing

Verify your migration:
```bash
# On-chain only
cargo check

# With client
cargo check --features client

# All features
cargo check --all-features
```

## Support

For issues or questions:
- GitHub: https://github.com/switchboard-xyz/switchboard-on-demand
- Documentation: https://docs.switchboard.xyz