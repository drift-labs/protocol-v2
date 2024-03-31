use anchor_lang::prelude::*;

declare_id!("SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f");

#[program]
pub mod switchboard {

}

#[zero_copy(unsafe)]
#[repr(packed)]
#[derive(Default, Debug, Eq, PartialEq, AnchorDeserialize)]
pub struct SwitchboardDecimal {
    /// The part of a floating-point number that represents the significant digits of that number, and that is multiplied by the base, 10, raised to the power of scale to give the actual value of the number.
    pub mantissa: i128,
    /// The number of decimal places to move to the left to yield the actual value.
    pub scale: u32,
}

#[zero_copy(unsafe)]
#[repr(packed)]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct Hash {
    /// The bytes used to derive the hash.
    pub data: [u8; 32],
}

#[zero_copy(unsafe)]
#[repr(packed)]
#[derive(Default, PartialEq, Eq)]
pub struct AggregatorRound {
    /// Maintains the number of successful responses received from nodes.
    /// Nodes can submit one successful response per round.
    pub num_success: u32,
    /// Number of error responses.
    pub num_error: u32,
    /// Whether an update request round has ended.
    pub is_closed: bool,
    /// Maintains the `solana_program::clock::Slot` that the round was opened at.
    pub round_open_slot: u64,
    /// Maintains the `solana_program::clock::UnixTimestamp;` the round was opened at.
    pub round_open_timestamp: i64,
    /// Maintains the current median of all successful round responses.
    pub result: SwitchboardDecimal,
    /// Standard deviation of the accepted results in the round.
    pub std_deviation: SwitchboardDecimal,
    /// Maintains the minimum node response this round.
    pub min_response: SwitchboardDecimal,
    /// Maintains the maximum node response this round.
    pub max_response: SwitchboardDecimal,
    /// Pubkeys of the oracles fulfilling this round.
    pub oracle_pubkeys_data: [Pubkey; 16],
    /// Represents all successful node responses this round. `NaN` if empty.
    pub medians_data: [SwitchboardDecimal; 16],
    /// Current rewards/slashes oracles have received this round.
    pub current_payout: [i64; 16],
    /// Keep track of which responses are fulfilled here.
    pub medians_fulfilled: [bool; 16],
    /// Keeps track of which errors are fulfilled here.
    pub errors_fulfilled: [bool; 16],
}

#[derive(Copy, Clone, Debug, AnchorSerialize, AnchorDeserialize, Eq, PartialEq)]
#[repr(u8)]
pub enum AggregatorResolutionMode {
    ModeRoundResolution = 0,
    ModeSlidingResolution = 1,
}

#[account(zero_copy(unsafe))]
#[repr(packed)]
#[derive(PartialEq)]
pub struct AggregatorAccountData {
    /// Name of the aggregator to store on-chain.
    pub name: [u8; 32],
    /// Metadata of the aggregator to store on-chain.
    pub metadata: [u8; 128],
    /// Reserved.
    pub _reserved1: [u8; 32],
    /// Pubkey of the queue the aggregator belongs to.
    pub queue_pubkey: Pubkey,
    /// CONFIGS
    /// Number of oracles assigned to an update request.
    pub oracle_request_batch_size: u32,
    /// Minimum number of oracle responses required before a round is validated.
    pub min_oracle_results: u32,
    /// Minimum number of job results before an oracle accepts a result.
    pub min_job_results: u32,
    /// Minimum number of seconds required between aggregator rounds.
    pub min_update_delay_seconds: u32,
    /// Unix timestamp for which no feed update will occur before.
    pub start_after: i64,
    /// Change percentage required between a previous round and the current round. If variance percentage is not met, reject new oracle responses.
    pub variance_threshold: SwitchboardDecimal,
    /// Number of seconds for which, even if the variance threshold is not passed, accept new responses from oracles.
    pub force_report_period: i64,
    /// Timestamp when the feed is no longer needed.
    pub expiration: i64,
    //
    /// Counter for the number of consecutive failures before a feed is removed from a queue. If set to 0, failed feeds will remain on the queue.
    pub consecutive_failure_count: u64,
    /// Timestamp when the next update request will be available.
    pub next_allowed_update_time: i64,
    /// Flag for whether an aggregators configuration is locked for editing.
    pub is_locked: bool,
    /// Optional, public key of the crank the aggregator is currently using. Event based feeds do not need a crank.
    pub crank_pubkey: Pubkey,
    /// Latest confirmed update request result that has been accepted as valid.
    pub latest_confirmed_round: AggregatorRound,
    /// Oracle results from the current round of update request that has not been accepted as valid yet.
    pub current_round: AggregatorRound,
    /// List of public keys containing the job definitions for how data is sourced off-chain by oracles.
    pub job_pubkeys_data: [Pubkey; 16],
    /// Used to protect against malicious RPC nodes providing incorrect task definitions to oracles before fulfillment.
    pub job_hashes: [Hash; 16],
    /// Number of jobs assigned to an oracle.
    pub job_pubkeys_size: u32,
    /// Used to protect against malicious RPC nodes providing incorrect task definitions to oracles before fulfillment.
    pub jobs_checksum: [u8; 32],
    //
    /// The account delegated as the authority for making account changes.
    pub authority: Pubkey,
    /// Optional, public key of a history buffer account storing the last N accepted results and their timestamps.
    pub history_buffer: Pubkey,
    /// The previous confirmed round result.
    pub previous_confirmed_round_result: SwitchboardDecimal,
    /// The slot when the previous confirmed round was opened.
    pub previous_confirmed_round_slot: u64,
    /// 	Whether an aggregator is permitted to join a crank.
    pub disable_crank: bool,
    /// Job weights used for the weighted median of the aggregator's assigned job accounts.
    pub job_weights: [u8; 16],
    /// Unix timestamp when the feed was created.
    pub creation_timestamp: i64,
    /// Use sliding windoe or round based resolution
    /// NOTE: This changes result propogation in latest_round_result
    pub resolution_mode: AggregatorResolutionMode,
    /// Reserved for future info.
    pub _ebuf: [u8; 138],
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::prelude::{AccountLoader, Pubkey};
    use std::str::FromStr;

    fn create_account_info<'a>(
        key: &'a Pubkey,
        is_writable: bool,
        lamports: &'a mut u64,
        bytes: &'a mut [u8],
        owner: &'a Pubkey,
    ) -> AccountInfo<'a> {
        AccountInfo::new(key, false, is_writable, lamports, bytes, owner, false, 0)
    }

    #[test]
    fn load() {
        let aggregator_str = String::from("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");
        let mut decoded_bytes = base64::decode(aggregator_str).unwrap();
        let aggregator_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f").unwrap();
        let mut lamports = 0;
        let account_info = create_account_info(&key, true, &mut lamports, aggregator_bytes, &owner);

        let account_loader: AccountLoader<AggregatorAccountData> =
            AccountLoader::try_from(&account_info).unwrap();

        let aggregator = account_loader.load().unwrap();
        let price = &aggregator.latest_confirmed_round.result;
        println!("price {:?}", price);
    }
}
