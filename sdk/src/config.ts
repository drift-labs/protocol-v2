import {
	DevnetPerpMarkets,
	MainnetMarkets,
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

type DriftConfig = {
	ENV: DriftEnv;
	PYTH_ORACLE_MAPPING_ADDRESS: string;
	CLEARING_HOUSE_PROGRAM_ID: string;
	USDC_MINT_ADDRESS: string;
	SERUM_V3: string;
	V2_ALPHA_TICKET_MINT_ADDRESS: string;
	PERP_MARKETS: PerpMarketConfig[];
	SPOT_MARKETS: SpotMarketConfig[];
};

export type DriftEnv = 'devnet' | 'mainnet-beta';

export const configs: { [key in DriftEnv]: DriftConfig } = {
	devnet: {
		ENV: 'devnet',
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: 'H4G1xzAoqSW8n1Edmeowqsgc895tSNCeDPafYjv4Md7i',
		USDC_MINT_ADDRESS: '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2',
		SERUM_V3: 'DESVgJVGajEgKGXhb6XmqDHGz3VjdgP7rEVESBgxmroY',
		V2_ALPHA_TICKET_MINT_ADDRESS:
			'DeEiGWfCMP9psnLGkxGrBBMEAW5Jv8bBGMN8DCtFRCyB',
		PERP_MARKETS: DevnetPerpMarkets,
		SPOT_MARKETS: DevnetSpotMarkets,
	},
	'mainnet-beta': {
		ENV: 'mainnet-beta',
		PYTH_ORACLE_MAPPING_ADDRESS: 'AHtgzX45WTKfkPG53L6WYhGEXwQkN1BVknET3sVsLL8J',
		CLEARING_HOUSE_PROGRAM_ID: 'dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN',
		USDC_MINT_ADDRESS: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		SERUM_V3: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
		V2_ALPHA_TICKET_MINT_ADDRESS: '',
		PERP_MARKETS: MainnetMarkets,
		SPOT_MARKETS: MainnetSpotMarkets,
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

export function getMarketsAndOraclesForSubscription(env: DriftEnv): {
	perpMarketIndexes: number[];
	spotMarketIndexes: number[];
	oracleInfos: OracleInfo[];
} {
	const perpMarketIndexes = [];
	const spotMarketIndexes = [];
	const oracleInfos = new Map<string, OracleInfo>();

	for (const market of PerpMarkets[env]) {
		perpMarketIndexes.push(market.marketIndex);
		oracleInfos.set(market.oracle.toString(), {
			publicKey: market.oracle,
			source: market.oracleSource,
		});
	}

	for (const spotMarket of SpotMarkets[env]) {
		spotMarketIndexes.push(spotMarket.marketIndex);
		oracleInfos.set(spotMarket.oracle.toString(), {
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
