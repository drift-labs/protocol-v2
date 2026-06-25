---
'@velocity-exchange/sdk': patch
---

Fix account decoder to pass account names as-is instead of capitalizing them. The
Anchor v1 IDL program constructor already camelCases account names, so the extra
`capitalize()` call was incorrect and caused decoding failures in the gRPC and
WebSocket subscribers.
