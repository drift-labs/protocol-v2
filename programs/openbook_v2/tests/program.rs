use std::fs;
use solana_program::pubkey::Pubkey;
use solana_program::rent::Rent;
use solana_program_test::ProgramTest;
use solana_sdk::account::Account;
use crate::utils::get_paths;

pub fn setup_programs(validator: &mut ProgramTest) -> anyhow::Result<()>{
    let path = get_paths();
    // add openbook v2
    add_program(validator, openbook_v2_light::id(), &format!("{}/deps/openbook_v2.so", path))?;
    // add drift
    add_program(validator, drift::id(), &format!("{}/target/deploy/drift.so", path))?;
    // add pyth
    add_program(validator, pyth::id(), &format!("{}/target/deploy/pyth.so", path))?;
    Ok(())
}

pub fn add_program(validator: &mut ProgramTest, id: Pubkey, path: &str ) -> anyhow::Result<()> {
    let data = fs::read(path)?;
    validator.add_account(
        id,
        Account {
            lamports: Rent::default().minimum_balance(data.len()).max(1),
            data,
            owner: solana_sdk::bpf_loader::id(),
            executable: true,
            rent_epoch: 0,
        }
    );
    Ok(())
}