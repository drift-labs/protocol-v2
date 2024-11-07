import {
	MemcmpFilter,
	PublicKey,
	RpcResponseAndContext,
} from '@solana/web3.js';
import { DriftClient } from '../driftClient';
import { ReferrerInfo } from '../types';
import {
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
} from '../addresses/pda';
import {
	getUserStatsFilter,
	getUserStatsIsReferredFilter,
	getUserStatsIsReferredOrReferrerFilter,
} from '../memcmp';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';

const DEFAULT_PUBLIC_KEY = PublicKey.default.toBase58();

export class ReferrerMap {
	/**
	 * map from authority pubkey to referrer pubkey.
	 */
	private authorityReferrerMap = new Map<string, string>();
	/**
	 * map from referrer pubkey to ReferrerInfo.
	 * Will be undefined if the referrer is not in the map yet.
	 */
	private referrerReferrerInfoMap = new Map<string, ReferrerInfo>();
	private driftClient: DriftClient;
	private parallelSync: boolean;

	private fetchPromise?: Promise<void>;
	private fetchPromiseResolver: () => void;

	/**
	 * Creates a new UserStatsMap instance.
	 *
	 * @param {DriftClient} driftClient - The DriftClient instance.
	 */
	constructor(driftClient: DriftClient, parallelSync?: boolean) {
		this.driftClient = driftClient;
		this.parallelSync = parallelSync !== undefined ? parallelSync : true;
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
		return this.authorityReferrerMap.has(authorityPublicKey);
	}

	public get(authorityPublicKey: string): ReferrerInfo | undefined {
		return this.getReferrer(authorityPublicKey);
	}

	public async addReferrer(authority: string, referrer?: string) {
		if (referrer) {
			this.authorityReferrerMap.set(authority, referrer);
		} else if (referrer === undefined) {
			const userStatsAccountPublicKey = getUserStatsAccountPublicKey(
				this.driftClient.program.programId,
				new PublicKey(authority)
			);
			const buffer = (
				await this.driftClient.connection.getAccountInfo(
					userStatsAccountPublicKey,
					'processed'
				)
			).data;

			const referrer = bs58.encode(buffer.subarray(40, 72));

			this.addReferrer(authority, referrer);
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
	): Promise<ReferrerInfo | undefined> {
		if (!this.has(authorityPublicKey)) {
			await this.addReferrer(authorityPublicKey);
		}
		return this.getReferrer(authorityPublicKey);
	}

	public getReferrer(authorityPublicKey: string): ReferrerInfo | undefined {
		const referrer = this.authorityReferrerMap.get(authorityPublicKey);
		if (!referrer) {
			// return undefined if the referrer is not in the map
			return undefined;
		}

		if (referrer === DEFAULT_PUBLIC_KEY) {
			return undefined;
		}

		if (this.referrerReferrerInfoMap.has(referrer)) {
			return this.referrerReferrerInfoMap.get(referrer);
		}

		const referrerKey = new PublicKey(referrer);
		const referrerInfo = {
			referrer: getUserAccountPublicKeySync(
				this.driftClient.program.programId,
				referrerKey,
				0
			),
			referrerStats: getUserStatsAccountPublicKey(
				this.driftClient.program.programId,
				referrerKey
			),
		};

		this.referrerReferrerInfoMap.set(referrer, referrerInfo);
		return referrerInfo;
	}

	public size(): number {
		return this.authorityReferrerMap.size;
	}

	public numberOfReferred(): number {
		return Array.from(this.authorityReferrerMap.values()).filter(
			(referrer) => referrer !== DEFAULT_PUBLIC_KEY
		).length;
	}

	public async sync(): Promise<void> {
		if (this.fetchPromise) {
			return this.fetchPromise;
		}

		this.fetchPromise = new Promise((resolver) => {
			this.fetchPromiseResolver = resolver;
		});

		try {
			if (this.parallelSync) {
				await Promise.all([
					this.syncAll(),
					this.syncReferrer(getUserStatsIsReferredFilter()),
					this.syncReferrer(getUserStatsIsReferredOrReferrerFilter()),
				]);
			} else {
				await this.syncAll();
				await this.syncReferrer(getUserStatsIsReferredFilter());
				await this.syncReferrer(getUserStatsIsReferredOrReferrerFilter());
			}
		} finally {
			this.fetchPromiseResolver();
			this.fetchPromise = undefined;
		}
	}

	public async syncAll(): Promise<void> {
		const rpcRequestArgs = [
			this.driftClient.program.programId.toBase58(),
			{
				commitment: this.driftClient.opts.commitment,
				filters: [getUserStatsFilter()],
				encoding: 'base64',
				dataSlice: {
					offset: 0,
					length: 0,
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

		for (const account of rpcResponseAndContext.value) {
			// only add if it isn't already in the map
			// so that if syncReferrer already set it, we dont overwrite
			if (!this.has(account.pubkey)) {
				this.addReferrer(account.pubkey, DEFAULT_PUBLIC_KEY);
			}
		}
	}

	async syncReferrer(referrerFilter: MemcmpFilter): Promise<void> {
		const rpcRequestArgs = [
			this.driftClient.program.programId.toBase58(),
			{
				commitment: this.driftClient.opts.commitment,
				filters: [getUserStatsFilter(), referrerFilter],
				encoding: 'base64',
				dataSlice: {
					offset: 0,
					length: 72,
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
					const authority = bs58.encode(buffer.subarray(8, 40));
					const referrer = bs58.encode(buffer.subarray(40, 72));

					this.addReferrer(authority, referrer);
				})
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	public async unsubscribe() {
		this.authorityReferrerMap.clear();
		this.referrerReferrerInfoMap.clear();
	}
}
