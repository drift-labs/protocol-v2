use std::io::Read;
use std::str::FromStr;
use anchor_lang::{AccountDeserialize, InstructionData};
use anchor_lang::prelude::Pubkey;
use solana_client::rpc_client::RpcClient;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::message::{v0, VersionedMessage};
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::system_program::id;
use solana_sdk::transaction::VersionedTransaction;
use openbook_v2::instruction::PlaceTakeOrder;
use openbook_v2::{Market, PlaceOrderType, Side};

fn main(){
    let market_key = Pubkey::from_str("CFSMrBssNG8Ud1edW59jNLnq2cwrQ9uY5cM3wXmqRJj3").unwrap();
    let client = RpcClient::new("https://api.mainnet-beta.solana.com");
    let mut data = client.get_account_data(&market_key).unwrap();
    // TODO change to your path to your solana wallet priv key
    let mut file = std::fs::File::open("/Users/oktogen/.config/solana/id.json").unwrap();
    let mut buffer = String::new();
    file.read_to_string(&mut buffer);
    buffer = buffer
        .replace("[","")
        .replace("]","")
        .replace("\n","");
    let priv_key = buffer.split(",").map(| x| u8::from_str(x).unwrap()).collect::<Vec<u8>>();
    let keypair = Keypair::from_bytes(&priv_key).unwrap();
    println!("{}", keypair.pubkey());
    let market = Market::try_deserialize(&mut &data[..]).unwrap();

    let (base_ata, _) = Pubkey::find_program_address(
        &[&keypair.pubkey().to_bytes(),
            &Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap().to_bytes(),
            &market.base_mint.to_bytes(),
        ],
        &Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap());

    let (quote_ata, _) = Pubkey::find_program_address(
        &[&keypair.pubkey().to_bytes(),
            &Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap().to_bytes(),
            &market.quote_mint.to_bytes(),
        ],
        &Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap());
    // sell 0.05 wsol for minimum of 150.0 - to get calculations look js sdk of openbook v2
    let args = PlaceTakeOrder{
        side: Side::Ask, // 1
        price_lots: 150_000, // or use i64::MAX
        max_base_lots: 10, // 9223372036854, // 8
        max_quote_lots_including_fees: 5_000_000, // 8
        order_type: PlaceOrderType::Market, // 1
        limit: 50, // number of orders to match why 50?
        // total - 27
    };
    let data = args.data();
    println!("data: {:?}", data);
    let mut instruction = Instruction{
        program_id: openbook_v2::id(),
        accounts: vec![
            AccountMeta::new(keypair.pubkey(), true),
            AccountMeta::new(keypair.pubkey(), true),
            AccountMeta::new(market_key, false),
            AccountMeta::new_readonly(market.market_authority, false),
            AccountMeta::new(market.bids, false),
            AccountMeta::new(market.asks, false),
            AccountMeta::new(market.market_base_vault, false),
            AccountMeta::new(market.market_quote_vault, false),
            AccountMeta::new(market.event_heap, false),
            AccountMeta::new(base_ata, false),
            AccountMeta::new(quote_ata, false),
            AccountMeta::new_readonly(openbook_v2::id(), false),
            AccountMeta::new_readonly(openbook_v2::id(), false),
            AccountMeta::new_readonly(Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap(), false),
            AccountMeta::new_readonly(id(), false),
            AccountMeta::new_readonly(openbook_v2::id(), false),
        ],
        data,
    };
    let hash = client.get_latest_blockhash().unwrap();
    let txn = VersionedTransaction::try_new(
        VersionedMessage::V0(v0::Message::try_compile(
            &keypair.pubkey(),
            &[instruction],
            &[],
            hash,
        ).unwrap()),
        &[&keypair],
    ).unwrap();
    let result = client.simulate_transaction(&txn);
    println!("{:?}", result);
    // TODO remove if you want to swap ...
    let result = client.send_and_confirm_transaction(&txn).unwrap();
    println!("signature: {}", result);
}

// TODO - check
/*
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut)]
    pub penalty_payer: Signer<'info>,

    #[account(
        mut,
        has_one = bids,
        has_one = asks,
        has_one = event_heap,
        has_one = market_base_vault,
        has_one = market_quote_vault,
        has_one = market_authority,
        constraint = market.load()?.oracle_a == oracle_a.non_zero_key(),
        constraint = market.load()?.oracle_b == oracle_b.non_zero_key(),
        constraint = market.load()?.open_orders_admin == open_orders_admin.non_zero_key() @ OpenBookError::InvalidOpenOrdersAdmin
    )]
    pub market: AccountLoader<'info, Market>,
    /// CHECK: checked on has_one in market
    pub market_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub bids: AccountLoader<'info, BookSide>,
    #[account(mut)]
    pub asks: AccountLoader<'info, BookSide>,
    #[account(mut)]
    pub market_base_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub market_quote_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub event_heap: AccountLoader<'info, EventHeap>,

    #[account(
        mut,
        token::mint = market_base_vault.mint
    )]
    pub user_base_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = market_quote_vault.mint
    )]
    pub user_quote_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: The oracle can be one of several different account types and the pubkey is checked above
    pub oracle_a: Option<UncheckedAccount<'info>>, - System account
    /// CHECK: The oracle can be one of several different account types and the pubkey is checked above
    pub oracle_b: Option<UncheckedAccount<'info>>, - System account as default

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub open_orders_admin: Option<Signer<'info>>,
    add also ooa accounts if using PlaceTakeOrder
 */