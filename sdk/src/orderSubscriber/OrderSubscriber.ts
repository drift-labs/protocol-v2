import { DriftClient } from '../driftClient';
import { UserAccount } from '../types';
import { getNonIdleUserFilter, getUserFilter } from '../memcmp';
import { PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { DLOB } from '../dlob/DLOB';
import { OrderSubscriberConfig } from './types';
import { PollingOrderSubscriber } from './PollingOrderSubscriber';

export class OrderSubscriber {
	driftClient: DriftClient;
	usersAccounts = new Map<string, { slot: number; userAccount: UserAccount }>();
	subscription: PollingOrderSubscriber;

	constructor(config: OrderSubscriberConfig) {
		this.driftClient = config.driftClient;
		this.subscription = new PollingOrderSubscriber({
			orderSubscriber: this,
			frequency: config.subscriptionConfig.frequency,
		});
	}

	public async subscribe(): Promise<void> {
		await this.subscription.subscribe();
	}

	async fetch(): Promise<void> {
		const rpcRequestArgs = [
			this.driftClient.program.programId.toBase58(),
			{
				commitment: this.driftClient.opts.commitment,
				filters: [getUserFilter(), getNonIdleUserFilter()],
				encoding: 'base64',
				withContext: true,
			},
		];

		// @ts-ignore
		const rpcJSONResponse: any = await this.driftClient.connection._rpcRequest(
			'getProgramAccounts',
			rpcRequestArgs
		);

		const rpcResponseAndContext: RpcResponseAndContext<
			Array<{
				pubkey: PublicKey;
				account: {
					data: [string, string];
				};
			}>
		> = rpcJSONResponse.result;

		const slot: number = rpcResponseAndContext.context.slot;

		const programAccountBufferMap = new Map<string, Buffer>();
		for (const programAccount of rpcResponseAndContext.value) {
			programAccountBufferMap.set(
				programAccount.pubkey.toString(),
				// @ts-ignore
				Buffer.from(
					programAccount.account.data[0],
					programAccount.account.data[1]
				)
			);
		}

		for (const [key, buffer] of programAccountBufferMap.entries()) {
			const slotAndUserAccount = this.usersAccounts.get(key);
			if (!slotAndUserAccount || slotAndUserAccount.slot < slot) {
				const userAccount =
					this.driftClient.program.account.user.coder.accounts.decode(
						'User',
						buffer
					);
				await this.usersAccounts.set(key, { slot, userAccount });
			}
		}

		for (const key of this.usersAccounts.keys()) {
			if (!programAccountBufferMap.has(key)) {
				this.usersAccounts.delete(key);
			}
		}
	}

	public async getDLOB(slot: number): Promise<DLOB> {
		const dlob = new DLOB();
		for (const [key, { userAccount }] of this.usersAccounts.entries()) {
			const userAccountPubkey = new PublicKey(key);
			for (const order of userAccount.orders) {
				dlob.insertOrder(order, userAccountPubkey, slot);
			}
		}
		return dlob;
	}

	public async unsubscribe(): Promise<void> {
		await this.subscription.unsubscribe();
	}
}
