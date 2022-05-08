import { ConfirmOptions, Connection, PublicKey } from '@solana/web3.js';
import { IWallet } from '../types';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import { TxSender } from '../tx/types';
import { AnchorProvider, Idl, Program } from '@project-serum/anchor';
import { ClearingHouse } from '../clearingHouse';
import clearingHouseIDL from '../idl/clearing_house.json';
import { WebSocketClearingHouseAccountSubscriber } from '../accounts/webSocketClearingHouseAccountSubscriber';
import { DefaultTxSender } from '../tx/defaultTxSender';
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
};

type WebSocketClearingHouseConfiguration = BaseClearingHouseConfig;

type PollingClearingHouseConfiguration = BaseClearingHouseConfig & {
	accountLoader: BulkAccountLoader;
};

type ClearingHouseConfig =
	| PollingClearingHouseConfiguration
	| WebSocketClearingHouseConfiguration;

export type TxSenderType = 'default' | 'retry';

type BaseTxSenderConfig = {
	type: TxSenderType;
};

type DefaultTxSenderConfig = BaseTxSenderConfig;

type RetryTxSenderConfig = BaseTxSenderConfig & {
	timeout?: number;
	retrySleep?: number;
	additionalConnections?: Connection[];
};

type TxSenderConfig = DefaultTxSenderConfig | RetryTxSenderConfig;

export function getWebSocketClearingHouseConfig(
	connection: Connection,
	wallet: IWallet,
	programID: PublicKey,
	opts: ConfirmOptions = AnchorProvider.defaultOptions(),
	txSenderConfig?: TxSenderConfig
): WebSocketClearingHouseConfiguration {
	return {
		type: 'websocket',
		connection,
		wallet,
		programID,
		opts,
		txSenderConfig,
	};
}

export function getPollingClearingHouseConfig(
	connection: Connection,
	wallet: IWallet,
	programID: PublicKey,
	accountLoader: BulkAccountLoader,
	opts: ConfirmOptions = AnchorProvider.defaultOptions(),
	txSenderConfig?: TxSenderConfig
): PollingClearingHouseConfiguration {
	return {
		type: 'polling',
		connection,
		wallet,
		programID,
		accountLoader,
		opts,
		txSenderConfig,
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
		accountSubscriber = new WebSocketClearingHouseAccountSubscriber(program);
	} else if (config.type === 'polling') {
		accountSubscriber = new PollingClearingHouseAccountSubscriber(
			program,
			(config as PollingClearingHouseConfiguration).accountLoader
		);
	}

	let txSender: TxSender;
	if (config.txSenderConfig?.type === 'retry') {
		const txSenderConfig = config.txSenderConfig as RetryTxSenderConfig;
		txSender = new RetryTxSender(
			provider,
			txSenderConfig.timeout,
			txSenderConfig.retrySleep,
			txSenderConfig.additionalConnections
		);
	} else {
		txSender = new DefaultTxSender(provider);
	}

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
		accountSubscriber = new WebSocketClearingHouseAccountSubscriber(program);
	} else if (config.type === 'polling') {
		accountSubscriber = new PollingClearingHouseAccountSubscriber(
			program,
			(config as PollingClearingHouseConfiguration).accountLoader
		);
	}

	let txSender: TxSender;
	if (config.txSenderConfig?.type === 'retry') {
		const txSenderConfig = config.txSenderConfig as RetryTxSenderConfig;
		txSender = new RetryTxSender(
			provider,
			txSenderConfig.timeout,
			txSenderConfig.retrySleep,
			txSenderConfig.additionalConnections
		);
	} else {
		txSender = new DefaultTxSender(provider);
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
