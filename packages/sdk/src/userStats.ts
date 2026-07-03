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

	/**
	 * Subscribes to this authority's `UserStats` account.
	 * @param userStatsAccount Optional pre-fetched account to seed the subscriber with, skipping the initial RPC fetch.
	 * @returns True once the underlying subscriber reports subscribed.
	 */
	public async subscribe(
		userStatsAccount?: UserStatsAccount
	): Promise<boolean> {
		this.isSubscribed = await this.accountSubscriber.subscribe(
			userStatsAccount
		);
		return this.isSubscribed;
	}

	/** Forces the account subscriber to re-fetch the `UserStats` account from RPC. */
	public async fetchAccounts(): Promise<void> {
		await this.accountSubscriber.fetch();
	}

	/** Tears down the `UserStats` account subscription. */
	public async unsubscribe(): Promise<void> {
		await this.accountSubscriber.unsubscribe();
		this.isSubscribed = false;
	}

	/** Like `getAccount`, but also returns the slot at which the account was last observed. Same `undefined`-when-not-found contract. */
	public getAccountAndSlot(): DataAndSlot<UserStatsAccount> | undefined {
		return this.accountSubscriber.getUserStatsAccountAndSlot();
	}

	/**
	 * Returns the cached `UserStats` account, or `undefined` if it has not been
	 * loaded yet (e.g. `subscribe()` has not resolved, or the account does not
	 * exist on chain). Unlike `User.getUserAccount`, this does not throw
	 * `NotSubscribedError` when called before subscribing — it simply returns
	 * `undefined` from the subscriber's initial (empty) state.
	 */
	public getAccount(): UserStatsAccount | undefined {
		return this.accountSubscriber.getUserStatsAccountAndSlot()?.data;
	}

	/**
	 * Like `getAccount` but throws a named error instead of returning
	 * `undefined` when the stats account has not been loaded yet.
	 */
	public getAccountOrThrow(): UserStatsAccount {
		const account = this.getAccount();
		if (!account) {
			throw new Error('UserStats account not loaded');
		}
		return account;
	}

	/**
	 * Returns the addresses of this user's referrer's `User` (sub-account 0)
	 * and `UserStats` accounts, or `undefined` if the account is not loaded or
	 * has no referrer set (`referrer` is the default/zero pubkey).
	 */
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

	/**
	 * Returns the earliest of the account's three rolling-30-day activity
	 * timestamps (filler, maker, taker volume), i.e. the oldest evidence of
	 * account activity — used to estimate account age for deletion-eligibility
	 * checks (see `User.canBeDeleted`).
	 * @returns Unix timestamp in seconds.
	 */
	public static getOldestActionTs(account: UserStatsAccount): number {
		return Math.min(
			account.lastFillerVolume30DTs.toNumber(),
			account.lastMakerVolume30DTs.toNumber(),
			account.lastTakerVolume30DTs.toNumber()
		);
	}
}
