import { ConfirmOptions, Connection, PublicKey } from '@solana/web3.js';
import { IWallet } from '../types';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import { TxSender } from '../tx/types';
import { Idl, Program, Provider } from '@project-serum/anchor';
import { ClearingHouse } from '../clearingHouse';
import clearingHouseIDL from '../idl/clearing_house.json';
import { WebSocketClearingHouseAccountSubscriber } from '../accounts/webSocketClearingHouseAccountSubscriber';
import { DefaultTxSender } from '../tx/defaultTxSender';
import { ClearingHouseAccountSubscriber } from '../accounts/types';
import { PollingClearingHouseAccountSubscriber } from '../accounts/pollingClearingHouseAccountSubscriber';
import { Admin } from '../admin';

export type ClearingHouseConfigType = 'websocket' | 'polling' | 'custom';

type BaseClearingHouseConfig = {
	type: ClearingHouseConfigType;
	connection: Connection;
	wallet: IWallet;
	programID: PublicKey;
	opts?: ConfirmOptions;
	txSender?: TxSender;
};

type WebSocketClearingHouseConfiguration = BaseClearingHouseConfig;

type PollingClearingHouseConfiguration = BaseClearingHouseConfig & {
	accountLoader: BulkAccountLoader;
};

type ClearingHouseConfig =
	| PollingClearingHouseConfiguration
	| WebSocketClearingHouseConfiguration;

export function getWebSocketClearingHouseConfig(
	connection: Connection,
	wallet: IWallet,
	programID: PublicKey,
	opts: ConfirmOptions = Provider.defaultOptions(),
	txSender?: TxSender
): WebSocketClearingHouseConfiguration {
	return {
		type: 'websocket',
		connection,
		wallet,
		programID,
		opts,
		txSender,
	};
}

export function getPollingClearingHouseConfig(
	connection: Connection,
	wallet: IWallet,
	programID: PublicKey,
	accountLoader: BulkAccountLoader,
	opts: ConfirmOptions = Provider.defaultOptions(),
	txSender?: TxSender
): PollingClearingHouseConfiguration {
	return {
		type: 'polling',
		connection,
		wallet,
		programID,
		accountLoader,
		opts,
		txSender,
	};
}

export function getClearingHouse(config: ClearingHouseConfig): ClearingHouse {
	const provider = new Provider(config.connection, config.wallet, config.opts);
	const program = new Program(
		clearingHouseIDL as Idl,
		config.programID,
		provider
	);
	let accountSubscriber: ClearingHouseAccountSubscriber;
	if (config.type === 'websocket') {
		accountSubscriber = new WebSocketClearingHouseAccountSubscriber(program);
	} else if (config.type === 'polling') {
		accountSubscriber = new PollingClearingHouseAccountSubscriber(
			program,
			(config as PollingClearingHouseConfiguration).accountLoader
		);
	}

	const txSender = config.txSender || new DefaultTxSender(provider);
	return new ClearingHouse(
		config.connection,
		config.wallet,
		program,
		accountSubscriber,
		txSender,
		config.opts
	);
}

export function getAdmin(config: ClearingHouseConfig): Admin {
	const provider = new Provider(config.connection, config.wallet, config.opts);
	const program = new Program(
		clearingHouseIDL as Idl,
		config.programID,
		provider
	);
	let accountSubscriber: ClearingHouseAccountSubscriber;
	if (config.type === 'websocket') {
		accountSubscriber = new WebSocketClearingHouseAccountSubscriber(program);
	} else if (config.type === 'polling') {
		accountSubscriber = new PollingClearingHouseAccountSubscriber(
			program,
			(config as PollingClearingHouseConfiguration).accountLoader
		);
	}

	const txSender = config.txSender || new DefaultTxSender(provider);
	return new Admin(
		config.connection,
		config.wallet,
		program,
		accountSubscriber,
		txSender,
		config.opts
	);
}
