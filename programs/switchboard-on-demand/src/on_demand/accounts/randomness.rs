use std::cell::Ref;

use crate::{Pubkey, *};

/// Switchboard randomness account for verifiable random number generation
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
pub struct RandomnessAccountData {
    /// Authority that can update this randomness account
    pub authority: Pubkey,
    /// Queue this randomness account belongs to
    pub queue: Pubkey,

    /// Slot hash used as randomness seed
    pub seed_slothash: [u8; 32],
    /// Slot number used as randomness seed
    pub seed_slot: u64,
    /// Oracle that provided the randomness
    pub oracle: Pubkey,

    /// Slot at which randomness was revealed
    pub reveal_slot: u64,
    /// The random value (32 bytes)
    pub value: [u8; 32],

    _ebuf2: [u8; 96],
    _ebuf1: [u8; 128],
}
impl Discriminator for RandomnessAccountData {
    const DISCRIMINATOR: &'static [u8] = &[10, 66, 229, 135, 220, 239, 217, 114];
}
impl Owner for RandomnessAccountData {
    fn owner() -> Pubkey {
        if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        }
    }
}

cfg_client! {
    impl_account_deserialize!(RandomnessAccountData);
}
impl RandomnessAccountData {
    /// Returns the total size of a randomness account in bytes
    pub const fn size() -> usize {
        std::mem::size_of::<Self>() + 8
    }

    /// Gets the random value if it's current (matches reveal slot)
    pub fn get_value(&self, clock_slot: u64) -> std::result::Result<[u8; 32], OnDemandError> {
        if clock_slot != self.reveal_slot {
            return Err(OnDemandError::SwitchboardRandomnessTooOld);
        }
        Ok(self.value)
    }

    /// Returns true if randomness can be revealed at current slot
    pub fn is_revealable(&self, clock_slot: u64) -> bool {
        self.seed_slot < clock_slot
    }

    /// Parses randomness account data from raw bytes
    pub fn parse<'info>(
        data: Ref<'info, &mut [u8]>,
    ) -> std::result::Result<Ref<'info, Self>, OnDemandError> {
        if data.len() < Self::DISCRIMINATOR.len() {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        let mut disc_bytes = [0u8; 8];
        disc_bytes.copy_from_slice(&data[..8]);
        if disc_bytes != *Self::DISCRIMINATOR {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        // Check size before attempting to parse
        let expected_size = std::mem::size_of::<Self>() + 8;
        if data.len() < expected_size {
            return Err(OnDemandError::InvalidData);
        }

        // Validate the slice can be safely cast before using from_bytes
        let slice_to_parse = &data[8..expected_size];
        if slice_to_parse.len() != std::mem::size_of::<Self>() {
            return Err(OnDemandError::InvalidData);
        }

        // Check alignment requirements for bytemuck
        match bytemuck::try_from_bytes::<Self>(slice_to_parse) {
            Ok(_) => {
                // If try_from_bytes succeeds, we know from_bytes will also succeed
                Ok(Ref::map(data, |data: &&mut [u8]| {
                    bytemuck::from_bytes(&data[8..std::mem::size_of::<Self>() + 8])
                }))
            }
            Err(_) => Err(OnDemandError::AccountDeserializeError),
        }
    }

    cfg_client! {
        /// Fetches a randomness account asynchronously from the Solana network
        pub async fn fetch_async(
            client: &crate::RpcClient,
            pubkey: Pubkey,
        ) -> std::result::Result<Self, crate::OnDemandError> {
            let pubkey = pubkey.to_bytes().into();
            crate::client::fetch_zerocopy_account(client, pubkey).await
        }
    }
}
