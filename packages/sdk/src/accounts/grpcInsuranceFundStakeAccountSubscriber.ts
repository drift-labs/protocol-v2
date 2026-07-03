import { GrpcConfigs } from './types';
import { PublicKey } from '@solana/web3.js';
import { InsuranceFundStake } from '../types';
import { WebSocketInsuranceFundStakeAccountSubscriber } from './webSocketInsuranceFundStakeAccountSubscriber';
import { grpcAccountSubscriber } from './grpcAccountSubscriber';
import { VelocityProgram } from '../config';

/**
 * `InsuranceFundStakeAccountSubscriber` variant of `WebSocketInsuranceFundStakeAccountSubscriber`
 * that tracks the `InsuranceFundStake` account via a `grpcAccountSubscriber` (gRPC Geyser stream)
 * instead of `connection.onAccountChange`.
 */
export class grpcInsuranceFundStakeAccountSubscriber extends WebSocketInsuranceFundStakeAccountSubscriber {
	private grpcConfigs: GrpcConfigs;

	/**
	 * @param grpcConfigs gRPC Geyser endpoint/token/commitment config (Yellowstone or LaserStream).
	 * @param program Anchor program providing the connection and coder.
	 * @param insuranceFundStakeAccountPublicKey Address of the `InsuranceFundStake` account to track.
	 * @param resubTimeoutMs Resub watchdog timeout (ms) passed to the underlying `grpcAccountSubscriber`.
	 */
	public constructor(
		grpcConfigs: GrpcConfigs,
		program: VelocityProgram,
		insuranceFundStakeAccountPublicKey: PublicKey,
		resubTimeoutMs?: number
	) {
		super(program, insuranceFundStakeAccountPublicKey, resubTimeoutMs);
		this.grpcConfigs = grpcConfigs;
	}

	/**
	 * Creates the underlying `grpcAccountSubscriber` and subscribes it. Idempotent: a no-op
	 * (returns `true`) if already subscribed.
	 * @param insuranceFundStakeAccount Optional pre-fetched account data to seed the subscriber with, skipping the initial RPC fetch.
	 */
	async subscribe(
		insuranceFundStakeAccount?: InsuranceFundStake
	): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.insuranceFundStakeDataAccountSubscriber =
			await grpcAccountSubscriber.create(
				this.grpcConfigs,
				'insuranceFundStake',
				this.program,
				this.insuranceFundStakeAccountPublicKey,
				undefined,
				{
					resubTimeoutMs: this.resubTimeoutMs,
				}
			);

		if (insuranceFundStakeAccount) {
			this.insuranceFundStakeDataAccountSubscriber.setData(
				insuranceFundStakeAccount
			);
		}

		await this.insuranceFundStakeDataAccountSubscriber.subscribe(
			(data: InsuranceFundStake) => {
				this.eventEmitter.emit('insuranceFundStakeAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}
}
