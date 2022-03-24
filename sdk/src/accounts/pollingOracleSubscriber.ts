import { NotSubscribedError, OracleEvents, OracleSubscriber } from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './bulkAccountLoader';
import { OracleClient, OraclePriceData } from '../oracles/types';

export class PollingOracleSubscriber implements OracleSubscriber {
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, OracleEvents>;
	publicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	oracleClient: OracleClient;
	callbackId?: string;
	errorCallbackId?: string;

	oraclePriceData?: OraclePriceData;

	public constructor(
		publicKey: PublicKey,
		oracleClient: OracleClient,
		accountLoader: BulkAccountLoader
	) {
		this.isSubscribed = false;
		this.publicKey = publicKey;
		this.oracleClient = oracleClient;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.addToAccountLoader();
		await this.fetch();
		this.eventEmitter.emit('update');

		this.isSubscribed = true;
		return true;
	}

	addToAccountLoader(): void {
		if (this.callbackId) {
			return;
		}

		this.callbackId = this.accountLoader.addAccount(
			this.publicKey,
			async (buffer) => {
				const oraclePriceData =
					await this.oracleClient.getOraclePriceDataFromBuffer(buffer);
				this.oraclePriceData = oraclePriceData;
				// @ts-ignore
				this.eventEmitter.emit('oracleUpdate', oraclePriceData);
				this.eventEmitter.emit('update');
			}
		);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	async fetch(): Promise<void> {
		await this.accountLoader.load();
		const buffer = this.accountLoader.getAccountData(this.publicKey);
		this.oraclePriceData = await this.oracleClient.getOraclePriceDataFromBuffer(
			buffer
		);
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		this.accountLoader.removeAccount(this.publicKey, this.callbackId);
		this.callbackId = undefined;

		this.accountLoader.removeErrorCallbacks(this.errorCallbackId);
		this.errorCallbackId = undefined;

		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getOraclePriceData(): OraclePriceData {
		this.assertIsSubscribed();
		return this.oraclePriceData;
	}
}
