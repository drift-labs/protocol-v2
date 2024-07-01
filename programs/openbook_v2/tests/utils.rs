use solana_program::instruction::Instruction;
use solana_program::pubkey::Pubkey;
use solana_program_test::BanksClient;
use solana_sdk::transaction::Transaction;
use solana_sdk::{signature::Keypair, signer::Signer};
use std::ffi::OsStr;

// trying to find direction to protocol-v2
pub fn get_paths() -> String {
    let mut path_buf = std::env::current_dir().unwrap();
    loop {
        let option_path = path_buf.iter().last();
        match option_path {
            None => {
                panic!("not found directory protocol-v2 in current working directory");
            }
            Some(path) => {
                if path.to_str().unwrap().contains("protocol-v2") {
                    return path_buf.to_str().unwrap().to_string();
                } else {
                    path_buf = path_buf.parent().unwrap().to_path_buf();
                }
            }
        }
    }
}

pub async fn create_account_for_type<T>(
    banks_client: &mut BanksClient,
    keypair: &Keypair,
) -> Pubkey {
    let key = Keypair::new();
    let len = 8 + std::mem::size_of::<T>();
    let rent = banks_client.get_rent().await.unwrap().minimum_balance(len);
    let create_account_instr = solana_sdk::system_instruction::create_account(
        &keypair.pubkey(),
        &key.pubkey(),
        rent,
        len as u64,
        &openbook_v2_light::id(),
    );
    let tx = Transaction::new_signed_with_payer(
        &[create_account_instr],
        Some(&keypair.pubkey()),
        &[&keypair, &key],
        banks_client.get_latest_blockhash().await.unwrap(),
    );
    banks_client.process_transaction(tx).await;
    key.pubkey()
}

pub async fn process(
    banks_client: &mut BanksClient,
    ixs: Vec<Instruction>,
    payer: &Pubkey,
    signers: &Vec<&Keypair>,
) -> anyhow::Result<()> {
    let tx = Transaction::new_signed_with_payer(
        &ixs,
        Some(&payer),
        &signers[..],
        banks_client.get_latest_blockhash().await.unwrap(),
    );
    banks_client.process_transaction(tx).await?;
    Ok(())
}
