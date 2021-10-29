import { AccountSubscriber } from './types';
import { Program } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';

export class WebSocketAccountSubscriber<T> implements AccountSubscriber<T> {
	data?: T;
	accountName: string;
	program: Program;
	accountPublicKey: PublicKey;

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
		this.data = (await this.program.account[this.accountName].fetch(
			this.accountPublicKey
		)) as T;

		onChange(this.data);

		this.program.account[this.accountName]
			.subscribe(this.accountPublicKey, this.program.provider.opts.commitment)
			.on('change', async (data: T) => {
				this.data = data;
				onChange(data);
			});
	}

	unsubscribe(): Promise<void> {
		return this.program.account[this.accountName].unsubscribe(
			this.accountPublicKey
		);
	}
}
