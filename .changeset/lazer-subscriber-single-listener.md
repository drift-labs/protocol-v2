---
'@velocity-exchange/sdk': patch
---

Fix two `PythLazerSubscriber` reliability bugs:

- **Register the message listener once per client, not once per feed chunk.** The SDK's `addMessageListener` is global to the client (it fires for every message, not scoped to a subscription), so registering it inside the per-chunk subscribe loop meant every incoming message was processed once per chunk — K× redundant map writes and K× resubscribe-timer churn for K subscription chunks. The stored prices were already idempotent so there is no behavior change to reported prices; this removes the wasted per-message work.
- **Subscribe via `subscribe()` instead of `send()`.** `send()` fires the subscription frame once and is never replayed, so after the first heartbeat-timeout socket reconnect the connection streamed nothing and only recovered via the coarse watchdog (which tears down the whole client and reopens all connections). `subscribe()` registers the request in the pool so `ResilientWebSocket` replays it on every reconnect, recovering in place with no connection churn.

Affects every consumer of `PythLazerSubscriber` (filler, pyth-lazer cranker; the maker bid/ask TWAP crank and multithreaded filler use a separate copy in keeper-bots-v2 that already used `subscribe()` and got the same single-listener fix).
