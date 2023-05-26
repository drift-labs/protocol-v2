import { DriftClient } from '../driftClient';
import { UserAccount } from '../types';
import { getNonIdleUserFilter, getUserFilter } from '../memcmp';
import {
	MemcmpFilter,
	PublicKey,
	RpcResponseAndContext,
} from '@solana/web3.js';
import { Buffer } from 'buffer';

export class OrderSubscriber {
	private driftClient: DriftClient;
	usersAccounts = new Map<string, { slot: number; userAccount: UserAccount }>();

	constructor({ driftClient }: { driftClient: DriftClient }) {
		this.driftClient = driftClient;
	}

	public async subscribe(): Promise<void> {
		await this.loadUsers();

		this.driftClient.connection.onProgramAccountChange(
			this.driftClient.program.programId,
			(keyAccountInfo, context) => {
				const userKey = keyAccountInfo.accountId.toBase58();
				const current = this.usersAccounts.get(userKey);
				if (current && current.slot < context.slot) {
					return;
				}

				const userAccount =
					this.driftClient.program.account.user.coder.accounts.decode(
						'User',
						keyAccountInfo.accountInfo.data
					);
				this.usersAccounts.set(userKey, {
					slot: context.slot,
					userAccount,
				});
			},
			this.driftClient.opts.commitment,
			this.getFilters()
		);
	}

	async loadUsers(): Promise<void> {
		const rpcRequestArgs = [
			this.driftClient.program.programId.toBase58(),
			{
				commitment: this.driftClient.opts.commitment,
				filters: this.getFilters(),
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

		for (const programAccount of rpcResponseAndContext.value) {
			// @ts-ignore
			const buffer = Buffer.from(
				programAccount.account.data[0],
				programAccount.account.data[1]
			);
			const userAccount =
				this.driftClient.program.account.user.coder.accounts.decode(
					'User',
					buffer
				);

			this.usersAccounts.set(programAccount.pubkey.toString(), {
				slot,
				userAccount,
			});
		}
	}

	getFilters(): MemcmpFilter[] {
		return [getUserFilter(), getNonIdleUserFilter()];
	}
}
