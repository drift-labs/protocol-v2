use std::str::FromStr;

use anchor_client::solana_client::rpc_filter::RpcFilterType;
use anchor_client::solana_client::rpc_filter::{Memcmp, MemcmpEncodedBytes};
use anchor_client::solana_sdk::bs58;
use anchor_client::solana_sdk::signer::Signer;
use anchor_client::ProgramAccountsIterator;

use anchor_client::anchor_lang::{AccountDeserialize, AnchorDeserialize, AnchorSerialize};
use anchor_lang::Discriminator;

use anchor_lang::prelude::Pubkey;
// use anchor_client::solana_sdk::{signature::read_keypair_file, signer::Signer};
use drift_sdk::drift_client::DriftClient;
use drift_sdk::utils::read_keypair_file_multi_format;

use drift::state::perp_market::PerpMarket;

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<(), anchor_client::ClientError> {
    let keypair_path =
        // "/path/to/keypair.json";
        "/Users/ww/.config/solana/mine/taytayopCMREJjXAAJP7GTFkqi55sDtNXAnBfPAvtU3.json";

    let keypair = read_keypair_file_multi_format(keypair_path).unwrap();

    println!("keypairl loaded: {:?}", keypair.pubkey().to_string());

    let drift_client = DriftClient::builder()
        .signing_authority(keypair)
        // .rpc_http_url("https://custom.rpc.url".to_string()) // set custom rpc url
        .rpc_http_url("http://drift-cranking.rpcpool.com/f1ead98714b94a67f82203cce918".to_string())
        // .rpc_http_url("http://localhost:3333".to_string())
        // .rpc_ws_url("ws://drift-cranking.rpcpool.com/f1ead98714b94a67f82203cce918".to_string())
        .build()
        .unwrap();

    match drift_client.rpc_client.get_slot() {
        Ok(slot) => println!("Current slot: {:?}", slot),
        Err(err) => println!("Error: {:?}", err),
    }

    println!("rpc http url: {:?}", drift_client.cluster.url());
    println!("rpc ws url: {:?}", drift_client.cluster.ws_url());

    println!("discriminator: {:?}", PerpMarket::discriminator().to_vec());
    // conver tbytes to base58 encoding
    println!(
        "discriminator b58: {:?}",
        bs58::encode(PerpMarket::discriminator().to_vec()).into_string()
    );

    // let acc = drit_client.program.account::<PerpMarket>(Pubkey::from_str("53xRgYi7591y8TKSqRbC2AMzXJF7ZLLTms6t2XKuigUp").unwrap())?;
    // println!("account: {:?}", acc);

    // let mut deserialized = Vec::<PerpMarket>::new();
    let mut markets_count = 0;
    for perp_market in drift_client.program.accounts_lazy::<PerpMarket>(vec![])? {
        // deserialized.push(perp_market?.1);
        match perp_market {
            Ok((pubkey, perp_market)) => {
                println!(
                    "Loaded {:?}: {:?}",
                    pubkey.to_string(),
                    String::from_utf8_lossy(&perp_market.name)
                );
            }
            Err(err) => println!("Error: {:?}", err),
        }
        markets_count += 1;
    }
    println!("size of markets: {:?}", markets_count);
    Ok(())
}
