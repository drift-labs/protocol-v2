import { ResubOpts, GrpcConfigs } from './types';
import { PublicKey } from '@solana/web3.js';
import { UserStatsAccount } from '../types';
import { WebSocketUserStatsAccountSubscriber } from './webSocketUserStatsAccountSubsriber';
import { grpcAccountSubscriber } from './grpcAccountSubscriber';
import { VelocityProgram } from '../config';

/**
 * `UserStatsAccountSubscriber` variant of `WebSocketUserStatsAccountSubscriber` that tracks the
 * `UserStatsAccount` via a `grpcAccountSubscriber` (gRPC Geyser stream) instead of `connection.onAccountChange`.
 */
export class grpcUserStatsAccountSubscriber extends WebSocketUserStatsAccountSubscriber {
	private grpcConfigs: GrpcConfigs;

	/**
	 * @param grpcConfigs gRPC Geyser endpoint/token/commitment config (Yellowstone or LaserStream).
	 * @param program Anchor program providing the connection and coder.
	 * @param userStatsAccountPublicKey Address of the `UserStatsAccount` to track.
	 * @param resubOpts Resubscription watchdog options passed to the underlying `grpcAccountSubscriber`.
	 */
	public constructor(
		grpcConfigs: GrpcConfigs,
		program: VelocityProgram,
		userStatsAccountPublicKey: PublicKey,
		resubOpts?: ResubOpts
	) {
		super(program, userStatsAccountPublicKey, resubOpts);
		this.grpcConfigs = grpcConfigs;
	}

	/**
	 * Creates the underlying `grpcAccountSubscriber` and subscribes it. Idempotent: a no-op
	 * (returns `true`) if already subscribed.
	 * @param userStatsAccount Optional pre-fetched account data to seed the subscriber with, skipping the initial RPC fetch.
	 */
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
