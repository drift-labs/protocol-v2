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
            multiple_operations as u8,
            PerpOperation::AmmFill
        ));
        assert!(PerpOperation::is_operation_paused(
            multiple_operations as u8,
            PerpOperation::SettlePnl
        ));
        assert!(!PerpOperation::is_operation_paused(
            multiple_operations as u8,
            PerpOperation::Fill
        ));
    }
}
