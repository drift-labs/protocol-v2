import { GrpcConfigs } from './types';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { InsuranceFundStake } from '../types';
import { WebSocketInsuranceFundStakeAccountSubscriber } from './webSocketInsuranceFundStakeAccountSubscriber';
import { grpcAccountSubscriber } from './grpcAccountSubscriber';

export class grpcInsuranceFundStakeAccountSubscriber extends WebSocketInsuranceFundStakeAccountSubscriber {
	private grpcConfigs: GrpcConfigs;

	public constructor(
		grpcConfigs: GrpcConfigs,
		program: Program,
		insuranceFundStakeAccountPublicKey: PublicKey,
		resubTimeoutMs?: number
	) {
		super(program, insuranceFundStakeAccountPublicKey, resubTimeoutMs);
		this.grpcConfigs = grpcConfigs;
	}

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
