# PropAMM match_perp_order_via_prop_amm — transaction size analysis

## Solana limit

- **Total transaction size: 1232 bytes** (MTU-derived).
- **Account key: 32 bytes** each in the message (legacy tx).
- **Signature: 64 bytes** each.
- Dominant cost: **number of account keys** (32 × accounts).

## Current account layout

| Segment | Count | Formula |
|--------|-------|--------|
| Fixed (Anchor) | 6 | user, user_stats, state, perp_market, oracle, clock |
| Remaining [0] | 1 | midprice_program |
| Remaining [1..amm_start] | S | spot markets (collateral; canonical discriminator scan) |
| Per AMM | 4 | matcher, midprice_account, maker_user, maker_user_stats |
| **Total accounts** | **7 + S + 4×N** | N = number of PropAMMs |

**Example:** S=2 spot markets, N=4 AMMs → 7+2+16 = **25 accounts** → 25×32 = **800 bytes** (keys only). With message header, blockhash, instruction meta, and 1 signature you're already ~900–1000 bytes; N=5 or N=6 pushes over 1232.

**Root cause:** Linear growth in **account keys** (4 per AMM + S spot markets). Each AMM adds 4×32 = 128 bytes before any ALT.

---

## Optimizations (opinionated, with tradeoffs)

### 1. **Use an Address Lookup Table (ALT)** — do this first

**What:** Put all PropAMM-related accounts (and shared ones) in a single ALT. The message references them by 1-byte index instead of 32-byte pubkey.

**Impact:** ~32× reduction per account for keys that are in the table (e.g. 25 accounts → ~25–50 bytes of indices + one 32-byte ALT address).

**Tradeoffs:**
- **Pro:** No program or account-structure change; works with existing layout; standard Solana pattern.
- **Con:** ALT must be created and extended when new PropAMMs / spot markets are added; client must use versioned tx and pass the ALT; table can hold max 256 addresses (enough for many AMMs).

**Recommendation:** Primary fix. Use a VersionedTransaction with an ALT containing at least: drift program, midprice program, state, oracle, clock, quote spot market(s), then per-AMM (matcher, midprice, maker_user, maker_stats). Client builds the match ix with account keys in the same order as the ALT and attaches the ALT to the tx.

---

### 2. **Cap or reduce spot markets in remaining**

**What:** Either (a) pass only the quote (USDC) spot market for margin, or (b) cap collateral spot markets to a small fixed number (e.g. 2).

**Impact:** Saves S×32 bytes (S = number of spot markets removed or capped). E.g. S=3→1 saves 64 bytes.

**Tradeoffs:**
- **Pro:** Simple; can be a program/config option (e.g. “minimal margin” mode).
- **Con:** (a) Margin can be wrong if taker/makers have non-quote collateral; (b) cap may be too low for some risk setups. Acceptable if PropAMM is used in “quote-only” or “few assets” environments.

**Recommendation:** If you can enforce “quote-only collateral” for this flow, pass only the quote spot market (e.g. back to a single fixed `quote_spot_market` or a single spot in remaining). Otherwise cap S (e.g. 2) and document that only the first S collateral markets are considered.

---

### 3. **Midprice account as PDA (midprice_pino change)**

**What:** In midprice_pino, make the midprice account a PDA, e.g.  
`PDA(midprice_program_id, [b"midprice", market_index, authority])`.  
Drift then **derives** the midprice account from (market_index, maker_user) and does **not** pass it in remaining.

**Impact:** Removes 1 account per AMM from the message → 32×N bytes saved.

**Tradeoffs:**
- **Pro:** Smaller tx; address is deterministic from (market, authority).
- **Con:** Requires midprice_pino change and migration for existing keypair-based midprice accounts; all clients must derive the same PDA.

**Recommendation:** Strong long-term option if you control midprice_pino and can migrate. Do after ALT so you get both benefits.

---

### 4. **Do not pass matcher in remaining (derive only in CPI)**

**What:** Matcher is already `PDA(drift, ["matcher", maker_user])`. Today we pass it so the CPI has an `AccountInfo`. You could change the CPI to build the account list from (midprice_program, midprice_account, maker_user) and have the **runtime** resolve the matcher PDA when building the inner instruction.

**Impact:** Removes 1 account per AMM (32×N bytes).

**Tradeoffs:**
- **Pro:** Smaller tx; matcher is derivable.
- **Con:** CPI still needs an `AccountInfo` for the matcher. Solana does not let you “invent” an account in the callee; the matcher must appear in the **outer** tx’s account list so it’s passed into the program and then into the CPI. So you **cannot** remove the matcher from the account list without the runtime/loader providing a way to “expand PDA at CPI time,” which Solana doesn’t do. So this option is **not viable** as stated — the matcher must stay in remaining.

**Recommendation:** Do not pursue; keep matcher in remaining.

---

### 5. **Chunk: multiple txs (1–2 AMMs per tx)**

**What:** One instruction matches 1 (or 2) PropAMMs; client sends several txs to match against all AMMs.

**Impact:** Each tx stays under 1232 bytes; total accounts per tx = 7 + S + 4×1 (or 4×2).

**Tradeoffs:**
- **Pro:** No program or midprice_pino change; works with current limits.
- **Con:** More txs (fees, latency); partial fill across txs can be confusing; taker order might be fully filled in tx 1 and later txs no-op.

**Recommendation:** Use only as a fallback if ALT is not available; prefer ALT so one tx can still match many AMMs.

---

### 6. **Single “PropAMM registry” account (big refactor)**

**What:** One account (e.g. per market) holds a list of (midprice_pubkey, maker_user_pubkey). Program reads this account, then loads maker_user / maker_stats (and midprice, matcher) by **loading from addresses stored in the registry** … but Solana instructions receive a fixed account list; you cannot dynamically add accounts by reading pubkeys from an account. So you still have to pass all accounts in the tx; the registry would only change *who* is allowed, not *how many* accounts you pass.

**Impact:** No real reduction in account count unless the registry is used to **cap** how many AMMs are matched per tx (e.g. “first K from registry”), in which case it’s equivalent to chunking.

**Tradeoffs:**
- **Con:** Large refactor; does not remove the need to pass every account in the transaction.

**Recommendation:** Skip for size; consider only if you need a separate “allowlist” or ordering of PropAMMs.

---

### 7. **Smaller instruction data**

**What:** Current data: 8 (discriminator) + 4 (taker_order_id) = 12 bytes. Negligible.

**Recommendation:** No meaningful gain; leave as is.

---

## Recommended order of work

1. **ALT (client + versioned tx)** — no program change; largest and fastest win.
2. **Spot market reduction/cap** — optional program/param change; small but easy.
3. **PDA midprice accounts (midprice_pino)** — program change + migration; 32×N bytes.
4. **Chunking** — only if you cannot use ALT.

## Quick size check (with ALT)

With ALT, assume ~1 byte per account index and one 32-byte lookup table address.  
Approximate message growth: ~(7 + S + 4×N) + 32 bytes for the table reference.  
So you can support many more AMMs (e.g. 20+ AMMs with S=2) before hitting 1232 bytes again.

---

## Summary table

| Option | Saves (bytes) | Program change | Client change | Recommendation |
|--------|----------------|----------------|---------------|----------------|
| ALT | ~31× (total account keys) | No | Yes (versioned tx + ALT) | **Do first** |
| Quote-only / cap spot | 32×(S−1) or similar | Optional | Small | Do if margin rules allow |
| PDA midprice | 32×N | midprice_pino | Yes (derive PDA) | Do after ALT if you own midprice |
| No matcher in list | — | Not possible | — | Skip |
| Chunk txs | Per-tx under limit | No | Yes | Fallback only |
