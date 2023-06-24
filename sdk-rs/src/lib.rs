#[cfg(test)]
mod tests {
    #[test]
    fn it_works() {
        let result = 2 + 2;
        assert_eq!(result, 4);
    }
}

pub mod drift_client;
pub mod polling_drift_client_account_subscriber;
pub mod types;
pub mod utils;
pub mod websocket_drift_client_account_subscriber;
