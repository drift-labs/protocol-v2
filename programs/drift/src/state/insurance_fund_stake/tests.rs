mod transfer_config {
    use crate::state::insurance_fund_stake::ProtocolIfSharesTransferConfig;
    use solana_program::pubkey::Pubkey;

    #[test]
    fn validate_signer() {
        let mut config = ProtocolIfSharesTransferConfig::default();

        let signer = Pubkey::new_unique();

        assert!(config.validate_signer(&signer).is_err());

        let signer = Pubkey::default();

        assert!(config.validate_signer(&signer).is_err());

        let signer = Pubkey::new_unique();
        config.whitelisted_signers[0] = signer;

        assert!(config.validate_signer(&signer).is_ok());
    }
}
