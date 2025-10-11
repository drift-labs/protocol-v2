use borsh::BorshSerialize;
use solana_program::instruction::{AccountMeta, Instruction};
#[cfg(not(feature = "pinocchio"))]
use solana_program::program::invoke_signed;
use solana_program::program_error::ProgramError;
use solana_program::sysvar::slot_hashes;

use crate::anchor_traits::*;
// Use our AccountInfo type alias that conditionally uses pinocchio or anchor/solana-program
#[cfg(not(feature = "pinocchio"))]
use crate::get_account_key;
use crate::prelude::*;
use crate::{get_sb_program_id, solana_program, AccountInfo, Pubkey};

/// Randomness commitment instruction
pub struct RandomnessCommit {}

/// Parameters for randomness commitment instruction
#[derive(Clone, BorshSerialize, Debug)]
pub struct RandomnessCommitParams {}

impl InstructionData for RandomnessCommitParams {}

const DISCRIMINATOR: &[u8] = &[52, 170, 152, 201, 179, 133, 242, 141];
impl Discriminator for RandomnessCommitParams {
    const DISCRIMINATOR: &[u8] = DISCRIMINATOR;
}

impl Discriminator for RandomnessCommit {
    const DISCRIMINATOR: &[u8] = DISCRIMINATOR;
}

/// Account metas for randomness commitment instruction
pub struct RandomnessCommitAccounts {
    /// Randomness account public key
    pub randomness: Pubkey,
    /// Queue account public key
    pub queue: Pubkey,
    /// Oracle account public key
    pub oracle: Pubkey,
    /// Recent slot hashes sysvar account
    pub recent_slothashes: Pubkey,
    /// Authority account public key
    pub authority: Pubkey,
}
impl ToAccountMetas for RandomnessCommitAccounts {
    fn to_account_metas(&self, _: Option<bool>) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.randomness, false),
            AccountMeta::new_readonly(self.queue, false),
            AccountMeta::new(self.oracle, false),
            AccountMeta::new_readonly(slot_hashes::ID, false),
            AccountMeta::new_readonly(self.authority, true),
        ]
    }
}

impl RandomnessCommit {
    /// Builds a randomness commitment instruction
    pub fn build_ix(
        randomness: Pubkey,
        queue: Pubkey,
        oracle: Pubkey,
        authority: Pubkey,
    ) -> Result<Instruction, OnDemandError> {
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        Ok(crate::utils::build_ix(
            &pid,
            &RandomnessCommitAccounts {
                randomness,
                queue,
                oracle,
                authority,
                recent_slothashes: slot_hashes::ID,
            },
            &RandomnessCommitParams {},
        ))
    }

    /// Invokes the `randomness_commit` Switchboard CPI call.
    ///
    /// This call commits a new randomness value to the randomness account.
    ///
    /// # Requirements
    ///
    /// - The `authority` must be a signer.
    ///
    /// # Parameters
    ///
    /// - **switchboard**: Switchboard program account.
    /// - **randomness**: Randomness account.
    /// - **queue**: Queue account associated with the randomness account.
    /// - **oracle**: Oracle account assigned for the randomness request.
    /// - **authority**: Authority of the randomness account.
    /// - **recent_slothashes**: Sysvar account to fetch recent slot hashes.
    /// - **seeds**: Seeds for the CPI call.
    ///
    #[cfg(feature = "pinocchio")]
    pub fn invoke(
        #[allow(unused)] switchboard: AccountInfo,
        randomness: AccountInfo,
        queue: AccountInfo,
        oracle: AccountInfo,
        authority: AccountInfo,
        recent_slothashes: AccountInfo,
        #[allow(unused)] seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        let _accounts = vec![randomness, queue, oracle, recent_slothashes, authority];

        // TODO: Implement pinocchio-compatible invoke_signed
        // This is a complex conversion that requires bridging pinocchio and solana-program types
        unimplemented!("pinocchio invoke_signed needs type bridge implementation")
    }

    #[cfg(not(feature = "pinocchio"))]
    pub fn invoke<'a>(
        switchboard: AccountInfo<'a>,
        randomness: AccountInfo<'a>,
        queue: AccountInfo<'a>,
        oracle: AccountInfo<'a>,
        authority: AccountInfo<'a>,
        recent_slothashes: AccountInfo<'a>,
        seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        let accounts = [
            randomness.clone(),
            queue.clone(),
            oracle.clone(),
            recent_slothashes.clone(),
            authority.clone(),
        ];
        let account_metas = RandomnessCommitAccounts {
            randomness: (*get_account_key!(randomness)),
            queue: (*get_account_key!(queue)),
            oracle: (*get_account_key!(oracle)),
            recent_slothashes: (*get_account_key!(recent_slothashes)),
            authority: (*get_account_key!(authority)),
        }
        .to_account_metas(None);
        let ix = Instruction {
            program_id: (*get_account_key!(switchboard)),
            accounts: account_metas,
            data: ix_discriminator("randomness_commit").to_vec(),
        };
        invoke_signed(&ix, &accounts, seeds)
    }
}

#[cfg(not(feature = "pinocchio"))]
fn ix_discriminator(name: &str) -> [u8; 8] {
    use crate::solana_compat::hash;
    let preimage = format!("global:{}", name);
    let mut sighash = [0u8; 8];
    let hash_result = hash::hash(preimage.as_bytes());
    sighash.copy_from_slice(&hash_result.to_bytes()[..8]);
    sighash
}
