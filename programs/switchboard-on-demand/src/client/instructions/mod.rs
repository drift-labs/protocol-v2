pub mod pull_feed_submit_response_ix;
pub use pull_feed_submit_response_ix::*;
pub mod pull_feed_submit_response_many_ix;
pub use pull_feed_submit_response_many_ix::*;
pub mod pull_feed_submit_response_consensus;
pub use pull_feed_submit_response_consensus::*;
use sha2::{Digest, Sha256};

pub fn get_discriminator(name: &str) -> Vec<u8> {
    let name = format!("global:{}", name);
    Sha256::digest(&name)[..8].to_vec()
}
