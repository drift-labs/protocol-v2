use super::secp256k1::Secp256k1InstructionUtils;
use super::secp256k1::SecpSignature;
use super::Gateway;
use super::accounts::{OracleAccountData, State, PullFeedAccountData, QueueAccountData};
use super::lut_owner::{self};
use super::instructions::*;
use super::crossbar::CrossbarClient;
use super::gateway::{FeedConfig, encode_jobs, FetchSignaturesParams, FetchSignaturesConsensusParams};
use super::oracle_job::OracleJob;
use super::lut_owner::load_lookup_tables;
use super::recent_slothashes::SlotHashSysvar;
use crate::get_switchboard_on_demand_program_id;
use anyhow::anyhow;
use anyhow::Context;
use anyhow::Error as AnyhowError;
use super::associated_token_account::get_associated_token_address;
use super::associated_token_account::NATIVE_MINT;
use super::associated_token_account::SPL_TOKEN_PROGRAM_ID;
use base64::{engine::general_purpose::STANDARD as base64, Engine as _};
use bs58;
use bytemuck;
use dashmap::DashMap;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use crate::solana_compat::solana_client::nonblocking::rpc_client::RpcClient;
use anchor_client::solana_sdk::address_lookup_table::AddressLookupTableAccount;
use anchor_client::solana_sdk::instruction::Instruction;
use crate::{Pubkey, SYSTEM_PROGRAM_ID};
use std::result::Result;
use std::sync::Arc;
use tokio::join;
use tokio::sync::OnceCell;

type LutCache = DashMap<Pubkey, AddressLookupTableAccount>;
type JobCache = DashMap<[u8; 32], OnceCell<Vec<OracleJob>>>;
type PullFeedCache = DashMap<Pubkey, OnceCell<PullFeedAccountData>>;

pub fn generate_combined_checksum(
    queue_key: &[u8; 32],
    feeds: &[PullFeedAccountData],
    signed_slothash: &[u8; 32],
    submission_values: &[i128],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(queue_key);

    for feed in feeds {
        hasher.update(feed.feed_hash);
        hasher.update(feed.max_variance.to_le_bytes());
        hasher.update(feed.min_responses.to_le_bytes());
    }

    hasher.update(signed_slothash);
    for &value in submission_values {
        hasher.update(value.to_le_bytes());
    }

    // Finalize and return the hash.
    hasher.finalize().into()
}

pub struct SbContext {
    pub lut_cache: LutCache,
    pub job_cache: JobCache,
    pub pull_feed_cache: PullFeedCache,
}
impl SbContext {
    pub fn new() -> Arc<Self> {
        Arc::new(SbContext {
            lut_cache: DashMap::new(),
            job_cache: DashMap::new(),
            pull_feed_cache: DashMap::new(),
        })
    }
}

pub async fn fetch_and_cache_luts<T: bytemuck::Pod + lut_owner::LutOwner>(
    client: &RpcClient,
    context: Arc<SbContext>,
    oracle_keys: &[Pubkey],
) -> Result<Vec<AddressLookupTableAccount>, AnyhowError> {
    let mut luts = Vec::new();
    let mut keys_to_fetch = Vec::new();

    for &key in oracle_keys {
        if let Some(cached_lut) = context.lut_cache.get(&key) {
            luts.push(cached_lut.clone());
        } else {
            keys_to_fetch.push(key);
        }
    }

    if !keys_to_fetch.is_empty() {
        let fetched_luts = load_lookup_tables::<T>(client, &keys_to_fetch).await?;
        for (key, lut) in keys_to_fetch.into_iter().zip(fetched_luts.into_iter()) {
            context.lut_cache.insert(key, lut.clone());
            luts.push(lut);
        }
    }

    Ok(luts)
}

#[derive(Clone, Debug)]
pub struct OracleResponse {
    pub value: Option<Decimal>,
    pub error: String,
    pub oracle: Pubkey,
    pub signature: [u8; 64],
    pub recovery_id: u8,
}

#[derive(Clone, Debug, Default)]
pub struct FetchUpdateParams {
    pub feed: Pubkey,
    pub payer: Pubkey,
    pub gateway: Gateway,
    pub crossbar: Option<CrossbarClient>,
    pub num_signatures: Option<u32>,
    pub debug: Option<bool>,
}

#[derive(Clone, Debug, Default)]
pub struct FetchUpdateManyParams {
    pub feeds: Vec<Pubkey>,
    pub payer: Pubkey,
    pub gateway: Gateway,
    pub crossbar: Option<CrossbarClient>,
    pub num_signatures: Option<u32>,
    pub debug: Option<bool>,
}

#[derive(Clone, Debug, Default)]
pub struct FetchUpdateBatchParams {
    pub feeds: Vec<Pubkey>,
    pub payer: Pubkey,
    pub gateway: Gateway,
    pub crossbar: Option<CrossbarClient>,
    pub num_signatures: Option<u32>,
    pub debug: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SolanaSubmitSignaturesParams {
    pub queue: Pubkey,
    pub feed: Pubkey,
    pub payer: Pubkey,
}

pub struct PullFeed;

impl PullFeed {
    pub async fn load_data(
        client: &RpcClient,
        key: &Pubkey,
    ) -> Result<PullFeedAccountData, AnyhowError> {
        let account = client
            .get_account_data(&key.to_bytes().into())
            .await
            .map_err(|_| anyhow!("PullFeed.load_data: Account not found"))?;
        let account = account[8..].to_vec();
        let data = bytemuck::try_from_bytes::<PullFeedAccountData>(&account)
            .map_err(|_| anyhow!("PullFeed.load_data: Failed to parse data"))?;
        Ok(*data)
    }

    fn get_solana_submit_signatures_ix(
        slot: u64,
        responses: Vec<OracleResponse>,
        params: SolanaSubmitSignaturesParams,
    ) -> Result<Instruction, AnyhowError> {
        let mut submissions = Vec::new();
        for resp in &responses {
            let mut value_i128 = i128::MAX;
            if let Some(mut val) = resp.value {
                val.rescale(18);
                value_i128 = val.mantissa();
            }
            submissions.push(Submission {
                value: value_i128,
                signature: resp.signature,
                recovery_id: resp.recovery_id,
                offset: 0,
            });
        }
        let mut remaining_accounts = Vec::new();
        for resp in &responses {
            remaining_accounts.push(anchor_client::solana_sdk::instruction::AccountMeta::new_readonly(resp.oracle.to_bytes().into(), false));
        }
        for resp in responses {
            let stats_key = OracleAccountData::stats_key(&resp.oracle);
            remaining_accounts.push(anchor_client::solana_sdk::instruction::AccountMeta::new(stats_key.to_bytes().into(), false));
        }
        let mut submit_ix = Instruction {
            program_id: get_switchboard_on_demand_program_id(),
            data: PullFeedSubmitResponseParams { slot, submissions }.data(),
            accounts: PullFeedSubmitResponse {
                feed: params.feed,
                queue: params.queue,
                program_state: State::key(),
                recent_slothashes: crate::solana_sdk::sysvar::slot_hashes::ID.to_bytes().into(),
                payer: params.payer,
                system_program: SYSTEM_PROGRAM_ID,
                reward_vault: get_associated_token_address(&params.queue, &NATIVE_MINT),
                token_program: *SPL_TOKEN_PROGRAM_ID,
                token_mint: *NATIVE_MINT,
            }
            .to_account_metas(None)
            .into_iter()
            .map(|meta| anchor_client::solana_sdk::instruction::AccountMeta {
                pubkey: meta.pubkey.to_bytes().into(),
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            })
            .collect(),
        };
        submit_ix.accounts.extend(remaining_accounts);
        Ok(submit_ix)
    }

    pub async fn fetch_update_ix(
        context: Arc<SbContext>,
        client: &RpcClient,
        params: FetchUpdateParams,
    ) -> Result<
        (
            Instruction,
            Vec<OracleResponse>,
            usize,
            Vec<AddressLookupTableAccount>,
        ),
        AnyhowError,
    > {
        let latest_slot = SlotHashSysvar::get_latest_slothash(client)
            .await
            .context("PullFeed.fetchUpdateIx: Failed to fetch latest slot")?;

        let feed_data = *context
            .pull_feed_cache
            .entry(params.feed)
            .or_insert_with(OnceCell::new)
            .get_or_try_init(|| PullFeed::load_data(client, &params.feed))
            .await?;

        let feed_hash = feed_data.feed_hash;
        let jobs = context
            .job_cache
            .entry(feed_hash)
            .or_insert_with(OnceCell::new)
            .get_or_try_init(|| {
                let crossbar = params.crossbar.clone().unwrap_or_default();
                async move {
                    let jobs_data = crossbar
                        .fetch(&hex::encode(feed_hash))
                        .await
                        .context("PullFeed.fetchUpdateIx: Failed to fetch jobs")?;

                    let jobs: Vec<OracleJob> =
                        serde_json::from_value(jobs_data.get("jobs").unwrap().clone())
                            .context("PullFeed.fetchUpdateIx: Failed to deserialize jobs")?;

                    Ok::<Vec<OracleJob>, AnyhowError>(jobs)
                }
            })
            .await?
            .clone();

        let encoded_jobs = encode_jobs(&jobs);
        let gateway = params.gateway;

        let num_signatures = if params.num_signatures.is_none() {
            (feed_data.min_sample_size as f64 + ((feed_data.min_sample_size as f64) / 3.0).ceil())
                as u32
        } else {
            params.num_signatures.unwrap()
        };

        let price_signatures = gateway
            .fetch_signatures_from_encoded(FetchSignaturesParams {
                recent_hash: Some(bs58::encode(latest_slot.hash).into_string()),
                encoded_jobs: encoded_jobs.clone(),
                num_signatures,
                max_variance: Some((feed_data.max_variance / 1_000_000_000) as u32),
                min_responses: Some(feed_data.min_responses),
                use_timestamp: Some(false),
            })
            .await
            .context("PullFeed.fetchUpdateIx: Failed to fetch signatures")?;

        let mut num_successes = 0;
        let oracle_responses: Vec<OracleResponse> = price_signatures
            .responses
            .iter()
            .map(|x| {
                let value = x.success_value.parse::<i128>().ok();
                let mut formatted_value = None;
                if let Some(val) = value {
                    num_successes += 1;
                    formatted_value = Some(Decimal::from_i128_with_scale(val, 18));
                }
                OracleResponse {
                    value: formatted_value,
                    error: x.failure_error.clone(),
                    oracle: Pubkey::new_from_array(
                        hex::decode(x.oracle_pubkey.clone())
                            .unwrap()
                            .try_into()
                            .unwrap(),
                    ),
                    recovery_id: x.recovery_id as u8,
                    signature: base64
                        .decode(x.signature.clone())
                        .unwrap_or_default()
                        .try_into()
                        .unwrap_or([0; 64]),
                }
            })
            .collect();

        if params.debug.unwrap_or(false) {
            println!("priceSignatures: {:?}", price_signatures);
        }

        if num_successes == 0 {
            return Err(anyhow::Error::msg(
                "PullFeed.fetchUpdateIx Failure: No successful responses".to_string(),
            ));
        }

        let submit_signatures_ix = PullFeed::get_solana_submit_signatures_ix(
            latest_slot.slot,
            oracle_responses.clone(),
            SolanaSubmitSignaturesParams {
                feed: params.feed,
                queue: feed_data.queue,
                payer: params.payer,
            },
        )
        .context("PullFeed.fetchUpdateIx: Failed to create submit signatures instruction")?;

        let oracle_keys: Vec<Pubkey> = oracle_responses.iter().map(|x| x.oracle).collect();
        let feed_key = [params.feed];
        let queue_key = [feed_data.queue];

        let (oracle_luts, pull_feed_lut, queue_lut) = join!(
            fetch_and_cache_luts::<OracleAccountData>(client, context.clone(), &oracle_keys),
            fetch_and_cache_luts::<PullFeedAccountData>(client, context.clone(), &feed_key),
            fetch_and_cache_luts::<QueueAccountData>(client, context.clone(), &queue_key)
        );
        let oracle_luts = oracle_luts?;
        let pull_feed_lut = pull_feed_lut?;
        let queue_lut = queue_lut?;

        let mut luts = oracle_luts;
        luts.extend(pull_feed_lut);
        luts.extend(queue_lut);

        Ok((submit_signatures_ix, oracle_responses, num_successes, luts))
    }

    /// Fetch the oracle responses for multiple feeds via the consensus endpoint,
    /// build the necessary secp256k1 verification instruction and the feed update instruction,
    /// and return these instructions along with the required lookup tables.
    ///
    /// # Arguments
    /// * `context` - Shared context holding caches for feeds, jobs, and lookup tables.
    /// * `client` - The RPC client for connecting to the cluster.
    /// * `params` - Parameters for fetching updates, including:
    ///     - `feeds`: A vector of feed public keys.
    ///     - `payer`: The payer public key.
    ///     - `gateway`: A Gateway instance for the API calls.
    ///     - `crossbar`: Optional CrossbarClient instance.
    ///     - `num_signatures`: Optional override for the number of signatures to fetch.
    ///     - `debug`: Optional flag to print debug logs.
    ///
    /// # Returns
    /// A tuple containing:
    ///   1. A vector of two Instructions (first is secp256k1 verification, second is the feed update).
    ///   2. A vector of AddressLookupTableAccount to include in the transaction.
    pub async fn fetch_update_consensus_ix(
        context: Arc<SbContext>,
        client: &RpcClient,
        params: FetchUpdateManyParams,
    ) -> Result<(Vec<Instruction>, Vec<AddressLookupTableAccount>), AnyhowError> {
        let gateway = params.gateway;
        let mut num_signatures = params.num_signatures.unwrap_or(1);
        let mut feed_configs = Vec::new();
        let mut queue = Pubkey::default();
        let mut feed_datas = Vec::new();
        // For each feed, load its on-chain data and build its configuration (jobs, encoded jobs, etc.)
        for feed in &params.feeds {
            let data = *context
                .pull_feed_cache
                .entry(*feed)
                .or_insert_with(OnceCell::new)
                .get_or_try_init(|| PullFeed::load_data(client, feed))
                .await?;
            feed_datas.push((feed, data));
            let num_sig_lower_bound =
                data.min_sample_size as u32 + ((data.min_sample_size as f64) / 3.0).ceil() as u32;
            if num_signatures < num_sig_lower_bound {
                num_signatures = num_sig_lower_bound;
            }
            queue = data.queue;
            // Fetch jobs from the crossbar (or use cache) and encode them.
            let jobs = context
                .job_cache
                .entry(data.feed_hash)
                .or_insert_with(OnceCell::new)
                .get_or_try_init(|| {
                    let crossbar = params.crossbar.clone().unwrap_or_default();
                    async move {
                        let jobs_data = crossbar
                            .fetch(&hex::encode(data.feed_hash))
                            .await
                            .context("PullFeed.fetchUpdateIx: Failed to fetch jobs")?;

                        let jobs: Vec<OracleJob> =
                            serde_json::from_value(jobs_data.get("jobs").unwrap().clone())
                                .context("PullFeed.fetchUpdateIx: Failed to deserialize jobs")?;

                        Ok::<Vec<OracleJob>, AnyhowError>(jobs)
                    }
                })
                .await?
                .clone();
            let encoded_jobs = encode_jobs(&jobs);
            let max_variance = (data.max_variance / 1_000_000_000) as u32;
            let min_responses = data.min_responses;
            // Build the feed configuration required by the gateway.
            feed_configs.push(FeedConfig {
                encoded_jobs,
                max_variance: Some(max_variance),
                min_responses: Some(min_responses),
            });
        }

        // Get the latest slot.
        let latest_slot = SlotHashSysvar::get_latest_slothash(client)
            .await
            .context("PullFeed.fetchUpdateIx: Failed to fetch latest slot")?;

        // Call the gateway consensus endpoint and fetch signatures
        let price_signatures = gateway
            .fetch_signatures_consensus(FetchSignaturesConsensusParams {
                recent_hash: Some(bs58::encode(latest_slot.hash).into_string()),
                num_signatures: Some(num_signatures),
                feed_configs,
                use_timestamp: Some(false),
            })
            .await
            .context("PullFeed.fetchUpdateIx: fetch signatures consensus failure")?;
        if params.debug.unwrap_or(false) {
            println!("priceSignatures: {:?}", price_signatures);
        }

        // Parse the median responses into i128 values and build the consensus payload.
        let consensus_values: Vec<i128> = price_signatures
            .median_responses
            .iter()
            .map(|mr| mr.value.parse::<i128>().unwrap_or(i128::MAX))
            .collect();
        // Build the consensus Ix data.
        let consensus_ix_data = PullFeedSubmitResponseConsensusParams {
            slot: latest_slot.slot,
            values: consensus_values,
        };
        // Extract oracle keys from the gateway responses.
        let mut remaining_accounts = Vec::new();
        if price_signatures.oracle_responses.is_empty() {
            return Err(anyhow::Error::msg(
                "PullFeed.fetchUpdateConsensusIx Failure: No oracle responses".to_string(),
            ));
        }
        if price_signatures.median_responses.is_empty() {
            return Err(anyhow::Error::msg(
                "PullFeed.fetchUpdateConsensusIx Failure: No success responses found".to_string(),
            ));
        }
        let oracle_keys: Vec<Pubkey> = price_signatures
            .oracle_responses
            .iter()
            .map(|x| {
                Pubkey::new_from_array(
                    hex::decode(x.feed_responses.first().unwrap().oracle_pubkey.clone())
                        .unwrap_or_default()
                        .try_into()
                        .unwrap(),
                )
            })
            .collect();
        // Map the gateway oracle responses to our SecpSignature struct.
        let secp_signatures: Vec<SecpSignature> = price_signatures
            .oracle_responses
            .iter()
            .map(|oracle_response| SecpSignature {
                eth_address: hex::decode(&oracle_response.eth_address)
                    .unwrap()
                    .try_into()
                    .expect("slice with incorrect length"),
                signature: base64
                    .decode(&oracle_response.signature)
                    .unwrap()
                    .try_into()
                    .expect("slice with incorrect length"),
                message: base64
                    .decode(&oracle_response.checksum)
                    .unwrap()
                    .try_into()
                    .expect("slice with incorrect length"),
                recovery_id: oracle_response.recovery_id as u8,
            })
            .collect();

        // Build the secp256k1 instruction:
        let secp_ix = Secp256k1InstructionUtils::build_secp256k1_instruction(&secp_signatures, 0)
            .map_err(|_| {
            anyhow!("Feed failed to produce signatures: Failed to build secp256k1 instruction")
        })?;

        // Match each median response to its corresponding feed account by comparing feed hashes.
        let feed_pubkeys: Vec<Pubkey> = price_signatures
            .median_responses
            .iter()
            .map(|median_response| {
                let matching = feed_datas.iter().find(|(_, data)| {
                    let feed_hash_hex = hex::encode(data.feed_hash);
                    feed_hash_hex == median_response.feed_hash
                });
                if let Some((feed, _)) = matching {
                    **feed
                } else {
                    if params.debug.unwrap_or(false) {
                        eprintln!("Feed not found for hash: {}", median_response.feed_hash);
                    }
                    Pubkey::default()
                }
            })
            .collect();

        // Attach feed accounts and oracle accounts (plus their stats accounts) as remaining accounts.
        for feed in &feed_pubkeys {
            remaining_accounts.push(anchor_client::solana_sdk::instruction::AccountMeta::new(feed.to_bytes().into(), false));
        }
        for oracle in oracle_keys.iter() {
            remaining_accounts.push(anchor_client::solana_sdk::instruction::AccountMeta::new_readonly(oracle.to_bytes().into(), false));
            let stats_key = OracleAccountData::stats_key(oracle);
            remaining_accounts.push(anchor_client::solana_sdk::instruction::AccountMeta::new(stats_key.to_bytes().into(), false));
        }
        // Load lookup tables for oracle, feed, and queue accounts concurrently.
        let queue_key = [queue];
        let (oracle_luts_result, pull_feed_luts_result, queue_lut_result) = join!(
            fetch_and_cache_luts::<OracleAccountData>(client, context.clone(), &oracle_keys),
            fetch_and_cache_luts::<PullFeedAccountData>(client, context.clone(), &params.feeds),
            fetch_and_cache_luts::<QueueAccountData>(client, context.clone(), &queue_key)
        );

        // Handle the results after they are all awaited
        let oracle_luts = oracle_luts_result?;
        let pull_feed_luts = pull_feed_luts_result?;
        let queue_lut = queue_lut_result?;

        let mut luts = oracle_luts;
        luts.extend(pull_feed_luts);
        luts.extend(queue_lut);

        // Construct the instruction that updates the feed consensus using the consensus payload.
        let mut submit_ix = Instruction {
            program_id: get_switchboard_on_demand_program_id(),
            data: consensus_ix_data.data(),
            accounts: PullFeedSubmitResponseConsensus {
                queue,
                program_state: State::key(),
                recent_slothashes: crate::solana_sdk::sysvar::slot_hashes::ID.to_bytes().into(),
                payer: params.payer,
                system_program: SYSTEM_PROGRAM_ID,
                reward_vault: get_associated_token_address(&queue, &NATIVE_MINT),
                token_program: *SPL_TOKEN_PROGRAM_ID,
                token_mint: *NATIVE_MINT,
            }
            .to_account_metas(None)
            .into_iter()
            .map(|meta| anchor_client::solana_sdk::instruction::AccountMeta {
                pubkey: meta.pubkey.to_bytes().into(),
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            })
            .collect(),
        };
        submit_ix.accounts.extend(remaining_accounts);
        let ixs = vec![secp_ix, submit_ix];

        Ok((ixs, luts))
    }
}
