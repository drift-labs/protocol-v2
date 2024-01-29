mod test {
    use crate::state::paused_operations::PerpOperations;

    #[test]
    fn test_is_operation_paused() {
        // Test each variant individually
        assert!(PerpOperations::is_operation_paused(
            0b00000001,
            PerpOperations::UpdateFunding
        ));
        assert!(PerpOperations::is_operation_paused(
            0b00000010,
            PerpOperations::AmmFill
        ));
        assert!(PerpOperations::is_operation_paused(
            0b00000100,
            PerpOperations::Fill
        ));
        assert!(PerpOperations::is_operation_paused(
            0b00001000,
            PerpOperations::SettlePnl
        ));

        // Test combinations
        let all_operations = PerpOperations::UpdateFunding as u8
            | PerpOperations::AmmFill as u8
            | PerpOperations::Fill as u8
            | PerpOperations::SettlePnl as u8;
        assert!(PerpOperations::is_operation_paused(
            all_operations,
            PerpOperations::UpdateFunding
        ));
        assert!(PerpOperations::is_operation_paused(
            all_operations,
            PerpOperations::AmmFill
        ));
        assert!(PerpOperations::is_operation_paused(
            all_operations,
            PerpOperations::Fill
        ));
        assert!(PerpOperations::is_operation_paused(
            all_operations,
            PerpOperations::SettlePnl
        ));

        let no_operations = 0;
        assert!(!PerpOperations::is_operation_paused(
            no_operations,
            PerpOperations::UpdateFunding
        ));
        assert!(!PerpOperations::is_operation_paused(
            no_operations,
            PerpOperations::AmmFill
        ));
        assert!(!PerpOperations::is_operation_paused(
            no_operations,
            PerpOperations::Fill
        ));
        assert!(!PerpOperations::is_operation_paused(
            no_operations,
            PerpOperations::SettlePnl
        ));

        // Test with multiple operations
        let multiple_operations = PerpOperations::AmmFill as u8 | PerpOperations::SettlePnl as u8;
        assert!(PerpOperations::is_operation_paused(
            multiple_operations as u8,
            PerpOperations::AmmFill
        ));
        assert!(PerpOperations::is_operation_paused(
            multiple_operations as u8,
            PerpOperations::SettlePnl
        ));
        assert!(!PerpOperations::is_operation_paused(
            multiple_operations as u8,
            PerpOperations::Fill
        ));
    }
}
