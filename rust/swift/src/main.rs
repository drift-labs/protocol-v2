use clap::{Arg, Command};

mod confirmation_server;
mod super_slot_subscriber;
mod swift_server;
mod types;
mod user_account_fetcher;
mod util;
mod ws_server;

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();
    env_logger::init();

    // Build provenance — logged first so a stale-image / build-cache deploy is
    // obvious from line one (see docker/rust-app.Dockerfile). `BUILD_*` are baked
    // as ENV at image build; absent for a local `cargo run`.
    log::info!(
        target: "startup",
        "swift-server starting: pkg_version={} build_version={} git_sha={}",
        env!("CARGO_PKG_VERSION"),
        std::env::var("BUILD_VERSION").as_deref().unwrap_or("dev"),
        std::env::var("BUILD_GIT_SHA").as_deref().unwrap_or("unknown"),
    );

    let matches = Command::new("Swift Server")
        .version("1.0")
        .arg(
            Arg::new("server")
                .long("server")
                .value_name("SERVER_TYPE")
                .help("Sets the type of server")
                .default_value("swift")
                .value_parser(["swift", "ws", "confirmation"]),
        )
        .get_matches();

    let server_type = matches
        .get_one::<String>("server")
        .expect("default is provided");

    match server_type.as_str() {
        "confirmation" => {
            // Run the confirmation server
            confirmation_server::start_server().await;
        }
        "swift" => {
            // Run the swift http server
            swift_server::start_server().await;
        }
        "ws" => {
            // Run the WebSocket server
            ws_server::start_server().await;
        }
        _ => {
            log::error!("Invalid server type");
        }
    }
}
