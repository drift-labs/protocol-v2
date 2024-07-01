use solana_program::program_pack::Pack;
use solana_program::pubkey::Pubkey;
use solana_program_test::BanksClient;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use spl_token::instruction;
use spl_token::state::Mint;

// initialize token, initialize ata and send amount to keypair's ata ...
pub async fn init_mint(
    banks_client: &mut BanksClient,
    keypair: &Keypair,
    decimals: u8,
    amount: u64,
) -> Pubkey {
    let mint_account = Keypair::new();
    let token_program = &spl_token::id();
    let rent = banks_client.get_rent().await.unwrap();
    let mint_rent = rent.minimum_balance(Mint::LEN);

    let token_mint_account_ix = solana_program::system_instruction::create_account(
        &keypair.pubkey(),
        &mint_account.pubkey(),
        mint_rent,
        Mint::LEN as u64,
        token_program,
    );

    let token_mint_ix = instruction::initialize_mint(
        token_program,
        &mint_account.pubkey(),
        &keypair.pubkey(),
        None,
        decimals,
    )
    .unwrap();
    let ata = spl_associated_token_account::get_associated_token_address(
        &keypair.pubkey(),
        &mint_account.pubkey(),
    );
    let ata_ix = spl_associated_token_account::instruction::create_associated_token_account(
        &keypair.pubkey(),
        &keypair.pubkey(),
        &mint_account.pubkey(),
        token_program,
    );
    let token_mint_to_ix = instruction::mint_to(
        token_program,
        &mint_account.pubkey(),
        &ata,
        &keypair.pubkey(),
        &vec![&keypair.pubkey(), &mint_account.pubkey()],
        amount,
    )
    .unwrap();

    let tx = Transaction::new_signed_with_payer(
        &[
            token_mint_account_ix,
            token_mint_ix,
            ata_ix,
            token_mint_to_ix,
        ],
        Some(&keypair.pubkey()),
        &[&keypair, &mint_account],
        banks_client.get_latest_blockhash().await.unwrap(),
    );
    banks_client.process_transaction(tx).await;
    return mint_account.pubkey();
}
