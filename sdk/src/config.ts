type DriftConfig = {
	PYTH_ORACLE_MAPPING_ADDRESS: string;
	CLEARING_HOUSE_PROGRAM_ID: string;
	USDC_MINT_ADDRESS: string;
	MOCK_USDC_FAUCET_ADDRESS: string;
	EXCHANGE_HISTORY_SERVER_URL: string;
};

export type DriftEnv = 'local' | 'master' | 'devnet' | 'mainnet-beta';

const configs: { [key in DriftEnv]: DriftConfig } = {
	local: {
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: 'CxoFf4oyt8AbVvxQ5DqrA33C2me28erNf8A11TrvBrLt',
		USDC_MINT_ADDRESS: '2dNmQf9RjEwW4C7hLrhnenipyhYMSxYMyZ5F3oqQb4Gt',
		MOCK_USDC_FAUCET_ADDRESS: '6QyqoDq895KMfJcZxVrFQJJpNpx8CLWR4Y2JNqYFsyP6',
		EXCHANGE_HISTORY_SERVER_URL: 'http://localhost:5000',
	},
	master: {
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: 'CxoFf4oyt8AbVvxQ5DqrA33C2me28erNf8A11TrvBrLt',
		USDC_MINT_ADDRESS: '2dNmQf9RjEwW4C7hLrhnenipyhYMSxYMyZ5F3oqQb4Gt',
		MOCK_USDC_FAUCET_ADDRESS: '6QyqoDq895KMfJcZxVrFQJJpNpx8CLWR4Y2JNqYFsyP6',
		EXCHANGE_HISTORY_SERVER_URL: 'https://master.history.drift.trade',
	},
	devnet: {
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: 'CxoFf4oyt8AbVvxQ5DqrA33C2me28erNf8A11TrvBrLt',
		USDC_MINT_ADDRESS: '2dNmQf9RjEwW4C7hLrhnenipyhYMSxYMyZ5F3oqQb4Gt',
		MOCK_USDC_FAUCET_ADDRESS: '6QyqoDq895KMfJcZxVrFQJJpNpx8CLWR4Y2JNqYFsyP6',
		EXCHANGE_HISTORY_SERVER_URL: 'https://devnet.history.drift.trade',
	},
	//TODO - replace these with mainnet values
	'mainnet-beta': {
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: 'CxoFf4oyt8AbVvxQ5DqrA33C2me28erNf8A11TrvBrLt',
		USDC_MINT_ADDRESS: '2dNmQf9RjEwW4C7hLrhnenipyhYMSxYMyZ5F3oqQb4Gt',
		MOCK_USDC_FAUCET_ADDRESS: '6QyqoDq895KMfJcZxVrFQJJpNpx8CLWR4Y2JNqYFsyP6',
		EXCHANGE_HISTORY_SERVER_URL: 'https://devnet.history.drift.trade',
	},
};

let currentConfig: DriftConfig = configs.master;

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
	currentConfig = { ...configs[props.env], ...(props.overrideEnv ?? {}) };

	return currentConfig;
};
