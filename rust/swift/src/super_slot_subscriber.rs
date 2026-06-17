use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64},
        Arc,
    },
    time::Duration,
};

use drift_rs::{event_subscriber::PubsubClient, slot_subscriber::SlotSubscriber, RpcClient};
use solana_clock::Slot;

/// Combines multiple slot subscribers for redundancy
/// Tracks the latest slot known by its constituents
pub struct SuperSlotSubscriber {
    subscribers: Vec<SlotSubscriber>,
    current_slot: Arc<AtomicU64>,
    is_stale: Arc<AtomicBool>,
    rpc: Arc<RpcClient>,
}

impl SuperSlotSubscriber {
    pub fn new(ws_conns: Vec<Arc<PubsubClient>>, rpc: Arc<RpcClient>) -> Self {
        Self {
            subscribers: ws_conns
                .iter()
                .map(|x| SlotSubscriber::new(Arc::clone(x)))
                .collect(),
            current_slot: Arc::default(),
            is_stale: Arc::default(),
            rpc,
        }
    }
    pub fn subscribe(&mut self) {
        for s in self.subscribers.iter_mut() {
            let current_slot_ref = Arc::clone(&self.current_slot);
            s.subscribe(move |new_slot| {
                let current_slot = current_slot_ref.load(std::sync::atomic::Ordering::Acquire);
                if new_slot.latest_slot > current_slot {
                    current_slot_ref
                        .store(new_slot.latest_slot, std::sync::atomic::Ordering::Release);
                }
            })
            .expect("subscribed");
        }

        // monitor slot-subscriber staleness
        tokio::spawn({
            let is_stale_ref = Arc::clone(&self.is_stale);
            let current_slot_ref = Arc::clone(&self.current_slot);
            let rpc = Arc::clone(&self.rpc);
            async move {
                let mut last_check_slot = 0;
                let mut interval = tokio::time::interval(Duration::from_secs(60));
                let _ = interval.tick().await; // ignore immediate first tick
                loop {
                    let _ = interval.tick().await;
                    let current_slot = current_slot_ref.load(std::sync::atomic::Ordering::Acquire);
                    if current_slot <= last_check_slot {
                        is_stale_ref.store(true, std::sync::atomic::Ordering::Release);
                        log::warn!("slot subscriber stale");
                        if let Ok(new_slot) = rpc.get_slot().await {
                            log::info!("polling slot RPC");
                            current_slot_ref.store(new_slot, std::sync::atomic::Ordering::Release);
                            is_stale_ref.store(false, std::sync::atomic::Ordering::Release);
                        }
                    } else {
                        is_stale_ref.store(false, std::sync::atomic::Ordering::Release);
                    }
                    last_check_slot = current_slot;
                }
            }
        });
    }
    /// Get the current slot
    pub fn current_slot(&self) -> Slot {
        self.current_slot.load(std::sync::atomic::Ordering::Acquire)
    }
    /// True if the slot subscriber has not updated recently
    pub fn is_stale(&self) -> bool {
        self.is_stale.load(std::sync::atomic::Ordering::Acquire)
    }
}
