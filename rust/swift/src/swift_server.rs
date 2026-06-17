use std::{
    collections::HashSet,
    env,
    net::SocketAddr,
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, SystemTime},
};

use crate::{
    super_slot_subscriber::SuperSlotSubscriber,
    types::{
        messages::{
            DepositAndPlaceRequest, IncomingSignedMessage, OrderMetadataAndMessage,
            ProcessOrderResponse, PROCESS_ORDER_RESPONSE_ERROR_MSG_DELISTED_MARKET,
            PROCESS_ORDER_RESPONSE_ERROR_MSG_DELIVERY_FAILED,
            PROCESS_ORDER_RESPONSE_ERROR_MSG_INVALID_ORDER,
            PROCESS_ORDER_RESPONSE_ERROR_MSG_INVALID_ORDER_AMOUNT,
            PROCESS_ORDER_RESPONSE_ERROR_MSG_ORDER_SLOT_TOO_OLD,
            PROCESS_ORDER_RESPONSE_ERROR_MSG_VERIFY_SIGNATURE,
            PROCESS_ORDER_RESPONSE_IGNORE_PUBKEY, PROCESS_ORDER_RESPONSE_INVALID_UUID_UTF8,
            PROCESS_ORDER_RESPONSE_MESSAGE_SUCCESS,
        },
        types::{unix_now_ms, RequestContext},
    },
    user_account_fetcher::UserAccountFetcher,
    util::{
        headers::XSwiftClientConsumer,
        metrics::{metrics_handler, MetricsServerParams, SwiftServerMetrics},
    },
};
use anchor_lang::{AccountDeserialize, Discriminator};
use axum::{
    extract::State,
    http::{self, Method, StatusCode},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use dotenv::dotenv;
use drift_rs::{
    constants::state_account,
    drift_idl,
    event_subscriber::PubsubClient,
    math::account_list_builder::AccountsListBuilder,
    swift_order_subscriber::{SignedMessageInfo, SignedOrderType},
    types::{
        accounts::User, errors::ErrorCode, CommitmentConfig, MarketId, MarketStatus, MarketType,
        MarketTypeExt, OrderParams, OrderParamsExt, OrderType, PositionDirection, ProgramError,
        SdkError, SdkResult, SignedMsgTriggerOrderParams, VersionedMessage, VersionedTransaction,
    },
    Context, DriftClient, RpcClient, TransactionBuilder, Wallet,
};
use log::warn;
use prometheus::Registry;
use redis::{aio::MultiplexedConnection, AsyncCommands};
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_clock::Slot;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::v0::Message;
use solana_pubkey::Pubkey;
use solana_rpc_client_api::{
    client_error,
    config::{RpcSimulateTransactionAccountsConfig, RpcSimulateTransactionConfig},
    response::RpcSimulateTransactionResult,
};
use solana_signature::Signature;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use tower_http::cors::{Any, CorsLayer};

/// Accept orders under-collaterized upto this ratio.
const COLLATERAL_BUFFER: f64 = 1.01;

struct Config {
    /// RPC tx simulation on/off
    disable_rpc_sim: AtomicBool,
    /// RPC tx simulation timeout
    simulation_timeout: Duration,
}

impl Config {
    fn from_env() -> Self {
        Self {
            disable_rpc_sim: AtomicBool::new(
                std::env::var("DISABLE_RPC_SIM").unwrap_or("false".to_string()) == "true",
            ),
            simulation_timeout: Duration::from_millis(300),
        }
    }
}

#[derive(Clone)]
pub struct ServerParams {
    drift: drift_rs::DriftClient,
    slot_subscriber: Arc<SuperSlotSubscriber>,
    metrics: SwiftServerMetrics,
    redis_pool: MultiplexedConnection,
    user_account_fetcher: UserAccountFetcher,
    config: Arc<Config>,
    farmer_pubkeys: HashSet<Pubkey>,
}

pub async fn fallback(uri: axum::http::Uri) -> impl axum::response::IntoResponse {
    (axum::http::StatusCode::NOT_FOUND, format!("No route {uri}"))
}

pub async fn process_order_wrapper(
    x_swift_client_header: Option<axum_extra::TypedHeader<XSwiftClientConsumer>>,
    State(server_params): State<&'static ServerParams>,
    Json(incoming_message): Json<IncomingSignedMessage>,
) -> impl axum::response::IntoResponse {
    let context = RequestContext::from_incoming_message(&incoming_message);
    if context.is_err() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(ProcessOrderResponse {
                message: PROCESS_ORDER_RESPONSE_INVALID_UUID_UTF8,
                error: None,
            }),
        );
    }
    let context = context.unwrap();

    let (status, resp) = match process_order(server_params, incoming_message, false, &context).await
    {
        Ok(order_metadata) => {
            let metrics_labels = &[
                context.market_type,
                &context.market_index.to_string(),
                match order_metadata.will_sanitize {
                    true => "true",
                    false => "false",
                },
            ];
            let topic = format!("swift_orders_{}_{}", metrics_labels[0], metrics_labels[1]);
            let payload = order_metadata.encode();

            server_params
                .publish_order(
                    &topic,
                    &payload,
                    order_metadata.uuid(),
                    metrics_labels,
                    &context,
                )
                .await
        }
        Err(err) => err,
    };

    log::info!(
        target: "server",
        "{} status={status} err={} ui={} uuid={} taker={}",
        context.log_prefix,
        resp.error.as_deref().unwrap_or(""),
        x_swift_client_header.is_some_and(|x| x.is_app_order()),
        context.order_uuid,
        context.taker_authority,
    );
    (status, Json(resp))
}

pub async fn process_order(
    server_params: &'static ServerParams,
    incoming_message: IncomingSignedMessage,
    skip_sim: bool,
    context: &RequestContext,
) -> Result<OrderMetadataAndMessage, (http::StatusCode, ProcessOrderResponse)> {
    let IncomingSignedMessage {
        taker_pubkey,
        signature: taker_signature,
        message: _,
        signing_authority,
        taker_authority,
    } = incoming_message;

    let taker_authority = if taker_authority == Pubkey::default() {
        taker_pubkey
    } else {
        taker_authority
    };

    if server_params.farmer_pubkeys.contains(&taker_authority) {
        log::debug!(
            target: "server",
            "Ignoring order from farmer pubkey: {taker_authority}"
        );
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            ProcessOrderResponse {
                message: PROCESS_ORDER_RESPONSE_IGNORE_PUBKEY,
                error: None,
            },
        ));
    }

    server_params.metrics.taker_orders_counter.inc();

    let signing_pubkey = if signing_authority == Pubkey::default() {
        taker_authority
    } else {
        signing_authority
    };

    log::trace!(
        target: "server",
        "{}: Received order with signing pubkey: {signing_pubkey}",
        context.log_prefix,
    );

    let signed_msg = match incoming_message.verify_and_get_signed_message() {
        Ok(m) => m,
        Err(e) => {
            log::warn!(
                "{}: Error verifying signed message: {e:?}, signer: {}, taker_authority: {}",
                context.log_prefix,
                incoming_message.signing_authority,
                incoming_message.taker_authority
            );
            return Err((
                axum::http::StatusCode::BAD_REQUEST,
                ProcessOrderResponse {
                    message: PROCESS_ORDER_RESPONSE_ERROR_MSG_VERIFY_SIGNATURE,
                    error: Some(e.to_string()),
                },
            ));
        }
    };
    let delegate_signer = if signed_msg.is_delegated() {
        Some(&signing_pubkey)
    } else {
        None
    };

    let current_slot = server_params.slot_subscriber.current_slot();
    let (
        SignedMessageInfo {
            slot: taker_slot,
            order_params,
            taker_pubkey,
            uuid,
        },
        max_margin_ratio,
        isolated_position_deposit,
    ) = extract_signed_message_info(signed_msg, &taker_authority, current_slot)?;

    log::info!(
        target: "server",
        "{} signer={} taker_subaccount={} slot={} side={:?} base={} price={} order_type={:?} reduce_only={} post_only={:?} iso={:?} delegate_signer={:?}",
        context.log_prefix,
        signing_pubkey,
        taker_pubkey,
        taker_slot,
        order_params.direction,
        order_params.base_asset_amount,
        order_params.price,
        order_params.order_type,
        order_params.reduce_only,
        order_params.post_only,
        isolated_position_deposit,
        delegate_signer,
    );

    // check the order is valid for execution by program
    let market = server_params
        .drift
        .try_get_perp_market_account(order_params.market_index);

    if market
        .as_ref()
        .is_ok_and(|m| matches!(m.status, MarketStatus::Delisted | MarketStatus::Settlement))
    {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            ProcessOrderResponse {
                message: PROCESS_ORDER_RESPONSE_ERROR_MSG_DELISTED_MARKET,
                error: format!("market {} delisted", order_params.market_index).into(),
            },
        ));
    }

    if let Err(err) = validate_signed_order_params(
        &order_params,
        market.map(|m| m.market_stats.min_order_size).unwrap_or(0),
    ) {
        log::warn!(
            target: "server",
            "{}: Order did not validate: {err:?}, {order_params:?}",
            context.log_prefix
        );
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            ProcessOrderResponse {
                message: PROCESS_ORDER_RESPONSE_ERROR_MSG_INVALID_ORDER,
                error: Some(err.to_string()),
            },
        ));
    }

    if !skip_sim {
        match server_params
            .simulate_taker_order_rpc(
                &taker_pubkey,
                &order_params,
                delegate_signer,
                current_slot,
                max_margin_ratio,
                isolated_position_deposit,
                context,
            )
            .await
        {
            Ok(sim_res) => {
                server_params
                    .metrics
                    .rpc_simulation_status
                    .with_label_values(&[sim_res.as_str()])
                    .inc();
            }
            Err((status, sim_err_str, logs)) => {
                server_params
                    .metrics
                    .rpc_simulation_status
                    .with_label_values(&["invalid"])
                    .inc();
                log::warn!(
                    target: "server",
                    "{}: Order sim failed (taker: {taker_pubkey:?}, delegate: {delegate_signer:?}, market: {}-{}): {sim_err_str}. Logs: {logs:?}",
                    context.log_prefix,
                    order_params.market_type.as_str(),
                    order_params.market_index,
                );
                log::warn!(
                    target: "server",
                    "{}: failed order params: {order_params:?}",
                    context.log_prefix,
                );
                return Err((
                    status,
                    ProcessOrderResponse {
                        message: PROCESS_ORDER_RESPONSE_ERROR_MSG_INVALID_ORDER,
                        error: Some(sim_err_str),
                    },
                ));
            }
        };
    }

    if let Some(order_message_str) = signed_msg.raw() {
        // If fat fingered order that requires sanitization, then just send the order
        let will_sanitize =
            server_params.simulate_will_auction_params_sanitize(&order_params, context);
        let order_metadata = OrderMetadataAndMessage {
            market_index: order_params.market_index,
            market_type: order_params.market_type,
            signing_authority: signing_pubkey,
            taker_authority,
            order_message_str: order_message_str.to_owned(),
            order_signature: taker_signature.into(),
            ts: context.recv_ts,
            uuid,
            will_sanitize,
        };

        server_params
            .metrics
            .current_slot_gauge
            .set(current_slot as f64);

        Ok(order_metadata)
    } else {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            ProcessOrderResponse {
                message: "missing order message str",
                error: None,
            },
        ))
    }
}

pub async fn send_heartbeat(server_params: &'static ServerParams) {
    let heartbeat_time = unix_now_ms();
    let log_prefix = format!("[heartbeat: {heartbeat_time}]");

    let mut conn = server_params.redis_pool.clone();
    let topic = "heartbeat";
    let start = std::time::Instant::now();
    let result: redis::RedisResult<i64> = conn
        .publish(topic.to_string(), "love you".to_string())
        .await;
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    server_params
        .metrics
        .redis_publish_latency
        .observe(elapsed_ms);

    match result {
        Ok(receivers) => {
            log::trace!(
                target: "redis",
                "{log_prefix}: published heartbeat receivers={receivers} latency_ms={elapsed_ms:.2}"
            );
            server_params
                .metrics
                .order_type_counter
                .with_label_values(&["_", "heartbeat", "_"])
                .inc();
            server_params
                .metrics
                .redis_publish_success_counter
                .with_label_values(&[topic])
                .inc();
            server_params
                .metrics
                .redis_publish_subscribers
                .with_label_values(&[topic])
                .set(receivers);
        }
        Err(e) => {
            log::error!(
                target: "redis",
                "{log_prefix}: failed to publish heartbeat, error: {e:?}"
            );
            server_params
                .metrics
                .redis_publish_fail_counter
                .with_label_values(&[topic])
                .inc();
        }
    }
}

pub async fn deposit_trade(
    State(server_params): State<&'static ServerParams>,
    Json(req): Json<DepositAndPlaceRequest>,
) -> impl axum::response::IntoResponse {
    let context = RequestContext::from_incoming_message(&req.swift_order);
    if context.is_err() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(ProcessOrderResponse {
                message: PROCESS_ORDER_RESPONSE_INVALID_UUID_UTF8,
                error: None,
            }),
        );
    }
    let context = context.unwrap();
    let current_slot = server_params.slot_subscriber.current_slot();

    let signed_order_info = req
        .swift_order
        .order()
        .info(&req.swift_order.taker_authority);
    let max_margin_ratio = match extract_signed_message_info(
        &req.swift_order.order(),
        &req.swift_order.taker_authority,
        current_slot,
    ) {
        Ok((_info, max_margin_ratio, _is_isolated)) => max_margin_ratio,
        Err((_status, err)) => return (StatusCode::BAD_REQUEST, Json(err)),
    };

    log::info!(
        target: "server",
        "{} depositToTrade request | authority={:?},subaccount={:?}",
        context.log_prefix,
        req.swift_order.taker_authority,
        req.swift_order.taker_pubkey
    );

    if req.deposit_tx.signatures.is_empty()
        || req.deposit_tx.verify_with_results().iter().any(|x| !*x)
    {
        log::info!(target: "server", "{} invalid deposit tx", context.log_prefix);
        return (
            StatusCode::BAD_REQUEST,
            Json(ProcessOrderResponse {
                message: "",
                error: Some("invalid deposit tx".into()),
            }),
        );
    }

    // verify place order ix exists
    let mut has_place_ix = false;
    for ix in req.deposit_tx.message.instructions() {
        if ix.data.len() > 8
            && &ix.data[..8] == drift_idl::instructions::PlaceSignedMsgTakerOrder::DISCRIMINATOR
        {
            has_place_ix = true;
        }
    }

    if !has_place_ix {
        log::info!(target: "server", "{} missing place order ix", context.log_prefix);
        return (
            StatusCode::BAD_REQUEST,
            Json(ProcessOrderResponse {
                message: "",
                error: Some("missing placeSignedMsgTakerOrder ix".into()),
            }),
        );
    }

    // ensure deposit tx is valid
    let mut user_after_deposit = None;
    match simulate_tx(
        &server_params.drift,
        req.deposit_tx.message.clone(),
        &[req.swift_order.taker_pubkey],
    )
    .await
    {
        Ok(res) => {
            if let Some(err) = res.err {
                log::info!(
                    target: "server",
                    "{} deposit sim failed: {err:?}, logs: {:?}",
                    context.log_prefix,
                    res.logs
                );
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ProcessOrderResponse {
                        message: "",
                        error: Some("invalid deposit tx".into()),
                    }),
                );
            }
            if let Some(acc) = res.accounts {
                user_after_deposit = acc
                    .first()
                    .and_then(|a| a.as_ref())
                    .and_then(|a| a.data.decode())
                    .and_then(|data| User::try_deserialize(&mut data.as_slice()).ok());
            }
        }
        Err(err) => {
            log::info!(
                target: "server",
                "{} deposit sim network err: {err:?}",
                context.log_prefix,
            );
        }
    }

    if let Some(user) = user_after_deposit {
        if !server_params.simulate_taker_order_local(
            &signed_order_info.order_params,
            &user,
            max_margin_ratio,
            &context,
        ) {
            log::info!(target: "server", "{} local order sim failed", context.log_prefix);
            return (
                StatusCode::BAD_REQUEST,
                Json(ProcessOrderResponse {
                    message: "",
                    error: Some("invalid order".into()),
                }),
            );
        }
    }

    // TODO: deposit tx should enable sim to pass, if it didn't before otherwise order is invalid
    let (status, resp) = match process_order(server_params, req.swift_order, true, &context).await {
        Ok(order_metadata) => {
            let metrics_labels = &[
                context.market_type,
                &context.market_index.to_string(),
                match order_metadata.will_sanitize {
                    true => "true",
                    false => "false",
                },
            ];
            let topic = format!(
                "swift_orders_deposit_{}_{}",
                metrics_labels[0], metrics_labels[1]
            );
            let payload = serde_json::json!({
                "deposit": base64::prelude::BASE64_STANDARD
                .encode(bincode::serialize(&req.deposit_tx).unwrap()),
                "order": order_metadata.encode(),
            })
            .to_string();

            server_params
                .publish_order(
                    &topic,
                    &payload,
                    order_metadata.uuid(),
                    metrics_labels,
                    &context,
                )
                .await
        }
        Err(err) => err,
    };

    (status, Json(resp))
}

pub async fn health_check(
    State(server_params): State<&'static ServerParams>,
) -> impl axum::response::IntoResponse {
    let ws_healthy = server_params.drift.ws().is_running();
    let slot_sub_healthy = !server_params.slot_subscriber.is_stale();

    // Check if optional accounts are healthy
    let user_account_fetcher_redis_health = if server_params.user_account_fetcher.redis.is_some() {
        server_params
            .user_account_fetcher
            .check_redis_health()
            .await
    } else {
        true
    };

    let redis_health = {
        let mut conn = server_params.redis_pool.clone();
        let ping_result: redis::RedisResult<String> = conn.ping().await;
        ping_result.is_ok()
    };

    // Check if server has metadata available for all spot and perp markets
    let market_subs_healthy = server_params.drift.state_account().is_ok_and(|s| {
        s.number_of_spot_markets
            == server_params
                .drift
                .program_data()
                .spot_market_configs()
                .len() as u16
            && s.number_of_markets
                == server_params
                    .drift
                    .program_data()
                    .perp_market_configs()
                    .len() as u16
    });

    // Check if rpc is healthy
    let rpc_healthy = server_params.drift.rpc().get_health().await.is_ok();

    if ws_healthy
        && slot_sub_healthy
        && user_account_fetcher_redis_health
        && redis_health
        && rpc_healthy
        && market_subs_healthy
    {
        (axum::http::StatusCode::OK, "ok".into())
    } else {
        let msg = format!(
            "slot_sub_healthy={slot_sub_healthy} | ws_sub_healthy={ws_healthy} 
            | user_account_fetcher_healthy={user_account_fetcher_redis_health} |
            redis_healthy={redis_health}|rpc_healthy={rpc_healthy}|market_subs={market_subs_healthy}",
        );
        log::error!(target: "server", "Failed health check {}", &msg);
        (axum::http::StatusCode::PRECONDITION_FAILED, msg)
    }
}

pub async fn start_server() {
    // Start server
    dotenv().ok();

    let drift_env = env::var("ENV").unwrap_or("devnet".to_string());

    log::info!(target: "server", "ENV: {drift_env}");

    let redis_pool = {
        let elasticache_host =
            env::var("ELASTICACHE_HOST").unwrap_or_else(|_| "localhost".to_string());
        let elasticache_port = env::var("ELASTICACHE_PORT").unwrap_or_else(|_| "6379".to_string());
        let use_ssl = env::var("USE_SSL")
            .unwrap_or_else(|_| "false".to_string())
            .to_lowercase()
            == "true";
        let connection_string = if use_ssl {
            format!("rediss://{}:{}", elasticache_host, elasticache_port)
        } else {
            format!("redis://{}:{}", elasticache_host, elasticache_port)
        };
        log::info!(target: "redis", "connecting to redis at {connection_string}");
        let client = redis::Client::open(connection_string).expect("valid redis URL");
        client
            .get_multiplexed_tokio_connection()
            .await
            .expect("redis connected")
    };

    let rpc_endpoint =
        drift_rs::utils::get_http_url(&env::var("ENDPOINT").expect("valid rpc endpoint"))
            .expect("valid RPC endpoint");

    // Registry for metrics
    let registry = Registry::new();
    let metrics = SwiftServerMetrics::new();
    metrics.register(&registry);

    let context = match drift_env.as_str() {
        "devnet" => Context::DevNet,
        "mainnet-beta" => Context::MainNet,
        _ => panic!("Invalid drift environment: {drift_env}"),
    };
    let wallet = Wallet::new(Keypair::new());
    let client = DriftClient::new(context, RpcClient::new(rpc_endpoint), wallet)
        .await
        .expect("initialized client");

    let user_account_fetcher = UserAccountFetcher::from_env(client.clone()).await;

    // Slot subscriber
    let mut ws_clients = vec![];
    for (_k, ws_endpoint) in std::env::vars().filter(|(k, _v)| k.starts_with("WS_ENDPOINT")) {
        ws_clients.push(Arc::new(PubsubClient::new(&ws_endpoint).await.unwrap()));
    }
    assert!(
        !ws_clients.is_empty(),
        "no slot subscribers provided: set WS_ENDPOINT_*"
    );
    let mut slot_subscriber = SuperSlotSubscriber::new(ws_clients, client.rpc());
    slot_subscriber.subscribe();

    // Set ignore pubkeys
    let ignore_pubkeys = env::var("IGNORE_PUBKEYS").unwrap_or_else(|_| "".to_string());
    let pubkeys = ignore_pubkeys
        .split(',')
        .map(|s| s.trim()) // remove extra whitespace
        .filter_map(|s| match s.parse::<Pubkey>() {
            Ok(key) => Some(key),
            Err(_) => {
                log::warn!(target: "server", "Warning: invalid pubkey skipped for ignore pubkeys: {s:?}");
                None
            }
        });

    let state: &'static ServerParams = Box::leak(Box::new(ServerParams {
        drift: client,
        slot_subscriber: Arc::new(slot_subscriber),
        metrics,
        redis_pool,
        user_account_fetcher,
        config: Arc::new(Config::from_env()),
        farmer_pubkeys: HashSet::from_iter(pubkeys),
    }));

    // start oracle/market subscriptions (async)
    tokio::spawn(async move {
        let mut all_markets = state.drift.get_all_market_ids();

        // keep markets in settlement mode for tx simulation
        for market in state.drift.program_data().perp_market_configs() {
            if market.status == MarketStatus::Settlement {
                all_markets.push(MarketId::perp(market.market_index));
            }
        }

        for market in state.drift.program_data().spot_market_configs() {
            if market.status == MarketStatus::Settlement {
                all_markets.push(MarketId::spot(market.market_index));
            }
        }

        log::info!("subscribing markets: {:?}", &all_markets);
        if let Err(err) = state.drift.subscribe_markets(&all_markets).await {
            log::error!("couldn't subscribe markets: {err:?}, RPC sim disabled!");
            state.disable_rpc_sim();
        }
        if let Err(err) = state.drift.subscribe_oracles(&all_markets).await {
            log::error!("couldn't subscribe oracles: {err:?}, RPC sim disabled!");
            state.disable_rpc_sim();
        }

        if let Err(err) = state.drift.subscribe_blockhashes().await {
            log::error!("couldn't subscribe to blockhashes: {err:?}, RPC sim disabled!");
            state.disable_rpc_sim();
        }
    });

    // App
    let host = env::var("HOST").unwrap_or("0.0.0.0".to_string());
    let port = env::var("PORT").unwrap_or("3000".to_string());
    let cors = CorsLayer::new()
        .allow_methods([Method::POST, Method::GET, Method::OPTIONS])
        .allow_headers(Any)
        .allow_origin(Any);
    let addr: SocketAddr = format!("{host}:{port}").parse().unwrap();
    let app = Router::new()
        .fallback(fallback)
        .route("/orders", post(process_order_wrapper))
        .route("/depositTrade", post(deposit_trade))
        .route("/health", get(health_check))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    log::info!("Swift server on {}", listener.local_addr().unwrap());

    // Metrics
    let registry = Arc::new(registry);
    let server_metrics_state = MetricsServerParams { registry };
    let metrics_addr: SocketAddr = format!(
        "0.0.0.0:{}",
        env::var("METRICS_PORT").unwrap_or("9464".to_string())
    )
    .parse()
    .unwrap();
    let metrics_app = Router::new()
        .route("/metrics", get(metrics_handler))
        .with_state(server_metrics_state);

    let listener_metrics = tokio::net::TcpListener::bind(&metrics_addr).await.unwrap();
    log::info!(
        "Swift metrics server on {}",
        listener_metrics.local_addr().unwrap()
    );

    // RPC sim loop to avoid rpc cold starts when orders are infrequent
    // Build tx once and just resign with new blockhash
    let rpc_sim_loop = tokio::spawn(async {
        let sender = Keypair::new();
        let receiver = Keypair::new();
        let instruction =
            system_instruction::transfer(&sender.pubkey(), &receiver.pubkey(), 1_000_000_000u64);

        let mut interval = tokio::time::interval(Duration::from_secs(5));

        loop {
            interval.tick().await;
            let message = Message::try_compile(
                &sender.pubkey(),
                std::slice::from_ref(&instruction),
                &[],
                Hash::default(),
            )
            .unwrap();
            let versioned_message = VersionedMessage::V0(message);
            let _ = state
                .drift
                .rpc()
                .simulate_transaction_with_config(
                    &VersionedTransaction {
                        message: versioned_message,
                        // must provide a signature for the RPC call to work
                        signatures: vec![Signature::new_unique()],
                    },
                    RpcSimulateTransactionConfig {
                        sig_verify: false,
                        replace_recent_blockhash: true,
                        ..Default::default()
                    },
                )
                .await;
        }
    });

    let send_heartbeat_loop = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            interval.tick().await;
            send_heartbeat(state).await;
        }
    });

    let axum_server = tokio::spawn(async { axum::serve(listener, app).await });
    let metrics_server = tokio::spawn(async { axum::serve(listener_metrics, metrics_app).await });

    let _ = tokio::try_join!(
        rpc_sim_loop,
        axum_server,
        metrics_server,
        send_heartbeat_loop
    );
}

/// Simple validation from program's `handle_signed_order_ix`
fn validate_signed_order_params(
    taker_order_params: &OrderParams,
    min_order_size: u64,
) -> Result<(), ErrorCode> {
    if !matches!(
        taker_order_params.order_type,
        OrderType::Market | OrderType::Oracle | OrderType::Limit
    ) {
        return Err(ErrorCode::InvalidOrderMarketType);
    }

    if !matches!(taker_order_params.market_type, MarketType::Perp) {
        return Err(ErrorCode::InvalidOrderMarketType);
    }

    if taker_order_params.base_asset_amount < min_order_size {
        // can always close reduce_only
        if !taker_order_params.reduce_only {
            log::info!(target: "server", "{} < {min_order_size}", taker_order_params.base_asset_amount);
            return Err(ErrorCode::InvalidOrderSizeTooSmall);
        }
    }

    // has_valid_auction_params
    if taker_order_params.auction_duration.is_some()
        && taker_order_params.auction_start_price.is_some()
        && taker_order_params.auction_end_price.is_some()
    {
        let start_price = taker_order_params.auction_start_price.unwrap();
        let end_price = taker_order_params.auction_end_price.unwrap();

        if taker_order_params.direction == PositionDirection::Long && start_price <= end_price
            || taker_order_params.direction == PositionDirection::Short && start_price >= end_price
        {
            Ok(())
        } else {
            log::info!(target: "server", "auction price reversed");
            Err(ErrorCode::InvalidOrderAuction)
        }
    } else if taker_order_params.order_type == OrderType::Limit
        && taker_order_params.auction_duration.is_none()
        && taker_order_params.auction_start_price.is_none()
        && taker_order_params.auction_end_price.is_none()
    {
        Ok(())
    } else {
        Err(ErrorCode::InvalidOrderAuction)
    }
}

#[derive(Debug)]
pub enum SimulationStatus {
    /// Success sim'd locally
    Success,
    Degraded,
    Timeout,
    Disabled,
    /// Success but sim'd over RPC
    SuccessRpc,
    /// Given leniency for collateral error
    SuccessCollateralBuffer,
}

impl SimulationStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Degraded => "degraded",
            Self::Timeout => "timeout",
            Self::Disabled => "disabled",
            Self::SuccessRpc => "successRpc",
            Self::SuccessCollateralBuffer => "successBuffer",
        }
    }
}

impl ServerParams {
    /// Toggle RPC simulation off
    pub fn disable_rpc_sim(&self) {
        self.config
            .disable_rpc_sim
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
    /// True if RPC simulation is set disabled
    pub fn is_rpc_sim_disabled(&self) -> bool {
        self.config
            .disable_rpc_sim
            .load(std::sync::atomic::Ordering::Relaxed)
    }
    fn simulate_taker_order_local(
        &self,
        order_params: &OrderParams,
        user: &drift_rs::types::accounts::User,
        max_margin_ratio: Option<u16>,
        context: &RequestContext,
    ) -> bool {
        let state_bytes = match self.drift.account_raw(state_account()) {
            Ok(b) => b,
            Err(err) => {
                log::warn!(
                    target: "sim",
                    "{}: state account fetch failed: {err:?}",
                    context.log_prefix
                );
                return false;
            }
        };

        let mut accounts_builder = AccountsListBuilder::default();
        let accounts = match accounts_builder.try_build(
            &self.drift,
            user,
            &[MarketId::new(
                order_params.market_index,
                order_params.market_type,
            )],
        ) {
            Ok(a) => a,
            Err(err) => {
                log::warn!(
                    target: "sim",
                    "{}: couldn't build accounts for sim: {err:?}",
                    context.log_prefix
                );
                return false;
            }
        };

        match crate::util::local_sim::simulate_place_perp_order(
            user,
            accounts,
            &state_bytes,
            *order_params,
            max_margin_ratio,
        ) {
            Ok(()) => true,
            Err(err) => {
                log::debug!(
                    target: "sim",
                    "{}: local sim failed: {err:?}",
                    context.log_prefix
                );
                false
            }
        }
    }
    /// Simulate the taker placing a perp order via RPC, tries local sim first
    async fn simulate_taker_order_rpc(
        &self,
        taker_subaccount_pubkey: &Pubkey,
        taker_order_params: &OrderParams,
        delegate_signer: Option<&Pubkey>,
        slot: Slot,
        max_margin_ratio: Option<u16>,
        isolated_deposit: Option<u64>,
        context: &RequestContext,
    ) -> Result<SimulationStatus, (axum::http::StatusCode, String, Option<Vec<String>>)> {
        let mut sim_result = SimulationStatus::Disabled;

        let t0 = SystemTime::now();

        if let Some(delegate) = delegate_signer {
            log::debug!(
                target: "sim",
                "{}: delegate signer for sim: {delegate}",
                context.log_prefix
            );
        }

        let user_with_timeout = tokio::time::timeout(
            self.config.simulation_timeout,
            self.user_account_fetcher
                .get_user(taker_subaccount_pubkey, slot),
        )
        .await;

        if user_with_timeout.is_err() {
            sim_result = SimulationStatus::Timeout;
            warn!(
                target: "sim",
                "{}: simulateTransaction degraded (timeout)",
                context.log_prefix
            );
            return Ok(sim_result);
        }

        let user_result = user_with_timeout.unwrap();
        let user = user_result.map_err(|err| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("unable to fetch user: {err:?}"),
                None,
            )
        })?;

        // check the account delegate matches the signer
        // if delegate_signer.is_some_and(|d| d != &user.delegate) {
        //     return Err((
        //         axum::http::StatusCode::BAD_REQUEST,
        //         "signer is not configured delegate".to_string(),
        //     ));
        // }

        log::info!(
            target: "server",
            "{:?}: max_leverage={},activate_hlm={}",
            user.authority,
            taker_order_params.base_asset_amount == u64::MAX,
            taker_order_params.high_leverage_mode(),
        );

        if self.is_rpc_sim_disabled() {
            return Ok(sim_result);
        }

        let t1 = SystemTime::now();
        log::info!(
            target: "sim",
            "{}: fetch user: {:?}",
            context.log_prefix,
            SystemTime::now().duration_since(t0)
        );

        // TODO: isolated deposits need changes for local simming
        if isolated_deposit.is_none()
            && self.simulate_taker_order_local(taker_order_params, &user, max_margin_ratio, context)
        {
            sim_result = SimulationStatus::Success;
            log::info!(
                target: "sim",
                "{}: simulate tx (local): {:?}",
                context.log_prefix,
                SystemTime::now().duration_since(t1)
            );
            return Ok(sim_result);
        }

        // fallback to network sim
        let mut tx = TransactionBuilder::new(
            self.drift.program_data(),
            *taker_subaccount_pubkey,
            std::borrow::Cow::Owned(user),
            false,
        )
        .with_priority_fee(5_000, Some(1_400_000));
        if let Some(margin_ratio) = max_margin_ratio {
            tx = tx.update_user_perp_position_custom_margin_ratio(
                taker_order_params.market_index,
                margin_ratio,
            );
        }
        if let Some(amount) = isolated_deposit {
            tx = tx.transfer_isolated_perp_position_deposit(
                amount as i64,
                taker_order_params.market_index,
            );
        }

        // always set fee payer to some other account with SOL
        // supports privey wallets and how a swift order is intended to be placed anyway
        let message = tx
            .place_orders(vec![*taker_order_params])
            .fee_payer(solana_pubkey::pubkey!(
                "Eiv8eZUWaEPMne8XjA6afzVJ2tJs1BJJ4a1MpZacMSRA"
            ))
            .build();

        let simulate_result_with_timeout = tokio::time::timeout(
            self.config.simulation_timeout,
            self.drift.rpc().simulate_transaction_with_config(
                &VersionedTransaction {
                    message,
                    // must provide placerholder signature(s) for the RPC call to work
                    // signer + fee payer
                    signatures: vec![Signature::new_unique(), Signature::new_unique()],
                },
                RpcSimulateTransactionConfig {
                    sig_verify: false,
                    replace_recent_blockhash: true,
                    commitment: Some(CommitmentConfig::confirmed()),
                    min_context_slot: Some(slot - 30), // allow tx sim on up to 30 slots stale context
                    ..Default::default()
                },
            ),
        )
        .await;

        match simulate_result_with_timeout {
            Ok(Ok(res)) => {
                if let Some(simulate_err) = res.value.err {
                    log::warn!(
                        target: "sim",
                        "{}: program sim error: {simulate_err:?}",
                        context.log_prefix
                    );
                    let err = SdkError::Rpc(Box::new(client_error::Error {
                        request: None,
                        kind: Box::new(client_error::ErrorKind::TransactionError(
                            simulate_err.to_owned().into(),
                        )),
                    }));
                    match err.to_anchor_error_code() {
                        Some(code) => {
                            // insufficient collateral is prone to precision errors, allow the order through with some leniency
                            // EXCEPT for isolated deposits, where we want to return the error to the client
                            if code == ProgramError::Drift(ErrorCode::InsufficientCollateral)
                                && isolated_deposit.is_none()
                            {
                                if let Some(ref logs) = res.value.logs {
                                    if let Some(collateral_ratio) = extract_collateral_ratio(logs) {
                                        if collateral_ratio <= COLLATERAL_BUFFER {
                                            log::info!(
                                                target: "sim",
                                                "{}: accepting undercollateralized order: {collateral_ratio}",
                                                context.log_prefix
                                            );
                                            log::info!(
                                                target: "sim",
                                                "{}: simulate tx (rpc): {:?}",
                                                context.log_prefix,
                                                SystemTime::now().duration_since(t1)
                                            );
                                            return Ok(SimulationStatus::SuccessCollateralBuffer);
                                        }
                                    }
                                }
                                if log::log_enabled!(target: "accountState", log::Level::Debug) {
                                    dump_account_state(
                                        &self.drift,
                                        taker_subaccount_pubkey,
                                        user,
                                        taker_order_params,
                                        res.context.slot,
                                        context,
                                    );
                                }
                            }
                            Err((
                                axum::http::StatusCode::BAD_REQUEST,
                                format!("invalid order. error code: {code:?}"),
                                res.value.logs,
                            ))
                        }
                        None => Err((
                            axum::http::StatusCode::BAD_REQUEST,
                            format!("invalid order: {simulate_err:?}"),
                            res.value.logs,
                        )),
                    }
                } else {
                    log::info!(
                        target: "sim",
                        "{}: simulate tx (rpc): {:?}",
                        context.log_prefix,
                        SystemTime::now().duration_since(t1)
                    );
                    sim_result = SimulationStatus::SuccessRpc;
                    Ok(sim_result)
                }
            }
            Ok(Err(err)) => {
                log::warn!(
                    target: "sim",
                    "{}: network sim error: {err:?}",
                    context.log_prefix
                );
                sim_result = SimulationStatus::Degraded;
                Ok(sim_result)
            }
            Err(_) => {
                sim_result = SimulationStatus::Timeout;
                Ok(sim_result)
            }
        }
    }

    /// Simulate if auction params will be sanitized
    fn simulate_will_auction_params_sanitize(
        &self,
        order_params: &OrderParams,
        context: &RequestContext,
    ) -> bool {
        let perp_market = match self
            .drift
            .try_get_perp_market_account(order_params.market_index)
        {
            Ok(m) => m,
            Err(err) => {
                log::debug!(
                    target: "sim",
                    "{}: couldn't get perp market: {err:?}",
                    context.log_prefix
                );
                return false;
            }
        };

        let market_id = MarketId::new(order_params.market_index, order_params.market_type);
        let oracle_data = match self.drift.try_get_oracle_price_data_and_slot(market_id) {
            Some(p) => p,
            None => {
                log::debug!(
                    target: "sim",
                    "{}: oracle price is None",
                    context.log_prefix
                );
                return false;
            }
        };

        // Mirrors the on-chain `place_perp_order` sanitize step: returns true
        // when the program would adjust the auction params at placement time.
        let mut params = order_params.clone();
        match params.update_perp_auction_params(&perp_market, oracle_data.data.price, true) {
            Ok(sanitized) => sanitized,
            Err(err) => {
                log::debug!(
                    target: "sim",
                    "{}: local sim failed: {err:?}",
                    context.log_prefix
                );
                true
            }
        }
    }

    async fn publish_order(
        &self,
        topic: &str,
        payload: &String,
        uuid: &str,
        metrics_labels: &[&str; 3],
        context: &RequestContext,
    ) -> (axum::http::StatusCode, ProcessOrderResponse) {
        let mut conn = self.redis_pool.clone();
        let publish_start = std::time::Instant::now();
        let result: redis::RedisResult<i64> =
            conn.publish(topic.to_string(), payload.to_string()).await;
        let publish_rtt_ms = publish_start.elapsed().as_secs_f64() * 1000.0;
        self.metrics.redis_publish_latency.observe(publish_rtt_ms);

        match result {
            Ok(receivers) => {
                self.metrics
                    .order_type_counter
                    .with_label_values(metrics_labels)
                    .inc();
                self.metrics
                    .redis_publish_success_counter
                    .with_label_values(&[topic])
                    .inc();
                self.metrics
                    .redis_publish_subscribers
                    .with_label_values(&[topic])
                    .set(receivers);
                self.metrics
                    .response_time_histogram
                    .observe((unix_now_ms() - context.recv_ts) as f64);

                let publish_latency = unix_now_ms().saturating_sub(context.recv_ts);
                if receivers == 0 && topic != "heartbeat" {
                    log::warn!(
                        target: "redis",
                        "{} topic={topic}: published order {uuid} latency_ms={publish_latency} publish_rtt_ms={publish_rtt_ms:.2} receivers=0",
                        context.log_prefix
                    );
                } else {
                    log::info!(
                        target: "redis",
                        "{} topic={topic}: published order {uuid} latency_ms={publish_latency} publish_rtt_ms={publish_rtt_ms:.2} receivers={receivers}",
                        context.log_prefix
                    );
                }
                (
                    axum::http::StatusCode::OK,
                    ProcessOrderResponse {
                        message: PROCESS_ORDER_RESPONSE_MESSAGE_SUCCESS,
                        error: None,
                    },
                )
            }
            Err(e) => {
                log::error!(
                    target: "redis",
                    "{} topic={topic}: failed to publish order {uuid}, error: {e:?}",
                    context.log_prefix
                );
                self.metrics
                    .redis_publish_fail_counter
                    .with_label_values(&[topic])
                    .inc();
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    ProcessOrderResponse {
                        message: PROCESS_ORDER_RESPONSE_ERROR_MSG_DELIVERY_FAILED,
                        error: Some(format!("redis publish error: {e:?}")),
                    },
                )
            }
        }
    }
}

/// extract collateral ratio from program sim logs
fn extract_collateral_ratio(logs: &[String]) -> Option<f64> {
    for line in logs {
        if line.contains("Program log: total_collateral=") {
            let parts: Vec<&str> = line.split(',').collect();
            if parts.len() >= 2 {
                // Extract total_collateral
                let total_collateral_part = parts[0];
                let margin_requirement_part = parts[1];

                let total_collateral = total_collateral_part
                    .split('=')
                    .nth(1)?
                    .trim()
                    .parse::<f64>()
                    .ok()?;

                let margin_requirement = margin_requirement_part
                    .split('=')
                    .nth(1)?
                    .trim()
                    .parse::<f64>()
                    .ok()?;

                if total_collateral != 0.0 {
                    return Some(margin_requirement / total_collateral);
                }
            }
        }
    }
    None
}

fn validate_order(
    stop_loss: Option<&SignedMsgTriggerOrderParams>,
    take_profit: Option<&SignedMsgTriggerOrderParams>,
    taker_slot: Slot,
    current_slot: Slot,
) -> Result<(), (axum::http::StatusCode, ProcessOrderResponse)> {
    // Validate order parameters
    if stop_loss.is_some_and(|x| x.base_asset_amount == 0 || x.trigger_price == 0)
        || take_profit.is_some_and(|x| x.base_asset_amount == 0 || x.trigger_price == 0)
    {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            ProcessOrderResponse {
                message: PROCESS_ORDER_RESPONSE_ERROR_MSG_INVALID_ORDER_AMOUNT,
                error: None,
            },
        ));
    }

    // Validate slot
    if taker_slot < current_slot - 500 {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            ProcessOrderResponse {
                message: PROCESS_ORDER_RESPONSE_ERROR_MSG_ORDER_SLOT_TOO_OLD,
                error: Some(PROCESS_ORDER_RESPONSE_ERROR_MSG_ORDER_SLOT_TOO_OLD.to_string()),
            },
        ));
    }

    Ok(())
}

fn extract_signed_message_info(
    signed_msg: &SignedOrderType,
    taker_authority: &Pubkey,
    current_slot: Slot,
) -> Result<
    (SignedMessageInfo, Option<u16>, Option<u64>),
    (axum::http::StatusCode, ProcessOrderResponse),
> {
    match signed_msg {
        SignedOrderType::Delegated { inner, .. } => {
            validate_order(
                inner.stop_loss_order_params.as_ref(),
                inner.take_profit_order_params.as_ref(),
                inner.slot,
                current_slot,
            )?;
            Ok((
                SignedMessageInfo {
                    taker_pubkey: inner.taker_pubkey,
                    order_params: inner.signed_msg_order_params,
                    uuid: inner.uuid,
                    slot: inner.slot,
                },
                inner.max_margin_ratio,
                inner.isolated_position_deposit,
            ))
        }
        SignedOrderType::Authority { inner, .. } => {
            validate_order(
                inner.stop_loss_order_params.as_ref(),
                inner.take_profit_order_params.as_ref(),
                inner.slot,
                current_slot,
            )?;
            Ok((
                SignedMessageInfo {
                    taker_pubkey: Wallet::derive_user_account(
                        taker_authority,
                        inner.sub_account_id,
                    ),
                    order_params: inner.signed_msg_order_params,
                    uuid: inner.uuid,
                    slot: inner.slot,
                },
                inner.max_margin_ratio,
                inner.isolated_position_deposit,
            ))
        }
    }
}

fn dump_account_state(
    drift: &DriftClient,
    taker_subaccount_pubkey: &Pubkey,
    user: User,
    taker_order_params: &OrderParams,
    slot: Slot,
    context: &RequestContext,
) {
    log::info!(
    target: "accountState",
    "{}: dumping account state: user:{},authority:{},slot:{}",
    context.log_prefix,
    taker_subaccount_pubkey,
    user.authority,
    slot
    );
    let mut debug_log = String::with_capacity(8192 * 2);
    debug_log.push_str("user:");
    base64::engine::general_purpose::STANDARD
        .encode_string(drift_rs::utils::zero_account_to_bytes(user), &mut debug_log);
    debug_log.push('|');
    for p in user.spot_positions.iter().filter(|p| !p.is_available()) {
        if let Ok(market) = drift.try_get_spot_market_account(p.market_index) {
            debug_log.push_str(&format!("spotMarket-{}:", p.market_index,));
            base64::engine::general_purpose::STANDARD.encode_string(
                drift_rs::utils::zero_account_to_bytes(market),
                &mut debug_log,
            );
            debug_log.push('|');
        }
        if let Some(oracle) =
            drift.try_get_oracle_price_data_and_slot(MarketId::spot(p.market_index))
        {
            debug_log.push_str(&format!("oracle-{:?}-{}:", oracle.source, oracle.pubkey));
            base64::engine::general_purpose::STANDARD.encode_string(oracle.raw, &mut debug_log);
            debug_log.push('|');
        }
    }
    for p in user.perp_positions.iter().filter(|p| p.is_open_position()) {
        if let Ok(market) = drift.try_get_perp_market_account(p.market_index) {
            debug_log.push_str(&format!("perpMarket-{}:", p.market_index,));
            base64::engine::general_purpose::STANDARD.encode_string(
                drift_rs::utils::zero_account_to_bytes(market),
                &mut debug_log,
            );
            debug_log.push('|');
        }
        if let Some(oracle) =
            drift.try_get_oracle_price_data_and_slot(MarketId::perp(p.market_index))
        {
            debug_log.push_str(&format!("oracle-{:?}-{}:", oracle.source, oracle.pubkey));
            base64::engine::general_purpose::STANDARD.encode_string(oracle.raw, &mut debug_log);
            debug_log.push('|');
        }
    }

    if let Ok(market) = drift.try_get_perp_market_account(taker_order_params.market_index) {
        debug_log.push_str(&format!("perpMarket-{}:", taker_order_params.market_index,));
        base64::engine::general_purpose::STANDARD.encode_string(
            drift_rs::utils::zero_account_to_bytes(market),
            &mut debug_log,
        );
        debug_log.push('|');
    }

    if let Some(oracle) =
        drift.try_get_oracle_price_data_and_slot(MarketId::perp(taker_order_params.market_index))
    {
        debug_log.push_str(&format!("oracle-{:?}-{}:", oracle.source, oracle.pubkey,));
        base64::engine::general_purpose::STANDARD.encode_string(oracle.raw, &mut debug_log);
        debug_log.push('|');
    }

    let compressed = zstd::encode_all(debug_log.as_bytes(), 0).expect("encoded");
    log::debug!(target: "accountState", "{}", base64::engine::general_purpose::STANDARD.encode(compressed));
}

/// Simulate the tx on remote RPC node
pub async fn simulate_tx(
    drift: &DriftClient,
    tx: VersionedMessage,
    accounts: &[Pubkey],
) -> SdkResult<RpcSimulateTransactionResult> {
    let response = drift
        .rpc()
        .simulate_transaction_with_config(
            &VersionedTransaction {
                message: tx,
                // must provide a signature for the RPC call to work
                signatures: vec![Signature::new_unique()],
            },
            RpcSimulateTransactionConfig {
                sig_verify: false,
                replace_recent_blockhash: true,
                accounts: Some(RpcSimulateTransactionAccountsConfig {
                    encoding: Some(UiAccountEncoding::Base64Zstd),
                    addresses: accounts.iter().map(|x| x.to_string()).collect(),
                }),
                ..Default::default()
            },
        )
        .await;
    response.map(|r| r.value).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use drift_rs::types::{
        accounts::User, SignedMsgOrderParamsDelegateMessage, SignedMsgOrderParamsMessage,
        SignedMsgTriggerOrderParams,
    };
    use ed25519_dalek::Signature as Ed25519Signature;
    use solana_native_token::LAMPORTS_PER_SOL;

    fn is_isolated_deposit(signed_msg: &SignedOrderType) -> bool {
        match signed_msg {
            SignedOrderType::Delegated { inner, .. } => inner
                .isolated_position_deposit
                .is_some_and(|amount| amount > 0),
            SignedOrderType::Authority { inner, .. } => inner
                .isolated_position_deposit
                .is_some_and(|amount| amount > 0),
        }
    }

    fn create_test_order_params(
        order_type: OrderType,
        market_type: MarketType,
        base_asset_amount: u64,
        direction: PositionDirection,
        auction_params: Option<(u8, i64, i64)>, // (duration, start_price, end_price)
    ) -> OrderParams {
        let (auction_duration, auction_start_price, auction_end_price) =
            auction_params.unwrap_or((0, 0, 0));
        OrderParams {
            market_index: 0,
            market_type,
            order_type,
            base_asset_amount,
            price: 1_000,
            direction,
            auction_duration: if auction_duration > 0 {
                Some(auction_duration)
            } else {
                None
            },
            auction_start_price: if auction_start_price > 0 {
                Some(auction_start_price)
            } else {
                None
            },
            auction_end_price: if auction_end_price > 0 {
                Some(auction_end_price)
            } else {
                None
            },
            ..Default::default()
        }
    }

    #[test]
    fn test_validate_market_type() {
        let min_order_size = 1 * LAMPORTS_PER_SOL;

        // Test valid market type
        let params = create_test_order_params(
            OrderType::Market,
            MarketType::Perp,
            min_order_size,
            PositionDirection::Long,
            Some((1, 99, 100)),
        );
        assert!(validate_signed_order_params(&params, min_order_size).is_ok());

        // Test invalid market type
        let params = create_test_order_params(
            OrderType::Market,
            MarketType::Spot,
            min_order_size,
            PositionDirection::Long,
            Some((1, 99, 100)),
        );
        assert_eq!(
            validate_signed_order_params(&params, min_order_size),
            Err(ErrorCode::InvalidOrderMarketType)
        );
    }

    #[test]
    fn test_validate_order_size() {
        let min_order_size = 1 * LAMPORTS_PER_SOL;

        // Test valid order size
        let params = create_test_order_params(
            OrderType::Market,
            MarketType::Perp,
            min_order_size,
            PositionDirection::Long,
            Some((1, 99, 100)),
        );
        assert!(validate_signed_order_params(&params, min_order_size).is_ok());

        // Test invalid order size
        let params = create_test_order_params(
            OrderType::Market,
            MarketType::Perp,
            min_order_size - 1,
            PositionDirection::Long,
            None,
        );
        assert_eq!(
            validate_signed_order_params(&params, min_order_size),
            Err(ErrorCode::InvalidOrderSizeTooSmall)
        );
    }

    #[test]
    fn test_validate_auction_params() {
        let min_order_size = 1 * LAMPORTS_PER_SOL;

        // Test valid auction params for long position
        let params = create_test_order_params(
            OrderType::Limit,
            MarketType::Perp,
            min_order_size,
            PositionDirection::Long,
            Some((100, 1000, 1100)), // start < end for long
        );
        assert!(validate_signed_order_params(&params, min_order_size).is_ok());

        // Test valid auction params for short position
        let params = create_test_order_params(
            OrderType::Limit,
            MarketType::Perp,
            min_order_size,
            PositionDirection::Short,
            Some((100, 1100, 1000)), // start > end for short
        );
        assert!(validate_signed_order_params(&params, min_order_size).is_ok());

        // Test invalid auction params for long position
        let params = create_test_order_params(
            OrderType::Limit,
            MarketType::Perp,
            min_order_size,
            PositionDirection::Long,
            Some((100, 1100, 1000)), // start > end for long (invalid)
        );
        assert_eq!(
            validate_signed_order_params(&params, min_order_size),
            Err(ErrorCode::InvalidOrderAuction)
        );

        // Test invalid auction params for short position
        let params = create_test_order_params(
            OrderType::Limit,
            MarketType::Perp,
            min_order_size,
            PositionDirection::Short,
            Some((100, 1000, 1100)), // start < end for short (invalid)
        );
        assert_eq!(
            validate_signed_order_params(&params, min_order_size),
            Err(ErrorCode::InvalidOrderAuction)
        );

        // Test limit order with no auction params
        let params = create_test_order_params(
            OrderType::Limit,
            MarketType::Perp,
            min_order_size,
            PositionDirection::Long,
            None,
        );
        assert!(validate_signed_order_params(&params, min_order_size).is_ok());

        let params = create_test_order_params(
            OrderType::Limit,
            MarketType::Perp,
            min_order_size,
            PositionDirection::Long,
            Some((100, 1000, 1100)),
        );
        assert_eq!(
            validate_signed_order_params(&params, min_order_size),
            Ok(())
        );
    }

    #[test]
    fn test_request_context_from_incoming_message_valid_utf8() {
        let taker = Pubkey::new_unique();
        let uuid_valid: [u8; 8] = [b'a', b'b', b'c', b'd', b'e', b'f', b'g', b'h'];
        let authority_msg = SignedOrderType::authority(SignedMsgOrderParamsMessage {
            sub_account_id: 0,
            signed_msg_order_params: OrderParams {
                market_index: 2,
                market_type: MarketType::Perp,
                order_type: OrderType::Market,
                base_asset_amount: LAMPORTS_PER_SOL,
                price: 1000,
                direction: PositionDirection::Long,
                ..Default::default()
            },
            uuid: uuid_valid,
            slot: 1000,
            stop_loss_order_params: None,
            take_profit_order_params: None,
            max_margin_ratio: None,
            builder_fee_tenth_bps: None,
            builder_idx: None,
            isolated_position_deposit: None,
        });
        let msg = IncomingSignedMessage {
            taker_pubkey: taker,
            signature: Ed25519Signature::from_bytes(&[0u8; 64]).unwrap(),
            message: authority_msg,
            signing_authority: Pubkey::default(),
            taker_authority: Pubkey::default(),
        };
        let ctx = RequestContext::from_incoming_message(&msg).expect("valid utf8 uuid");
        assert_eq!(ctx.order_uuid, "abcdefgh");
        assert_eq!(ctx.market_index, 2);
        assert_eq!(ctx.market_type, "perp");
        assert_eq!(ctx.taker_authority, taker);
    }

    #[test]
    fn test_request_context_from_incoming_message_invalid_utf8() {
        let taker = Pubkey::new_unique();
        let uuid_invalid: [u8; 8] = [0xFF; 8];
        let authority_msg = SignedOrderType::authority(SignedMsgOrderParamsMessage {
            sub_account_id: 0,
            signed_msg_order_params: OrderParams {
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Market,
                base_asset_amount: LAMPORTS_PER_SOL,
                price: 1000,
                direction: PositionDirection::Long,
                ..Default::default()
            },
            uuid: uuid_invalid,
            slot: 1000,
            stop_loss_order_params: None,
            take_profit_order_params: None,
            max_margin_ratio: None,
            builder_fee_tenth_bps: None,
            builder_idx: None,
            isolated_position_deposit: None,
        });
        let msg = IncomingSignedMessage {
            taker_pubkey: taker,
            signature: Ed25519Signature::from_bytes(&[0u8; 64]).unwrap(),
            message: authority_msg,
            signing_authority: Pubkey::default(),
            taker_authority: Pubkey::default(),
        };
        assert!(RequestContext::from_incoming_message(&msg).is_err());
    }

    #[test]
    fn test_extract_signed_message_info_delegated() {
        let taker_authority = Pubkey::new_unique();
        let current_slot = 1000;

        // Test successful case
        let delegated_msg = SignedOrderType::delegated(SignedMsgOrderParamsDelegateMessage {
            taker_pubkey: Pubkey::new_unique(),
            signed_msg_order_params: OrderParams {
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Market,
                base_asset_amount: LAMPORTS_PER_SOL,
                price: 1000,
                direction: PositionDirection::Long,
                ..Default::default()
            },
            uuid: [1; 8],
            slot: current_slot,
            stop_loss_order_params: None,
            take_profit_order_params: None,
            max_margin_ratio: None,
            builder_fee_tenth_bps: None,
            builder_idx: None,
            isolated_position_deposit: None,
        });

        let result = extract_signed_message_info(&delegated_msg, &taker_authority, current_slot);
        assert!(result.is_ok_and(|(info, _, _)| {
            info.slot == current_slot
                && info.order_params.base_asset_amount == LAMPORTS_PER_SOL
                && info.order_params.order_type == OrderType::Market
        }));

        // Test invalid order amount case
        let delegated_msg = SignedOrderType::delegated(SignedMsgOrderParamsDelegateMessage {
            taker_pubkey: Pubkey::new_unique(),
            signed_msg_order_params: OrderParams {
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Market,
                base_asset_amount: LAMPORTS_PER_SOL,
                price: 1000,
                direction: PositionDirection::Long,
                ..Default::default()
            },
            uuid: [1; 8],
            slot: current_slot,
            stop_loss_order_params: Some(SignedMsgTriggerOrderParams {
                base_asset_amount: 0,
                ..Default::default()
            }),
            take_profit_order_params: None,
            max_margin_ratio: None,
            builder_fee_tenth_bps: None,
            builder_idx: None,
            isolated_position_deposit: None,
        });

        let result = extract_signed_message_info(&delegated_msg, &taker_authority, current_slot);
        assert!(result.is_err_and(|x| {
            x.0 == axum::http::StatusCode::BAD_REQUEST
                && x.1.message == PROCESS_ORDER_RESPONSE_ERROR_MSG_INVALID_ORDER_AMOUNT
                && x.1.error.is_none()
        }));
    }

    #[test]
    fn test_extract_signed_message_info_authority() {
        let taker_authority = Pubkey::new_unique();
        let current_slot = 1000;
        let sub_account_id = 1;

        // Test successful case
        let authority_msg = SignedOrderType::authority(SignedMsgOrderParamsMessage {
            sub_account_id,
            signed_msg_order_params: OrderParams {
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Market,
                base_asset_amount: LAMPORTS_PER_SOL,
                price: 1000,
                direction: PositionDirection::Long,
                ..Default::default()
            },
            uuid: [1; 8],
            slot: current_slot,
            stop_loss_order_params: None,
            take_profit_order_params: None,
            max_margin_ratio: None,
            builder_fee_tenth_bps: None,
            builder_idx: None,
            isolated_position_deposit: None,
        });

        let result = extract_signed_message_info(&authority_msg, &taker_authority, current_slot);
        assert!(result.is_ok_and(|(info, _margin_ratio, _is_isolated)| {
            info.slot == current_slot
                && info.order_params.base_asset_amount == LAMPORTS_PER_SOL
                && info.order_params.order_type == OrderType::Market
                && info.taker_pubkey
                    == Wallet::derive_user_account(&taker_authority, sub_account_id)
        }));

        // Test invalid order amount case
        let authority_msg = SignedOrderType::authority(SignedMsgOrderParamsMessage {
            sub_account_id,
            signed_msg_order_params: OrderParams {
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Market,
                base_asset_amount: LAMPORTS_PER_SOL,
                price: 1000,
                direction: PositionDirection::Long,
                ..Default::default()
            },
            uuid: [1; 8],
            slot: current_slot,
            stop_loss_order_params: None,
            take_profit_order_params: Some(SignedMsgTriggerOrderParams {
                base_asset_amount: 0,
                ..Default::default()
            }),
            max_margin_ratio: None,
            builder_fee_tenth_bps: None,
            builder_idx: None,
            isolated_position_deposit: None,
        });

        let result = extract_signed_message_info(&authority_msg, &taker_authority, current_slot);
        assert!(result.is_err_and(|x| {
            x.0 == axum::http::StatusCode::BAD_REQUEST
                && x.1.message == PROCESS_ORDER_RESPONSE_ERROR_MSG_INVALID_ORDER_AMOUNT
                && x.1.error.is_none()
        }));
    }

    #[test]
    fn test_extract_signed_message_info_slot_validation() {
        let taker_authority = Pubkey::new_unique();
        let current_slot = 1000;

        // Test slot too old
        let delegated_msg = SignedOrderType::delegated(SignedMsgOrderParamsDelegateMessage {
            taker_pubkey: Pubkey::new_unique(),
            signed_msg_order_params: OrderParams {
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Market,
                base_asset_amount: LAMPORTS_PER_SOL,
                price: 1000,
                direction: PositionDirection::Long,
                ..Default::default()
            },
            uuid: [1; 8],
            slot: current_slot - 501, // Slot too old
            stop_loss_order_params: None,
            take_profit_order_params: None,
            max_margin_ratio: None,
            builder_fee_tenth_bps: None,
            builder_idx: None,
            isolated_position_deposit: None,
        });

        let result = extract_signed_message_info(&delegated_msg, &taker_authority, current_slot);
        assert!(result.is_err_and(|x| x
            == (
                axum::http::StatusCode::BAD_REQUEST,
                ProcessOrderResponse {
                    message: PROCESS_ORDER_RESPONSE_ERROR_MSG_ORDER_SLOT_TOO_OLD,
                    error: Some(PROCESS_ORDER_RESPONSE_ERROR_MSG_ORDER_SLOT_TOO_OLD.into())
                }
            )));
    }

    #[test]
    fn test_is_isolated_deposit() {
        let taker_authority = Pubkey::new_unique();
        let current_slot = 1000;

        // Test delegated order with no isolated deposit
        let delegated_msg = SignedOrderType::delegated(SignedMsgOrderParamsDelegateMessage {
            taker_pubkey: Pubkey::new_unique(),
            signed_msg_order_params: OrderParams {
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Market,
                base_asset_amount: LAMPORTS_PER_SOL,
                price: 1000,
                direction: PositionDirection::Long,
                ..Default::default()
            },
            uuid: [1; 8],
            slot: current_slot,
            stop_loss_order_params: None,
            take_profit_order_params: None,
            max_margin_ratio: None,
            builder_fee_tenth_bps: None,
            builder_idx: None,
            isolated_position_deposit: None,
        });
        assert!(!is_isolated_deposit(&delegated_msg));
        let result = extract_signed_message_info(&delegated_msg, &taker_authority, current_slot);
        assert!(result.is_ok_and(|(_, _, is_isolated)| is_isolated.is_none()));

        // Test delegated order with isolated deposit of 0 (should be false)
        let delegated_msg = SignedOrderType::delegated(SignedMsgOrderParamsDelegateMessage {
            taker_pubkey: Pubkey::new_unique(),
            signed_msg_order_params: OrderParams {
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Market,
                base_asset_amount: LAMPORTS_PER_SOL,
                price: 1000,
                direction: PositionDirection::Long,
                ..Default::default()
            },
            uuid: [1; 8],
            slot: current_slot,
            stop_loss_order_params: None,
            take_profit_order_params: None,
            max_margin_ratio: None,
            builder_fee_tenth_bps: None,
            builder_idx: None,
            isolated_position_deposit: Some(0),
        });
        assert!(!is_isolated_deposit(&delegated_msg));
        let result = extract_signed_message_info(&delegated_msg, &taker_authority, current_slot);
        assert!(result.is_ok_and(|(_, _, is_isolated)| is_isolated.is_none()));

        // Test delegated order with isolated deposit > 0
        let delegated_msg = SignedOrderType::delegated(SignedMsgOrderParamsDelegateMessage {
            taker_pubkey: Pubkey::new_unique(),
            signed_msg_order_params: OrderParams {
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Market,
                base_asset_amount: LAMPORTS_PER_SOL,
                price: 1000,
                direction: PositionDirection::Long,
                ..Default::default()
            },
            uuid: [1; 8],
            slot: current_slot,
            stop_loss_order_params: None,
            take_profit_order_params: None,
            max_margin_ratio: None,
            builder_fee_tenth_bps: None,
            builder_idx: None,
            isolated_position_deposit: Some(100_000_000), // 0.1 SOL
        });
        assert!(is_isolated_deposit(&delegated_msg));
        let result = extract_signed_message_info(&delegated_msg, &taker_authority, current_slot);
        assert!(result.is_ok_and(|(_, _, is_isolated)| is_isolated.is_some()));

        // Test authority order with no isolated deposit
        let authority_msg = SignedOrderType::authority(SignedMsgOrderParamsMessage {
            sub_account_id: 0,
            signed_msg_order_params: OrderParams {
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Market,
                base_asset_amount: LAMPORTS_PER_SOL,
                price: 1000,
                direction: PositionDirection::Long,
                ..Default::default()
            },
            uuid: [1; 8],
            slot: current_slot,
            stop_loss_order_params: None,
            take_profit_order_params: None,
            max_margin_ratio: None,
            builder_fee_tenth_bps: None,
            builder_idx: None,
            isolated_position_deposit: None,
        });
        assert!(!is_isolated_deposit(&authority_msg));
        let result = extract_signed_message_info(&authority_msg, &taker_authority, current_slot);
        assert!(result.is_ok_and(|(_, _, is_isolated)| is_isolated.is_none()));

        // Test authority order with isolated deposit > 0
        let authority_msg = SignedOrderType::authority(SignedMsgOrderParamsMessage {
            sub_account_id: 0,
            signed_msg_order_params: OrderParams {
                market_index: 0,
                market_type: MarketType::Perp,
                order_type: OrderType::Market,
                base_asset_amount: LAMPORTS_PER_SOL,
                price: 1000,
                direction: PositionDirection::Long,
                ..Default::default()
            },
            uuid: [1; 8],
            slot: current_slot,
            stop_loss_order_params: None,
            take_profit_order_params: None,
            max_margin_ratio: None,
            builder_fee_tenth_bps: None,
            builder_idx: None,
            isolated_position_deposit: Some(50_000_000), // 0.05 SOL
        });
        assert!(is_isolated_deposit(&authority_msg));
        let result = extract_signed_message_info(&authority_msg, &taker_authority, current_slot);
        assert!(result.is_ok_and(|(_, _, is_isolated)| is_isolated.is_some()));
    }

    #[tokio::test]
    async fn test_simulate_taker_order_rpc() {
        let _ = env_logger::try_init();
        // Create mock server params
        let drift = DriftClient::new(
            drift_rs::Context::DevNet,
            RpcClient::new("https://api.devnet.solana.com".to_string()),
            Keypair::new().into(),
        )
        .await
        .unwrap();

        let taker_pubkey = Keypair::new().pubkey();
        let taker_pubkey2 = Keypair::new().pubkey();
        let delegate_pubkey = Keypair::new().pubkey();
        let users: HashMap<Pubkey, User> = [
            (
                taker_pubkey,
                User {
                    authority: taker_pubkey,
                    delegate: Pubkey::default(),
                    ..Default::default()
                },
            ),
            (
                taker_pubkey2,
                User {
                    authority: taker_pubkey2,
                    delegate: delegate_pubkey,
                    ..Default::default()
                },
            ),
        ]
        .into();

        dbg!(users.contains_key(&taker_pubkey));
        dbg!(users.contains_key(&taker_pubkey2));

        let redis_pool = redis::Client::open("redis://localhost:6379")
            .expect("valid redis URL")
            .get_multiplexed_tokio_connection()
            .await
            .expect("redis connected");
        let server_params = ServerParams {
            slot_subscriber: Arc::new(SuperSlotSubscriber::new(vec![], drift.rpc())),
            metrics: SwiftServerMetrics::new(),
            user_account_fetcher: UserAccountFetcher::mock(users),
            config: Arc::new(crate::swift_server::Config::from_env()),
            drift,
            farmer_pubkeys: Default::default(),
            redis_pool,
        };

        // Create mock order params
        let order_params = OrderParams {
            market_index: 0,
            market_type: MarketType::Perp,
            order_type: OrderType::Market,
            base_asset_amount: 1 * LAMPORTS_PER_SOL,
            price: 1_000,
            direction: PositionDirection::Short,
            ..Default::default()
        };

        // Test
        let context_primary = RequestContext {
            recv_ts: unix_now_ms(),
            log_prefix: format!("[test-order {}]", taker_pubkey),
            market_index: order_params.market_index,
            market_type: "perp",
            taker_authority: taker_pubkey,
            order_uuid: "TESTORD0".into(),
        };

        let result = server_params
            .simulate_taker_order_rpc(
                &taker_pubkey,
                &order_params,
                Some(&delegate_pubkey),
                1_000,
                None,
                None,
                &context_primary,
            )
            .await;
        assert!(result.is_err_and(|(status, msg, _)| {
            dbg!(&msg);
            status == axum::http::StatusCode::BAD_REQUEST
                && msg.contains("signer is not configured delegate")
        }));

        let context_secondary = RequestContext {
            recv_ts: unix_now_ms(),
            log_prefix: format!("[test-order {}]", taker_pubkey2),
            market_index: order_params.market_index,
            market_type: "perp",
            taker_authority: taker_pubkey2,
            order_uuid: "TESTORD1".into(),
        };

        let result = server_params
            .simulate_taker_order_rpc(
                &taker_pubkey2,
                &order_params,
                Some(&delegate_pubkey),
                1_000,
                None,
                None,
                &context_secondary,
            )
            .await;
        // it fails later at remote sim since the account is not a real drift account
        assert!(result.is_err_and(|(status, msg, _)| {
            dbg!(&msg);
            status == axum::http::StatusCode::BAD_REQUEST
                && msg.contains("invalid order: AccountNotFound")
        }));
    }
}
