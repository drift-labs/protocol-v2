use solana_program::pubkey::Pubkey;
use solana_program::rent::Rent;
use solana_program_test::ProgramTest;
use solana_sdk::account::Account;
use std::fs;
pub fn setup_programs(validator: &mut ProgramTest) -> anyhow::Result<()> {
    let path = get_paths();
    // add openbook v2
    add_program(
        validator,
        openbook_v2_light::id(),
        &format!("{}/tests/fixtures/openbook_v2.so", path),
    )?;
    // add drift
    add_program(
        validator,
        drift::id(),
        &format!("{}/target/deploy/drift.so", path),
    )?;
    // add pyth
    add_program(
        validator,
        pyth::id(),
        &format!("{}/target/deploy/pyth.so", path),
    )?;
    Ok(())
}

pub fn add_program(validator: &mut ProgramTest, id: Pubkey, path: &str) -> anyhow::Result<()> {
    let data = fs::read(path)?;
    validator.add_account(
        id,
        Account {
            lamports: Rent::default().minimum_balance(data.len()).max(1),
            data,
            owner: solana_sdk::bpf_loader::id(),
            executable: true,
            rent_epoch: 0,
        },
    );
    Ok(())
}

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
