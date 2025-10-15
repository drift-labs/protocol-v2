import { PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import { DriftClient } from '../driftClient';
import { RevenueShareEscrowAccount } from '../types';
import { getRevenueShareEscrowAccountPublicKey } from '../addresses/pda';
import { getRevenueShareEscrowFilter } from '../memcmp';

export class RevenueShareEscrowMap {
	/**
	 * map from authority pubkey to RevenueShareEscrow account data.
	 */
	private authorityEscrowMap = new Map<string, RevenueShareEscrowAccount>();
	private driftClient: DriftClient;
	private parallelSync: boolean;

	private fetchPromise?: Promise<void>;
	private fetchPromiseResolver: () => void;

	/**
	 * Creates a new RevenueShareEscrowMap instance.
	 *
	 * @param {DriftClient} driftClient - The DriftClient instance.
	 * @param {boolean} parallelSync - Whether to sync accounts in parallel.
	 */
	constructor(driftClient: DriftClient, parallelSync?: boolean) {
		this.driftClient = driftClient;
		this.parallelSync = parallelSync !== undefined ? parallelSync : true;
	}

	/**
	 * Subscribe to all RevenueShareEscrow accounts.
	 */
	public async subscribe() {
		if (this.size() > 0) {
			return;
		}

		await this.driftClient.subscribe();
		await this.sync();
	}

	public has(authorityPublicKey: string): boolean {
		return this.authorityEscrowMap.has(authorityPublicKey);
	}

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

	public async addRevenueShareEscrow(authority: string) {
		const escrowAccountPublicKey = getRevenueShareEscrowAccountPublicKey(
			this.driftClient.program.programId,
			new PublicKey(authority)
		);

		try {
			const accountInfo = await this.driftClient.connection.getAccountInfo(
				escrowAccountPublicKey,
				'processed'
			);

			if (accountInfo && accountInfo.data) {
				const escrow =
					this.driftClient.program.account.revenueShareEscrow.coder.accounts.decode(
						'RevenueShareEscrow',
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

	public size(): number {
		return this.authorityEscrowMap.size;
	}

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
			const accountInfo = await this.driftClient.connection.getAccountInfo(
				getRevenueShareEscrowAccountPublicKey(
					this.driftClient.program.programId,
					new PublicKey(authority)
				),
				'confirmed'
			);
			const escrowNew =
				this.driftClient.program.account.revenueShareEscrow.coder.accounts.decode(
					'RevenueShareEscrow',
					accountInfo.data
				) as RevenueShareEscrowAccount;
			this.authorityEscrowMap.set(authority, escrowNew);
		}
	}

	public async syncAll(): Promise<void> {
		const rpcRequestArgs = [
			this.driftClient.program.programId.toBase58(),
			{
				commitment: this.driftClient.opts.commitment,
				filters: [getRevenueShareEscrowFilter()],
				encoding: 'base64',
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
								programAccount.account.data[1]
							);

							const escrow =
								this.driftClient.program.account.revenueShareEscrow.coder.accounts.decode(
									'RevenueShareEscrow',
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
							programAccount.account.data[1]
						);

						const escrow =
							this.driftClient.program.account.revenueShareEscrow.coder.accounts.decode(
								'RevenueShareEscrow',
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

	/**
	 * Get all RevenueShareEscrow accounts
	 */
	public getAll(): Map<string, RevenueShareEscrowAccount> {
		return new Map(this.authorityEscrowMap);
	}

	/**
	 * Get all authorities that have RevenueShareEscrow accounts
	 */
	public getAuthorities(): string[] {
		return Array.from(this.authorityEscrowMap.keys());
	}

	/**
	 * Get RevenueShareEscrow accounts that have approved referrers
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
	 * Get RevenueShareEscrow accounts that have active orders
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
	 * Get RevenueShareEscrow account by referrer
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
	 * Get all RevenueShareEscrow accounts for a specific referrer
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

	public async unsubscribe() {
		this.authorityEscrowMap.clear();
	}
}
