use anchor_lang::InstructionData;
use bytemuck::Zeroable;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::pubkey::Pubkey;
use solana_program::system_program;
use solana_program_test::BanksClient;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use openbook_v2_light::instruction::{CreateOpenOrdersIndexer, CreateOpenOrdersAccount};

pub async fn setup_open_orders_account(banks_client: &mut BanksClient,
                                        keypair: &Keypair,
                                        market: &Pubkey
) -> anyhow::Result<(Pubkey,Pubkey)> {
        let open_orders_indexer = Pubkey::find_program_address(
            &[b"OpenOrdersIndexer".as_ref(), keypair.pubkey().as_ref()],
            &openbook_v2_light::id(),
        ).0;
        let ooi_ix = Instruction {
            program_id: openbook_v2_light::id(),
            accounts: vec![
                AccountMeta::new(keypair.pubkey(), true),
                AccountMeta::new(keypair.pubkey(), false),
                AccountMeta::new(open_orders_indexer, false),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            data: CreateOpenOrdersIndexer {}.data(),
        };
    let num_ooa_accounts = 1_u32;
    let account = Pubkey::find_program_address(
        &[
            b"OpenOrders".as_ref(),
            keypair.pubkey().as_ref(),
            &num_ooa_accounts.to_le_bytes(),
        ],
        &openbook_v2_light::id(),
    ).0;

    let ooa_ix = Instruction {
        program_id: openbook_v2_light::id(),
        accounts: vec![
            AccountMeta::new(keypair.pubkey(), true),
            AccountMeta::new(keypair.pubkey(), false),
            AccountMeta::new_readonly(Pubkey::zeroed(), false),
            AccountMeta::new(open_orders_indexer, false),
            AccountMeta::new(account, false),
            AccountMeta::new_readonly(*market, false),
            AccountMeta::new_readonly(system_program::id(), false)],
        data: CreateOpenOrdersAccount { name: "Freddy".to_string() }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ooi_ix, ooa_ix],
        Some(&keypair.pubkey()),
        &[keypair],
        banks_client.get_latest_blockhash().await?,
    );
    banks_client.process_transaction(tx).await?;
    return Ok((account, open_orders_indexer))
}