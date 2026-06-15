mod size {
    use crate::state::events::OrderActionRecord;
    use crate::state::insurance_fund_stake::InsuranceFundStake;
    use crate::state::perp_market::PerpMarket;
    use crate::state::spot_market::SpotMarket;
    use crate::state::state::State;
    use crate::state::traits::Size;
    use crate::state::user::{User, UserStats};

    #[test]
    fn order_action_records() {
        let expected_size = std::mem::size_of::<OrderActionRecord>() + 8;
        let actual_size = OrderActionRecord::SIZE;
        assert_eq!(actual_size, expected_size);
    }

    #[test]
    fn perp_market() {
        let expected_size = std::mem::size_of::<PerpMarket>() + 8;
        let actual_size = PerpMarket::SIZE;
        assert_eq!(actual_size, expected_size);
    }

    #[test]
    fn spot_market() {
        let expected_size = std::mem::size_of::<SpotMarket>() + 8;
        let actual_size = SpotMarket::SIZE;
        assert_eq!(actual_size, expected_size);
    }

    #[test]
    fn state() {
        let expected_size = std::mem::size_of::<State>() + 8;
        let actual_size = State::SIZE;
        assert_eq!(actual_size, expected_size);
    }

    #[test]
    fn user() {
        let expected_size = std::mem::size_of::<User>() + 8;
        let actual_size = User::SIZE;
        assert_eq!(actual_size, expected_size);
    }

    #[test]
    fn user_stats() {
        let expected_size = std::mem::size_of::<UserStats>() + 8;
        let actual_size = UserStats::SIZE;
        assert_eq!(actual_size, expected_size);

        // `padding1` replaced the removed `if_staked_gov_token_amount: u64` plus the
        // 1 byte of repr(C) alignment padding that preceded it; offsets of the fields
        // around it must not move for existing on-chain accounts to stay valid.
        assert_eq!(std::mem::offset_of!(UserStats, padding1), 159);
        assert_eq!(std::mem::offset_of!(UserStats, delegate_permissions), 168);
    }

    #[test]
    fn insurance_fund_stake() {
        let expected_size = std::mem::size_of::<InsuranceFundStake>() + 8;
        let actual_size = InsuranceFundStake::SIZE;
        assert_eq!(actual_size, expected_size);
    }
}

/// Tests that the hardcoded byte offsets used by the two native (non-Anchor) instruction
/// handlers in `instructions/admin.rs` still match the actual struct layout.
///
/// # Why this matters
///
/// `handle_update_mm_oracle_native` and `handle_update_amm_spread_adjustment_native` bypass
/// Anchor's deserialization and write directly into account bytes at fixed offsets.  They must
/// be kept in sync with any struct changes:
///
/// * **PerpMarket / AMM** – zero-copy (`#[account(zero_copy)]`), so the on-chain bytes are the
///   raw `repr(C)` memory layout.  Use `std::mem::offset_of!(AMM, field) + 8` (discriminator).
///
/// * **State** – zero-copy (`#[account(zero_copy(unsafe))]` + `#[repr(C)]`), so the on-chain
///   bytes are the raw `repr(C)` memory layout. Use `std::mem::offset_of!(State, field) + 8`
///   (discriminator).
///
/// If either test fails after a struct change, update the corresponding literal in admin.rs AND
/// the expected value here together.
mod native_instruction_offsets {
    use crate::state::perp_market::{MarketStats, PerpMarket, AMM};
    use crate::state::state::State;

    const DISC: usize = 8; // Anchor 8-byte account discriminator

    /// Native handlers read/write PerpMarket bytes at fixed offsets — verify
    /// these match the actual struct layout. `mm_oracle_*` lives in
    /// `MarketStats`; `amm_spread_adjustment` lives in `AMM`.
    #[test]
    fn amm_zero_copy_offsets() {
        let amm_start = DISC + std::mem::offset_of!(PerpMarket, amm);
        let stats_start = DISC + std::mem::offset_of!(PerpMarket, market_stats);
        assert_eq!(
            stats_start + std::mem::offset_of!(MarketStats, mm_oracle_price),
            720,
            "mm_oracle_price offset changed — update handle_update_mm_oracle_native"
        );
        assert_eq!(
            stats_start + std::mem::offset_of!(MarketStats, mm_oracle_slot),
            728,
            "mm_oracle_slot offset changed — update handle_update_mm_oracle_native"
        );
        assert_eq!(
            stats_start + std::mem::offset_of!(MarketStats, mm_oracle_sequence_id),
            736,
            "mm_oracle_sequence_id offset changed — update handle_update_mm_oracle_native"
        );
        assert_eq!(
            amm_start + std::mem::offset_of!(AMM, amm_spread_adjustment),
            1202,
            "amm_spread_adjustment offset changed — update handle_update_amm_spread_adjustment_native"
        );
    }

    /// State is zero-copy with `#[repr(C)]`; on-chain bytes match `mem::offset_of!`.
    /// After folding the admin authority config into State (cold/warm/pause + 11 hot
    /// pubkeys at the top) and removing `lp_cooldown_time`, feature_bit_flags lives at
    /// byte 1406 (offset 1398 + 8 discriminator).
    #[test]
    fn state_feature_bit_flags_offset() {
        assert_eq!(
            std::mem::offset_of!(State, feature_bit_flags) + DISC,
            1406,
            "State::feature_bit_flags offset changed — update handle_update_mm_oracle_native"
        );
    }

    /// State.hot_mm_oracle_crank lives at byte 392..424 (after discriminator). The native
    /// mm-oracle handler reads it via raw byte indexing.
    #[test]
    fn state_hot_mm_oracle_crank_offset() {
        assert_eq!(
            std::mem::offset_of!(State, hot_mm_oracle_crank) + DISC,
            392,
            "State::hot_mm_oracle_crank offset changed — update handle_update_mm_oracle_native"
        );
    }

    /// State.hot_amm_spread_adjust lives at byte 424..456 (after discriminator).
    #[test]
    fn state_hot_amm_spread_adjust_offset() {
        assert_eq!(
            std::mem::offset_of!(State, hot_amm_spread_adjust) + DISC,
            424,
            "State::hot_amm_spread_adjust offset changed — update handle_update_amm_spread_adjustment_native"
        );
    }
}

mod market_index_offset {
    // PoolBalance padding was widened so sizeof(PoolBalance) == 32 on both
    // x86_64 and SBF.  Struct fields were reordered so all u128-containing
    // types appear before the PoolBalance fields, eliminating architecture-
    // specific alignment gaps.  MARKET_INDEX_OFFSET is now the same value on
    // both architectures and these tests can run everywhere.
    use crate::create_anchor_account_info;
    use crate::state::perp_market::PerpMarket;
    use crate::state::spot_market::SpotMarket;
    use crate::state::traits::MarketIndexOffset;
    use arrayref::array_ref;

    #[test]
    fn spot_market() {
        let mut spot_market = SpotMarket {
            market_index: 11,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);

        let data = spot_market_account_info.try_borrow_data().unwrap();
        let market_index =
            u16::from_le_bytes(*array_ref![data, SpotMarket::MARKET_INDEX_OFFSET, 2]);
        assert_eq!(market_index, spot_market.market_index);
    }

    #[test]
    fn perp_market() {
        let mut perp_market = PerpMarket {
            market_index: 11,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(perp_market, PerpMarket, perp_market_account_info);

        let data = perp_market_account_info.try_borrow_data().unwrap();
        let market_index =
            u16::from_le_bytes(*array_ref![data, PerpMarket::MARKET_INDEX_OFFSET, 2]);
        assert_eq!(market_index, perp_market.market_index);
    }
}
