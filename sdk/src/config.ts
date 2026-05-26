import { ConfirmOptions, PublicKey } from '@solana/web3.js';
import { PerpMarketAccount, SpotMarketAccount } from './types';
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
import { Drift } from './idl/drift';

export type VelocityProgram = Program<Drift>;

/** @deprecated Use `VelocityProgram` instead. `DriftProgram` will be removed in a future major. */
export type DriftProgram = VelocityProgram;

export type VelocityEnv = 'devnet' | 'mainnet-beta';

/** @deprecated Use `VelocityEnv` instead. `DriftEnv` will be removed in a future major. */
export type DriftEnv = VelocityEnv;

/** Widened env type accepted by `initialize()`; `'master'` is a legacy alias for `'devnet'`. */
export type LegacyVelocityEnv = VelocityEnv | 'master';

export interface VelocityConfig {
	ENV: VelocityEnv;
	PYTH_ORACLE_MAPPING_ADDRESS: string;
	VELOCITY_PROGRAM_ID: string;
	/** @deprecated Use `VELOCITY_PROGRAM_ID` instead. Kept on the config shape so existing callers reading this field continue to work; will be removed in a future major. */
	DRIFT_PROGRAM_ID: string;
	JIT_PROXY_PROGRAM_ID?: string;
	VELOCITY_ORACLE_RECEIVER_ID: string;
	/** @deprecated Use `VELOCITY_ORACLE_RECEIVER_ID` instead. Kept on the config shape so existing callers reading this field continue to work; will be removed in a future major. */
	DRIFT_ORACLE_RECEIVER_ID: string;
	QUOTE_MINT_ADDRESS: string;
	V2_ALPHA_TICKET_MINT_ADDRESS: string;
	PERP_MARKETS: PerpMarketConfig[];
	SPOT_MARKETS: SpotMarketConfig[];
	/** @deprecated use MARKET_LOOKUP_TABLES */
	MARKET_LOOKUP_TABLE: string;
	MARKET_LOOKUP_TABLES: string[];
	SB_ON_DEMAND_PID: PublicKey;
}

/** @deprecated Use `VelocityConfig` instead. `DriftConfig` will be removed in a future major. */
export type DriftConfig = VelocityConfig;

export const VELOCITY_PROGRAM_ID =
	'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';

/** @deprecated Use `VELOCITY_PROGRAM_ID` instead. `DRIFT_PROGRAM_ID` will be removed in a future major. */
export const DRIFT_PROGRAM_ID = VELOCITY_PROGRAM_ID;

export const VELOCITY_DEVNET_PROGRAM_ID =
	'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';

/** @deprecated Use `VELOCITY_DEVNET_PROGRAM_ID` instead. `DRIFT_DEVNET_PROGRAM_ID` will be removed in a future major. */
export const DRIFT_DEVNET_PROGRAM_ID = VELOCITY_DEVNET_PROGRAM_ID;

export const VELOCITY_ORACLE_RECEIVER_ID =
	'G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha';

/** @deprecated Use `VELOCITY_ORACLE_RECEIVER_ID` instead. `DRIFT_ORACLE_RECEIVER_ID` will be removed in a future major. */
export const DRIFT_ORACLE_RECEIVER_ID = VELOCITY_ORACLE_RECEIVER_ID;
export const PTYH_LAZER_PROGRAM_ID =
	'pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt';
export const SB_ON_DEMAND_DEVNET_PID = new PublicKey(
	'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2'
);
export const SB_ON_DEMAND_MAINNET_PID = new PublicKey(
	'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv'
);
export const PYTH_LAZER_STORAGE_ACCOUNT_KEY = new PublicKey(
	'3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL'
);

export const DEFAULT_CONFIRMATION_OPTS: ConfirmOptions = {
	preflightCommitment: 'confirmed',
	commitment: 'confirmed',
};

export const configs: { [key in VelocityEnv]: VelocityConfig } = {
	devnet: {
		ENV: 'devnet',
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		VELOCITY_PROGRAM_ID: VELOCITY_DEVNET_PROGRAM_ID,
		/** @deprecated Read `VELOCITY_PROGRAM_ID` instead. */
		DRIFT_PROGRAM_ID: VELOCITY_DEVNET_PROGRAM_ID,
		JIT_PROXY_PROGRAM_ID: 'J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP',
		QUOTE_MINT_ADDRESS: '8FfvSRKMZRDHrCBy142XMUXrKEkXnxDQ4YmJv7xbAw8Q',
		V2_ALPHA_TICKET_MINT_ADDRESS:
			'DeEiGWfCMP9psnLGkxGrBBMEAW5Jv8bBGMN8DCtFRCyB',
		PERP_MARKETS: DevnetPerpMarkets,
		SPOT_MARKETS: DevnetSpotMarkets,
		/** @deprecated use MARKET_LOOKUP_TABLES */
		MARKET_LOOKUP_TABLE: 'FaMS3U4uBojvGn5FSDEPimddcXsCfwkKsFgMVVnDdxGb',
		MARKET_LOOKUP_TABLES: ['FaMS3U4uBojvGn5FSDEPimddcXsCfwkKsFgMVVnDdxGb'],
		VELOCITY_ORACLE_RECEIVER_ID,
		/** @deprecated Read `VELOCITY_ORACLE_RECEIVER_ID` instead. */
		DRIFT_ORACLE_RECEIVER_ID: VELOCITY_ORACLE_RECEIVER_ID,
		SB_ON_DEMAND_PID: SB_ON_DEMAND_DEVNET_PID,
	},
	'mainnet-beta': {
		ENV: 'mainnet-beta',
		PYTH_ORACLE_MAPPING_ADDRESS: 'AHtgzX45WTKfkPG53L6WYhGEXwQkN1BVknET3sVsLL8J',
		VELOCITY_PROGRAM_ID,
		/** @deprecated Read `VELOCITY_PROGRAM_ID` instead. */
		DRIFT_PROGRAM_ID: VELOCITY_PROGRAM_ID,
		JIT_PROXY_PROGRAM_ID: 'J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP',
		QUOTE_MINT_ADDRESS: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
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
		/** @deprecated Read `VELOCITY_ORACLE_RECEIVER_ID` instead. */
		DRIFT_ORACLE_RECEIVER_ID: VELOCITY_ORACLE_RECEIVER_ID,
		SB_ON_DEMAND_PID: SB_ON_DEMAND_MAINNET_PID,
	},
};

let currentConfig: VelocityConfig = configs.devnet;

export const getConfig = (): VelocityConfig => currentConfig;

/**
 * Allows customization of the SDK's environment and endpoints. You can pass individual settings to override the settings with your own presets.
 *
 * Defaults to master environment if you don't use this function.
 * @param props
 * @returns
 */
/**
 * Mirror a canonical/deprecated alias pair so the resolved config carries the
 * same value under both keys regardless of which one the caller overrode.
 */
const mirrorAlias = <K1 extends keyof VelocityConfig, K2 extends keyof VelocityConfig>(
	merged: VelocityConfig,
	override: Partial<VelocityConfig>,
	canon: K1,
	deprecated: K2
): void => {
	const value = override[canon] ?? override[deprecated] ?? merged[canon];
	(merged[canon] as VelocityConfig[K1]) = value as VelocityConfig[K1];
	(merged[deprecated] as VelocityConfig[K2]) = value as VelocityConfig[K2];
};

export const initialize = (props: {
	env: LegacyVelocityEnv;
	overrideEnv?: Partial<VelocityConfig>;
}): VelocityConfig => {
	const override = props.overrideEnv ?? {};
	const normalizedEnv: VelocityEnv =
		props.env === 'master' ? 'devnet' : props.env;
	const merged: VelocityConfig = { ...configs[normalizedEnv], ...override };

	mirrorAlias(merged, override, 'VELOCITY_PROGRAM_ID', 'DRIFT_PROGRAM_ID');
	mirrorAlias(
		merged,
		override,
		'VELOCITY_ORACLE_RECEIVER_ID',
		'DRIFT_ORACLE_RECEIVER_ID'
	);

	currentConfig = merged;
	return currentConfig;
};

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
		perpMarkets?.length > 0 ? perpMarkets : PerpMarkets[env];
	const spotMarketsToUse =
		spotMarkets?.length > 0 ? spotMarkets : SpotMarkets[env];

	const perpMarketIndexes = [];
	const spotMarketIndexes = [];
	const oracleInfos = new Map<string, OracleInfo>();

	for (const market of perpMarketsToUse) {
		perpMarketIndexes.push(market.marketIndex);
		oracleInfos.set(getOracleId(market.oracle, market.oracleSource), {
			publicKey: market.oracle,
			source: market.oracleSource,
		});
	}

	for (const spotMarket of spotMarketsToUse) {
		spotMarketIndexes.push(spotMarket.marketIndex);
		oracleInfos.set(getOracleId(spotMarket.oracle, spotMarket.oracleSource), {
			publicKey: spotMarket.oracle,
			source: spotMarket.oracleSource,
		});
	}

	return {
		perpMarketIndexes: perpMarketIndexes,
		spotMarketIndexes: spotMarketIndexes,
		oracleInfos: Array.from(oracleInfos.values()),
	};
}

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
		oracleInfos.set(
			getOracleId(perpMarket.amm.oracle, perpMarket.amm.oracleSource),
			{
				publicKey: perpMarket.amm.oracle,
				source: perpMarket.amm.oracleSource,
			}
		);
	}

	for (const spotMarketProgramAccount of spotMarketProgramAccounts) {
		const spotMarket = spotMarketProgramAccount.account as SpotMarketAccount;
		spotMarketIndexes.push(spotMarket.marketIndex);
		oracleInfos.set(getOracleId(spotMarket.oracle, spotMarket.oracleSource), {
			publicKey: spotMarket.oracle,
			source: spotMarket.oracleSource,
		});
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
