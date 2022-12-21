import { AdminClient } from './adminClient';
import { ConfirmOptions, Signer, Transaction } from '@solana/web3.js';
import { TxSigAndSlot } from './tx/types';
import { PollingDriftClientAccountSubscriber } from './accounts/pollingDriftClientAccountSubscriber';

export class TestClient extends AdminClient {
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
