use solana_pubkey::Pubkey;

/// Derives the midprice account PDA address and bump seed.
///
/// Seeds: `["midprice", market_index(u16 LE), authority(32), subaccount_index(u16 LE)]`
///
/// * `program_id` - Midprice-pino program ID.
/// * `authority` - Maker authority pubkey.
/// * `market_index` - Drift perp market index.
/// * `subaccount_index` - Maker subaccount index.
pub fn midprice_pda(
    program_id: &Pubkey,
    authority: &Pubkey,
    market_index: u16,
    subaccount_index: u16,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"midprice",
            &market_index.to_le_bytes(),
            authority.as_ref(),
            &subaccount_index.to_le_bytes(),
        ],
        program_id,
    )
}

/// Derives the global PropAMM matcher PDA address and bump seed. Seeds: `["prop_amm_matcher"]`
pub fn prop_amm_matcher_pda(drift_program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"prop_amm_matcher"], drift_program_id)
}

/// Derives the Drift state PDA address and bump seed. Seeds: `["drift_state"]`
pub fn drift_state_pda(drift_program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"drift_state"], drift_program_id)
}

/// Derives the Drift User account PDA address and bump seed.
///
/// Seeds: `["user", authority(32), sub_account_id(u16 LE)]`
///
/// * `drift_program_id` - Deployed Drift program ID.
/// * `authority` - User's wallet authority.
/// * `sub_account_id` - Drift subaccount index.
pub fn user_pda(
    drift_program_id: &Pubkey,
    authority: &Pubkey,
    sub_account_id: u16,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"user", authority.as_ref(), &sub_account_id.to_le_bytes()],
        drift_program_id,
    )
}

/// Derives the Drift UserStats PDA address and bump seed.
///
/// Seeds: `["user_stats", authority(32)]`
///
/// * `drift_program_id` - Deployed Drift program ID.
/// * `authority` - User's wallet authority.
pub fn user_stats_pda(drift_program_id: &Pubkey, authority: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"user_stats", authority.as_ref()], drift_program_id)
}

/// Derives the Drift PerpMarket PDA address and bump seed.
///
/// Seeds: `["perp_market", market_index(u16 LE)]`
///
/// * `drift_program_id` - Deployed Drift program ID.
/// * `market_index` - Perp market index.
pub fn perp_market_pda(drift_program_id: &Pubkey, market_index: u16) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"perp_market", &market_index.to_le_bytes()],
        drift_program_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn midprice_pda_deterministic() {
        let program_id = crate::constants::MIDPRICE_PINO_PROGRAM_ID;
        let authority = Pubkey::new_unique();
        let (a, _) = midprice_pda(&program_id, &authority, 0, 0);
        let (b, _) = midprice_pda(&program_id, &authority, 0, 0);
        assert_eq!(a, b);
    }

    #[test]
    fn different_market_index_gives_different_pda() {
        let program_id = crate::constants::MIDPRICE_PINO_PROGRAM_ID;
        let authority = Pubkey::new_unique();
        let (a, _) = midprice_pda(&program_id, &authority, 0, 0);
        let (b, _) = midprice_pda(&program_id, &authority, 1, 0);
        assert_ne!(a, b);
    }

    #[test]
    fn prop_amm_matcher_pda_deterministic() {
        let drift = crate::constants::DRIFT_PROGRAM_ID;
        let (a, _) = prop_amm_matcher_pda(&drift);
        let (b, _) = prop_amm_matcher_pda(&drift);
        assert_eq!(a, b);
    }
}
