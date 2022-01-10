import { AccountSubscriber } from './types';
import { Program } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';

export class WebSocketAccountSubscriber<T> implements AccountSubscriber<T> {
	data?: T;
	accountName: string;
	program: Program;
	accountPublicKey: PublicKey;
	onChange: (data: T) => void;

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
		this.onChange = onChange;
		await this.fetch();

		this.program.account[this.accountName]
			.subscribe(this.accountPublicKey, this.program.provider.opts.commitment)
			.on('change', async (data: T) => {
				this.data = data;
				this.onChange(data);
			});
	}

	async fetch(): Promise<void> {
		const newData = (await this.program.account[this.accountName].fetch(
			this.accountPublicKey
		)) as T;

		// if data has changed trigger update
		if (JSON.stringify(newData) !== JSON.stringify(this.data)) {
			this.data = newData;
			this.onChange(this.data);
		}
	}

	unsubscribe(): Promise<void> {
		return this.program.account[this.accountName].unsubscribe(
			this.accountPublicKey
		);
	}
}
