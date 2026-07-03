import { ConfirmOptions, PublicKey } from '@solana/web3.js';
import {
	isVariant,
	OracleSource,
	PerpMarketAccount,
	SpotMarketAccount,
} from './types';
import {
	DevnetPerpMarkets,
	MainnetPerpMarkets,
	PerpMarketConfig,
	PerpMarkets,
} from './constants/perpMarkets';
import {
	SpotMarketConfig,
	SpotMarkets,
	DevnetSpotMarkets,
	MainnetSpotMarkets,
} from './constants/spotMarkets';
import { OracleInfo } from './oracles/types';
import { Program, ProgramAccount } from './isomorphic/anchor';
import { getOracleId } from './oracles/oracleId';
import { Velocity } from './idl/velocity';

/** The Anchor `Program` client type for the velocity IDL, parameterized over the generated `Velocity` type. */
export type VelocityProgram = Program<Velocity>;

/** Supported deployment environments. */
export type VelocityEnv = 'devnet' | 'mainnet-beta';

/** Widened env type accepted by `initialize()`; `'master'` is a legacy alias for `'devnet'`. */
export type LegacyVelocityEnv = VelocityEnv | 'master';

/** Per-environment addresses, program ids, and default market lists returned by `getConfig()`/`initialize()`. */
export interface VelocityConfig {
	ENV: VelocityEnv;
	/** Legacy Pyth oracle mapping account address for this environment (push-oracle discovery; not used by pull/Lazer sources). */
	PYTH_ORACLE_MAPPING_ADDRESS: string;
	/** Deployed velocity program id for this environment, base58. */
	VELOCITY_PROGRAM_ID: string;
	/** Deployed jit-proxy program id, base58, if jit-proxy is available in this environment. */
	JIT_PROXY_PROGRAM_ID?: string;
	/** Velocity's oracle-receiver program id (verifies/receives pushed oracle updates), base58. */
	VELOCITY_ORACLE_RECEIVER_ID: string;
	/** Mint address of the protocol's quote asset (e.g. USDC) for this environment, base58. */
	QUOTE_MINT_ADDRESS: string;
	/** Mint address of the legacy v2-alpha ticket token for this environment, base58. */
	V2_ALPHA_TICKET_MINT_ADDRESS: string;
	/** Default perp market configs to subscribe to when the caller doesn't supply an explicit list. */
	PERP_MARKETS: PerpMarketConfig[];
	/** Default spot market configs to subscribe to when the caller doesn't supply an explicit list. */
	SPOT_MARKETS: SpotMarketConfig[];
	/** @deprecated use MARKET_LOOKUP_TABLES */
	MARKET_LOOKUP_TABLE: string;
	/** Address lookup table accounts (base58) used to fit market/oracle accounts into versioned transactions. */
	MARKET_LOOKUP_TABLES: string[];
	/** Deployed Switchboard On-Demand program id for this environment. */
	SB_ON_DEMAND_PID: PublicKey;
}

/** Mainnet-beta velocity program id, base58. */
export const VELOCITY_PROGRAM_ID =
	'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';

/** Devnet velocity program id, base58. */
export const VELOCITY_DEVNET_PROGRAM_ID =
	'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';

/** Velocity's oracle-receiver program id, base58 (same across devnet and mainnet-beta). */
export const VELOCITY_ORACLE_RECEIVER_ID =
	'G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha';

/** Pyth Lazer program id, base58. */
export const PYTH_LAZER_PROGRAM_ID =
	'pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt';

/** Switchboard On-Demand program id on devnet. */
export const SB_ON_DEMAND_DEVNET_PID = new PublicKey(
	'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2'
);
/** Switchboard On-Demand program id on mainnet-beta. */
export const SB_ON_DEMAND_MAINNET_PID = new PublicKey(
	'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv'
);
/** Pyth Lazer storage account holding feed metadata, shared across environments. */
export const PYTH_LAZER_STORAGE_ACCOUNT_KEY = new PublicKey(
	'3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL'
);

/** Default `ConfirmOptions` (both preflight and confirmation at `'confirmed'` commitment) used across the SDK's tx senders unless overridden. */
export const DEFAULT_CONFIRMATION_OPTS: ConfirmOptions = {
	preflightCommitment: 'confirmed',
	commitment: 'confirmed',
};

/** Built-in `VelocityConfig` presets for each supported environment. */
export const configs: { [key in VelocityEnv]: VelocityConfig } = {
	devnet: {
		ENV: 'devnet',
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		VELOCITY_PROGRAM_ID: VELOCITY_DEVNET_PROGRAM_ID,
		JIT_PROXY_PROGRAM_ID: 'J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP',
		QUOTE_MINT_ADDRESS: 'GqmEqYsy8EyvofDpmtFxK8zhYrgWgNokAtYoduQdL7v6',
		V2_ALPHA_TICKET_MINT_ADDRESS:
			'DeEiGWfCMP9psnLGkxGrBBMEAW5Jv8bBGMN8DCtFRCyB',
		PERP_MARKETS: DevnetPerpMarkets,
		SPOT_MARKETS: DevnetSpotMarkets,
		/** @deprecated use MARKET_LOOKUP_TABLES */
		MARKET_LOOKUP_TABLE: 'FaMS3U4uBojvGn5FSDEPimddcXsCfwkKsFgMVVnDdxGb',
		MARKET_LOOKUP_TABLES: ['FaMS3U4uBojvGn5FSDEPimddcXsCfwkKsFgMVVnDdxGb'],
		VELOCITY_ORACLE_RECEIVER_ID,
		SB_ON_DEMAND_PID: SB_ON_DEMAND_DEVNET_PID,
	},
	'mainnet-beta': {
		ENV: 'mainnet-beta',
		PYTH_ORACLE_MAPPING_ADDRESS: 'AHtgzX45WTKfkPG53L6WYhGEXwQkN1BVknET3sVsLL8J',
		VELOCITY_PROGRAM_ID,
		JIT_PROXY_PROGRAM_ID: 'J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP',
		// Relaunch quote market (spot 0) is USDT — see
		// deploy-scripts/params/relaunch-spot-markets.json.
		QUOTE_MINT_ADDRESS: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
		V2_ALPHA_TICKET_MINT_ADDRESS:
			'Cmvhycb6LQvvzaShGw4iDHRLzeSSryioAsU98DSSkMNa',
		PERP_MARKETS: MainnetPerpMarkets,
		SPOT_MARKETS: MainnetSpotMarkets,
		/** @deprecated use MARKET_LOOKUP_TABLES */
		MARKET_LOOKUP_TABLE: 'Fpys8GRa5RBWfyeN7AaDUwFGD1zkDCA4z3t4CJLV8dfL',
		MARKET_LOOKUP_TABLES: [
			'Fpys8GRa5RBWfyeN7AaDUwFGD1zkDCA4z3t4CJLV8dfL',
			'EiWSskK5HXnBTptiS5DH6gpAJRVNQ3cAhTKBGaiaysAb',
		],
		VELOCITY_ORACLE_RECEIVER_ID,
		SB_ON_DEMAND_PID: SB_ON_DEMAND_MAINNET_PID,
	},
};

/** Module-level active config; defaults to the `devnet` preset until `initialize()` is called. */
let currentConfig: VelocityConfig = configs.devnet;

/**
 * Returns the SDK's currently active `VelocityConfig` (the `devnet` preset by default, or
 * whatever was last set via `initialize()`).
 * @returns The active config.
 */
export const getConfig = (): VelocityConfig => currentConfig;

/**
 * Sets the SDK's active environment/config, read thereafter via `getConfig()`. This mutates
 * process-wide module state — call it once at startup before constructing clients, not
 * concurrently with multiple environments in the same process.
 *
 * Defaults to the `devnet` preset if you never call this function.
 * @param props.env - Environment to activate; `'master'` is accepted as a legacy alias for `'devnet'`.
 * @param props.overrideEnv - Partial fields to overlay on top of the selected preset (e.g. a custom `VELOCITY_PROGRAM_ID`).
 * @returns The resulting active `VelocityConfig` (preset merged with `overrideEnv`).
 */
export const initialize = (props: {
	env: LegacyVelocityEnv;
	overrideEnv?: Partial<VelocityConfig>;
}): VelocityConfig => {
	const override = props.overrideEnv ?? {};
	const normalizedEnv: VelocityEnv =
		props.env === 'master' ? 'devnet' : props.env;

	currentConfig = { ...configs[normalizedEnv], ...override };
	return currentConfig;
};

/**
 * Whether the SDK can construct an `OracleClient` for `source` — mirrors the throwing branches in
 * `getOracleClient`. Markets whose oracle source is unsupported (retired Switchboard feeds and
 * removed Pyth pull feeds) are still listed/indexed, but their oracles must not be added to
 * subscription lists, since building a client for them throws and would abort the whole subscribe.
 */
function isOracleSourceSubscribable(source: OracleSource): boolean {
	return !(
		isVariant(source, 'deprecatedSwitchboard') ||
		isVariant(source, 'deprecatedSwitchboardOnDemand') ||
		isVariant(source, 'pythPull') ||
		isVariant(source, 'pyth1KPull') ||
		isVariant(source, 'pyth1MPull') ||
		isVariant(source, 'pythStableCoinPull')
	);
}

/**
 * Builds the market-index and oracle-subscription lists a `VelocityClient` needs to subscribe to,
 * from static market configs (no RPC calls) — the fast, offline alternative to
 * `findAllMarketAndOracles`. Oracles are de-duplicated by `getOracleId` (pubkey + source), so a
 * pubkey shared across multiple markets under the same source only appears once.
 * @param env - Environment whose built-in market lists (`PerpMarkets[env]`/`SpotMarkets[env]`) are
 * used as the fallback when `perpMarkets`/`spotMarkets` aren't supplied.
 * @param perpMarkets - Explicit perp market configs to use instead of the environment default; if
 * omitted or empty, falls back to `PerpMarkets[env]`.
 * @param spotMarkets - Explicit spot market configs to use instead of the environment default; if
 * omitted or empty, falls back to `SpotMarkets[env]`.
 * @returns `perpMarketIndexes`/`spotMarketIndexes` for every market considered, and the
 * de-duplicated `oracleInfos` needed to subscribe to their oracles.
 */
export function getMarketsAndOraclesForSubscription(
	env: VelocityEnv,
	perpMarkets?: PerpMarketConfig[],
	spotMarkets?: SpotMarketConfig[]
): {
	perpMarketIndexes: number[];
	spotMarketIndexes: number[];
	oracleInfos: OracleInfo[];
} {
	const perpMarketsToUse =
		perpMarkets !== undefined && perpMarkets.length > 0
			? perpMarkets
			: PerpMarkets[env];
	const spotMarketsToUse =
		spotMarkets !== undefined && spotMarkets.length > 0
			? spotMarkets
			: SpotMarkets[env];

	const perpMarketIndexes = [];
	const spotMarketIndexes = [];
	const oracleInfos = new Map<string, OracleInfo>();

	for (const market of perpMarketsToUse) {
		perpMarketIndexes.push(market.marketIndex);
		if (isOracleSourceSubscribable(market.oracleSource)) {
			oracleInfos.set(getOracleId(market.oracle, market.oracleSource), {
				publicKey: market.oracle,
				source: market.oracleSource,
			});
		}
	}

	for (const spotMarket of spotMarketsToUse) {
		spotMarketIndexes.push(spotMarket.marketIndex);
		if (isOracleSourceSubscribable(spotMarket.oracleSource)) {
			oracleInfos.set(getOracleId(spotMarket.oracle, spotMarket.oracleSource), {
				publicKey: spotMarket.oracle,
				source: spotMarket.oracleSource,
			});
		}
	}

	return {
		perpMarketIndexes: perpMarketIndexes,
		spotMarketIndexes: spotMarketIndexes,
		oracleInfos: Array.from(oracleInfos.values()),
	};
}

/**
 * Discovers every perp/spot market currently deployed under `program`'s program id via
 * `getProgramAccounts` (`perpMarket.all()`/`spotMarket.all()`), rather than relying on a static
 * config list — use this to pick up markets added after the SDK's bundled configs were published,
 * or when running against a custom/unlisted deployment. Oracles are de-duplicated by `getOracleId`
 * (pubkey + source).
 * @param program - Anchor program client used to fetch all `PerpMarket`/`SpotMarket` accounts.
 * @returns Market indexes and full decoded accounts for every discovered perp/spot market, plus
 * the de-duplicated `oracleInfos` needed to subscribe to their oracles.
 */
export async function findAllMarketAndOracles(
	program: VelocityProgram
): Promise<{
	perpMarketIndexes: number[];
	perpMarketAccounts: PerpMarketAccount[];
	spotMarketIndexes: number[];
	oracleInfos: OracleInfo[];
	spotMarketAccounts: SpotMarketAccount[];
}> {
	const perpMarketIndexes = [];
	const spotMarketIndexes = [];
	const oracleInfos = new Map<string, OracleInfo>();

	const perpMarketProgramAccounts = (await (
		program.account as any
	).perpMarket.all()) as ProgramAccount<PerpMarketAccount>[];
	const spotMarketProgramAccounts = (await (
		program.account as any
	).spotMarket.all()) as ProgramAccount<SpotMarketAccount>[];

	for (const perpMarketProgramAccount of perpMarketProgramAccounts) {
		const perpMarket = perpMarketProgramAccount.account as PerpMarketAccount;
		perpMarketIndexes.push(perpMarket.marketIndex);
		if (isOracleSourceSubscribable(perpMarket.oracleSource)) {
			oracleInfos.set(getOracleId(perpMarket.oracle, perpMarket.oracleSource), {
				publicKey: perpMarket.oracle,
				source: perpMarket.oracleSource,
			});
		}
	}

	for (const spotMarketProgramAccount of spotMarketProgramAccounts) {
		const spotMarket = spotMarketProgramAccount.account as SpotMarketAccount;
		spotMarketIndexes.push(spotMarket.marketIndex);
		if (isOracleSourceSubscribable(spotMarket.oracleSource)) {
			oracleInfos.set(getOracleId(spotMarket.oracle, spotMarket.oracleSource), {
				publicKey: spotMarket.oracle,
				source: spotMarket.oracleSource,
			});
		}
	}

	return {
		perpMarketIndexes,
		perpMarketAccounts: perpMarketProgramAccounts.map(
			(account) => account.account
		),
		spotMarketIndexes,
		spotMarketAccounts: spotMarketProgramAccounts.map(
			(account) => account.account
		),
		oracleInfos: Array.from(oracleInfos.values()),
	};
}
