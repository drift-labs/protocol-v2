import {
	MemcmpFilter,
	PublicKey,
	RpcResponseAndContext,
} from '@solana/web3.js';
import { VelocityClient } from '../velocityClient';
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
import { isBuilderReferral } from '../math/builder';
import bs58 from 'bs58';

const DEFAULT_PUBLIC_KEY = PublicKey.default.toBase58();
// Byte offset of `UserStats.referrer_status` (u8). Matches the memcmp filters.
const REFERRER_STATUS_OFFSET = 188;

/**
 * In-memory cache mapping each trading authority to their referrer, built by
 * scanning `UserStats` accounts with memcmp filters on the referrer-status
 * byte (see `syncAll`/`syncReferrer`) rather than subscribing to every
 * account's full data.
 */
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
	/**
	 * map from authority pubkey to whether its escrow was initialized with a
	 * referrer (the `BuilderReferral` status bit). Only populated by the lazy
	 * full-account path (`addReferrer` / `mustGetIsBuilderReferral`) — the bulk
	 * sync uses narrow data slices that don't cover `referrer_status`.
	 */
	private authorityBuilderReferralMap = new Map<string, boolean>();
	private velocityClient: VelocityClient;
	private parallelSync: boolean;

	private fetchPromise?: Promise<void>;
	private fetchPromiseResolver: () => void = () => {};

	/**
	 * Creates a new ReferrerMap instance.
	 *
	 * @param {VelocityClient} velocityClient - The VelocityClient instance.
	 */
	constructor(velocityClient: VelocityClient, parallelSync?: boolean) {
		this.velocityClient = velocityClient;
		this.parallelSync = parallelSync !== undefined ? parallelSync : true;
	}

	/**
	 * Populates the map via a one-time `sync()` (no-op if already populated).
	 * There is no live/push subscription here — call `sync()` again later to
	 * pick up new referrers.
	 */
	public async subscribe() {
		if (this.size() > 0) {
			return;
		}

		await this.velocityClient.subscribe();
		await this.sync();
	}

	/** Returns true if `authorityPublicKey` has been synced into the map (has a known referrer, even if that referrer is "none"). */
	public has(authorityPublicKey: string): boolean {
		return this.authorityReferrerMap.has(authorityPublicKey);
	}

	/** Alias for `getReferrer`. */
	public get(authorityPublicKey: string): ReferrerInfo | undefined {
		return this.getReferrer(authorityPublicKey);
	}

	/**
	 * Records `authority`'s referrer. If `referrer` is omitted, fetches the
	 * authority's `UserStats` account directly via RPC and reads the referrer
	 * pubkey out of its raw bytes (offset 40..72, immediately after the
	 * discriminator + authority fields) rather than fully decoding the account.
	 * @throws If `referrer` is omitted and no `UserStats` account exists on chain for `authority`.
	 */
	public async addReferrer(authority: string, referrer?: string) {
		if (referrer) {
			this.authorityReferrerMap.set(authority, referrer);
		} else if (referrer === undefined) {
			const userStatsAccountPublicKey = getUserStatsAccountPublicKey(
				this.velocityClient.program.programId,
				new PublicKey(authority)
			);
			const accountInfo = await this.velocityClient.connection.getAccountInfo(
				userStatsAccountPublicKey,
				'processed'
			);
			if (!accountInfo) {
				throw new Error(
					`ReferrerMap: UserStats account not found for authority ${authority}`
				);
			}
			const buffer = accountInfo.data;

			this.authorityBuilderReferralMap.set(
				authority,
				isBuilderReferral({ referrerStatus: buffer[REFERRER_STATUS_OFFSET] })
			);

			const referrer = bs58.encode(buffer.subarray(40, 72));

			this.addReferrer(authority, referrer);
		}
	}

	/**
	 * True when the authority's escrow was initialized with a referrer (the
	 * `BuilderReferral` status bit). Returns `false` until the authority's
	 * UserStats has been read via the lazy path; use {@link mustGetIsBuilderReferral}
	 * to force a read.
	 */
	public isBuilderReferral(authorityPublicKey: string): boolean {
		return this.authorityBuilderReferralMap.get(authorityPublicKey) ?? false;
	}

	/**
	 * Like {@link isBuilderReferral} but reads the authority's UserStats from the
	 * chain if the status hasn't been cached yet. Throws if the UserStats account
	 * cannot be loaded (same as {@link addReferrer}).
	 */
	public async mustGetIsBuilderReferral(
		authorityPublicKey: string
	): Promise<boolean> {
		if (!this.authorityBuilderReferralMap.has(authorityPublicKey)) {
			await this.addReferrer(authorityPublicKey);
		}
		return this.isBuilderReferral(authorityPublicKey);
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

	/**
	 * Resolves `authorityPublicKey`'s referrer to a `ReferrerInfo` (the
	 * referrer's `User` sub-account-0 and `UserStats` addresses), caching the
	 * derived addresses per referrer pubkey.
	 * @returns `undefined` if `authorityPublicKey` isn't in the map yet, or if it has no referrer (default/zero pubkey).
	 */
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
				this.velocityClient.program.programId,
				referrerKey,
				0
			),
			referrerStats: getUserStatsAccountPublicKey(
				this.velocityClient.program.programId,
				referrerKey
			),
		};

		this.referrerReferrerInfoMap.set(referrer, referrerInfo);
		return referrerInfo;
	}

	/** Number of authorities synced into the map (referred or not). */
	public size(): number {
		return this.authorityReferrerMap.size;
	}

	/** Number of synced authorities that actually have a referrer set (excludes those with the default/zero pubkey). */
	public numberOfReferred(): number {
		return Array.from(this.authorityReferrerMap.values()).filter(
			(referrer) => referrer !== DEFAULT_PUBLIC_KEY
		).length;
	}

	/**
	 * Fully (re)populates the map: `syncAll` seeds every `UserStats` authority
	 * with a default ("no referrer") entry, then `syncReferrer` overwrites
	 * entries for authorities matching the is-referred and
	 * is-referred-or-referrer memcmp filters with their actual referrer. Runs
	 * the three passes in parallel by default (`parallelSync`), or serially if
	 * constructed with `parallelSync: false`. Concurrent calls share the same
	 * in-flight promise.
	 */
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

	/**
	 * Fetches every `UserStats` account pubkey (via a `getUserStatsFilter`
	 * memcmp filter, with a zero-length `dataSlice` so no account data is
	 * transferred) and seeds a default ("no referrer") entry for any authority
	 * not already present in the map.
	 */
	public async syncAll(): Promise<void> {
		const rpcRequestArgs = [
			this.velocityClient.program.programId.toBase58(),
			{
				commitment: this.velocityClient.opts?.commitment,
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
			await this.velocityClient.connection._rpcRequest(
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

	/**
	 * Fetches `UserStats` accounts matching `referrerFilter` combined with the
	 * base `UserStats` discriminator filter, with a `dataSlice` of exactly the
	 * bytes needed (offset 0, length 72 — discriminator + authority + referrer)
	 * to avoid transferring full account data. Decodes `authority`/`referrer`
	 * directly from the byte offsets and unconditionally sets them in the map
	 * (in batches of 1000, yielding to the event loop between batches).
	 * @param referrerFilter A memcmp filter selecting which referrer-status accounts to sync, e.g. from `getUserStatsIsReferredFilter`/`getUserStatsIsReferredOrReferrerFilter`.
	 */
	async syncReferrer(referrerFilter: MemcmpFilter): Promise<void> {
		const rpcRequestArgs = [
			this.velocityClient.program.programId.toBase58(),
			{
				commitment: this.velocityClient.opts?.commitment,
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
			await this.velocityClient.connection._rpcRequest(
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
						programAccount.account.data[1] as BufferEncoding
					);
					const authority = bs58.encode(buffer.subarray(8, 40));
					const referrer = bs58.encode(buffer.subarray(40, 72));

					this.addReferrer(authority, referrer);
				})
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	/** Clears the in-memory maps. Does not tear down any RPC subscriptions (this class has none — `subscribe` only triggers a one-time sync). */
	public async unsubscribe() {
		this.authorityReferrerMap.clear();
		this.referrerReferrerInfoMap.clear();
	}
}
