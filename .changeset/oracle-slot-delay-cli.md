---
'@velocity-exchange/admin-cli': minor
---

Add `perp-market set-oracle-slot-delay <market> <slots>` command to set a perp
market's `oracle_slot_delay_override`. Lets operators raise the "stale for amm
immediate" tolerance above the default `-1` (which clamps to a 0-slot threshold
and makes a healthy multi-slot oracle crank read as perpetually stale).
