pub mod pyth_program {
    use solana_program::declare_id;
    #[cfg(feature = "mainnet-beta")]
    declare_id!("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");
    #[cfg(not(feature = "mainnet-beta"))]
    declare_id!("gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s");
}

pub mod bonk_oracle {
    use solana_program::declare_id;
    #[cfg(feature = "mainnet-beta")]
    declare_id!("8ihFLu5FimgTQ1Unh4dVyEHUGodJ5gJQCrQf4KUVB9bN");
    #[cfg(not(feature = "mainnet-beta"))]
    declare_id!("6bquU99ktV1VRiHDr8gMhDFt3kMfhCQo5nfNrg2Urvsn");
}

pub mod pepe_oracle {
    use solana_program::declare_id;
    #[cfg(feature = "mainnet-beta")]
    declare_id!("FSfxunDmjjbDV2QxpyxFCAPKmYJHSLnLuvQXDLkMzLBm");
    #[cfg(not(feature = "mainnet-beta"))]
    declare_id!("Gz9RfgDeAFSsH7BHDGyNTgCik74rjNwsodJpsCizzmkj");
}

pub mod usdc_oracle {
    use solana_program::declare_id;
    #[cfg(feature = "mainnet-beta")]
    declare_id!("Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD");
    #[cfg(not(feature = "mainnet-beta"))]
    declare_id!("5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7");
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
