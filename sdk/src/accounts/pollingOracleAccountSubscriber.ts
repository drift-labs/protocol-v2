import {
	DataAndSlot,
	NotSubscribedError,
	OracleEvents,
	OracleAccountSubscriber,
} from './types';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './bulkAccountLoader';
import { OracleClient, OraclePriceData } from '../oracles/types';

export class PollingOracleAccountSubscriber implements OracleAccountSubscriber {
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, OracleEvents>;
	publicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	oracleClient: OracleClient;
	callbackId?: string;
	errorCallbackId?: string;

	oraclePriceData?: DataAndSlot<OraclePriceData>;

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

		await this.addToAccountLoader();

		let subscriptionSucceeded = false;
		let retries = 0;
		while (!subscriptionSucceeded && retries < 5) {
			await this.fetch();
			subscriptionSucceeded = this.didSubscriptionSucceed();
			retries++;
		}

		if (subscriptionSucceeded) {
			this.eventEmitter.emit('update');
		}

		this.isSubscribed = subscriptionSucceeded;
		return subscriptionSucceeded;
	}

	async addToAccountLoader(): Promise<void> {
		if (this.callbackId) {
			return;
		}

		this.callbackId = await this.accountLoader.addAccount(
			this.publicKey,
			async (buffer, slot) => {
				const oraclePriceData =
					await this.oracleClient.getOraclePriceDataFromBuffer(buffer);
				this.oraclePriceData = { data: oraclePriceData, slot };
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
		const { buffer, slot } = this.accountLoader.getBufferAndSlot(
			this.publicKey
		);
		this.oraclePriceData = {
			data: await this.oracleClient.getOraclePriceDataFromBuffer(buffer),
			slot,
		};
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

	public getOraclePriceData(): DataAndSlot<OraclePriceData> {
		this.assertIsSubscribed();
		return this.oraclePriceData;
	}

	didSubscriptionSucceed(): boolean {
		return !!this.oraclePriceData;
	}
}
