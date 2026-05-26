import { AdminClient } from './adminClient';
import { ConfirmOptions, Signer, Transaction } from '@solana/web3.js';
import { TxSigAndSlot } from './tx/types';
import { PollingVelocityClientAccountSubscriber } from './accounts/pollingVelocityClientAccountSubscriber';
import { VelocityClientConfig } from './velocityClientConfig';

export class TestClient extends AdminClient {
	public constructor(config: VelocityClientConfig) {
		config.txVersion = 'legacy';
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
			this.accountSubscriber as PollingVelocityClientAccountSubscriber
		).accountLoader.mostRecentSlot;
		await this.fetchAccounts();
		while (lastFetchedSlot < slot) {
			await this.fetchAccounts();
			lastFetchedSlot = (
				this.accountSubscriber as PollingVelocityClientAccountSubscriber
			).accountLoader.mostRecentSlot;
		}

		return { txSig, slot };
	}
}
