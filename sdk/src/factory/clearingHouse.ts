import { ConfirmOptions, Connection, PublicKey } from '@solana/web3.js';
import { IWallet } from '../types';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import { TxSender } from '../tx/types';
import { AnchorProvider, Idl, Program } from '@project-serum/anchor';
import { ClearingHouse } from '../clearingHouse';
import clearingHouseIDL from '../idl/clearing_house.json';
import { WebSocketClearingHouseAccountSubscriber } from '../accounts/webSocketClearingHouseAccountSubscriber';
import { ClearingHouseAccountSubscriber } from '../accounts/types';
import { PollingClearingHouseAccountSubscriber } from '../accounts/pollingClearingHouseAccountSubscriber';
import { Admin } from '../admin';
import { RetryTxSender } from '../tx/retryTxSender';

export type ClearingHouseConfigType = 'websocket' | 'polling' | 'custom';

type BaseClearingHouseConfig = {
	type: ClearingHouseConfigType;
	connection: Connection;
	wallet: IWallet;
	programID: PublicKey;
	opts?: ConfirmOptions;
	txSenderConfig?: TxSenderConfig;
	userId?: number;
};

type WebSocketClearingHouseConfiguration = BaseClearingHouseConfig;

type PollingClearingHouseConfiguration = BaseClearingHouseConfig & {
	accountLoader: BulkAccountLoader;
};

type ClearingHouseConfig =
	| PollingClearingHouseConfiguration
	| WebSocketClearingHouseConfiguration;

export type TxSenderType = 'retry';

type BaseTxSenderConfig = {
	type: TxSenderType;
};

type RetryTxSenderConfig = BaseTxSenderConfig & {
	timeout?: number;
	retrySleep?: number;
	additionalConnections?: Connection[];
};

type TxSenderConfig = RetryTxSenderConfig;

export function getWebSocketClearingHouseConfig(
	connection: Connection,
	wallet: IWallet,
	programID: PublicKey,
	opts: ConfirmOptions = AnchorProvider.defaultOptions(),
	txSenderConfig?: TxSenderConfig,
	userId?: number
): WebSocketClearingHouseConfiguration {
	return {
		type: 'websocket',
		connection,
		wallet,
		programID,
		opts,
		txSenderConfig,
		userId,
	};
}

export function getPollingClearingHouseConfig(
	connection: Connection,
	wallet: IWallet,
	programID: PublicKey,
	accountLoader: BulkAccountLoader,
	opts: ConfirmOptions = AnchorProvider.defaultOptions(),
	txSenderConfig?: TxSenderConfig,
	userId?: number
): PollingClearingHouseConfiguration {
	return {
		type: 'polling',
		connection,
		wallet,
		programID,
		accountLoader,
		opts,
		txSenderConfig,
		userId,
	};
}

export function getClearingHouse(config: ClearingHouseConfig): ClearingHouse {
	const provider = new AnchorProvider(
		config.connection,
		config.wallet,
		config.opts
	);
	const program = new Program(
		clearingHouseIDL as Idl,
		config.programID,
		provider
	);
	let accountSubscriber: ClearingHouseAccountSubscriber;
	if (config.type === 'websocket') {
		accountSubscriber = new WebSocketClearingHouseAccountSubscriber(
			program,
			provider.wallet.publicKey,
			config.userId
		);
	} else if (config.type === 'polling') {
		accountSubscriber = new PollingClearingHouseAccountSubscriber(
			program,
			provider.wallet.publicKey,
			(config as PollingClearingHouseConfiguration).accountLoader,
			config.userId
		);
	}

	let txSender: TxSender;
	if (config.txSenderConfig) {
		const txSenderConfig = config.txSenderConfig as RetryTxSenderConfig;
		txSender = new RetryTxSender(
			provider,
			txSenderConfig.timeout,
			txSenderConfig.retrySleep,
			txSenderConfig.additionalConnections
		);
	} else {
		txSender = new RetryTxSender(provider);
	}

	return new ClearingHouse(
		config.connection,
		config.wallet,
		program,
		accountSubscriber,
		txSender,
		config.opts,
		config.userId
	);
}

export function getAdmin(config: ClearingHouseConfig): Admin {
	const provider = new AnchorProvider(
		config.connection,
		config.wallet,
		config.opts
	);
	const program = new Program(
		clearingHouseIDL as Idl,
		config.programID,
		provider
	);
	let accountSubscriber: ClearingHouseAccountSubscriber;
	if (config.type === 'websocket') {
		accountSubscriber = new WebSocketClearingHouseAccountSubscriber(
			program,
			provider.wallet.publicKey,
			config.userId
		);
	} else if (config.type === 'polling') {
		accountSubscriber = new PollingClearingHouseAccountSubscriber(
			program,
			provider.wallet.publicKey,
			(config as PollingClearingHouseConfiguration).accountLoader,
			config.userId
		);
	}

	let txSender: TxSender;
	if (config.txSenderConfig) {
		const txSenderConfig = config.txSenderConfig as RetryTxSenderConfig;
		txSender = new RetryTxSender(
			provider,
			txSenderConfig.timeout,
			txSenderConfig.retrySleep,
			txSenderConfig.additionalConnections
		);
	} else {
		txSender = new RetryTxSender(provider);
	}

	return new Admin(
		config.connection,
		config.wallet,
		program,
		accountSubscriber,
		txSender,
		config.opts
	);
}
