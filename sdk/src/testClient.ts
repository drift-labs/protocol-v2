import { AdminClient } from './adminClient';
import { ConfirmOptions, Signer, Transaction } from '@solana/web3.js';
import { TxSigAndSlot } from './tx/types';
import { PollingDriftClientAccountSubscriber } from './accounts/pollingDriftClientAccountSubscriber';
import { DriftClientConfig } from './driftClientConfig';

/**
 * # TestClient
 * A test client for Drift protocol.
 * 
 * This is used to mock the behavior of a [DriftClient](./driftClient.ts) in tests.
 */
export class TestClient extends AdminClient {
	public constructor(config: DriftClientConfig) {
		if (config.accountSubscription.type !== 'polling') {
			throw new Error('Test client must be polling');
		}
		super(config);
	}

	async sendTransaction(
		tx: Transaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot> {
		const { txSig, slot } = await super.sendTransaction(
			tx,
			additionalSigners,
			opts,
			preSigned
		);

		let lastFetchedSlot = (
			this.accountSubscriber as PollingDriftClientAccountSubscriber
		).accountLoader.mostRecentSlot;
		while (lastFetchedSlot < slot) {
			await this.fetchAccounts();
			lastFetchedSlot = (
				this.accountSubscriber as PollingDriftClientAccountSubscriber
			).accountLoader.mostRecentSlot;
		}

		return { txSig, slot };
	}
}
