pub mod pyth_program {
    use solana_program::declare_id;
    #[cfg(feature = "mainnet-beta")]
    declare_id!("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");
    #[cfg(not(feature = "mainnet-beta"))]
    declare_id!("gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s");
}

pub mod wormhole_program {
    use solana_program::declare_id;
    declare_id!("HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ");
}

pub mod drift_oracle_receiver_program {
    use solana_program::declare_id;
    declare_id!("G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha");
}

pub mod pyth_lazer_program {
    use solana_program::declare_id;
    declare_id!("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
}

pub mod switchboard_program {
    use solana_program::declare_id;
    declare_id!("SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f");
}

pub mod switchboard_on_demand {
    use solana_program::declare_id;
    #[cfg(feature = "mainnet-beta")]
    declare_id!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
    #[cfg(not(feature = "mainnet-beta"))]
    declare_id!("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");
}

pub mod serum_program {
    use solana_program::declare_id;
    #[cfg(feature = "mainnet-beta")]
    declare_id!("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");
    #[cfg(not(feature = "mainnet-beta"))]
    declare_id!("DESVgJVGajEgKGXhb6XmqDHGz3VjdgP7rEVESBgxmroY");
}

pub mod srm_mint {
    use solana_program::declare_id;
    declare_id!("SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt");
}

pub mod msrm_mint {
    use solana_program::declare_id;
    declare_id!("MSRMcoVyrFxnSgo5uXwone5SKcGhT1KEJMFEkMEWf9L");
}

pub mod jupiter_mainnet_6 {
    use solana_program::declare_id;
    declare_id!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
}
pub mod jupiter_mainnet_4 {
    use solana_program::declare_id;
    declare_id!("JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB");
}
pub mod jupiter_mainnet_3 {
    use solana_program::declare_id;
    declare_id!("JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph");
}

pub mod marinade_mainnet {
    use solana_program::declare_id;
    declare_id!("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
}

pub mod admin_hot_wallet {
    use solana_program::declare_id;
    #[cfg(not(feature = "anchor-test"))]
    declare_id!("5hMjmxexWu954pX9gB9jkHxMqdjpxArQS2XdvkaevRax");
    #[cfg(feature = "anchor-test")]
    declare_id!("1ucYHAGrBbi1PaecC4Ptq5ocZLWGLBmbGWysoDGNB1N");
}

pub mod if_rebalance_wallet {
    use solana_program::declare_id;
    declare_id!("BuynBZjr5yiZCFpXngFQ31BAwechmFE1Ab6vNP3f5PTt");
}

pub mod lighthouse {
    use solana_program::declare_id;
    declare_id!("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
}

pub mod mm_oracle_crank_wallet {
    use solana_program::declare_id;
    #[cfg(not(feature = "anchor-test"))]
    #[cfg(feature = "mainnet-beta")]
    declare_id!("uZ1N4C9dc71Euu4GLYt5UURpFtg1WWSwo3F4Rn46Fr3");
    #[cfg(not(feature = "anchor-test"))]
    #[cfg(not(feature = "mainnet-beta"))]
    declare_id!("8X35rQUK2u9hfn8rMPwwr6ZSEUhbmfDPEapp589XyoM1");
    #[cfg(feature = "anchor-test")]
    declare_id!("1ucYHAGrBbi1PaecC4Ptq5ocZLWGLBmbGWysoDGNB1N");
}

pub mod amm_spread_adjust_wallet {
    use solana_program::declare_id;
    #[cfg(not(feature = "anchor-test"))]
    declare_id!("w1DrTeayRMutAiwzfJfK9zLcpkF7RzwPy1BLCgQA1aF");
    #[cfg(feature = "anchor-test")]
    declare_id!("1ucYHAGrBbi1PaecC4Ptq5ocZLWGLBmbGWysoDGNB1N");
}

pub mod dflow_mainnet_aggregator_4 {
    use solana_program::declare_id;
    declare_id!("DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH");
}

pub mod titan_mainnet_argos_v1 {
    use solana_program::declare_id;
    declare_id!("T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT");
}
