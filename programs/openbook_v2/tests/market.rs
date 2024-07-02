use anchor_lang::{InstructionData, Key};
use bytemuck::Zeroable;
use openbook_v2_light::instruction::{CreateMarket, PlaceOrder};
use openbook_v2_light::{BookSide, EventHeap, OracleConfigParams, Side};
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::pubkey::Pubkey;
use solana_program::system_program;
use solana_program_test::BanksClient;
use solana_sdk::transaction::Transaction;
use solana_sdk::{signature::Keypair, signer::Signer};

pub struct MarketKeys {
    pub market: Pubkey,
    pub bids: Pubkey,
    pub asks: Pubkey,
    pub event_heap: Pubkey,
    pub event_authority: Pubkey,
    pub market_authority: Pubkey,
    pub market_base_vault: Pubkey,
    pub market_quote_vault: Pubkey,
}

pub async fn place_order_and_execute(
    banks_client: &mut BanksClient,
    keypair: &Keypair,
    args: PlaceOrder,
    market_keys: &MarketKeys,
    ooa: &Pubkey,
    mint: &Pubkey,
) -> anyhow::Result<()> {
    let place_order_ix = Instruction::new_with_bytes(
        openbook_v2_light::id(),
        &args.data(),
        vec![
            AccountMeta::new(keypair.pubkey(), true),
            AccountMeta::new(*ooa, false),
            AccountMeta::new(openbook_v2_light::id(), false),
            AccountMeta::new(
                spl_associated_token_account::get_associated_token_address(&keypair.pubkey(), mint)
                    .key(),
                false,
            ), // ata
            AccountMeta::new(market_keys.market, false),
            AccountMeta::new(market_keys.bids, false),
            AccountMeta::new(market_keys.asks, false),
            AccountMeta::new(market_keys.event_heap, false),
            AccountMeta::new(
                if let Side::Bid = args.side {
                    market_keys.market_quote_vault
                } else {
                    market_keys.market_base_vault
                },
                false,
            ), // if bid quote else base
            AccountMeta::new(Pubkey::zeroed(), false),
            AccountMeta::new(Pubkey::zeroed(), false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
    );
    let tx = Transaction::new_signed_with_payer(
        &[place_order_ix],
        Some(&keypair.pubkey()),
        &[keypair],
        banks_client.get_latest_blockhash().await?,
    );
    banks_client.process_transaction(tx).await?;
    Ok(())
}

// creates bids,asks and event heap accounts
pub async fn create_bids_asks_event_heap(
    mut banks_client: &mut BanksClient,
    keypair: &Keypair,
) -> anyhow::Result<(Pubkey, Pubkey, Pubkey)> {
    let bids = create_account_for_type::<BookSide>(&mut banks_client, keypair).await?;
    let asks = create_account_for_type::<BookSide>(&mut banks_client, keypair).await?;
    let event_heap = create_account_for_type::<EventHeap>(&mut banks_client, keypair).await?;
    Ok((bids, asks, event_heap))
}

// imitates wsol/usdc market CFSMrBssNG8Ud1edW59jNLnq2cwrQ9uY5cM3wXmqRJj3
pub async fn create_default_market(
    banks_client: &mut BanksClient,
    keypair: &Keypair,
    base_mint: &Pubkey,
    quote_mint: &Pubkey,
    bids: &Pubkey,
    asks: &Pubkey,
    event_heap: &Pubkey,
) -> anyhow::Result<(Pubkey, Pubkey, Pubkey, Pubkey, Pubkey)> {
    let market = Keypair::new();
    let event_authority =
        Pubkey::find_program_address(&[b"__event_authority".as_ref()], &openbook_v2_light::id()).0;

    let market_authority = Pubkey::find_program_address(
        &[b"Market".as_ref(), market.pubkey().to_bytes().as_ref()],
        &openbook_v2_light::id(),
    )
    .0;

    let market_base_vault =
        spl_associated_token_account::get_associated_token_address(&market_authority, &base_mint);
    let market_quote_vault =
        spl_associated_token_account::get_associated_token_address(&market_authority, &quote_mint);
    // as for SOL-USDC market
    // create market similar as CFSMrBssNG8Ud1edW59jNLnq2cwrQ9uY5cM3wXmqRJj3
    let create_market = CreateMarket {
        name: "SOL-USDC".to_string(),
        oracle_config: OracleConfigParams {
            conf_filter: 0.1,
            max_staleness_slots: Some(100),
        },
        quote_lot_size: 1,
        base_lot_size: 1_000_000,
        maker_fee: 1000,
        taker_fee: 1000,
        time_expiry: 0,
    };

    let data = create_market.data();
    // let data: Vec<u8> = create_market.data();
    let create_market_ix = Instruction::new_with_bytes(
        openbook_v2_light::id(),
        &data,
        vec![
            AccountMeta::new(market.pubkey(), true),
            AccountMeta::new_readonly(market_authority, false),
            AccountMeta::new(*bids, false),
            AccountMeta::new(*asks, false),
            AccountMeta::new(*event_heap, false),
            AccountMeta::new(keypair.pubkey(), true),
            AccountMeta::new(market_base_vault, false),
            AccountMeta::new(market_quote_vault, false),
            AccountMeta::new_readonly(*base_mint, false),
            AccountMeta::new_readonly(*quote_mint, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(spl_associated_token_account::id(), false),
            AccountMeta::new(Pubkey::zeroed(), false),
            AccountMeta::new(Pubkey::zeroed(), false),
            AccountMeta::new(Pubkey::zeroed(), false),
            AccountMeta::new(Pubkey::zeroed(), false),
            AccountMeta::new(Pubkey::zeroed(), false),
            AccountMeta::new(openbook_v2_light::id(), false),
            AccountMeta::new(event_authority, false),
            AccountMeta::new(openbook_v2_light::id(), false),
        ],
    );
    let tx = Transaction::new_signed_with_payer(
        &[create_market_ix],
        Some(&keypair.pubkey()),
        &[&keypair, &market],
        banks_client.get_latest_blockhash().await.unwrap(),
    );
    banks_client.process_transaction(tx).await?;
    return Ok((
        market.pubkey(),
        event_authority,
        market_authority,
        market_base_vault,
        market_quote_vault,
    ));
}

pub async fn create_account_for_type<T>(
    banks_client: &mut BanksClient,
    keypair: &Keypair,
) -> anyhow::Result<Pubkey> {
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
    banks_client.process_transaction(tx).await?;
    Ok(key.pubkey())
}
