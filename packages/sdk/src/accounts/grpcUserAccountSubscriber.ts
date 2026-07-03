import { ResubOpts, GrpcConfigs } from './types';
import { PublicKey } from '@solana/web3.js';
import { UserAccount } from '../types';
import { WebSocketUserAccountSubscriber } from './webSocketUserAccountSubscriber';
import { grpcAccountSubscriber } from './grpcAccountSubscriber';
import { VelocityProgram } from '../config';

/**
 * `UserAccountSubscriber` variant of `WebSocketUserAccountSubscriber` that tracks the
 * `UserAccount` via a `grpcAccountSubscriber` (gRPC Geyser stream) instead of `connection.onAccountChange`.
 */
export class grpcUserAccountSubscriber extends WebSocketUserAccountSubscriber {
	private grpcConfigs: GrpcConfigs;

	/**
	 * @param grpcConfigs gRPC Geyser endpoint/token/commitment config (Yellowstone or LaserStream).
	 * @param program Anchor program providing the connection and coder.
	 * @param userAccountPublicKey Address of the `UserAccount` to track.
	 * @param resubOpts Resubscription watchdog options passed to the underlying `grpcAccountSubscriber`.
	 */
	public constructor(
		grpcConfigs: GrpcConfigs,
		program: VelocityProgram,
		userAccountPublicKey: PublicKey,
		resubOpts?: ResubOpts
	) {
		super(program, userAccountPublicKey, resubOpts);
		this.grpcConfigs = grpcConfigs;
	}

	/**
	 * Creates the underlying `grpcAccountSubscriber` and subscribes it. Idempotent: a no-op
	 * (returns `true`) if already subscribed.
	 * @param userAccount Optional pre-fetched account data to seed the subscriber with, skipping the initial RPC fetch.
	 */
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
