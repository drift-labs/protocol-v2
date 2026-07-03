import { PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import { VelocityClient } from '../velocityClient';
import { RevenueShareEscrowAccount } from '../types';
import { getRevenueShareEscrowAccountPublicKey } from '../addresses/pda';
import { getRevenueShareEscrowFilter } from '../memcmp';

/** In-memory cache mapping each authority to their `RevenueShareEscrow` account (builder/referral fee accrual escrow). */
export class RevenueShareEscrowMap {
	/**
	 * map from authority pubkey to RevenueShareEscrow account data.
	 */
	private authorityEscrowMap = new Map<string, RevenueShareEscrowAccount>();
	private velocityClient: VelocityClient;
	private parallelSync: boolean;

	private fetchPromise?: Promise<void>;
	private fetchPromiseResolver: () => void = () => {};

	/**
	 * Creates a new RevenueShareEscrowMap instance.
	 *
	 * @param {VelocityClient} velocityClient - The VelocityClient instance.
	 * @param {boolean} parallelSync - Whether to sync accounts in parallel.
	 */
	constructor(velocityClient: VelocityClient, parallelSync?: boolean) {
		this.velocityClient = velocityClient;
		this.parallelSync = parallelSync !== undefined ? parallelSync : true;
	}

	/**
	 * Populates the map via a one-time `sync()` (no-op if already populated).
	 * There is no live/push subscription here — call `sync()`/`slowSync()`
	 * again later to pick up new or updated escrow accounts.
	 */
	public async subscribe() {
		if (this.size() > 0) {
			return;
		}

		await this.velocityClient.subscribe();
		await this.sync();
	}

	/** Returns true if `authorityPublicKey` has a `RevenueShareEscrow` account cached in the map. */
	public has(authorityPublicKey: string): boolean {
		return this.authorityEscrowMap.has(authorityPublicKey);
	}

	/** Returns the cached `RevenueShareEscrowAccount` for `authorityPublicKey`, or `undefined` if not (yet) in the map. */
	public get(
		authorityPublicKey: string
	): RevenueShareEscrowAccount | undefined {
		return this.authorityEscrowMap.get(authorityPublicKey);
	}

	/**
	 * Enforce that a RevenueShareEscrow will exist for the given authorityPublicKey,
	 * reading one from the blockchain if necessary.
	 * @param authorityPublicKey
	 * @returns
	 */
	public async mustGet(
		authorityPublicKey: string
	): Promise<RevenueShareEscrowAccount | undefined> {
		if (!this.has(authorityPublicKey)) {
			await this.addRevenueShareEscrow(authorityPublicKey);
		}
		return this.get(authorityPublicKey);
	}

	/**
	 * Fetches and decodes `authority`'s `RevenueShareEscrow` account directly
	 * via RPC and caches it. If the account does not exist (a normal condition
	 * — not every authority has an escrow), logs a debug message and leaves the
	 * map entry absent rather than throwing.
	 */
	public async addRevenueShareEscrow(authority: string) {
		const escrowAccountPublicKey = getRevenueShareEscrowAccountPublicKey(
			this.velocityClient.program.programId,
			new PublicKey(authority)
		);

		try {
			const accountInfo = await this.velocityClient.connection.getAccountInfo(
				escrowAccountPublicKey,
				'processed'
			);

			if (accountInfo && accountInfo.data) {
				const escrow = (
					this.velocityClient.program.account as any
				).revenueShareEscrow.coder.accounts.decode(
					'revenueShareEscrow',
					accountInfo.data
				) as RevenueShareEscrowAccount;

				this.authorityEscrowMap.set(authority, escrow);
			}
		} catch (error) {
			// RevenueShareEscrow account doesn't exist for this authority, which is normal
			console.debug(
				`No RevenueShareEscrow account found for authority: ${authority}`
			);
		}
	}

	/** Number of `RevenueShareEscrow` accounts currently cached in the map. */
	public size(): number {
		return this.authorityEscrowMap.size;
	}

	/** Fully (re)populates the map via `syncAll` (a `getProgramAccounts` scan). Concurrent calls share the same in-flight promise. */
	public async sync(): Promise<void> {
		if (this.fetchPromise) {
			return this.fetchPromise;
		}

		this.fetchPromise = new Promise((resolver) => {
			this.fetchPromiseResolver = resolver;
		});

		try {
			await this.syncAll();
		} finally {
			this.fetchPromiseResolver();
			this.fetchPromise = undefined;
		}
	}

	/**
	 * A slow, bankrun test friendly version of sync(), uses getAccountInfo on every cached account to refresh data
	 * @returns
	 */
	public async slowSync(): Promise<void> {
		if (this.fetchPromise) {
			return this.fetchPromise;
		}
		for (const authority of this.authorityEscrowMap.keys()) {
			const accountInfo = await this.velocityClient.connection.getAccountInfo(
				getRevenueShareEscrowAccountPublicKey(
					this.velocityClient.program.programId,
					new PublicKey(authority)
				),
				'confirmed'
			);
			if (accountInfo === null) {
				throw new Error(
					`RevenueShareEscrow account not found for authority ${authority} during slowSync`
				);
			}
			const escrowNew = (
				this.velocityClient.program.account as any
			).revenueShareEscrow.coder.accounts.decode(
				'revenueShareEscrow',
				accountInfo.data
			) as RevenueShareEscrowAccount;
			this.authorityEscrowMap.set(authority, escrowNew);
		}
	}

	/**
	 * Fetches and decodes every `RevenueShareEscrow` program account (via
	 * `getRevenueShareEscrowFilter`), in batches of 100 with a 10ms delay
	 * between batches to avoid overwhelming the RPC, and caches them keyed by
	 * `escrow.authority`. Batch decoding runs in parallel unless constructed
	 * with `parallelSync: false`. A decode failure for one account is logged
	 * and skipped rather than aborting the whole sync.
	 */
	public async syncAll(): Promise<void> {
		const rpcRequestArgs = [
			this.velocityClient.program.programId.toBase58(),
			{
				commitment: this.velocityClient.opts.commitment,
				filters: [getRevenueShareEscrowFilter()],
				encoding: 'base64',
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

		const batchSize = 100;
		for (let i = 0; i < rpcResponseAndContext.value.length; i += batchSize) {
			const batch = rpcResponseAndContext.value.slice(i, i + batchSize);

			if (this.parallelSync) {
				await Promise.all(
					batch.map(async (programAccount) => {
						try {
							// @ts-ignore
							const buffer = Buffer.from(
								programAccount.account.data[0],
								programAccount.account.data[1] as BufferEncoding
							);

							const escrow = (
								this.velocityClient.program.account as any
							).revenueShareEscrow.coder.accounts.decode(
								'revenueShareEscrow',
								buffer
							) as RevenueShareEscrowAccount;

							// Extract authority from the account data
							const authorityKey = escrow.authority.toBase58();
							this.authorityEscrowMap.set(authorityKey, escrow);
						} catch (error) {
							console.warn(
								`Failed to decode RevenueShareEscrow account ${programAccount.pubkey}:`,
								error
							);
						}
					})
				);
			} else {
				for (const programAccount of batch) {
					try {
						// @ts-ignore
						const buffer = Buffer.from(
							programAccount.account.data[0],
							programAccount.account.data[1] as BufferEncoding
						);

						const escrow = (
							this.velocityClient.program.account as any
						).revenueShareEscrow.coder.accounts.decode(
							'revenueShareEscrow',
							buffer
						) as RevenueShareEscrowAccount;

						// Extract authority from the account data
						const authorityKey = escrow.authority.toBase58();
						this.authorityEscrowMap.set(authorityKey, escrow);
					} catch (error) {
						console.warn(
							`Failed to decode RevenueShareEscrow account ${programAccount.pubkey}:`,
							error
						);
					}
				}
			}

			// Add a small delay between batches to avoid overwhelming the RPC
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	/** Returns a shallow copy of the full authority-to-escrow map (mutating the returned map does not affect the cache). */
	public getAll(): Map<string, RevenueShareEscrowAccount> {
		return new Map(this.authorityEscrowMap);
	}

	/** Returns the base58 authority pubkeys of every `RevenueShareEscrow` account currently cached. */
	public getAuthorities(): string[] {
		return Array.from(this.authorityEscrowMap.keys());
	}

	/**
	 * Get `RevenueShareEscrow` accounts that have at least one entry in
	 * `approvedBuilders` — builders this user has approved to charge an order
	 * fee (not "referrers": `referrer` is a separate field on the account).
	 */
	public getEscrowsWithApprovedReferrers(): Map<
		string,
		RevenueShareEscrowAccount
	> {
		const result = new Map<string, RevenueShareEscrowAccount>();
		for (const [authority, escrow] of this.authorityEscrowMap) {
			if (escrow.approvedBuilders && escrow.approvedBuilders.length > 0) {
				result.set(authority, escrow);
			}
		}
		return result;
	}

	/**
	 * Get `RevenueShareEscrow` accounts with at least one entry in `orders` —
	 * the ring buffer of in-flight builder/referral fee accruals not yet
	 * settled via settle-PnL.
	 */
	public getEscrowsWithOrders(): Map<string, RevenueShareEscrowAccount> {
		const result = new Map<string, RevenueShareEscrowAccount>();
		for (const [authority, escrow] of this.authorityEscrowMap) {
			if (escrow.orders && escrow.orders.length > 0) {
				result.set(authority, escrow);
			}
		}
		return result;
	}

	/**
	 * Returns the first cached `RevenueShareEscrow` account whose `referrer`
	 * field equals `referrerPublicKey`. There is no reverse index, so this is
	 * an O(n) scan over every cached escrow; prefer `getAllByReferrer` if more
	 * than one escrow may share the same referrer.
	 */
	public getByReferrer(
		referrerPublicKey: string
	): RevenueShareEscrowAccount | undefined {
		for (const escrow of this.authorityEscrowMap.values()) {
			if (escrow.referrer.toBase58() === referrerPublicKey) {
				return escrow;
			}
		}
		return undefined;
	}

	/**
	 * Returns every cached `RevenueShareEscrow` account whose `referrer` field
	 * equals `referrerPublicKey`. O(n) scan over every cached escrow (no
	 * reverse index).
	 */
	public getAllByReferrer(
		referrerPublicKey: string
	): RevenueShareEscrowAccount[] {
		const result: RevenueShareEscrowAccount[] = [];
		for (const escrow of this.authorityEscrowMap.values()) {
			if (escrow.referrer.toBase58() === referrerPublicKey) {
				result.push(escrow);
			}
		}
		return result;
	}

	/** Clears the in-memory map. Does not tear down any RPC subscriptions (this class has none — `subscribe` only triggers a one-time sync). */
	public async unsubscribe() {
		this.authorityEscrowMap.clear();
	}
}
