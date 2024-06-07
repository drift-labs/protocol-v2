use std::str::FromStr;
use anchor_lang::AccountDeserialize;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_client::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;
use openbook_v2::{AnyNode, BookSide, LeafNode, LEAF_NODE_TAG, Market};

#[test]
pub fn market_test(){
    // SOL-USDC market
    let market = Pubkey::from_str("CFSMrBssNG8Ud1edW59jNLnq2cwrQ9uY5cM3wXmqRJj3").unwrap();
    let client = RpcClient::new("https://api.mainnet-beta.solana.com");
    let mut data = client.get_account_data(&market).unwrap();
    let market = Market::try_deserialize(&mut &data[..]).unwrap();
    // https://solscan.io/account/CFSMrBssNG8Ud1edW59jNLnq2cwrQ9uY5cM3wXmqRJj3#anchorData
    assert!(&market.market_quote_vault.to_string() == "EA3Qa1WUxuY2BZo6b2Dy3ZxGiK3qS5hkeSwbCzUNomBm");
    assert!(&market.market_authority.to_string() == "B44ts4KVwst9dYSYqGB5vY4Wee2KB3AK3e92yEdJzwrw");
    assert!(market.quote_decimals == 6);
    assert!(&market.asks.to_string() == "53v47CBoaKwoM8tSEDN4oNyCc2ZJenDeuhMJTEw7fL2M");
    assert!(&market.bids.to_string() == "Ad5skEiFoaeA27G3UhbpuwnFBCvmuuGEyoiijZhcd5xX");
    let market = bytemuck::try_from_bytes::<Market>(&data[8..]).unwrap();
    assert!(&market.market_quote_vault.to_string() == "EA3Qa1WUxuY2BZo6b2Dy3ZxGiK3qS5hkeSwbCzUNomBm");
    assert!(&market.market_authority.to_string() == "B44ts4KVwst9dYSYqGB5vY4Wee2KB3AK3e92yEdJzwrw");
    assert!(market.quote_decimals == 6);
    assert!(&market.asks.to_string() == "53v47CBoaKwoM8tSEDN4oNyCc2ZJenDeuhMJTEw7fL2M");
    assert!(&market.bids.to_string() == "Ad5skEiFoaeA27G3UhbpuwnFBCvmuuGEyoiijZhcd5xX");
}

#[test]
pub fn bid_and_ask_test(){
    // SOL-USDC market
    let market = Pubkey::from_str("CFSMrBssNG8Ud1edW59jNLnq2cwrQ9uY5cM3wXmqRJj3").unwrap();
    let client = RpcClient::new("https://api.mainnet-beta.solana.com");
    let mut data = client.get_account_data(&market).unwrap();
    let market = Market::try_deserialize(&mut &data[..]).unwrap();
    // https://solscan.io/account/CFSMrBssNG8Ud1edW59jNLnq2cwrQ9uY5cM3wXmqRJj3#anchorData
    let mut data = client.get_account_data(&market.bids).unwrap();
    let bookside = BookSide::try_deserialize(&mut &data[..]).unwrap();
    // let min = bookside.find_min();
    // let max = bookside.find_max();
    // println!("{:?} {:?}", min, max);
    println!("roots: {:?}", bookside.roots);
    for (idx, item) in bookside.nodes.nodes.iter().enumerate() {
        if item.tag == LEAF_NODE_TAG  {

            let leaf_node = LeafNode::try_from_slice(&item.try_to_vec().unwrap()).unwrap();
            let price = leaf_node.price_data();
            println!("idx: {} {} {} {} {}", idx, leaf_node.quantity, leaf_node.key, leaf_node.owner, price)
        }
    }
    let mut data = client.get_account_data(&market.asks).unwrap();
    let bookside = BookSide::try_deserialize(&mut &data[..]).unwrap();
    println!("");
    for item in bookside.nodes.nodes.iter() {
        if item.tag == LEAF_NODE_TAG  {

            let leaf_node = LeafNode::try_from_slice(&item.try_to_vec().unwrap()).unwrap();
            let price = leaf_node.price_data();
            println!("idx: {} {} {} {} ",leaf_node.quantity, leaf_node.key, leaf_node.owner, price)
        }
    }
    // let min = bookside.find_min();
    // let max = bookside.find_max();
    // println!("{:?} {:?}", min, max);
}