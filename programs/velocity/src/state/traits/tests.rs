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

/// Guards the hardcoded `State` byte offsets read by the two native (non-Anchor)
/// instruction handlers (`handle_update_mm_oracle_native`,
/// `handle_update_amm_spread_adjustment_native`).
///
/// Those handlers run before Anchor and, after validating ownership +
/// discriminator (`auth::require_native_account`), read the State auth fields by
/// fixed offset rather than deserializing the whole account:
///
/// * `feature_bit_flags` (byte 1374) — MM-oracle kill switch
/// * `hot_mm_oracle_crank` (bytes 360..392) — MM-oracle signer
/// * `hot_amm_spread_adjust` (bytes 392..424) — spread-adjust signer
///
/// The `PerpMarket`/`AMM` offsets below are not read by raw index (the handlers
/// `bytemuck`-cast the account and use typed field access) but are asserted here
/// as layout invariants. `State` is `#[account(zero_copy(unsafe))]` + `repr(C)`;
/// use `std::mem::offset_of!(_, field) + 8` (discriminator). If any test fails
/// after a struct change, update the literal in the handler AND here together.
mod native_instruction_offsets {
    use crate::state::perp_market::{MarketStats, PerpMarket, AMM};
    use crate::state::state::State;

    const DISC: usize = 8; // Anchor 8-byte account discriminator

    #[test]
    fn amm_zero_copy_offsets() {
        let amm_start = DISC + std::mem::offset_of!(PerpMarket, amm);
        let stats_start = DISC + std::mem::offset_of!(PerpMarket, market_stats);
        assert_eq!(
            stats_start + std::mem::offset_of!(MarketStats, mm_oracle_price),
            800,
            "mm_oracle_price offset changed"
        );
        assert_eq!(
            stats_start + std::mem::offset_of!(MarketStats, mm_oracle_slot),
            808,
            "mm_oracle_slot offset changed"
        );
        assert_eq!(
            stats_start + std::mem::offset_of!(MarketStats, mm_oracle_sequence_id),
            816,
            "mm_oracle_sequence_id offset changed"
        );
        assert_eq!(
            std::mem::offset_of!(PerpMarket, fee_ledger) % 16,
            0,
            "fee_ledger must be 16-aligned (host/SBF layout parity)"
        );
        assert_eq!(
            amm_start + std::mem::offset_of!(AMM, amm_spread_adjustment),
            1282,
            "amm_spread_adjustment offset changed"
        );
    }

    /// State.feature_bit_flags is read at byte 1374 by the MM-oracle kill switch.
    #[test]
    fn state_feature_bit_flags_offset() {
        assert_eq!(
            std::mem::offset_of!(State, feature_bit_flags) + DISC,
            1374,
            "State::feature_bit_flags offset changed — update handle_update_mm_oracle_native"
        );
    }

    /// State.hot_mm_oracle_crank is read at bytes 360..392 by the MM-oracle handler.
    #[test]
    fn state_hot_mm_oracle_crank_offset() {
        assert_eq!(
            std::mem::offset_of!(State, hot_mm_oracle_crank) + DISC,
            360,
            "State::hot_mm_oracle_crank offset changed — update handle_update_mm_oracle_native"
        );
    }

    /// State.hot_amm_spread_adjust is read at bytes 392..424 by the spread handler.
    #[test]
    fn state_hot_amm_spread_adjust_offset() {
        assert_eq!(
            std::mem::offset_of!(State, hot_amm_spread_adjust) + DISC,
            392,
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
