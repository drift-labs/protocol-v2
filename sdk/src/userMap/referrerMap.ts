import { PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import { BulkAccountLoader } from '../accounts/bulkAccountLoader';
import { DriftClient } from '../driftClient';
import { ReferrerInfo } from '../types';
import { UserStats } from '../userStats';
import {
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
} from '../addresses/pda';
import { getUserStatsFilter } from '../memcmp';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';

const DEFAULT_PUBLIC_KEY = PublicKey.default.toBase58();

export class ReferrerMap {
	/**
	 * map from authority pubkey to ReferrerInfo.
	 * - if a user has not been entered into the map, the value is undefined
	 * - if a user has no referrer, the value is null
	 * - if a user has a referrer, the value is a ReferrerInfo object
	 */
	private referrerMap = new Map<string, ReferrerInfo | null>();
	private driftClient: DriftClient;
	private bulkAccountLoader: BulkAccountLoader;

	private fetchPromise?: Promise<void>;
	private fetchPromiseResolver: () => void;

	/**
	 * Creates a new UserStatsMap instance.
	 *
	 * @param {DriftClient} driftClient - The DriftClient instance.
	 * @param {BulkAccountLoader} [bulkAccountLoader] - If not provided, a new BulkAccountLoader with polling disabled will be created.
	 */
	constructor(driftClient: DriftClient, bulkAccountLoader?: BulkAccountLoader) {
		this.driftClient = driftClient;
		if (!bulkAccountLoader) {
			bulkAccountLoader = new BulkAccountLoader(
				driftClient.connection,
				driftClient.opts.commitment,
				0
			);
		}
		this.bulkAccountLoader = bulkAccountLoader;
	}

	/**
	 * Subscribe to all UserStats accounts.
	 */
	public async subscribe() {
		if (this.size() > 0) {
			return;
		}

		await this.driftClient.subscribe();
		await this.sync();
	}

	public has(authorityPublicKey: string): boolean {
		return this.referrerMap.has(authorityPublicKey);
	}

	public get(authorityPublicKey: string): ReferrerInfo | undefined | null {
		return this.referrerMap.get(authorityPublicKey);
	}

	public async addReferrerInfo(
		authority: string,
		referrerInfo?: ReferrerInfo | null
	) {
		if (referrerInfo || referrerInfo === null) {
			this.referrerMap.set(authority, referrerInfo);
		} else if (referrerInfo === undefined) {
			const userStat = new UserStats({
				driftClient: this.driftClient,
				userStatsAccountPublicKey: getUserStatsAccountPublicKey(
					this.driftClient.program.programId,
					new PublicKey(authority)
				),
				accountSubscription: {
					type: 'polling',
					accountLoader: this.bulkAccountLoader,
				},
			});
			await userStat.fetchAccounts();

			const newReferrerInfo = userStat.getReferrerInfo();

			if (newReferrerInfo) {
				this.referrerMap.set(authority.toString(), newReferrerInfo);
			} else {
				this.referrerMap.set(authority.toString(), null);
			}
		}
	}

	/**
	 * Enforce that a UserStats will exist for the given authorityPublicKey,
	 * reading one from the blockchain if necessary.
	 * @param authorityPublicKey
	 * @returns
	 */
	public async mustGet(
		authorityPublicKey: string
	): Promise<ReferrerInfo | null | undefined> {
		if (!this.has(authorityPublicKey)) {
			await this.addReferrerInfo(authorityPublicKey);
		}
		return this.get(authorityPublicKey);
	}

	public values(): IterableIterator<ReferrerInfo | null> {
		return this.referrerMap.values();
	}

	public size(): number {
		return this.referrerMap.size;
	}

	public async sync(): Promise<void> {
		if (this.fetchPromise) {
			return this.fetchPromise;
		}

		this.fetchPromise = new Promise((resolver) => {
			this.fetchPromiseResolver = resolver;
		});

		try {
			const rpcRequestArgs = [
				this.driftClient.program.programId.toBase58(),
				{
					commitment: this.driftClient.opts.commitment,
					filters: [getUserStatsFilter()],
					encoding: 'base64',
					dataSlice: {
						offset: 8,
						length: 64,
					},
					withContext: true,
				},
			];

			const rpcJSONResponse: any =
				// @ts-ignore
				await this.driftClient.connection._rpcRequest(
					'getProgramAccounts',
					rpcRequestArgs
				);

			const rpcResponseAndContext: RpcResponseAndContext<
				Array<{
					pubkey: string;
					account: {
						data: [string, string];
					};
				}>
			> = rpcJSONResponse.result;

			const batchSize = 1000;
			for (let i = 0; i < rpcResponseAndContext.value.length; i += batchSize) {
				const batch = rpcResponseAndContext.value.slice(i, i + batchSize);
				await Promise.all(
					batch.map(async (programAccount) => {
						// @ts-ignore
						const buffer = Buffer.from(
							programAccount.account.data[0],
							programAccount.account.data[1]
						);
						const authority = bs58.encode(buffer.subarray(0, 32));
						const referrer = bs58.encode(buffer.subarray(32, 64));

						const referrerKey = new PublicKey(referrer);
						this.addReferrerInfo(
							authority,
							referrer === DEFAULT_PUBLIC_KEY
								? null
								: {
										referrer: getUserAccountPublicKeySync(
											this.driftClient.program.programId,
											referrerKey,
											0
										),
										referrerStats: getUserStatsAccountPublicKey(
											this.driftClient.program.programId,
											referrerKey
										),
								  }
						);
					})
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		} catch (e) {
			console.error('error in referrerMap.sync', e);
		} finally {
			this.fetchPromiseResolver();
			this.fetchPromise = undefined;
		}
	}

	public async unsubscribe() {
		this.referrerMap.clear();
	}
}
