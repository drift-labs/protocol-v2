import { ResubOpts, GrpcConfigs } from './types';
import { PublicKey } from '@solana/web3.js';
import { UserStatsAccount } from '../types';
import { WebSocketUserStatsAccountSubscriber } from './webSocketUserStatsAccountSubsriber';
import { grpcAccountSubscriber } from './grpcAccountSubscriber';
import { DriftProgram } from '../config';

export class grpcUserStatsAccountSubscriber extends WebSocketUserStatsAccountSubscriber {
	private grpcConfigs: GrpcConfigs;

	public constructor(
		grpcConfigs: GrpcConfigs,
		program: DriftProgram,
		userStatsAccountPublicKey: PublicKey,
		resubOpts?: ResubOpts
	) {
		super(program, userStatsAccountPublicKey, resubOpts);
		this.grpcConfigs = grpcConfigs;
	}

	async subscribe(userStatsAccount?: UserStatsAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.userStatsAccountSubscriber = await grpcAccountSubscriber.create(
			this.grpcConfigs,
			'userStats',
			this.program,
			this.userStatsAccountPublicKey,
			undefined,
			this.resubOpts
		);

		if (userStatsAccount) {
			this.userStatsAccountSubscriber.setData(userStatsAccount);
		}

		await this.userStatsAccountSubscriber.subscribe(
			(data: UserStatsAccount) => {
				this.eventEmitter.emit('userStatsAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}
}
