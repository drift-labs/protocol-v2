//! Consolidated AMM module.
//!
//! Contains the AMM state struct, its controller and refresh logic, the quoter
//! adapters that let the AMM participate in the generic quoter pipeline, and the
//! AMM-specific admin instruction handlers. Pure pricing math lives under
//! `amm::math`.

pub mod admin;
pub mod controller;
pub mod math;
pub mod quoter;
pub mod refresh;
pub mod state;

pub use quoter::{AmmJitQuoter, AmmQuoter};
pub use state::{AmmCurveRecordMetrics, AmmFeePoolSnapshot, AMM};
