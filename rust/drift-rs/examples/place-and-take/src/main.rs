use anchor_lang::AccountDeserialize;
use drift_rs::{
    Context, DriftClient, RpcClient, TransactionBuilder, Wallet,
    types::{MarketType, OrderParams, OrderType, PositionDirection, PostOnlyParam, accounts::User},
};
use serde::Deserialize;
use solana_pubkey::Pubkey;
use std::str::FromStr;

#[derive(Debug, Deserialize)]
struct TopMakerResponse {
    #[serde(rename = "userAccountPubKey")]
    user_account_pubkey: String,
    #[serde(rename = "accountBase64")]
    account_base64: String,
}

async fn get_top_makers(
    context: Context,
    market_index: u16,
    market_type: MarketType,
    side: &str,
    limit: Option<usize>,
) -> Result<Vec<(Pubkey, User)>, Box<dyn std::error::Error>> {
    let dlob_server_url = if context == Context::MainNet {
        "https://dlob.drift.trade"
    } else {
        "https://master.dlob.drift.trade"
    };
    // NOTE: This parameter controls the number of top makers that will be returned.
    // It is suggested not to use more than 4, in our current testing the size of the transaction will larger than the current limits if you pass more than 4 makers in.
    let limit = limit.unwrap_or(4);

    let query_params = format!(
        "marketIndex={}&marketType={}&side={}&limit={}&includeAccounts=true",
        market_index,
        market_type.as_str(),
        side,
        limit
    );

    let url = format!("{dlob_server_url}/topMakers?{query_params}");
    println!("{url}");

    let response = reqwest::get(&url).await?;

    if !response.status().is_success() {
        return Err(format!("Failed to fetch top makers: HTTP {}", response.status()).into());
    }

    let makers: Vec<TopMakerResponse> = response.json().await?;

    if makers.is_empty() {
        return Ok(Vec::new());
    }

    let mut maker_infos = Vec::new();

    for maker in makers {
        // Decode the user account from base64
        let account_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &maker.account_base64,
        )?;
        let user_account = User::try_deserialize(&mut account_bytes.as_slice())
            .expect("User deserializes");
        let maker_pubkey = Pubkey::from_str(&maker.user_account_pubkey)?;

        maker_infos.push((maker_pubkey, user_account));
    }

    Ok(maker_infos)
}

#[tokio::main]
async fn main() {
    let _ = env_logger::init();
    let _ = dotenv::dotenv();
    let wallet: Wallet = (drift_rs::utils::load_keypair_multi_format(
        &std::env::var("PRIVATE_KEY").expect("base58 PRIVATE_KEY set"),
    )
    .unwrap())
    .into();

    let context = if std::env::var("MAINNET").is_ok() {
        Context::MainNet
    } else {
        Context::DevNet
    };
    let rpc_url = std::env::var("RPC_URL")
        .unwrap_or_else(|_| "https://api.mainnet-beta.solana.com".to_string());
    let drift = DriftClient::new(context, RpcClient::new(rpc_url), wallet.clone())
        .await
        .expect("initialized client");

    // choose a sub-account for order placement
    let maker_subaccount = wallet.default_sub_account();

    let maker_subaccount_data = drift
        .get_account_value(&maker_subaccount)
        .await
        .expect("drift account exists");

    // Example order parameters - you can modify these as needed
    let market_index = 0; // SOL-PERP market
    let market_type = MarketType::Perp;
    let order_direction = PositionDirection::Long;
    let side = if order_direction == PositionDirection::Long {
        "ask"
    } else {
        "bid"
    };

    // Create a sample order
    let order = OrderParams {
        market_index,
        market_type,
        base_asset_amount: 10_000_000,
        order_type: OrderType::Market,
        direction: PositionDirection::Long,
        post_only: PostOnlyParam::None,
        ..Default::default()
    };

    // Get top makers
    let makers = match get_top_makers(context, market_index, market_type, side, Some(4)).await {
        Ok(makers) if !makers.is_empty() => {
            println!(
                "Found {} makers for market {} on {} side",
                makers.len(),
                market_index,
                side
            );
            makers
        }
        Ok(_) => {
            eprintln!(
                "No makers found for market {} on {} side",
                market_index, side
            );
            return;
        }
        Err(e) => {
            eprintln!("Error fetching makers: {}", e);
            return;
        }
    };

    // Display information about all makers
    for (i, (maker, account)) in makers.iter().enumerate() {
        println!(
            "Maker {}: {} (authority: {})",
            i + 1,
            maker,
            account.authority
        );
    }

    let referrer = None; // Optional referrer

    let tx = TransactionBuilder::new(
        drift.program_data(),
        maker_subaccount,
        std::borrow::Cow::Borrowed(&maker_subaccount_data),
        false,
    )
    .with_priority_fee(1_000, Some(200_000))
    .place_and_take(order, &makers, referrer, None, None)
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
