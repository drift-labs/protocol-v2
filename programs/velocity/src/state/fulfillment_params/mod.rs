//! Fulfillment parameter types for spot order routing. The remaining venue is
//! the internal Velocity AMM/DLOB; external venue support (Serum, Phoenix, OpenBook)
//! was removed when spot DLOB trading was disabled.

pub mod velocity;
