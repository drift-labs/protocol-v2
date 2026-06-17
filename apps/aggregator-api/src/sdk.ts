/**
 * Env-driven SDK selection for the aggregator-api.
 *
 * The aggregator runs in two modes, chosen at boot via `SDK_MODE`:
 *
 *   SDK_MODE=velocity  (default) — serves live Velocity data via @velocity-exchange/sdk
 *   SDK_MODE=drift                — serves frozen historical Drift data via @drift-labs/sdk
 *
 * Velocity is a fork of Drift, so the two SDKs ship structurally identical
 * helpers, but `initialize()` (market list) and `decodeUser()` (account layout)
 * must match the program that produced the data being served. These dispatch
 * at call time. Numeric precision constants are math values shared between
 * the forks and are re-exported from a single source for type stability.
 *
 * Live RPC clients (`velocityClient`, `centralServerVelocity`, etc.) are NOT
 * routed through this adapter — they're wired by the `central-server-*`
 * plugins and only used by routes that are gated off in Drift mode. See
 * `plugins/index.ts` and `app.ts` for that wiring.
 */
import * as drift from '@drift-labs/sdk';
import * as velocity from '@velocity-exchange/sdk';

export type SdkMode = 'drift' | 'velocity';

export const SDK_MODE: SdkMode = process.env.SDK_MODE === 'drift' ? 'drift' : 'velocity';

// --- Runtime helpers that must dispatch ----------------------------------

type SdkInitializeReturn = ReturnType<typeof velocity.initialize>;

/**
 * Returns the SPOT_MARKETS / PERP_MARKETS arrays for the active SDK.
 * `env` accepts the same string literals in both SDKs ('mainnet-beta', 'devnet', …).
 */
export const initialize = (opts: { env: string }): SdkInitializeReturn => {
	if (SDK_MODE === 'drift') {
		// Cast to the canonical (Velocity) shape — runtime layout is identical;
		// the type-identity mismatch is purely a TS package-path artifact.
		return drift.initialize({
			env: opts.env as drift.DriftEnv,
		}) as unknown as SdkInitializeReturn;
	}
	return velocity.initialize({ env: opts.env as velocity.VelocityEnv });
};

/**
 * Decodes a Drift/Velocity on-chain User account. The two forks may diverge
 * here over time, so we route through the active SDK's decoder.
 */
export const decodeUser = (data: Buffer): velocity.UserAccount => {
	if (SDK_MODE === 'drift') {
		return drift.decodeUser(data) as unknown as velocity.UserAccount;
	}
	return velocity.decodeUser(data);
};

// --- Re-exports: identical math constants & shared utilities --------------

export {
	BN,
	AMM_RESERVE_PRECISION,
	BASE_PRECISION,
	FUNDING_RATE_PRECISION,
	PERCENTAGE_PRECISION,
	PRICE_PRECISION,
	PRICE_PRECISION_EXP,
	QUOTE_PRECISION,
	QUOTE_PRECISION_EXP,
	SPOT_MARKET_BALANCE_PRECISION,
	SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
} from '@velocity-exchange/sdk';

// --- Type-only re-exports -------------------------------------------------

/**
 * Canonical env type alias. Named `SdkEnv` (not `VelocityEnv`) to read
 * correctly in both modes; the runtime values are the same string literals
 * accepted by both SDKs.
 */
export type SdkEnv = velocity.VelocityEnv;

export type { SpotMarketConfig } from '@velocity-exchange/sdk';
