import { PublicKey } from '@solana/web3.js';
import { ClearingHouse } from '../clearingHouse';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import { ClearingHouseUser } from '../clearingHouseUser';
import { UserAccountSubscriber } from '../accounts/types';
import { WebSocketUserAccountSubscriber } from '../accounts/webSocketUserAccountSubscriber';
import { PollingUserAccountSubscriber } from '../accounts/pollingUserAccountSubscriber';

export type ClearingHouseUserConfigType = 'websocket' | 'polling' | 'custom';

type BaseClearingHouseUserConfig = {
	type: ClearingHouseUserConfigType;
	clearingHouse: ClearingHouse;
	userAccountPublicKey: PublicKey;
};

type WebSocketClearingHouseUserConfig = BaseClearingHouseUserConfig;

type PollingClearingHouseUserConfig = BaseClearingHouseUserConfig & {
	accountLoader: BulkAccountLoader;
};

type ClearingHouseUserConfig =
	| PollingClearingHouseUserConfig
	| WebSocketClearingHouseUserConfig;

export function getWebSocketClearingHouseUserConfig(
	clearingHouse: ClearingHouse,
	userAccountPublicKey: PublicKey
): WebSocketClearingHouseUserConfig {
	return {
		type: 'websocket',
		clearingHouse,
		userAccountPublicKey,
	};
}

export function getPollingClearingHouseUserConfig(
	clearingHouse: ClearingHouse,
	userAccountPublicKey: PublicKey,
	accountLoader: BulkAccountLoader
): PollingClearingHouseUserConfig {
	return {
		type: 'polling',
		clearingHouse,
		userAccountPublicKey,
		accountLoader,
	};
}

export function getClearingHouseUser(
	config: ClearingHouseUserConfig
): ClearingHouseUser {
	let accountSubscriber: UserAccountSubscriber;
	if (config.type === 'websocket') {
		accountSubscriber = new WebSocketUserAccountSubscriber(
			config.clearingHouse.program,
			config.userAccountPublicKey
		);
	} else if (config.type === 'polling') {
		accountSubscriber = new PollingUserAccountSubscriber(
			config.clearingHouse.program,
			config.userAccountPublicKey,
			(config as PollingClearingHouseUserConfig).accountLoader
		);
	}

	return new ClearingHouseUser(
		config.clearingHouse,
		config.userAccountPublicKey,
		accountSubscriber
	);
}
