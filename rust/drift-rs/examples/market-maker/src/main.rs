use drift_rs::{Context, Wallet};

mod grpc_marker;
mod ws_maker;

/// Market maker example
#[derive(argh::FromArgs)]
struct Args {
    /// run gRPC example
    #[argh(switch)]
    grpc: bool,
}

#[tokio::main]
async fn main() {
    let _ = dotenv::dotenv();
    let args: Args = argh::from_env();

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

    if args.grpc {
        println!("running gRPC maker example");
        grpc_marker::grpc_marker(context, wallet).await;
    } else {
        println!("running Ws maker example");
        ws_maker::ws_maker(context, wallet).await;
    }
}
