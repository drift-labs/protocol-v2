
type DriftConfig = {
	ENV: DriftEnv;
	PYTH_ORACLE_MAPPING_ADDRESS: string;
	CLEARING_HOUSE_PROGRAM_ID: string;
	USDC_MINT_ADDRESS: string;
	MOCK_USDC_FAUCET_ADDRESS: string;
	EXCHANGE_HISTORY_SERVER_URL: string;
};

export type DriftEnv = 'local' | 'master' | 'devnet' | 'mainnet-beta';

export const configs: { [key in DriftEnv]: DriftConfig } = {
	local: {
		ENV: 'local',
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: '4iMFTW4MbQexJPRBF7n1bJ7yBjCDG1rpFwaspGSCmzYA',
		USDC_MINT_ADDRESS: '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2',
		MOCK_USDC_FAUCET_ADDRESS: '2vUr12Y5ELMMBCshTkkBrCHkcBXmigpqEGCKAmc5YqcD',
		EXCHANGE_HISTORY_SERVER_URL: 'http://localhost:5000',
	},
	master: {
		ENV: 'master',
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: 'Gpz7UHP5NPvWLs79xs3qi19Vu6Z38YEuc1Mjtrj4BybE',
		USDC_MINT_ADDRESS: '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2',
		MOCK_USDC_FAUCET_ADDRESS: '7Ru4SBDA3wPvsPcz6KVg2baVruTRK2tqYq9AuAXRqF2K',
		EXCHANGE_HISTORY_SERVER_URL: 'https://master.history.drift.trade',
	},
	devnet: {
		ENV: 'devnet',
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: '4awDz7psr6PTq8CrE72anZx7Bbs8EtwToNtQf3YuT6of',
		USDC_MINT_ADDRESS: '5p5BksZo5qHAvZxdwKJWWF7QLk4boLavSnrqRvKJGWFD',
		MOCK_USDC_FAUCET_ADDRESS: '79wPMqgrg3VXUcUiwPUcyBYkrKu8FnqSodGirvhZxGQ6',
		EXCHANGE_HISTORY_SERVER_URL: 'https://devnet.history.drift.trade',
	},
	//TODO - replace these with mainnet values
	'mainnet-beta': {
		ENV: 'mainnet-beta',
		PYTH_ORACLE_MAPPING_ADDRESS: 'AHtgzX45WTKfkPG53L6WYhGEXwQkN1BVknET3sVsLL8J',
		CLEARING_HOUSE_PROGRAM_ID: 'damm6x5ddj4JZKzpFN9y2jgtnHY3xryBUoQfjFuL5qo',
		USDC_MINT_ADDRESS: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		MOCK_USDC_FAUCET_ADDRESS: 'FPj8ZqD9CnsDismBjHq4oXLjm8zypvitc86mSwj9tYgH',
		EXCHANGE_HISTORY_SERVER_URL: 'https://mainnet-beta.history.drift.trade',
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
