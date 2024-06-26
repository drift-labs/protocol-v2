use std::str::FromStr;
use anchor_lang::InstructionData;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::pubkey::Pubkey;
use solana_program_test::BanksClient;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use pyth::instruction::Initialize;

pub async fn initialize_pyth_oracle(banks_client: &mut BanksClient, keypair: &Keypair, args: Initialize) -> anyhow::Result<Pubkey> {
    let data = args.data();
    let len = 3312;
    let rent = banks_client.get_rent().await.unwrap().minimum_balance(len);
    let oracle_feed = Keypair::new();
    let create_account_ix = solana_sdk::system_instruction::create_account(
        &keypair.pubkey(),
        &oracle_feed.pubkey(),
        rent,
        len as u64,
        &Pubkey::from_str("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH").unwrap(),
    );
    let set_ix = Instruction{
        program_id: Pubkey::from_str("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH").unwrap(),
        accounts: vec![
            AccountMeta::new(oracle_feed.pubkey(), true),
        ],
        data,
    };
    let tx = Transaction::new_signed_with_payer(
        &[create_account_ix, set_ix],
        Some(&keypair.pubkey()),
        &[&keypair, &oracle_feed],
        banks_client.get_latest_blockhash().await.unwrap(),
    );
    banks_client.process_transaction(tx).await.unwrap();
    Ok(oracle_feed.pubkey())
}