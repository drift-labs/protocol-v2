use anchor_lang::{InstructionData, Key};
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::pubkey::Pubkey;
use solana_program::system_program;
use solana_program_test::BanksClient;
use solana_sdk::{signature::Keypair, signer::Signer};
use solana_sdk::transaction::Transaction;
use drift::instruction::{Deposit, Initialize, InitializeSpotMarket};
use drift::state::oracle::OracleSource;
use drift::state::order_params::OrderParams;
use drift::state::spot_market::AssetTier;

pub async fn initialize_drift(banks_client: &mut BanksClient, keypair: &Keypair, quote_mint: &Pubkey) -> anyhow::Result<(Pubkey,Pubkey)>{
    let state = Pubkey::find_program_address(&[b"drift_state".as_ref(),], &drift::id()).0;
    let drift_signer = Pubkey::find_program_address(&[b"drift_signer".as_ref(),], &drift::id()).0;

    let init_data = Initialize{}.data();
    let initialize_ix = Instruction{
        program_id: drift::id(),
        accounts: vec![
            AccountMeta::new(keypair.pubkey(), true),
            AccountMeta::new(state, false),
            AccountMeta::new_readonly(*quote_mint, false),
            AccountMeta::new_readonly(drift_signer, false),
            AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data: init_data,
    };
    let tx = Transaction::new_signed_with_payer(
        &[initialize_ix],
        Some(&keypair.pubkey()),
        &[keypair],
        banks_client.get_latest_blockhash().await?,
    );
    banks_client.process_transaction(tx).await?;
    Ok((state, drift_signer))
}

// imitates USDC market
pub async fn init_quote_market( banks_client: &mut BanksClient,
                         keypair: &Keypair,
                         quote_mint: &Pubkey,
                         drift_signer: &Pubkey,
                         state: &Pubkey) -> anyhow::Result<(Pubkey, Pubkey, Pubkey)>{
    let data = initialize_quote_market_data();
    let spot_index = 0_u16;
    let spot_market = Pubkey::find_program_address(&[b"spot_market".as_ref(), &spot_index.to_le_bytes()], &drift::id()).0;
    let spot_market_vault = Pubkey::find_program_address(&[b"spot_market_vault".as_ref(), &spot_index.to_le_bytes()], &drift::id()).0;
    let insurance_fund_vault = Pubkey::find_program_address(&[b"insurance_fund_vault".as_ref(), &spot_index.to_le_bytes()], &drift::id()).0;
    let init_quote_market = Instruction{
        program_id: drift::id(),
        accounts: vec![
            AccountMeta::new(spot_market, false),
            AccountMeta::new_readonly(*quote_mint, false),
            AccountMeta::new(spot_market_vault, false),
            AccountMeta::new(insurance_fund_vault, false),
            AccountMeta::new_readonly(*drift_signer, false),
            AccountMeta::new(*state, false),
            AccountMeta::new_readonly(Pubkey::default(), false),
            AccountMeta::new(keypair.pubkey(), true),
            AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data,
    };
    let tx = Transaction::new_signed_with_payer(
        &[init_quote_market],
        Some(&keypair.pubkey()),
        &[keypair],
        banks_client.get_latest_blockhash().await?,
    );
    banks_client.process_transaction(tx).await?;
    Ok((spot_market, spot_market_vault, insurance_fund_vault))
}

// initialize spot market - index 1, imitating wsol market
pub async fn init_spot_market( banks_client: &mut BanksClient,
                               keypair: &Keypair,
                               mint: &Pubkey,
                               drift_signer: &Pubkey,
                               state: &Pubkey,
                               oracle_feed: &Pubkey,
) -> anyhow::Result<(Pubkey, Pubkey, Pubkey)>{
    let data = initialize_spot_market_data();
    let spot_index = 1_u16;
    let spot_market = Pubkey::find_program_address(&[b"spot_market".as_ref(), &spot_index.to_le_bytes()], &drift::id()).0;
    let spot_market_vault = Pubkey::find_program_address(&[b"spot_market_vault".as_ref(), &spot_index.to_le_bytes()], &drift::id()).0;
    let insurance_fund_vault = Pubkey::find_program_address(&[b"insurance_fund_vault".as_ref(), &spot_index.to_le_bytes()], &drift::id()).0;
    let init_spot_market = Instruction{
        program_id: drift::id(),
        accounts: vec![
            AccountMeta::new(spot_market, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(spot_market_vault, false),
            AccountMeta::new(insurance_fund_vault, false),
            AccountMeta::new_readonly(*drift_signer, false),
            AccountMeta::new(*state, false),
            AccountMeta::new_readonly(*oracle_feed, false),
            AccountMeta::new(keypair.pubkey(), true),
            AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data,
    };
    let tx = Transaction::new_signed_with_payer(
        &[init_spot_market],
        Some(&keypair.pubkey()),
        &[keypair],
        banks_client.get_latest_blockhash().await.unwrap(),
    );
    banks_client.process_transaction(tx).await?;
    Ok((spot_market, spot_market_vault, insurance_fund_vault))
}

pub async fn create_user(
    banks_client: &mut BanksClient,
    keypair: &Keypair,
    state: &Pubkey,
) -> anyhow::Result<(Pubkey, Pubkey)>{
    let user_stats = Pubkey::find_program_address(&[b"user_stats".as_ref(), &keypair.pubkey().as_ref(), ], &drift::id()).0;
    let data = drift::instruction::InitializeUserStats{}.data();
    let init_user_stats = Instruction {
    program_id: drift::id(),
    accounts: vec![
        AccountMeta::new(user_stats, false),
        AccountMeta::new(*state, false),
        AccountMeta::new(keypair.pubkey(), true),
        AccountMeta::new(keypair.pubkey(), true),
        AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false),
        AccountMeta::new_readonly(system_program::id(), false),
    ],
    data: data,
    };
    // the name is arbitrary!
    let data = drift::instruction::InitializeUser{ sub_account_id: 0, name: [35;32] }.data();
    let user = Pubkey::find_program_address(&[b"user".as_ref(), &keypair.pubkey().as_ref(), 0_u16.to_le_bytes().as_ref()], &drift::id()).0;
    let init_user = Instruction {
    program_id: drift::id(),
    accounts: vec![
        AccountMeta::new(user, false),
        AccountMeta::new(user_stats, false),
        AccountMeta::new(*state, false),
        AccountMeta::new(keypair.pubkey(), true),
        AccountMeta::new(keypair.pubkey(), true),
        AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false),
        AccountMeta::new_readonly(system_program::id(), false),
    ],
    data: data,
    };

    let tx = Transaction::new_signed_with_payer(
    &[init_user_stats, init_user],
    Some(&keypair.pubkey()),
    &[keypair],
    banks_client.get_latest_blockhash().await.unwrap(),
    );
    banks_client.process_transaction(tx).await?;
    Ok((user, user_stats))
}

// imitates drift quote market - USDC
pub fn initialize_quote_market_data() -> Vec<u8> {
    InitializeSpotMarket{
        optimal_utilization: 700000,
        optimal_borrow_rate: 150000,
        max_borrow_rate: 2000000,
        oracle_source: OracleSource::QuoteAsset,
        initial_asset_weight: 10000,
        maintenance_asset_weight: 10000,
        initial_liability_weight: 10000,
        maintenance_liability_weight: 10000,
        imf_factor: 0,
        liquidator_fee: 7500,
        if_liquidation_fee: 22500,
        active_status: true,
        asset_tier: AssetTier::Collateral,
        scale_initial_asset_weight_start: 150000000000000,
        withdraw_guard_threshold: 1000000000000,
        order_tick_size: 0,
        order_step_size: 0,
        if_total_factor: 0,
        name: [
            85,
            83,
            68,
            67,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32
        ],
    }.data()
}

// will init with values for SOL market
pub fn initialize_spot_market_data() -> Vec<u8> {
    InitializeSpotMarket{
        optimal_utilization: 700000,
        optimal_borrow_rate: 150000,
        max_borrow_rate: 2000000,
        oracle_source: OracleSource::Pyth,
        initial_asset_weight: 8000,
        maintenance_asset_weight: 9000,
        initial_liability_weight: 12000,
        maintenance_liability_weight: 11000,
        imf_factor: 0,
        liquidator_fee: 0,
        if_liquidation_fee: 5000,
        active_status: true,
        asset_tier: AssetTier::Collateral,
        scale_initial_asset_weight_start: 150000000000000,
        withdraw_guard_threshold: 1000000000000,
        order_tick_size: 100,
        order_step_size: 1000000,
        if_total_factor: 0,
        name: [
            83,
            79,
            76,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32,
            32
        ],
    }.data()
}

pub async fn deposit_and_execute(banks_client: &mut BanksClient,
                                 keypair: &Keypair,
                                 args: Deposit,
                                 state: &Pubkey,
                                 user: &Pubkey,
                                 user_stats: &Pubkey,
                                 mint: &Pubkey,
                                 remaining_accounts: &mut Vec<AccountMeta>
) -> anyhow::Result<()>{
    let mut accounts = vec![
        AccountMeta::new(*state, false),
        AccountMeta::new(*user, false),
        AccountMeta::new(*user_stats, false),
        AccountMeta::new(keypair.pubkey(), true),
        AccountMeta::new(Pubkey::find_program_address(&[b"spot_market_vault".as_ref(), &args.market_index.to_le_bytes()], &drift::id()).0, false),
        AccountMeta::new(spl_associated_token_account::get_associated_token_address(&keypair.pubkey(), &mint).key(), false),
        AccountMeta::new_readonly(spl_token::id(), false),
    ];
    accounts.append(remaining_accounts);
    let deposit_ix = Instruction {
        program_id: drift::id(),
        accounts: accounts,
        data: args.data(),
    };

    let tx = Transaction::new_signed_with_payer(
        &[deposit_ix],
        Some(&keypair.pubkey()),
        &[keypair],
        banks_client.get_latest_blockhash().await.unwrap(),
    );
    banks_client.process_transaction(tx).await?;
    Ok(())
}

pub async fn initialize_openbook_v2_config(
    banks_client: &mut BanksClient,
    keypair: &Keypair,
    openbook_v2_market: &Pubkey,
    spot_market: &Pubkey,
    quote_market: &Pubkey,
    state: &Pubkey,
    drift_signer: &Pubkey,
    market_index: u16,
) -> anyhow::Result<(Pubkey)>{
    let config = Pubkey::find_program_address(&[ b"openbook_v2_fulfillment_config".as_ref(), openbook_v2_market.as_ref()], &drift::id()).0;
    let data = drift::instruction::InitializeOpenbookV2FulfillmentConfig{ market_index: market_index }.data();
    let init_fulfillment_config = Instruction {
        program_id: drift::id(),
        accounts: vec![
            AccountMeta::new_readonly(*spot_market, false),
            AccountMeta::new_readonly(*quote_market, false),
            AccountMeta::new(*state, false),
            AccountMeta::new_readonly(openbook_v2_light::id(), false),
            AccountMeta::new_readonly(*openbook_v2_market, false),
            AccountMeta::new_readonly(*drift_signer, false),
            AccountMeta::new(config, false),
            AccountMeta::new(keypair.pubkey(), true),
            AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: data,
    };

    let tx = Transaction::new_signed_with_payer(
        &[init_fulfillment_config],
        Some(&keypair.pubkey()),
        &[keypair],
        banks_client.get_latest_blockhash().await.unwrap(),
    );
    banks_client.process_transaction(tx).await?;
    Ok(config)
}

pub async fn place_spot_order_and_execute(
    banks_client: &mut BanksClient,
    keypair: &Keypair,
    args: OrderParams,
    user: &Pubkey,
    spot_market: &Pubkey,
    quote_market: &Pubkey,
    state: &Pubkey,
    oracle_feed: &Pubkey,
) -> anyhow::Result<()>{
    let data = drift::instruction::PlaceSpotOrder{ params: args }.data();
    let place_order_ix = Instruction {
        program_id: drift::id(),
        accounts: vec![
            AccountMeta::new_readonly(*state, false),
            AccountMeta::new(*user, false),
            AccountMeta::new(keypair.pubkey(), true),
            AccountMeta::new_readonly(oracle_feed.key(), false),
            AccountMeta::new(*quote_market, false),
            AccountMeta::new(*spot_market, false),
        ],
        data: data,
    };
    let tx = Transaction::new_signed_with_payer(
        &[place_order_ix],
        Some(&keypair.pubkey()),
        &[keypair],
        banks_client.get_latest_blockhash().await?,
    );
    banks_client.process_transaction(tx).await?;
   Ok(())
}