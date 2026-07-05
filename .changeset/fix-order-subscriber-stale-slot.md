---
'@velocity-exchange/sdk': patch
---

Fix `OrderSubscriber.fetch()` leaving `mostRecentSlot` (and therefore `getSlot()`) stuck at `0` when a `getProgramAccounts` snapshot matches zero accounts (e.g. no users currently have open orders). The RPC response's slot is now stamped unconditionally, not only inside the per-account loop.
