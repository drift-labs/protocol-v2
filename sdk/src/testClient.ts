import { AdminClient } from './adminClient';
import { ConfirmOptions, Signer, Transaction } from '@solana/web3.js';
import { TxSigAndSlot } from './tx/types';
import { PollingDriftClientAccountSubscriber } from './accounts/pollingDriftClientAccountSubscriber';
import { DriftClientConfig } from './driftClientConfig';

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
		await this.fetchAccounts();
		let tries = 0;
		while (lastFetchedSlot < slot) {
			await this.fetchAccounts();
			lastFetchedSlot = (
				this.accountSubscriber as PollingDriftClientAccountSubscriber
			).accountLoader.mostRecentSlot;
			tries++;
			if (tries > 10) {
				break;
			}
		}

		return { txSig, slot };
	}
}
