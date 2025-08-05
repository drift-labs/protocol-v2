import { ResubOpts, GrpcConfigs } from './types';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { UserAccount } from '../types';
import { WebSocketUserAccountSubscriber } from './webSocketUserAccountSubscriber';
import { grpcAccountSubscriber } from './grpcAccountSubscriber';

export class grpcUserAccountSubscriber extends WebSocketUserAccountSubscriber {
	private grpcConfigs: GrpcConfigs;

	public constructor(
		grpcConfigs: GrpcConfigs,
		program: Program,
		userAccountPublicKey: PublicKey,
		resubOpts?: ResubOpts
	) {
		super(program, userAccountPublicKey, resubOpts);
		this.grpcConfigs = grpcConfigs;
	}

	async subscribe(userAccount?: UserAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.userDataAccountSubscriber = await grpcAccountSubscriber.create(
			this.grpcConfigs,
			'user',
			this.program,
			this.userAccountPublicKey,
			undefined,
			this.resubOpts
		);

		if (userAccount) {
			this.userDataAccountSubscriber.setData(userAccount);
		}

		await this.userDataAccountSubscriber.subscribe((data: UserAccount) => {
			this.eventEmitter.emit('userAccountUpdate', data);
			this.eventEmitter.emit('update');
		});

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}
}
