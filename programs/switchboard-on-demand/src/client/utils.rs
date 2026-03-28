use crate::prelude::*;
use anyhow::anyhow;
use sha2::{Digest, Sha256};
use anchor_client::solana_sdk::client::SyncClient;
use anchor_client::solana_sdk::signer::keypair::{keypair_from_seed, read_keypair_file, Keypair};
use anchor_client::solana_sdk::signer::Signer;
use std::env;
use std::result::Result;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::RwLock;
use anchor_client::solana_sdk::transaction::Transaction;
use crate::anchor_traits::*;
use crate::Pubkey;
use anchor_client::anchor_lang::AccountDeserialize;
use anyhow::Error as AnyhowError;
use anchor_client::solana_sdk::message::v0::Message as V0Message;
use anchor_client::solana_sdk::transaction::VersionedTransaction;
use anchor_client::solana_sdk::compute_budget::ComputeBudgetInstruction;
use crate::solana_program::hash::Hash;
use anchor_client::solana_client::nonblocking::rpc_client::RpcClient;
use anchor_client::solana_sdk::address_lookup_table::AddressLookupTableAccount;
use anchor_client::solana_sdk::message::VersionedMessage::V0;

pub async fn ix_to_tx_v0(
    rpc_client: &RpcClient,
    ixs: &[Instruction],
    signers: &[&Keypair],
    blockhash: Hash,
    luts: &[AddressLookupTableAccount],
) -> Result<VersionedTransaction, OnDemandError> {
    let payer_original = signers[0].pubkey();
    let payer: anchor_client::solana_sdk::pubkey::Pubkey = payer_original.to_bytes().into();

    // Auto-detect Compute Unit Limit
    let compute_unit_limit = estimate_compute_units(rpc_client, ixs, luts, blockhash, signers).await.unwrap_or(1_400_000); // Default to 1.4M units if estimate fails

    // Add Compute Budget Instruction (Optional but improves execution)
    let cus = std::cmp::min((compute_unit_limit as f64 * 1.4) as u32, 1_400_000);
    let compute_budget_ix = ComputeBudgetInstruction::set_compute_unit_limit(cus);
    // TODO: make dynamic
    let priority_fee_ix = ComputeBudgetInstruction::set_compute_unit_price(10_000);

    // Convert SDK instructions to program instructions
    let compute_budget_ix_converted = Instruction {
        program_id: compute_budget_ix.program_id.to_bytes().into(),
        accounts: compute_budget_ix.accounts.iter().map(|acc| AccountMeta {
            pubkey: acc.pubkey.to_bytes().into(),
            is_signer: acc.is_signer,
            is_writable: acc.is_writable,
        }).collect(),
        data: compute_budget_ix.data.clone(),
    };

    let priority_fee_ix_converted = Instruction {
        program_id: priority_fee_ix.program_id.to_bytes().into(),
        accounts: priority_fee_ix.accounts.iter().map(|acc| AccountMeta {
            pubkey: acc.pubkey.to_bytes().into(),
            is_signer: acc.is_signer,
            is_writable: acc.is_writable,
        }).collect(),
        data: priority_fee_ix.data.clone(),
    };

    let mut final_ixs = vec![
        compute_budget_ix_converted,
        priority_fee_ix_converted,
    ];
    final_ixs.extend_from_slice(ixs);

    // Convert AddressLookupTableAccount types
    let converted_luts: Vec<anchor_client::solana_sdk::message::AddressLookupTableAccount> = luts.iter().map(|lut| {
        anchor_client::solana_sdk::message::AddressLookupTableAccount {
            key: lut.key.to_bytes().into(),
            addresses: lut.addresses.iter().map(|addr| addr.to_bytes().into()).collect(),
        }
    }).collect();

    // Convert instructions to anchor-client types
    let converted_ixs: Vec<anchor_client::solana_sdk::instruction::Instruction> = final_ixs.iter().map(|ix| {
        anchor_client::solana_sdk::instruction::Instruction {
            program_id: ix.program_id.to_bytes().into(),
            accounts: ix.accounts.iter().map(|acc| anchor_client::solana_sdk::instruction::AccountMeta {
                pubkey: acc.pubkey.to_bytes().into(),
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            }).collect(),
            data: ix.data.clone(),
        }
    }).collect();

    // Create Message with Address Lookup Tables (ALTs)
    let converted_blockhash: anchor_client::solana_sdk::hash::Hash = blockhash.to_bytes().into();
    let message = V0Message::try_compile(&payer, &converted_ixs, &converted_luts, converted_blockhash)
        .map_err(|_| OnDemandError::SolanaSignError)?;

    let message = V0(message);
    // if message.header().num_required_signatures as usize != signers.len() {
        // // Skips all signature validation
        // return Ok(VersionedTransaction {
            // message: message,
            // signatures: vec![],
        // })
    // }
    // Create Versioned Transaction
    let tx = VersionedTransaction::try_new(message, signers)
        .map_err(|_| OnDemandError::SolanaSignError)?;

    Ok(tx)
}

/// Estimates Compute Unit Limit for Instructions
async fn estimate_compute_units(rpc_client: &RpcClient, ixs: &[Instruction], luts: &[AddressLookupTableAccount], blockhash: Hash, signers: &[&Keypair]) -> Result<u32, AnyhowError> {
    let payer_original = signers[0].pubkey();
    let payer: anchor_client::solana_sdk::pubkey::Pubkey = payer_original.to_bytes().into();
    let mut ixs = ixs.to_vec();
    let compute_limit_ix = ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);
    let compute_limit_ix_converted = Instruction {
        program_id: compute_limit_ix.program_id.to_bytes().into(),
        accounts: compute_limit_ix.accounts.iter().map(|acc| AccountMeta {
            pubkey: acc.pubkey.to_bytes().into(),
            is_signer: acc.is_signer,
            is_writable: acc.is_writable,
        }).collect(),
        data: compute_limit_ix.data.clone(),
    };
    ixs.insert(0, compute_limit_ix_converted);

    // Convert AddressLookupTableAccount types for this function too
    let converted_luts: Vec<anchor_client::solana_sdk::message::AddressLookupTableAccount> = luts.iter().map(|lut| {
        anchor_client::solana_sdk::message::AddressLookupTableAccount {
            key: lut.key.to_bytes().into(),
            addresses: lut.addresses.iter().map(|addr| addr.to_bytes().into()).collect(),
        }
    }).collect();

    // Convert instructions to anchor-client types
    let converted_ixs: Vec<anchor_client::solana_sdk::instruction::Instruction> = ixs.iter().map(|ix| {
        anchor_client::solana_sdk::instruction::Instruction {
            program_id: ix.program_id.to_bytes().into(),
            accounts: ix.accounts.iter().map(|acc| anchor_client::solana_sdk::instruction::AccountMeta {
                pubkey: acc.pubkey.to_bytes().into(),
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            }).collect(),
            data: ix.data.clone(),
        }
    }).collect();
    let converted_blockhash: anchor_client::solana_sdk::hash::Hash = blockhash.to_bytes().into();

    let message = V0Message::try_compile(&payer, &converted_ixs, &converted_luts, converted_blockhash)
        .map_err(|_| OnDemandError::SolanaSignError)?;

    // Create Versioned Transaction
    let tx = VersionedTransaction::try_new(V0(message), signers)
        .map_err(|_| OnDemandError::SolanaSignError)?;
    // Simulate Transaction to Estimate Compute Usage
    let sim_result = rpc_client.simulate_transaction(&tx)
        .await
        .map_err(|_| anyhow!("Failed to simulate transaction"))?;

    if let Some(units) = sim_result.value.units_consumed {
        Ok(units as u32)
    } else {
        Err(anyhow!("Failed to estimate compute units"))
    }
}

pub fn ix_to_tx(
    ixs: &[Instruction],
    signers: &[&Keypair],
    blockhash: crate::solana_program::hash::Hash,
) -> Result<Transaction, OnDemandError> {
    // Convert instructions to compatible type for solana_sdk
    let converted_ixs: Vec<anchor_client::solana_sdk::instruction::Instruction> = ixs.iter().map(|ix| {
        anchor_client::solana_sdk::instruction::Instruction {
            program_id: ix.program_id.to_bytes().into(),
            accounts: ix.accounts.iter().map(|acc| anchor_client::solana_sdk::instruction::AccountMeta {
                pubkey: acc.pubkey.to_bytes().into(),
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            }).collect(),
            data: ix.data.clone(),
        }
    }).collect();

    let converted_msg = anchor_client::solana_sdk::message::Message::new(&converted_ixs, Some(&signers[0].pubkey().to_bytes().into()));
    let mut tx = Transaction::new_unsigned(converted_msg);
    let converted_blockhash: anchor_client::solana_sdk::hash::Hash = blockhash.to_bytes().into();
    tx.try_sign(&signers.to_vec(), converted_blockhash)
        .map_err(|_e| OnDemandError::SolanaSignError)?;
    Ok(tx)
}

pub async fn get_enclave_signer_pubkey(
    enclave_signer: &Arc<RwLock<Keypair>>,
) -> Result<Arc<Pubkey>, OnDemandError> {
    let enclave_signer = enclave_signer.clone();
    let ro_enclave_signer = enclave_signer.read().await;
    let pubkey_bytes = ro_enclave_signer.pubkey().to_bytes();
    let pubkey = Arc::new(Pubkey::new_from_array(pubkey_bytes));
    Ok(pubkey)
}

pub fn load_env_pubkey(key: &str) -> Result<Pubkey, OnDemandError> {
    Pubkey::from_str(&env::var(key).unwrap_or_default())
        .map_err(|_| OnDemandError::EnvVariableMissing)
}

/// Parse a string into an optional Pubkey. If the string is empty, return None.
pub fn parse_optional_pubkey(var: &str) -> Option<Pubkey> {
    if var.is_empty() {
        None
    } else {
        match Pubkey::from_str(var) {
            Ok(pubkey) => {
                if pubkey != Pubkey::default() {
                    Some(pubkey)
                } else {
                    None
                }
            }
            Err(_) => None,
        }
    }
}

/// Generates a keypair from a base seed, secret key, optional additional bytes, and an optional program ID.
///
/// # Arguments
///
/// * `base` - The base seed as a string.
/// * `secret_key` - The secret key as a vector of bytes.
/// * `more_bytes` - Optional additional bytes to include in the seed.
/// * `program_id` - Optional program ID to include in the seed.
///
/// # Returns
///
/// Returns a `Result` containing an `Arc<Keypair>` if the keypair is successfully derived, or an `OnDemandError` if there is an error.
///
/// # Errors
///
/// Returns an `OnDemandError` with the message "InvalidSecretKey" if the length of the secret key is not 32 bytes.
/// Returns an `OnDemandError` with the message "Failed to derive keypair" if there is an error deriving the keypair.
///
/// # Example
///
/// ```rust
/// use solana_sdk::pubkey::Pubkey;
/// use solana_sdk::signature::{Keypair, keypair_from_seed};
/// use solana_sdk::hash::Hash;
/// use sha2::{Digest, Sha256};
/// use std::sync::Arc;
/// use switchboard_solana::OnDemandError;
///
/// let base = "base_seed";
/// let secret_key = vec![0; 32];
/// let more_bytes = Some(vec![1, 2, 3]);
/// let program_id = Some(Pubkey::new_unique());
///
/// let result = switchboard_solana::client::utils::keypair_from_base_seed(base, secret_key, more_bytes, program_id);
/// match result {
///     Ok(keypair) => {
///         // Key pair successfully derived
///         println!("Derived keypair: {:?}", keypair);
///     }
///     Err(error) => {
///         // Error deriving key pair
///         println!("Failed to derive keypair: {:?}", error);
///     }
/// }
/// ```
pub fn keypair_from_base_seed(
    base: &str,
    secret_key: Vec<u8>,
    more_bytes: Option<Vec<u8>>,
    program_id: Option<Pubkey>,
) -> Result<Arc<Keypair>, OnDemandError> {
    if secret_key.len() != 32 {
        return Err(OnDemandError::InvalidSecretKey);
    }

    let mut seed = base.as_bytes().to_vec();
    seed.extend_from_slice(&secret_key);

    if let Some(bytes) = more_bytes.as_ref() {
        seed.extend_from_slice(bytes);
    }

    // Optionally, allow the progam ID to be included in the bytes so we
    // can create new environments on different program IDs without collisions.
    if let Some(program_id) = program_id.as_ref() {
        seed.extend_from_slice(program_id.as_ref());
    } else {
        seed.extend_from_slice(crate::get_switchboard_on_demand_program_id().as_ref());
    }

    match keypair_from_seed(&Sha256::digest(&seed)) {
        Ok(keypair) => Ok(Arc::new(keypair)),
        Err(e) => {
            if let Some(err) = e.source() {
                println!("Failed to derive keypair -- {}", err);
            }

            Err(OnDemandError::KeyDerivationFailed)
        }
    }
}

pub fn signer_to_pubkey(signer: Arc<Keypair>) -> std::result::Result<Pubkey, OnDemandError> {
    let pubkey_bytes = signer.pubkey().to_bytes();
    Ok(Pubkey::new_from_array(pubkey_bytes))
}

pub fn load_keypair_fs(fs_path: &str) -> Result<Arc<Keypair>, OnDemandError> {
    match read_keypair_file(fs_path) {
        Ok(keypair) => Ok(Arc::new(keypair)),
        Err(e) => {
            if let Some(err) = e.source() {
                println!("Failed to read keypair file -- {}", err);
            }

            Err(OnDemandError::IoError)
        }
    }
}

/// Fetches a zero-copy account from the Solana blockchain.
///
/// # Arguments
///
/// * `client` - The Solana RPC client used to interact with the blockchain.
/// * `pubkey` - The public key of the account to fetch.
///
/// # Returns
///
/// Returns a result containing the fetched account data as the specified type `T`, or an `OnDemandError` if an error occurs.
///
/// # Errors
///
/// This function can return the following errors:
///
/// * `OnDemandError::AccountNotFound` - If the account with the specified public key is not found.
/// * `OnDemandError::Message("no discriminator found")` - If no discriminator is found in the account data.
/// * `OnDemandError::Message("Discriminator error, check the account type")` - If the discriminator in the account data does not match the expected discriminator for type `T`.
/// * `OnDemandError::Message("AnchorParseError")` - If an error occurs while parsing the account data into type `T`.
pub async fn fetch_zerocopy_account<T: bytemuck::Pod + Discriminator + Owner>(
    client: &crate::RpcClient,
    pubkey: Pubkey,
) -> Result<T, OnDemandError> {
    let data = client
        .get_account_data(&pubkey.to_bytes().into())
        .await
        .map_err(|_| OnDemandError::AccountNotFound)?;

    if data.len() < T::discriminator().len() {
        return Err(OnDemandError::InvalidDiscriminator);
    }

    let mut disc_bytes = [0u8; 8];
    disc_bytes.copy_from_slice(&data[..8]);
    if disc_bytes != T::discriminator() {
        return Err(OnDemandError::InvalidDiscriminator);
    }

    Ok(*bytemuck::try_from_bytes::<T>(&data[8..])
        .map_err(|_| OnDemandError::AnchorParseError)?)
}

/// Fetches the account data synchronously from the Solana blockchain using the provided client.
///
/// # Arguments
///
/// * `client` - The client used to interact with the Solana blockchain.
/// * `pubkey` - The public key of the account to fetch.
///
/// # Generic Parameters
///
/// * `C` - The type of the client, which must implement the `SyncClient` trait.
/// * `T` - The type of the account data, which must implement the `bytemuck::Pod`, `Discriminator`, and `Owner` traits.
///
/// # Returns
///
/// Returns a `Result` containing the fetched account data of type `T` if successful, or an `OnDemandError` if an error occurs.
pub fn fetch_zerocopy_account_sync<C: SyncClient, T: bytemuck::Pod + Discriminator + Owner>(
    client: &C,
    pubkey: Pubkey,
) -> Result<T, OnDemandError> {
    let data = client
        .get_account_data(&pubkey.to_bytes().into())
        .map_err(|_| OnDemandError::AccountNotFound)?
        .ok_or(OnDemandError::AccountNotFound)?;

    if data.len() < T::discriminator().len() {
        return Err(OnDemandError::InvalidDiscriminator);
    }

    let mut disc_bytes = [0u8; 8];
    disc_bytes.copy_from_slice(&data[..8]);
    if disc_bytes != T::discriminator() {
        return Err(OnDemandError::InvalidDiscriminator);
    }

    Ok(*bytemuck::try_from_bytes::<T>(&data[8..])
        .map_err(|_| OnDemandError::AnchorParseError)?)
}

pub async fn fetch_borsh_account<T: Discriminator + Owner + AccountDeserialize>(
    client: &crate::RpcClient,
    pubkey: Pubkey,
) -> Result<T, OnDemandError> {
    let account_data = client
        .get_account_data(&pubkey.to_bytes().into())
        .await
        .map_err(|_| OnDemandError::AccountNotFound)?;

    T::try_deserialize(&mut account_data.as_slice())
        .map_err(|_| OnDemandError::AnchorParseError)
}

pub fn fetch_borsh_account_sync<C: SyncClient, T: Discriminator + Owner + AccountDeserialize>(
    client: &C,
    pubkey: Pubkey,
) -> Result<T, OnDemandError> {
    let data = client
        .get_account_data(&pubkey.to_bytes().into())
        .map_err(|_| OnDemandError::AccountNotFound)?
        .ok_or(OnDemandError::AccountNotFound)?;

    T::try_deserialize(&mut data.as_slice()).map_err(|_| OnDemandError::AnchorParseError)
}


// type GenericError = Box<dyn std::error::Error + Send + Sync>;
