---
'@velocity-exchange/sdk': patch
---

Make the `UserAccountSubscriber` "not subscribed" contract consistent and fix a
misleading error message. `getUserAccountAndSlot()` now throws `NotSubscribedError`
when called before `subscribe()` on the gRPC-multi and WebSocket-program subscribers
too (the WebSocket and polling subscribers already did) — so `User.getUserAccount()`
uniformly throws when not subscribed and returns `undefined` only when subscribed but
the account was not found on chain. `getUserAccountOrThrow()` /
`getUserAccountAndSlotOrThrow()` now throw `User account not found: <pubkey>` (was
`User account not loaded`), since after `subscribe()` resolves a missing account means
"not found", not "still loading".
