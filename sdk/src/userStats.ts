/**
 * UserStats — abstraction over the on-chain `UserStats` account.
 * Tracks referral links, 30-day maker/taker volume, and IF staking stats.
 * One `UserStats` account exists per authority (shared across all subaccounts).
 */
import { VelocityClient } from './velocityClient';
import { PublicKey } from '@solana/web3.js';
import { DataAndSlot, UserStatsAccountSubscriber } from './accounts/types';
import { UserStatsConfig } from './userStatsConfig';
import { PollingUserStatsAccountSubscriber } from './accounts/pollingUserStatsAccountSubscriber';
import { WebSocketUserStatsAccountSubscriber } from './accounts/webSocketUserStatsAccountSubsriber';
import { ReferrerInfo, UserStatsAccount } from './types';
import {
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
} from './addresses/pda';
import { grpcUserStatsAccountSubscriber } from './accounts/grpcUserStatsAccountSubscriber';

export class UserStats {
	velocityClient: VelocityClient;
	userStatsAccountPublicKey: PublicKey;
	accountSubscriber: UserStatsAccountSubscriber;
	isSubscribed = false;

	public constructor(config: UserStatsConfig) {
		// Type-system guarantees at least one of the two is supplied.
		const velocityClient = config.velocityClient!;
		this.velocityClient = velocityClient;
		this.userStatsAccountPublicKey = config.userStatsAccountPublicKey;
		if (config.accountSubscription?.type === 'polling') {
			this.accountSubscriber = new PollingUserStatsAccountSubscriber(
				velocityClient.program,
				config.userStatsAccountPublicKey,
				config.accountSubscription.accountLoader
			);
		} else if (config.accountSubscription?.type === 'grpc') {
			this.accountSubscriber = new grpcUserStatsAccountSubscriber(
				config.accountSubscription.grpcConfigs,
				velocityClient.program,
				config.userStatsAccountPublicKey,
				{
					resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
					logResubMessages: config.accountSubscription?.logResubMessages,
				}
			);
		} else if (config.accountSubscription?.type === 'websocket') {
			this.accountSubscriber = new WebSocketUserStatsAccountSubscriber(
				velocityClient.program,
				config.userStatsAccountPublicKey,
				{
					resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
					logResubMessages: config.accountSubscription?.logResubMessages,
				},
				config.accountSubscription.commitment
			);
		} else if (config.accountSubscription?.type === 'custom') {
			this.accountSubscriber =
				config.accountSubscription.userStatsAccountSubscriber;
		} else {
			const exhaustiveCheck: undefined = config.accountSubscription;

			throw new Error(
				`Unknown user stats account subscription type: ${exhaustiveCheck}`
			);
		}
	}

	public async subscribe(
		userStatsAccount?: UserStatsAccount
	): Promise<boolean> {
		this.isSubscribed = await this.accountSubscriber.subscribe(
			userStatsAccount
		);
		return this.isSubscribed;
	}

	public async fetchAccounts(): Promise<void> {
		await this.accountSubscriber.fetch();
	}

	public async unsubscribe(): Promise<void> {
		await this.accountSubscriber.unsubscribe();
		this.isSubscribed = false;
	}

	public getAccountAndSlot(): DataAndSlot<UserStatsAccount> | undefined {
		return this.accountSubscriber.getUserStatsAccountAndSlot();
	}

	public getAccount(): UserStatsAccount | undefined {
		return this.accountSubscriber.getUserStatsAccountAndSlot()?.data;
	}

	/**
	 * Like {@link getAccount} but throws a named error instead of returning
	 * `undefined` when the stats account has not been loaded yet.
	 */
	public getAccountOrThrow(): UserStatsAccount {
		const account = this.getAccount();
		if (!account) {
			throw new Error('UserStats account not loaded');
		}
		return account;
	}

	public getReferrerInfo(): ReferrerInfo | undefined {
		const account = this.getAccount();
		if (!account || account.referrer.equals(PublicKey.default)) {
			return undefined;
		} else {
			return {
				referrer: getUserAccountPublicKeySync(
					this.velocityClient.program.programId,
					account.referrer,
					0
				),
				referrerStats: getUserStatsAccountPublicKey(
					this.velocityClient.program.programId,
					account.referrer
				),
			};
		}
	}

	public static getOldestActionTs(account: UserStatsAccount): number {
		return Math.min(
			account.lastFillerVolume30DTs.toNumber(),
			account.lastMakerVolume30DTs.toNumber(),
			account.lastTakerVolume30DTs.toNumber()
		);
	}
}
