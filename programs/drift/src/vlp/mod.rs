//! Velocity Liquidity Provider.
//!
//! Groups the constant-product vAMM and the LP pool that hedges its inventory
//! under one module, alongside the shared position cache that bridges them, so the
//! whole product can later be extracted into its own program.

pub mod amm;
pub mod amm_cache;
pub mod hedge;
