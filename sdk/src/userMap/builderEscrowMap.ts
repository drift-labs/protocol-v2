import { PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import { DriftClient } from '../driftClient';
import { BuilderEscrow } from '../types';
import { getBuilderEscrowAccountPublicKey } from '../addresses/pda';
import { getBuilderEscrowFilter } from '../memcmp';

export class BuilderEscrowMap {
	/**
	 * map from authority pubkey to BuilderEscrow account data.
	 */
	private authorityEscrowMap = new Map<string, BuilderEscrow>();
	private driftClient: DriftClient;
	private parallelSync: boolean;

	private fetchPromise?: Promise<void>;
	private fetchPromiseResolver: () => void;

	/**
	 * Creates a new BuilderEscrowMap instance.
	 *
	 * @param {DriftClient} driftClient - The DriftClient instance.
	 * @param {boolean} parallelSync - Whether to sync accounts in parallel.
	 */
	constructor(driftClient: DriftClient, parallelSync?: boolean) {
		this.driftClient = driftClient;
		this.parallelSync = parallelSync !== undefined ? parallelSync : true;
	}

	/**
	 * Subscribe to all BuilderEscrow accounts.
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

	public get(authorityPublicKey: string): BuilderEscrow | undefined {
		return this.authorityEscrowMap.get(authorityPublicKey);
	}

	/**
	 * Enforce that a BuilderEscrow will exist for the given authorityPublicKey,
	 * reading one from the blockchain if necessary.
	 * @param authorityPublicKey
	 * @returns
	 */
	public async mustGet(
		authorityPublicKey: string
	): Promise<BuilderEscrow | undefined> {
		if (!this.has(authorityPublicKey)) {
			await this.addBuilderEscrow(authorityPublicKey);
		}
		return this.get(authorityPublicKey);
	}

	public async addBuilderEscrow(authority: string) {
		const builderEscrowAccountPublicKey = getBuilderEscrowAccountPublicKey(
			this.driftClient.program.programId,
			new PublicKey(authority)
		);

		try {
			const accountInfo = await this.driftClient.connection.getAccountInfo(
				builderEscrowAccountPublicKey,
				'processed'
			);

			if (accountInfo && accountInfo.data) {
				const builderEscrow =
					this.driftClient.program.account.builderEscrow.coder.accounts.decode(
						'BuilderEscrow',
						accountInfo.data
					) as BuilderEscrow;

				this.authorityEscrowMap.set(authority, builderEscrow);
			}
		} catch (error) {
			// BuilderEscrow account doesn't exist for this authority, which is normal
			console.debug(
				`No BuilderEscrow account found for authority: ${authority}`
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
				getBuilderEscrowAccountPublicKey(
					this.driftClient.program.programId,
					new PublicKey(authority)
				),
				'confirmed'
			);
			const builderEscrowNew =
				this.driftClient.program.account.builderEscrow.coder.accounts.decode(
					'BuilderEscrow',
					accountInfo.data
				) as BuilderEscrow;
			this.authorityEscrowMap.set(authority, builderEscrowNew);
		}
	}

	public async syncAll(): Promise<void> {
		const rpcRequestArgs = [
			this.driftClient.program.programId.toBase58(),
			{
				commitment: this.driftClient.opts.commitment,
				filters: [getBuilderEscrowFilter()],
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

							const builderEscrow =
								this.driftClient.program.account.builderEscrow.coder.accounts.decode(
									'BuilderEscrow',
									buffer
								) as BuilderEscrow;

							// Extract authority from the account data
							const authorityKey = builderEscrow.authority.toBase58();
							this.authorityEscrowMap.set(authorityKey, builderEscrow);
						} catch (error) {
							console.warn(
								`Failed to decode BuilderEscrow account ${programAccount.pubkey}:`,
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

						const builderEscrow =
							this.driftClient.program.account.builderEscrow.coder.accounts.decode(
								'BuilderEscrow',
								buffer
							) as BuilderEscrow;

						// Extract authority from the account data
						const authorityKey = builderEscrow.authority.toBase58();
						this.authorityEscrowMap.set(authorityKey, builderEscrow);
					} catch (error) {
						console.warn(
							`Failed to decode BuilderEscrow account ${programAccount.pubkey}:`,
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
	 * Get all BuilderEscrow accounts
	 */
	public getAll(): Map<string, BuilderEscrow> {
		return new Map(this.authorityEscrowMap);
	}

	/**
	 * Get all authorities that have BuilderEscrow accounts
	 */
	public getAuthorities(): string[] {
		return Array.from(this.authorityEscrowMap.keys());
	}

	/**
	 * Get BuilderEscrow accounts that have approved builders
	 */
	public getEscrowsWithApprovedBuilders(): Map<string, BuilderEscrow> {
		const result = new Map<string, BuilderEscrow>();
		for (const [authority, escrow] of this.authorityEscrowMap) {
			if (escrow.approvedBuilders && escrow.approvedBuilders.length > 0) {
				result.set(authority, escrow);
			}
		}
		return result;
	}

	/**
	 * Get BuilderEscrow accounts that have active orders
	 */
	public getEscrowsWithOrders(): Map<string, BuilderEscrow> {
		const result = new Map<string, BuilderEscrow>();
		for (const [authority, escrow] of this.authorityEscrowMap) {
			if (escrow.orders && escrow.orders.length > 0) {
				result.set(authority, escrow);
			}
		}
		return result;
	}

	/**
	 * Get BuilderEscrow account by referrer
	 */
	public getByReferrer(referrerPublicKey: string): BuilderEscrow | undefined {
		for (const escrow of this.authorityEscrowMap.values()) {
			if (escrow.referrer.toBase58() === referrerPublicKey) {
				return escrow;
			}
		}
		return undefined;
	}

	/**
	 * Get all BuilderEscrow accounts for a specific referrer
	 */
	public getAllByReferrer(referrerPublicKey: string): BuilderEscrow[] {
		const result: BuilderEscrow[] = [];
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
