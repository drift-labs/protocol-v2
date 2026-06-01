//! Pure AMM math: invariant updates, spread/peg/k computations, JIT calculations.
//! Deterministic given inputs — no account I/O.

pub mod amm;
pub mod cp_curve;
pub mod jit;
pub mod repeg;
pub mod spread;
