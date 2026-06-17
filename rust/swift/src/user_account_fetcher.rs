use std::collections::HashMap;

use anchor_lang::AccountDeserialize;
use base64::Engine;
use drift_rs::{types::accounts::User, DriftClient};
use redis::{aio::MultiplexedConnection, AsyncCommands};
use solana_clock::Slot;
use solana_pubkey::Pubkey;

/// Fallback lookup strategy
#[derive(Clone)]
enum Fallback {
    /// Lookup from RPC
    Rpc(DriftClient),
    /// Lookup from some mocked hashmap
    Mock(HashMap<Pubkey, User>),
}

/// Fetches users from UserMap server
#[derive(Clone)]
pub struct UserAccountFetcher {
    pub redis: Option<MultiplexedConnection>,
    fallback: Fallback,
}

impl UserAccountFetcher {
    #[cfg(test)]
    pub fn mock(mocks: HashMap<Pubkey, User>) -> Self {
        Self {
            fallback: Fallback::Mock(mocks),
            redis: None,
        }
    }
    /// Create a new `UserAccountFetcher` from env vars
    pub async fn from_env(drift: DriftClient) -> Self {
        let redis = {
            let elasticache_host = std::env::var("USERMAP_ELASTICACHE_HOST")
                .unwrap_or_else(|_| "localhost".to_string());
            let elasticache_port =
                std::env::var("USERMAP_ELASTICACHE_PORT").unwrap_or_else(|_| "6379".to_string());
            let connection_string = if std::env::var("USERMAP_USE_SSL")
                .unwrap_or_else(|_| "false".to_string())
                .to_lowercase()
                == "true"
            {
                format!(
                    // "rediss://{}:{}/#insecure",
                    "rediss://{}:{}",
                    elasticache_host, elasticache_port
                )
            } else {
                format!("redis://{}:{}", elasticache_host, elasticache_port)
            };
            let conn = redis::Client::open(connection_string);
            match conn {
                Ok(r) => r.get_multiplexed_tokio_connection().await.ok(),
                Err(err) => {
                    log::warn!("usermap not connected: {err:?}. user queries will use RPC");
                    None
                }
            }
        };

        Self {
            redis,
            fallback: Fallback::Rpc(drift),
        }
    }

    /// Use pings to check for health
    pub async fn check_redis_health(&self) -> bool {
        if let Some(mut conn) = self.redis.clone() {
            let ping_result: redis::RedisResult<String> =
                redis::cmd("PING").query_async(&mut conn).await;
            if ping_result.is_ok() {
                return true;
            }
            log::error!("Redis health check failed: {:?}", ping_result.err());
        }
        false
    }

    // Fetch a drift `User` from usermap, falling back to RPC
    pub async fn get_user(&self, account: &Pubkey, slot: Slot) -> Result<User, ()> {
        match self.usermap_lookup(account, slot).await {
            Ok(res) => Ok(res),
            Err(_) => match &self.fallback {
                Fallback::Rpc(drift) => drift.get_account_value(account).await.map_err(|_| ()),
                Fallback::Mock(mocks) => mocks.get(account).copied().ok_or(()),
            },
        }
    }

    pub async fn usermap_lookup(&self, account: &Pubkey, slot: Slot) -> Result<User, ()> {
        // usermap server not connected
        if self.redis.is_none() {
            return Err(());
        }

        let conn = self.redis.clone();
        let redis_key = format!("usermap-server:{account}");
        match conn.unwrap().get::<_, Option<String>>(&redis_key).await {
            Ok(Some(value)) => {
                let mut parts = value.split("::");
                match (parts.next(), parts.next()) {
                    (Some(redis_slot), Some(account)) => {
                        let redis_slot = redis_slot.parse::<u64>().unwrap_or_default();
                        if slot.saturating_sub(redis_slot) > (90_f64 * 2.5) as u64 {
                            log::warn!("User found in redis is too old. redis: {redis_slot}, current: {slot}");
                            return Err(());
                        }

                        let user = User::try_deserialize(
                            &mut &base64::engine::general_purpose::STANDARD
                                .decode(account)
                                .unwrap()[..],
                        );

                        user.map_err(|err| {
                            log::error!("Failed to deserialize user from redis: {err:?}");
                        })
                    }
                    _ => {
                        log::warn!("Invalid usermap value");
                        Err(())
                    }
                }
            }
            Ok(None) => {
                log::warn!("No value found for usermap key: {redis_key:?}");
                Err(())
            }
            Err(err) => {
                log::error!("usermap query error: {err:?}");
                Err(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use drift_rs::{Context, RpcClient};
    use solana_keypair::Keypair;

    use super::*;

    #[ignore]
    #[tokio::test]
    async fn usermap_lookups() {
        let _ = env_logger::try_init();
        let drift = DriftClient::new(
            Context::DevNet,
            RpcClient::new("https://api.devnet.solana.com".into()),
            Keypair::new().into(),
        )
        .await
        .unwrap();
        let u = UserAccountFetcher::from_env(drift.clone()).await;
        let keys = [
            solana_pubkey::pubkey!("9wcC14v9n3YvGenSnAnsA8yTwnCyUg3ayTBGaJUNEnn6"),
            solana_pubkey::pubkey!("6nBSTpFpAqw32CKdauAL1FnSLvrtUpBgeXXjPEL2ooB7"),
            solana_pubkey::pubkey!("ECqYuYada7SCFyJKX8ieRWyy4rTYh9eiEiofbftwy12V"),
            solana_pubkey::pubkey!("FGHNtir5sfFyQfiGZ1cPxagCFLrBA1B9qdEQSkeqw3rP"),
            solana_pubkey::pubkey!("FdXRVMFkNEXf9uWmcYfkxRvLTDKeY3X9uxhxaQLuuVHR"),
            solana_pubkey::pubkey!("2tyhK1zxrMYRNDZX9EnPDSAqBNYz8MXRwLVE96g5ZKEw"),
            solana_pubkey::pubkey!("34gEWrhb9WQd16DhS2o28A4xmBnXgE5caWe6kYhzY2XA"),
            solana_pubkey::pubkey!("9TDcwUU43bbhGM8JDMY7FT8797foKA32ekSH9eieT3jX"),
        ];

        let slot = drift.rpc().get_slot().await.unwrap();

        for p in keys {
            let t0 = std::time::Instant::now();
            assert!(u.get_user(&p, slot).await.is_ok());
            let time = (std::time::Instant::now() - t0).as_millis();
            dbg!(time);
        }
    }
}
