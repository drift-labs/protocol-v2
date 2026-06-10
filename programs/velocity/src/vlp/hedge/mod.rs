//! The hedge half of VLP: the LP pool that offsets vAMM inventory.
//!
//! Contains the pool accounts and their constituent loader, the perp-to-lp
//! settlement math, the admin-setup and user-facing instruction handlers, and the
//! settlement keeper handler.

pub mod admin;
pub mod constituent_map;
pub mod instructions;
pub mod math;
pub mod settle;
pub mod state;
