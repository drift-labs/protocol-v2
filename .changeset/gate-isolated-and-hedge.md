---
'@velocity-exchange/sdk': patch
---

Add `IsolatedPositionDisabled` (6357) error to the IDL. Mainnet program builds now compile out the isolated-position and VLP hedge instruction surface pending audit (`isolated-position` / `vlp-hedge` cargo features); devnet and test builds keep both enabled.
