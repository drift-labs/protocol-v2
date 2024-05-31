mod test {
    use crate::error::ErrorCode;
    use crate::SettlePnlMode;

    #[test]
    fn test_must_settle_returns_err() {
        let mode = SettlePnlMode::MustSettle;
        let result = mode.result(ErrorCode::DefaultError, "Must settle error");
        assert_eq!(result, Err(ErrorCode::DefaultError));
    }

    #[test]
    fn test_try_settle_returns_ok() {
        let mode = SettlePnlMode::TrySettle;
        let result = mode.result(ErrorCode::DefaultError, "Try settle error");
        assert_eq!(result, Ok(()));
    }
}
