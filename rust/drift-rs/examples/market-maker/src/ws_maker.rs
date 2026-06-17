//! Example Market Making bot with Ws based subscriptions
//!
//! Resubmits quotes on a fixed interval
use std::time::Duration;

use drift_rs::{
    event_subscriber::{DriftEvent, EventSubscriber},
    math::constants::{BASE_PRECISION_U64, PRICE_PRECISION_U64},
    types::{
        accounts::{PerpMarket, User},
        MarketPrecision, MarketType, OrderParams, OrderType, PositionDirection, PostOnlyParam,
    },
    Context, DriftClient, Pubkey, RpcClient, TransactionBuilder, Wallet,
};
use futures_util::StreamExt;
use solana_keypair::Keypair;

pub async fn ws_maker(context: Context, wallet: Wallet) {
    let rpc_url = std::env::var("RPC_URL")
        .unwrap_or_else(|_| "https://api.mainnet-beta.solana.com".to_string());
    let drift = DriftClient::new(context, RpcClient::new(rpc_url), Keypair::new().into())
        .await
        .expect("initialized client");
    let _ = drift.subscribe_blockhashes().await; // subscribe blockhases for fast tx building

    let market_id = drift.market_lookup("sol-perp").unwrap();
    let market_info = drift
        .try_get_perp_market_account(market_id.index())
        .unwrap();

    let sub_account_address = drift.wallet().sub_account(0); // trade on the default sub-account index
    let _ = drift
        .subscribe_account(&sub_account_address)
        .await
        .expect("subscribed account");
    let _ = drift
        .subscribe_oracles(&[market_id])
        .await
        .expect("subscribed oracle");

    let mut account_events = EventSubscriber::subscribe(drift.ws(), sub_account_address)
        .await
        .unwrap();

    loop {
        let mut requote_interval = tokio::time::interval(Duration::from_millis(400));
        tokio::select! {
            biased;
            _ = requote_interval.tick() => {
                let sub_account_data: User = drift.try_get_account(&sub_account_address).expect("has account");
                let oracle_account = drift.try_get_oracle_price_data_and_slot(market_id).expect("has oracle");

                if let Ok(position) = sub_account_data.get_perp_position(market_info.market_index) {
                    let upnl = position.get_unrealized_pnl(oracle_account.data.price).unwrap();
                    println!("current position value: ${}, upnl: ${upnl}", position.quote_asset_amount);
                }

                let quote_price = 123 * PRICE_PRECISION_U64; // $123.000_000
                let quote_size = 5_u64 * BASE_PRECISION_U64; // 5.000_000_000

                place_txs(
                    &drift,
                    &market_info,
                    sub_account_address,
                    &sub_account_data,
                    vec![
                        // fixed price limit order
                        OrderParams {
                            order_type: OrderType::Limit,
                            price: standardize_amount(quote_price, market_info.price_tick()),
                            base_asset_amount: standardize_amount(quote_size, market_info.quantity_tick()).max(market_info.min_order_size()),
                            direction: PositionDirection::Long,
                            market_type: MarketType::Perp,
                            market_index: market_info.market_index,
                            post_only: PostOnlyParam::MustPostOnly,
                            reduce_only: false,
                            user_order_id: 1, // self-assigned order ID from 0-255
                            ..Default::default()
                        },
                        // floating limit order, priced dynamically as offset from oracle price
                        OrderParams {
                            order_type: OrderType::Limit,
                            oracle_price_offset: Some((1 * PRICE_PRECISION_U64) as i32), // short 1$ above oracle
                            base_asset_amount: standardize_amount(quote_size, market_info.quantity_tick()).max(market_info.min_order_size()),
                            direction: PositionDirection::Short,
                            market_type: MarketType::Perp,
                            market_index: market_info.market_index,
                            post_only: PostOnlyParam::MustPostOnly,
                            reduce_only: false,
                            // max_ts: Some(unix_s) // auto-expire by timestamp. default: expire at now + 30s
                            ..Default::default()
                        }
                    ],
                ).await;
            },
            event = account_events.next() => {
                if event.is_none() {
                    eprintln!("event stream finished");
                    break;
                }
                match event.unwrap() {
                    DriftEvent::OrderFill {
                        maker,
                        maker_fee,
                        maker_order_id,
                        maker_side,
                        taker,
                        taker_fee,
                        taker_order_id,
                        taker_side,
                        base_asset_amount_filled,
                        quote_asset_amount_filled,
                        market_index,
                        market_type,
                        oracle_price,
                        signature,
                        tx_idx,
                        ts,
                        bit_flags,
                    } => {
                        println!("order filled. id:{maker_order_id},market={market_index}/{market_type:?},fill_size={quote_asset_amount_filled}");
                    }
                    DriftEvent::OrderCancel { maker_order_id, .. } => {
                        println!("order cancelled. id:{maker_order_id}");
                    }
                    DriftEvent::OrderCreate {
                        order,
                        user,
                        ts,
                        signature,
                        tx_idx,
                    } => {
                        println!("order created. id:{},tx:{signature}", order.order_id);
                    }
                    DriftEvent::FundingPayment {
                        amount,
                        market_index,
                        user,
                        ts,
                        signature,
                        tx_idx,
                    } => {
                        println!("funding paid. market={market_index},amount={amount}");
                    }
                    _other => {}
                }
            }
        }
    }
}

/// quantize `amount` to `tick_size` rounding down
fn standardize_amount(amount: u64, tick_size: u64) -> u64 {
    amount.saturating_sub(amount % tick_size)
}

async fn place_txs(
    drift: &DriftClient,
    market: &PerpMarket,
    sub_account: Pubkey,
    sub_account_data: &User,
    orders: Vec<OrderParams>,
) {
    let builder = TransactionBuilder::new(
        drift.program_data(),
        sub_account,
        std::borrow::Cow::Borrowed(sub_account_data),
        false,
    );
    let tx = builder
        .with_priority_fee(1_000, Some(100_000))
        .cancel_orders((market.market_index, MarketType::Perp), None) // cancel all orders by market
        // .cancel_orders_by_user_id(user_order_ids) // cancel orders by list of userids
        // .cancel_orders_by_id(user_ids) // cancel orders by program assigned order id
        .place_orders(orders) // place new orders
        .build();

    match drift.sign_and_send(tx).await {
        Ok(sig) => {
            println!("sent tx: {sig:?}");
        }
        Err(err) => {
            println!("send tx err: {err:?}");
        }
    }
}
