import { ConfirmOptions } from '@solana/web3.js';
import { PerpMarketAccount, PublicKey, SpotMarketAccount } from '.';
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
import { Program, ProgramAccount } from '@coral-xyz/anchor';
import {
	ON_DEMAND_DEVNET_PID,
	ON_DEMAND_MAINNET_PID,
} from '@switchboard-xyz/on-demand';
import { getOracleId } from './oracles/oracleId';

type DriftConfig = {
	ENV: DriftEnv;
	PYTH_ORACLE_MAPPING_ADDRESS: string;
	DRIFT_PROGRAM_ID: string;
	JIT_PROXY_PROGRAM_ID?: string;
	DRIFT_ORACLE_RECEIVER_ID: string;
	USDC_MINT_ADDRESS: string;
	SERUM_V3: string;
	PHOENIX: string;
	OPENBOOK: string;
	V2_ALPHA_TICKET_MINT_ADDRESS: string;
	PERP_MARKETS: PerpMarketConfig[];
	SPOT_MARKETS: SpotMarketConfig[];
	MARKET_LOOKUP_TABLE: string;
	SERUM_LOOKUP_TABLE?: string;
	PYTH_PULL_ORACLE_LOOKUP_TABLE?: string;
	SB_ON_DEMAND_PID: PublicKey;
};

export type DriftEnv = 'devnet' | 'mainnet-beta';

export const DRIFT_PROGRAM_ID = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';
export const DRIFT_ORACLE_RECEIVER_ID =
	'G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha';
export const PTYH_LAZER_PROGRAM_ID =
	'pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt';
export const PYTH_LAZER_STORAGE_ACCOUNT_KEY = new PublicKey(
	'3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL'
);

export const DEFAULT_CONFIRMATION_OPTS: ConfirmOptions = {
	preflightCommitment: 'confirmed',
	commitment: 'confirmed',
};

export const configs: { [key in DriftEnv]: DriftConfig } = {
	devnet: {
		ENV: 'devnet',
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		DRIFT_PROGRAM_ID,
		JIT_PROXY_PROGRAM_ID: 'J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP',
		USDC_MINT_ADDRESS: '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2',
		SERUM_V3: 'DESVgJVGajEgKGXhb6XmqDHGz3VjdgP7rEVESBgxmroY',
		PHOENIX: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
		OPENBOOK: 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',
		V2_ALPHA_TICKET_MINT_ADDRESS:
			'DeEiGWfCMP9psnLGkxGrBBMEAW5Jv8bBGMN8DCtFRCyB',
		PERP_MARKETS: DevnetPerpMarkets,
		SPOT_MARKETS: DevnetSpotMarkets,
		MARKET_LOOKUP_TABLE: 'FaMS3U4uBojvGn5FSDEPimddcXsCfwkKsFgMVVnDdxGb',
		DRIFT_ORACLE_RECEIVER_ID,
		SB_ON_DEMAND_PID: ON_DEMAND_DEVNET_PID,
	},
	'mainnet-beta': {
		ENV: 'mainnet-beta',
		PYTH_ORACLE_MAPPING_ADDRESS: 'AHtgzX45WTKfkPG53L6WYhGEXwQkN1BVknET3sVsLL8J',
		DRIFT_PROGRAM_ID,
		JIT_PROXY_PROGRAM_ID: 'J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP',
		USDC_MINT_ADDRESS: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		SERUM_V3: 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
		PHOENIX: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
		OPENBOOK: 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',
		V2_ALPHA_TICKET_MINT_ADDRESS:
			'Cmvhycb6LQvvzaShGw4iDHRLzeSSryioAsU98DSSkMNa',
		PERP_MARKETS: MainnetPerpMarkets,
		SPOT_MARKETS: MainnetSpotMarkets,
		MARKET_LOOKUP_TABLE: 'Fpys8GRa5RBWfyeN7AaDUwFGD1zkDCA4z3t4CJLV8dfL',
		SERUM_LOOKUP_TABLE: 'GPZkp76cJtNL2mphCvT6FXkJCVPpouidnacckR6rzKDN',
		DRIFT_ORACLE_RECEIVER_ID,
		SB_ON_DEMAND_PID: ON_DEMAND_MAINNET_PID,
	},
};

let currentConfig: DriftConfig = configs.devnet;

export const getConfig = (): DriftConfig => currentConfig;

/**
 * Allows customization of the SDK's environment and endpoints. You can pass individual settings to override the settings with your own presets.
 *
 * Defaults to master environment if you don't use this function.
 * @param props
 * @returns
 */
export const initialize = (props: {
	env: DriftEnv;
	overrideEnv?: Partial<DriftConfig>;
}): DriftConfig => {
	//@ts-ignore
	if (props.env === 'master')
		return { ...configs['devnet'], ...(props.overrideEnv ?? {}) };

	currentConfig = { ...configs[props.env], ...(props.overrideEnv ?? {}) };

	return currentConfig;
};

export function getMarketsAndOraclesForSubscription(
	env: DriftEnv,
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

export async function findAllMarketAndOracles(program: Program): Promise<{
	perpMarketIndexes: number[];
	perpMarketAccounts: PerpMarketAccount[];
	spotMarketIndexes: number[];
	oracleInfos: OracleInfo[];
	spotMarketAccounts: SpotMarketAccount[];
}> {
	const perpMarketIndexes = [];
	const spotMarketIndexes = [];
	const oracleInfos = new Map<string, OracleInfo>();

	const perpMarketProgramAccounts =
		(await program.account.perpMarket.all()) as ProgramAccount<PerpMarketAccount>[];
	const spotMarketProgramAccounts =
		(await program.account.spotMarket.all()) as ProgramAccount<SpotMarketAccount>[];

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
