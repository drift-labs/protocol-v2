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
	authority: PublicKey;
	userId: number;
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
	authority: PublicKey,
	userId = 0
): WebSocketClearingHouseUserConfig {
	return {
		type: 'websocket',
		clearingHouse,
		authority,
		userId,
	};
}

export function getPollingClearingHouseUserConfig(
	clearingHouse: ClearingHouse,
	authority: PublicKey,
	accountLoader: BulkAccountLoader,
	userId = 0
): PollingClearingHouseUserConfig {
	return {
		type: 'polling',
		clearingHouse,
		authority,
		accountLoader,
		userId,
	};
}

export function getClearingHouseUser(
	config: ClearingHouseUserConfig
): ClearingHouseUser {
	let accountSubscriber: UserAccountSubscriber;
	if (config.type === 'websocket') {
		accountSubscriber = new WebSocketUserAccountSubscriber(
			config.clearingHouse.program,
			config.authority
		);
	} else if (config.type === 'polling') {
		accountSubscriber = new PollingUserAccountSubscriber(
			config.clearingHouse.program,
			config.authority,
			(config as PollingClearingHouseUserConfig).accountLoader
		);
	}

	return new ClearingHouseUser(
		config.clearingHouse,
		config.authority,
		accountSubscriber
	);
}
