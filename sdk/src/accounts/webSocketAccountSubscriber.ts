import { AccountData, AccountSubscriber } from './types';
import { Program } from '@project-serum/anchor';
import { AccountInfo, Context, PublicKey } from '@solana/web3.js';
import { capitalize } from './utils';
import * as Buffer from 'buffer';

export class WebSocketAccountSubscriber<T> implements AccountSubscriber<T> {
	data?: T;
	accountData?: AccountData;
	accountName: string;
	program: Program;
	accountPublicKey: PublicKey;
	onChange: (data: T) => void;
	listenerId?: number;

	public constructor(
		accountName: string,
		program: Program,
		accountPublicKey: PublicKey
	) {
		this.accountName = accountName;
		this.program = program;
		this.accountPublicKey = accountPublicKey;
	}

	async subscribe(onChange: (data: T) => void): Promise<void> {
		if (this.listenerId) {
			return;
		}

		this.onChange = onChange;
		await this.fetch();

		this.listenerId = this.program.provider.connection.onAccountChange(
			this.accountPublicKey,
			(accountInfo, context) => {
				this.handleRpcResponse(context, accountInfo);
			},
			this.program.provider.opts.commitment
		);
	}

	async fetch(): Promise<void> {
		const rpcResponse =
			await this.program.provider.connection.getAccountInfoAndContext(
				this.accountPublicKey,
				this.program.provider.opts.commitment
			);
		this.handleRpcResponse(rpcResponse.context, rpcResponse?.value);
	}

	handleRpcResponse(context: Context, accountInfo?: AccountInfo<Buffer>): void {
		const newSlot = context.slot;
		let newBuffer: Buffer | undefined = undefined;
		if (accountInfo) {
			newBuffer = accountInfo.data;
		}

		if (!this.accountData) {
			this.accountData = {
				buffer: newBuffer,
				slot: newSlot,
			};
			if (newBuffer) {
				this.data = this.program.account[
					this.accountName
				].coder.accounts.decode(capitalize(this.accountName), newBuffer);
				this.onChange(this.data);
			}
			return;
		}

		if (newSlot <= this.accountData.slot) {
			return;
		}

		const oldBuffer = this.accountData.buffer;
		if (newBuffer && (!oldBuffer || !newBuffer.equals(oldBuffer))) {
			this.accountData = {
				buffer: newBuffer,
				slot: newSlot,
			};
			this.data = this.program.account[this.accountName].coder.accounts.decode(
				capitalize(this.accountName),
				newBuffer
			);
			this.onChange(this.data);
		}
	}

	unsubscribe(): Promise<void> {
		if (this.listenerId) {
			const promise =
				this.program.provider.connection.removeAccountChangeListener(
					this.listenerId
				);
			this.listenerId = undefined;
			return promise;
		}
	}
}
