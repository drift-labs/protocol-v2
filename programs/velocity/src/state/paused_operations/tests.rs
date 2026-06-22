mod test {
    use crate::state::paused_operations::PerpOperation;

    #[test]
    fn test_is_operation_paused() {
        // Test each variant individually
        assert!(PerpOperation::is_operation_paused(
            0b00000001,
            PerpOperation::UpdateFunding
        ));
        assert!(PerpOperation::is_operation_paused(
            0b00000010,
            PerpOperation::AmmFill
        ));
        assert!(PerpOperation::is_operation_paused(
            0b00000100,
            PerpOperation::Fill
        ));
        assert!(PerpOperation::is_operation_paused(
            0b00001000,
            PerpOperation::SettlePnl
        ));

        // Test combinations
        let all_operations = PerpOperation::UpdateFunding as u8
            | PerpOperation::AmmFill as u8
            | PerpOperation::Fill as u8
            | PerpOperation::SettlePnl as u8;
        assert!(PerpOperation::is_operation_paused(
            all_operations,
            PerpOperation::UpdateFunding
        ));
        assert!(PerpOperation::is_operation_paused(
            all_operations,
            PerpOperation::AmmFill
        ));
        assert!(PerpOperation::is_operation_paused(
            all_operations,
            PerpOperation::Fill
        ));
        assert!(PerpOperation::is_operation_paused(
            all_operations,
            PerpOperation::SettlePnl
        ));

        let no_operations = 0;
        assert!(!PerpOperation::is_operation_paused(
            no_operations,
            PerpOperation::UpdateFunding
        ));
        assert!(!PerpOperation::is_operation_paused(
            no_operations,
            PerpOperation::AmmFill
        ));
        assert!(!PerpOperation::is_operation_paused(
            no_operations,
            PerpOperation::Fill
        ));
        assert!(!PerpOperation::is_operation_paused(
            no_operations,
            PerpOperation::SettlePnl
        ));

        // Test with multiple operations
        let multiple_operations = PerpOperation::AmmFill as u8 | PerpOperation::SettlePnl as u8;
        assert!(PerpOperation::is_operation_paused(
            multiple_operations,
            PerpOperation::AmmFill
        ));
        assert!(PerpOperation::is_operation_paused(
            multiple_operations,
            PerpOperation::SettlePnl
        ));
        assert!(!PerpOperation::is_operation_paused(
            multiple_operations,
            PerpOperation::Fill
        ));
    }

    #[test]
    fn test_is_warm_update_allowed() {
        let funding = PerpOperation::UpdateFunding as u8;
        let rev_pool = PerpOperation::SettleRevPool as u8;
        let liq = PerpOperation::Liquidation as u8;
        let fill = PerpOperation::Fill as u8;

        // No change at all is always fine.
        assert!(PerpOperation::is_warm_update_allowed(0, 0));
        assert!(PerpOperation::is_warm_update_allowed(liq, liq));

        // Flipping only warm-editable bits, from an empty mask.
        assert!(PerpOperation::is_warm_update_allowed(0, funding));
        assert!(PerpOperation::is_warm_update_allowed(0, rev_pool));
        assert!(PerpOperation::is_warm_update_allowed(0, funding | rev_pool));

        // Toggling a warm bit while preserving a reserved bit is allowed:
        // add funding on top of an existing Liquidation pause...
        assert!(PerpOperation::is_warm_update_allowed(liq, liq | funding));
        // ...and clear funding again, still preserving Liquidation.
        assert!(PerpOperation::is_warm_update_allowed(liq | funding, liq));

        // Touching a reserved bit is rejected, regardless of warm bits.
        // Clearing Liquidation (the original bug: whole-mask replace).
        assert!(!PerpOperation::is_warm_update_allowed(liq, funding));
        // Adding a reserved bit warm doesn't own.
        assert!(!PerpOperation::is_warm_update_allowed(0, fill));
        // Even a correct warm toggle is rejected if a reserved bit also moves.
        assert!(!PerpOperation::is_warm_update_allowed(liq, fill | funding));

        // The mask is exactly the two intended bits, nothing else.
        assert_eq!(PerpOperation::WARM_EDITABLE, funding | rev_pool);
    }
}
