use anchor_lang::InstructionData;
use anchor_lang::{AccountDeserialize, Key};
use drift::controller::position::PositionDirection;
use drift::instruction::Deposit;
use drift::instructions::SpotFulfillmentType;
use drift::state::order_params::OrderParams;
use drift::state::user::OrderTriggerCondition::{TriggeredAbove, TriggeredBelow};
use drift::state::user::{MarketType, OrderType, User};
use openbook_v2_light::instruction::PlaceOrder;
use openbook_v2_light::{PlaceOrderType, SelfTradeBehavior, Side};
use pyth::instruction::Initialize as PythInitialize;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::system_program;
use solana_program_test::{tokio, ProgramTest};
use solana_sdk::{signer::Signer, transaction::Transaction};

use crate::drift_utils::{
    create_user, deposit_and_execute, init_quote_market, init_spot_market, initialize_drift,
    initialize_openbook_v2_config, place_spot_order_and_execute,
};
use crate::market::{
    create_bids_asks_event_heap, create_default_market, place_order_and_execute, MarketKeys,
};
use crate::ooa::setup_open_orders_account;
use crate::pyth_utils::initialize_pyth_oracle;
use crate::token::init_mint;

mod drift_utils;
mod market;
mod ooa;
mod pyth_utils;
mod token;

#[tokio::test]
async fn test_program() -> anyhow::Result<()> {
    let mut validator = ProgramTest::new("drift", drift::id(), None);
    validator.add_program("pyth", pyth::id(), None);
    validator.add_program("openbook_v2", openbook_v2_light::id(), None);

    // init Drift spot account
    // init drift fulfillment
    // order on drift
    // fulfill via openbook v2
    let (mut banks_client, keypair, _hash) = validator.start().await;
    // mock wsol
    let base_mint = init_mint(&mut banks_client, &keypair, 9, 1000_000_000_000_000).await?;
    // mock usdc
    let quote_mint = init_mint(&mut banks_client, &keypair, 6, 1_000_000_000_000).await?;
    let (bids, asks, event_heap) = create_bids_asks_event_heap(&mut banks_client, &keypair).await?;

    let (market, event_authority, market_authority, market_base_vault, market_quote_vault) =
        create_default_market(
            &mut banks_client,
            &keypair,
            &base_mint,
            &quote_mint,
            &bids,
            &asks,
            &event_heap,
        )
        .await?;

    let market_keys = MarketKeys {
        market,
        bids,
        asks,
        event_heap,
        event_authority,
        market_authority,
        market_base_vault,
        market_quote_vault,
    };
    // create open_orders_account ( and open_orders_indexer too)
    let (ooa, _ooi) = setup_open_orders_account(&mut banks_client, &keypair, &market).await?;

    // market maker place bid
    place_order_and_execute(
        &mut banks_client,
        &keypair,
        PlaceOrder {
            side: Side::Bid,
            price_lots: 150_000,
            max_base_lots: 1000,
            max_quote_lots_including_fees: 500_000_000,
            client_order_id: 0,
            order_type: PlaceOrderType::Limit,
            expiry_timestamp: 0,
            self_trade_behavior: SelfTradeBehavior::DecrementTake,
            limit: 10,
        },
        &market_keys,
        &ooa,
        &quote_mint,
    )
    .await?;
    // market maker place ask
    place_order_and_execute(
        &mut banks_client,
        &keypair,
        PlaceOrder {
            side: Side::Ask,
            price_lots: 154_000,
            max_base_lots: 1000,
            max_quote_lots_including_fees: 500_000_000,
            client_order_id: 0,
            order_type: PlaceOrderType::Limit,
            expiry_timestamp: 0,
            self_trade_behavior: SelfTradeBehavior::DecrementTake,
            limit: 10,
        },
        &market_keys,
        &ooa,
        &base_mint,
    )
    .await?;
    // init drift
    let (state, drift_signer) = initialize_drift(&mut banks_client, &keypair, &quote_mint).await?;
    println!("state: {} drift signer: {}", state, drift_signer);
    // init quote market
    let (quote_market, quote_market_vault, _quote_insurance_fund_vault) = init_quote_market(
        &mut banks_client,
        &keypair,
        &quote_mint,
        &drift_signer,
        &state,
    )
    .await?;

    // pyth feed
    let oracle_feed = initialize_pyth_oracle(
        &mut banks_client,
        &keypair,
        PythInitialize {
            price: 155_000,
            expo: -3,
            conf: 28988326,
        },
    )
    .await?;
    println!("{}", oracle_feed);

    // create spot market
    let (spot_market, spot_market_vault, _spot_insurance_fund_vault) = init_spot_market(
        &mut banks_client,
        &keypair,
        &base_mint,
        &drift_signer,
        &state,
        &oracle_feed,
    )
    .await?;

    // create user
    let (user, user_stats) = create_user(&mut banks_client, &keypair, &state).await?;

    // deposit mock USDC  ...
    deposit_and_execute(
        &mut banks_client,
        &keypair,
        Deposit {
            market_index: 0,
            amount: 1_000_000_000, // 1000 mock usdc
            reduce_only: false,
        },
        &state,
        &user,
        &user_stats,
        &quote_mint,
        &mut vec![AccountMeta::new(quote_market, false)],
    )
    .await?;

    deposit_and_execute(
        &mut banks_client,
        &keypair,
        Deposit {
            market_index: 1,
            amount: 1_000_000_000_000, // 1000 mock usdc
            reduce_only: false,
        },
        &state,
        &user,
        &user_stats,
        &base_mint,
        &mut vec![
            AccountMeta::new_readonly(oracle_feed, false),
            AccountMeta::new(spot_market, false),
            AccountMeta::new(quote_market, false),
        ],
    )
    .await?;

    // create OpenbookV2 fulfillment config
    let config = initialize_openbook_v2_config(
        &mut banks_client,
        &keypair,
        &market,
        &spot_market,
        &quote_market,
        &state,
        &drift_signer,
        1,
    )
    .await?;

    // long spot trade on drift
    place_spot_order_and_execute(
        &mut banks_client,
        &keypair,
        OrderParams {
            order_type: OrderType::Market,
            market_type: MarketType::Spot,
            direction: PositionDirection::Long,
            user_order_id: 0,
            base_asset_amount: 1_000_000_000, // 0.1 wsol
            price: 160_000_000,
            market_index: 1,
            reduce_only: false,
            post_only: Default::default(),
            immediate_or_cancel: false,
            max_ts: None,
            trigger_price: None,
            trigger_condition: TriggeredBelow,
            oracle_price_offset: None,
            auction_duration: Some(0),
            auction_start_price: None,
            auction_end_price: None,
        },
        &user,
        &spot_market,
        &quote_market,
        &state,
        &oracle_feed,
    )
    .await?;

    // fulfillment
    let account = banks_client.get_account(user).await?.unwrap().data;
    let user_data = User::try_deserialize(&mut &account[..]).unwrap();
    for order in user_data.orders.iter() {
        if order.market_index == 1 {
            let order_id = order.order_id;
            let data = drift::instruction::FillSpotOrder {
                order_id: Some(order_id),
                fulfillment_type: Option::from(SpotFulfillmentType::OpenbookV2),
                maker_order_id: None,
            }
            .data();
            let fill_ix = Instruction {
                program_id: drift::id(),
                accounts: vec![
                    // AccountMeta::new_readonly(spot_market, false),
                    // AccountMeta::new_readonly(quote_market, false),
                    AccountMeta::new_readonly(state, false),
                    AccountMeta::new(keypair.pubkey(), true),
                    AccountMeta::new(user, false),
                    AccountMeta::new(user_stats, false),
                    AccountMeta::new(user, false),
                    AccountMeta::new(user_stats, false),
                    AccountMeta::new_readonly(oracle_feed.key(), false),
                    AccountMeta::new(quote_market, false),
                    AccountMeta::new(spot_market, false),
                    AccountMeta::new_readonly(config, false),
                    AccountMeta::new(drift_signer, false),
                    AccountMeta::new_readonly(openbook_v2_light::id(), false),
                    AccountMeta::new(market, false),
                    AccountMeta::new_readonly(market_authority, false),
                    AccountMeta::new(event_heap, false),
                    AccountMeta::new(bids, false),
                    AccountMeta::new(asks, false),
                    AccountMeta::new(market_base_vault, false),
                    AccountMeta::new(market_quote_vault, false),
                    AccountMeta::new(spot_market_vault, false),
                    AccountMeta::new(quote_market_vault, false),
                    AccountMeta::new_readonly(spl_token::id(), false),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(quote_market, false),
                    AccountMeta::new(spot_market, false),
                ],
                data: data,
            };
            let tx = Transaction::new_signed_with_payer(
                &[fill_ix],
                Some(&keypair.pubkey()),
                &[&keypair],
                banks_client.get_latest_blockhash().await.unwrap(),
            );
            banks_client.process_transaction(tx).await?;
        }
    }

    // add buy before
    place_order_and_execute(
        &mut banks_client,
        &keypair,
        PlaceOrder {
            side: Side::Bid,
            price_lots: 156_000,
            max_base_lots: 2000,
            max_quote_lots_including_fees: 1_000_000_000,
            client_order_id: 0,
            order_type: PlaceOrderType::Limit,
            expiry_timestamp: 0,
            self_trade_behavior: SelfTradeBehavior::DecrementTake,
            limit: 10,
        },
        &market_keys,
        &ooa,
        &quote_mint,
    )
    .await?;
    // short
    place_spot_order_and_execute(
        &mut banks_client,
        &keypair,
        OrderParams {
            order_type: OrderType::Market,
            market_type: MarketType::Spot,
            direction: PositionDirection::Short,
            user_order_id: 0,
            base_asset_amount: 1_00_000_000, // 0.1 wsol
            price: 154_000_000,
            market_index: 1,
            reduce_only: false,
            post_only: Default::default(),
            immediate_or_cancel: false,
            max_ts: None,
            trigger_price: None,
            trigger_condition: TriggeredAbove,
            oracle_price_offset: None,
            auction_duration: Some(0),
            auction_start_price: None,
            auction_end_price: None,
        },
        &user,
        &spot_market,
        &quote_market,
        &state,
        &oracle_feed,
    )
    .await?;
    // fulfillment
    let account = banks_client.get_account(user).await?.unwrap().data;
    let user_data = User::try_deserialize(&mut &account[..]).unwrap();
    for order in user_data.orders.iter() {
        if order.market_index == 1 {
            let order_id = order.order_id;
            let data = drift::instruction::FillSpotOrder {
                order_id: Some(order_id),
                fulfillment_type: Option::from(SpotFulfillmentType::OpenbookV2),
                maker_order_id: None,
            }
            .data();
            let fill_ix = Instruction {
                program_id: drift::id(),
                accounts: vec![
                    // AccountMeta::new_readonly(spot_market, false),
                    // AccountMeta::new_readonly(quote_market, false),
                    AccountMeta::new_readonly(state, false),
                    AccountMeta::new(keypair.pubkey(), true),
                    AccountMeta::new(user, false),
                    AccountMeta::new(user_stats, false),
                    AccountMeta::new(user, false),
                    AccountMeta::new(user_stats, false),
                    AccountMeta::new_readonly(oracle_feed.key(), false),
                    AccountMeta::new(quote_market, false),
                    AccountMeta::new(spot_market, false),
                    AccountMeta::new_readonly(config, false),
                    AccountMeta::new(drift_signer, false),
                    AccountMeta::new_readonly(openbook_v2_light::id(), false),
                    AccountMeta::new(market, false),
                    AccountMeta::new_readonly(market_authority, false),
                    AccountMeta::new(event_heap, false),
                    AccountMeta::new(bids, false),
                    AccountMeta::new(asks, false),
                    AccountMeta::new(market_base_vault, false),
                    AccountMeta::new(market_quote_vault, false),
                    AccountMeta::new(spot_market_vault, false),
                    AccountMeta::new(quote_market_vault, false),
                    AccountMeta::new_readonly(spl_token::id(), false),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(quote_market, false),
                    AccountMeta::new(spot_market, false),
                ],
                data: data,
            };
            let tx = Transaction::new_signed_with_payer(
                &[fill_ix],
                Some(&keypair.pubkey()),
                &[&keypair],
                banks_client.get_latest_blockhash().await.unwrap(),
            );
            banks_client.process_transaction(tx).await?;
        }
    }
    Ok(())
}
