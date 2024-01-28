mod test {
    use crate::state::paused_operations::PausedOperations;

    #[test]
    fn test_is_operation_paused() {
        // Test each variant individually
        assert!(PausedOperations::is_operation_paused(
            0b00000001,
            PausedOperations::Funding
        ));
        assert!(PausedOperations::is_operation_paused(
            0b00000010,
            PausedOperations::AmmFills
        ));
        assert!(PausedOperations::is_operation_paused(
            0b00000100,
            PausedOperations::Fill
        ));
        assert!(PausedOperations::is_operation_paused(
            0b00001000,
            PausedOperations::Withdraw
        ));

        // Test combinations
        let all_operations = PausedOperations::Funding as u8
            | PausedOperations::AmmFills as u8
            | PausedOperations::Fill as u8
            | PausedOperations::Withdraw as u8;
        assert!(PausedOperations::is_operation_paused(
            all_operations,
            PausedOperations::Funding
        ));
        assert!(PausedOperations::is_operation_paused(
            all_operations,
            PausedOperations::AmmFills
        ));
        assert!(PausedOperations::is_operation_paused(
            all_operations,
            PausedOperations::Fill
        ));
        assert!(PausedOperations::is_operation_paused(
            all_operations,
            PausedOperations::Withdraw
        ));

        let no_operations = 0;
        assert!(!PausedOperations::is_operation_paused(
            no_operations,
            PausedOperations::Funding
        ));
        assert!(!PausedOperations::is_operation_paused(
            no_operations,
            PausedOperations::AmmFills
        ));
        assert!(!PausedOperations::is_operation_paused(
            no_operations,
            PausedOperations::Fill
        ));
        assert!(!PausedOperations::is_operation_paused(
            no_operations,
            PausedOperations::Withdraw
        ));

        // Test with multiple operations
        let multiple_operations =
            PausedOperations::AmmFills as u8 | PausedOperations::Withdraw as u8;
        assert!(PausedOperations::is_operation_paused(
            multiple_operations as u8,
            PausedOperations::AmmFills
        ));
        assert!(PausedOperations::is_operation_paused(
            multiple_operations as u8,
            PausedOperations::Withdraw
        ));
        assert!(!PausedOperations::is_operation_paused(
            multiple_operations as u8,
            PausedOperations::Fill
        ));
    }
}
