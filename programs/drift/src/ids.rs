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
    declare_id!("5hMjmxexWu954pX9gB9jkHxMqdjpxArQS2XdvkaevRax");
}

pub mod swift_server {
    use solana_program::declare_id;
    #[cfg(not(feature = "anchor-test"))]
    declare_id!("SW1fThqrxLzVprnCMpiybiqYQfoNCdduC5uWsSUKChS");
    #[cfg(feature = "anchor-test")]
    declare_id!("DpaEdAPW3ZX67fnczT14AoX12Lx9VMkxvtT81nCHy3Nv");
}
