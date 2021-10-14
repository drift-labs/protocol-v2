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
		CLEARING_HOUSE_PROGRAM_ID: '8Fs5E3Jt4Tx7La47XHXBWevqGrZtTJB2txvU8MrBUoWS',
		USDC_MINT_ADDRESS: 'Doe9rajhwt18aAeaVe8vewzAsBk4kSQ2tTyZVUJhHjhY',
		MOCK_USDC_FAUCET_ADDRESS: '2z2DLVD3tBWc86pbvvy5qN31v1NXprM6zA5MDr2FMx64',
		EXCHANGE_HISTORY_SERVER_URL: 'http://localhost:5000',
	},
	master: {
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: 'H44rgda6EEuHE93aUX6FrAx6X6pNdKnBUkZiT8ssqjtG',
		USDC_MINT_ADDRESS: '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2',
		MOCK_USDC_FAUCET_ADDRESS: 'AmNeSW4UMPFBodCjEJD22G3kA8EraUGkhxr3GmdyEF4f',
		EXCHANGE_HISTORY_SERVER_URL: 'https://master.history.drift.trade',
	},
	devnet: {
		PYTH_ORACLE_MAPPING_ADDRESS: 'BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2',
		CLEARING_HOUSE_PROGRAM_ID: '4awDz7psr6PTq8CrE72anZx7Bbs8EtwToNtQf3YuT6of',
		USDC_MINT_ADDRESS: '5p5BksZo5qHAvZxdwKJWWF7QLk4boLavSnrqRvKJGWFD',
		MOCK_USDC_FAUCET_ADDRESS: '79wPMqgrg3VXUcUiwPUcyBYkrKu8FnqSodGirvhZxGQ6',
		EXCHANGE_HISTORY_SERVER_URL: 'https://devnet.history.drift.trade',
	},
	//TODO - replace these with mainnet values
	'mainnet-beta': {
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
