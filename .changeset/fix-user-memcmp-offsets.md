---
'@velocity-exchange/sdk': patch
---

Fix stale `User` account byte offsets in `memcmp` filters and `OrderSubscriber`.

The Velocity `User` account is 4496 bytes, but the memcmp filters and the
`OrderSubscriber` staleness check still used offsets from the older 4376-byte
layout. As a result `getUserWithOrderFilter()` matched zero accounts, so any
consumer that bulk-loads users-with-orders (e.g. the DLOB server's
`OrderSubscriber.fetch()`) loaded no orders and produced an empty order book
(vAMM-only L2, empty L3). Offsets for `idle`, `hasOpenOrder`, `hasOpenAuction`,
`poolId`, and `lastActiveSlot` are corrected to match the on-chain layout.
