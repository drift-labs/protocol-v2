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
		CLEARING_HOUSE_PROGRAM_ID: '4SYdcUY98GqtjDjwRK9ZNpGqeCdjJnyfbFrXKsuKAvFF',
		USDC_MINT_ADDRESS: '82Ar4D7N6uwHpt3ziKGohhaRyYwzgFMof2nVD22HtFyn',
		MOCK_USDC_FAUCET_ADDRESS: 'AESxnDwuJZ4CXtkyphjUyjK6BQkpuRQPZa3uiwkpZ5NM',
		EXCHANGE_HISTORY_SERVER_URL: 'http://localhost:5000',
	},
	master: {
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: '4SYdcUY98GqtjDjwRK9ZNpGqeCdjJnyfbFrXKsuKAvFF',
		USDC_MINT_ADDRESS: '82Ar4D7N6uwHpt3ziKGohhaRyYwzgFMof2nVD22HtFyn',
		MOCK_USDC_FAUCET_ADDRESS: 'AESxnDwuJZ4CXtkyphjUyjK6BQkpuRQPZa3uiwkpZ5NM',
		EXCHANGE_HISTORY_SERVER_URL: 'https://master.history.drift.trade',
	},
	devnet: {
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: '4SYdcUY98GqtjDjwRK9ZNpGqeCdjJnyfbFrXKsuKAvFF',
		USDC_MINT_ADDRESS: '82Ar4D7N6uwHpt3ziKGohhaRyYwzgFMof2nVD22HtFyn',
		MOCK_USDC_FAUCET_ADDRESS: 'AESxnDwuJZ4CXtkyphjUyjK6BQkpuRQPZa3uiwkpZ5NM',
		EXCHANGE_HISTORY_SERVER_URL: 'https://devnet.history.drift.trade',
	},
	//TODO - replace these with mainnet values
	'mainnet-beta': {
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: '9vNbzHGb1WstrTr2x2Etm7rqQLAM6BJA5VS9Mzto2Efw',
		USDC_MINT_ADDRESS: 'CCkDdiRzZibDG8UMcrhBtAM2WhzmYpWAi4oUNvkg1zve',
		MOCK_USDC_FAUCET_ADDRESS: '8Bb44YDL3aWBzuhqGhbCpjQAABnUDcXELATFavad76qm',
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
