//! utils for async functions

use std::time::Duration;

use futures_util::{
    future::{ready, BoxFuture},
    Future, FutureExt,
};
use tokio::task::JoinHandle;

use self::retry_policy::TaskRetryPolicy;

pub mod retry_policy {
    //! retry policies for async tasks
    use super::*;

    /// Defines whether an async task should be retried or not
    pub trait TaskRetryPolicy: Send + Sync + 'static {
        /// called pre-retry, returns whether retry should proceed or not
        fn check(&mut self, _attempts: u32) -> BoxFuture<bool>;
    }
    /// Create a new fail fast policy
    pub fn never() -> FailFast {
        FailFast {}
    }

    /// Create a new exponential backoff policy
    pub fn exponential_backoff(max_attempts: u32) -> ExponentialBackoff {
        ExponentialBackoff { max_attempts }
    }

    /// Create a new never ending retry policy
    pub fn forever(delay_s: u32) -> InfiniteRetry {
        InfiniteRetry { delay_s }
    }

    /// TaskFails on first retry
    pub struct FailFast;

    impl TaskRetryPolicy for FailFast {
        fn check(&mut self, _attempts: u32) -> BoxFuture<bool> {
            ready(false).boxed()
        }
    }

    /// Exponential back-off policy up to `max_attempts`
    pub struct ExponentialBackoff {
        max_attempts: u32,
    }

    impl TaskRetryPolicy for ExponentialBackoff {
        fn check(&mut self, attempts: u32) -> BoxFuture<bool> {
            async move {
                if attempts > self.max_attempts {
                    false
                } else {
                    tokio::time::sleep(Duration::from_secs(2_u64.pow(attempts))).await;
                    true
                }
            }
            .boxed()
        }
    }

    /// A policy that retries a task indefinitely, with constant delay between successive retries
    pub struct InfiniteRetry {
        delay_s: u32,
    }

    impl TaskRetryPolicy for InfiniteRetry {
        fn check(&mut self, _attempts: u32) -> BoxFuture<bool> {
            async move {
                tokio::time::sleep(Duration::from_secs(self.delay_s as u64)).await;
                true
            }
            .boxed()
        }
    }
}
/// Spawns a new tokio task with udf retry behaviour
///
/// - `task_fn` generator function for the task future
///
/// ```example
/// let task_gen = move || {
///     async move {
///         1 + 1
///     }
/// };
///
/// spawn_retry_task(task_gen, FailFast {})
/// ```
pub fn spawn_retry_task<F, G>(task_fn: G, mut retry_policy: impl TaskRetryPolicy) -> JoinHandle<()>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
    G: Fn() -> F + Send + 'static,
{
    tokio::spawn(async move {
        let mut attempts = 0;
        loop {
            task_fn().await;
            if !retry_policy.check(attempts).await {
                break;
            }
            attempts += 1;
        }
    })
}
