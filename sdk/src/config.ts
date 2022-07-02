import {
	DevnetMarkets,
	MainnetMarkets,
	MarketConfig,
	Markets,
} from './constants/markets';
import {
	BankConfig,
	Banks,
	DevnetBanks,
	MainnetBanks,
} from './constants/banks';
import { BN } from '@project-serum/anchor';
import { OracleInfo } from './oracles/types';

type DriftConfig = {
	ENV: DriftEnv;
	PYTH_ORACLE_MAPPING_ADDRESS: string;
	CLEARING_HOUSE_PROGRAM_ID: string;
	USDC_MINT_ADDRESS: string;
	MARKETS: MarketConfig[];
	BANKS: BankConfig[];
};

export type DriftEnv = 'devnet' | 'mainnet-beta';

export const configs: { [key in DriftEnv]: DriftConfig } = {
	devnet: {
		ENV: 'devnet',
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: 'Eqa21pSiUCR7e796As4mLK9ypo4sfu159mdUDiwY3dtx',
		USDC_MINT_ADDRESS: '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2',
		MARKETS: DevnetMarkets,
		BANKS: DevnetBanks,
	},
	'mainnet-beta': {
		ENV: 'mainnet-beta',
		PYTH_ORACLE_MAPPING_ADDRESS: 'AHtgzX45WTKfkPG53L6WYhGEXwQkN1BVknET3sVsLL8J',
		CLEARING_HOUSE_PROGRAM_ID: 'dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN',
		USDC_MINT_ADDRESS: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		MARKETS: MainnetMarkets,
		BANKS: MainnetBanks,
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

export function getMarketsBanksAndOraclesForSubscription(env: DriftEnv): {
	marketIndexes: BN[];
	bankIndexes: BN[];
	oracleInfos: OracleInfo[];
} {
	const marketIndexes = [];
	const bankIndexes = [];
	const oracleInfos = new Map<string, OracleInfo>();

	for (const market of Markets[env]) {
		marketIndexes.push(market.marketIndex);
		oracleInfos.set(market.oracle.toString(), {
			publicKey: market.oracle,
			source: market.oracleSource,
		});
	}

	for (const bank of Banks[env]) {
		bankIndexes.push(bank.bankIndex);
		oracleInfos.set(bank.oracle.toString(), {
			publicKey: bank.oracle,
			source: bank.oracleSource,
		});
	}

	return {
		marketIndexes,
		bankIndexes,
		oracleInfos: Array.from(oracleInfos.values()),
	};
}
