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
    declare_id!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
}

pub mod bonk_oracle {
    use solana_program::declare_id;
    #[cfg(feature = "mainnet-beta")]
    declare_id!("8ihFLu5FimgTQ1Unh4dVyEHUGodJ5gJQCrQf4KUVB9bN");
    #[cfg(not(feature = "mainnet-beta"))]
    declare_id!("6bquU99ktV1VRiHDr8gMhDFt3kMfhCQo5nfNrg2Urvsn");
}

pub mod bonk_pull_oracle {
    use solana_program::declare_id;
    declare_id!("GojbSnJuPdKDT1ZuHuAM5t9oz6bxTo1xhUKpTua2F72p");
}

pub mod pepe_oracle {
    use solana_program::declare_id;
    #[cfg(feature = "mainnet-beta")]
    declare_id!("FSfxunDmjjbDV2QxpyxFCAPKmYJHSLnLuvQXDLkMzLBm");
    #[cfg(not(feature = "mainnet-beta"))]
    declare_id!("Gz9RfgDeAFSsH7BHDGyNTgCik74rjNwsodJpsCizzmkj");
}

pub mod pepe_pull_oracle {
    use solana_program::declare_id;
    declare_id!("CLxofhtzvLiErpn25wvUzpZXEqBhuZ6WMEckEraxyuGt");
}

pub mod wen_oracle {
    use solana_program::declare_id;
    #[cfg(feature = "mainnet-beta")]
    declare_id!("6Uo93N83iF5U9KwC8eQpogx4XptMT4wSKfje7hB1Ufko");
    #[cfg(not(feature = "mainnet-beta"))]
    declare_id!("HuobqtT6QaJ8napVARKRxqZN33NqYzQJKLTKKrGy8Bvo");
}

pub mod wen_pull_oracle {
    use solana_program::declare_id;
    declare_id!("F47c7aJgYkfKXQ9gzrJaEpsNwUKHprysregTWXrtYLFp");
}

pub mod usdc_oracle {
    use solana_program::declare_id;
    #[cfg(feature = "mainnet-beta")]
    declare_id!("Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD");
    #[cfg(not(feature = "mainnet-beta"))]
    declare_id!("5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7");
}

pub mod usdc_pull_oracle {
    use solana_program::declare_id;
    declare_id!("En8hkHLkRe9d9DraYmBTrus518BvmVH448YcvmrFM6Ce");
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

pub mod usdt_oracle {
    use solana_program::declare_id;
    declare_id!("3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxQmBGCkyqEEefL");
}

pub mod usdt_pull_oracle {
    use solana_program::declare_id;
    declare_id!("BekJ3P5G3iFeC97sXHuKnUHofCFj9Sbo7uyF2fkKwvit");
}

pub mod fuel_airdrop_wallet {
    use solana_program::declare_id;
    declare_id!("5hMjmxexWu954pX9gB9jkHxMqdjpxArQS2XdvkaevRax");
}
