import {
	BN,
	BigNum,
	VelocityClient,
	getInsuranceFundStakeAccountPublicKey,
	getUserAccountPublicKey,
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
	TEN,
	UserMap,
	unstakeSharesToAmount as depositSharesToVaultAmount,
	ZERO,
	getInsuranceFundVaultPublicKey,
	OracleSource,
	WRAPPED_SOL_MINT,
	SpotMarketAccount,
	UserAccount,
	UserStatsAccount,
	QUOTE_PRECISION_EXP,
} from '@velocity-exchange/sdk';
import { BorshAccountsCoder, Program, ProgramAccount } from '@coral-xyz/anchor';
import { Vaults } from './types/vaults';
import {
	getTokenizedVaultAddressSync,
	getTokenizedVaultMintAddressSync,
	getInsuranceFundTokenVaultAddressSync,
	getTokenVaultAddressSync,
	getVaultAddressSync,
	getVaultDepositorAddressSync,
	getVaultProtocolAddressSync,
	getFeeUpdateAddressSync,
} from './addresses';
import {
	AccountMeta,
	AddressLookupTableAccount,
	ComputeBudgetProgram,
	PublicKey,
	SystemProgram,
	SYSVAR_RENT_PUBKEY,
	TransactionInstruction,
	TransactionSignature,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	createAssociatedTokenAccountInstruction,
	createCloseAccountInstruction,
	createSyncNativeInstruction,
	getAssociatedTokenAddressSync,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	FeeUpdate,
	hasPendingFeeUpdate,
	Vault,
	VaultClass,
	VaultDepositor,
	VaultParams,
	VaultProtocol,
	VaultProtocolParams,
	VaultWithProtocolParams,
	WithdrawUnit,
} from './types/types';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { UserMapConfig } from '@velocity-exchange/sdk';
import { calculateRealizedVaultDepositorEquity } from './math';
import { Metaplex } from '@metaplex-foundation/js';
import { getOrCreateATAInstruction } from './utils';
import { VAULT_ADMIN_KEY, VAULT_SHARES_PRECISION_EXP } from './constants';

type OracleFeedConfig = {
	feed: PublicKey;
	oracleSource: OracleSource;
	pythLazerId?: number;
};

export type TxParams = {
	cuLimit?: number;
	cuPriceMicroLamports?: number;
	simulateTransaction?: boolean;
	lookupTables?: AddressLookupTableAccount[];
	oracleFeedsToCrank?: {
		feedsToCrank: OracleFeedConfig[];
		pythLazerMsgHexGetter?: (feedIds: number[]) => Promise<string>;
	};
	noLut?: boolean;
};

export class VaultClient {
	velocityClient: VelocityClient;
	metaplex?: Metaplex;
	program: Program<Vaults>;
	cliMode: boolean;

	/**
	 * Cache map of drift user accounts of vaults.
	 */
	readonly vaultUsers: UserMap;

	constructor({
		velocityClient,
		program,
		metaplex,
		// @deprecated, no longer used
		cliMode,
		userMapConfig,
	}: {
		velocityClient: VelocityClient;
		program: Program<Vaults>;
		metaplex?: Metaplex;
		// @deprecated, no longer used
		cliMode?: boolean;
		userMapConfig?: UserMapConfig;
	}) {
		this.velocityClient = velocityClient;
		this.metaplex = metaplex;
		this.program = program;
		this.cliMode = !!cliMode;

		if (!userMapConfig) {
			this.vaultUsers = new UserMap({
				velocityClient: velocityClient,
				subscriptionConfig: {
					type: 'polling',
					frequency: 1000,
					commitment: 'processed',
				},
			});
		} else {
			this.vaultUsers = new UserMap(userMapConfig);
		}
	}

	private getRemainingAccountsForUser(
		userAccounts: UserAccount[],
		writableSpotMarketIndexes: number[],
		vaultAccount: Vault,
		_userStats: UserStatsAccount,
		skipVaultProtocol = false,
		skipFeeUpdate = false
	) {
		const remainingAccounts = this.velocityClient.getRemainingAccounts({
			userAccounts,
			writableSpotMarketIndexes,
		});

		const hasVaultProtocol = vaultAccount.vaultProtocol === true;

		const hasFeeUpdate = hasPendingFeeUpdate(vaultAccount.feeUpdateStatus);

		if (hasFeeUpdate && !skipFeeUpdate) {
			const feeUpdate = getFeeUpdateAddressSync(
				this.program.programId,
				vaultAccount.pubkey
			);
			remainingAccounts.push({
				pubkey: feeUpdate,
				isSigner: false,
				isWritable: true,
			});
		}

		if (hasVaultProtocol && !skipVaultProtocol) {
			const vaultProtocol = this.getVaultProtocolAddress(vaultAccount.pubkey);
			remainingAccounts.push({
				pubkey: vaultProtocol,
				isSigner: false,
				isWritable: true,
			});
		}

		return remainingAccounts;
	}

	private async checkIfAccountExists(account: PublicKey): Promise<boolean> {
		try {
			const accountInfo = await this.velocityClient.connection.getAccountInfo(
				account
			);
			return accountInfo != null;
		} catch (e) {
			// Doesn't already exist
			return false;
		}
	}

	/**
	 * Unsubscribes from the vault users map. Call this to clean up any dangling promises.
	 */
	public async unsubscribe() {
		if (this.vaultUsers) {
			await this.vaultUsers.unsubscribe();
		}
	}

	public async getVault(vault: PublicKey): Promise<Vault> {
		return await this.program.account.vault.fetch(vault);
	}

	public async getFeeUpdate(feeUpdate: PublicKey): Promise<FeeUpdate> {
		return await this.program.account.feeUpdate.fetch(feeUpdate);
	}

	public async getVaultAndSlot(
		vault: PublicKey
	): Promise<{ vault: Vault; slot: number }> {
		const vaultAndSlot = await this.program.account.vault.fetchAndContext(
			vault
		);
		return {
			vault: vaultAndSlot.data as Vault,
			slot: vaultAndSlot.context.slot,
		};
	}

	public async getVaultDepositor(vaultDepositor: PublicKey): Promise<any> {
		return await this.program.account.vaultDepositor.fetch(vaultDepositor);
	}

	public async getVaultDepositorAndSlot(
		vaultDepositor: PublicKey
	): Promise<{ vaultDepositor: any; slot: number }> {
		const vaultDepositorAndSlot =
			await this.program.account.vaultDepositor.fetchAndContext(vaultDepositor);
		return {
			vaultDepositor: vaultDepositorAndSlot.data,
			slot: vaultDepositorAndSlot.context.slot,
		};
	}

	public getVaultProtocolAddress(vault: PublicKey): PublicKey {
		return getVaultProtocolAddressSync(this.program.programId, vault);
	}

	public async getVaultProtocol(
		vaultProtocol: PublicKey
	): Promise<VaultProtocol> {
		return await this.program.account.vaultProtocol.fetch(vaultProtocol);
	}

	public async getVaultProtocolAndSlot(
		vaultProtocol: PublicKey
	): Promise<{ vaultProtocol: VaultProtocol; slot: number }> {
		const vaultProtocolAndSlot =
			await this.program.account.vaultProtocol.fetchAndContext(vaultProtocol);
		return {
			vaultProtocol: vaultProtocolAndSlot.data as VaultProtocol,
			slot: vaultProtocolAndSlot.context.slot,
		};
	}

	public async getAllVaultDepositorsWithNoWithdrawRequest(
		vault: PublicKey
	): Promise<ProgramAccount<VaultDepositor>[]> {
		const filters = [
			{
				// discriminator = VaultDepositor
				memcmp: {
					offset: 0,
					bytes: bs58.encode(
						(
							this.program.coder.accounts as BorshAccountsCoder
						).accountDiscriminator('vaultDepositor')
					),
				},
			},
			{
				// vault = vault
				memcmp: {
					offset: 8,
					bytes: vault.toBase58(),
				},
			},
			{
				// last_withdraw_request.shares (u128) = 0
				memcmp: {
					offset: 112,
					bytes: bs58.encode(new Uint8Array(16).fill(0)),
				},
			},
		];
		// @ts-ignore
		return (await this.program.account.vaultDepositor.all(
			filters
		)) as ProgramAccount<VaultDepositor>[];
	}

	public async getAllVaultDepositors(
		vault?: PublicKey
	): Promise<ProgramAccount<VaultDepositor>[]> {
		const filters = [
			{
				// discriminator = VaultDepositor
				memcmp: {
					offset: 0,
					bytes: bs58.encode(
						(
							this.program.coder.accounts as BorshAccountsCoder
						).accountDiscriminator('vaultDepositor')
					),
				},
			},
		];
		if (vault) {
			filters.push({
				// vault = vault
				memcmp: {
					offset: 8,
					bytes: vault.toBase58(),
				},
			});
		}
		// @ts-ignore
		return (await this.program.account.vaultDepositor.all(
			filters
		)) as ProgramAccount<VaultDepositor>[];
	}

	public async getAllVaultDepositorsForAuthority(
		authority: PublicKey
	): Promise<ProgramAccount<VaultDepositor>[]> {
		const filters = [
			{
				// discriminator = VaultDepositor
				memcmp: {
					offset: 0,
					bytes: bs58.encode(
						(
							this.program.coder.accounts as BorshAccountsCoder
						).accountDiscriminator('vaultDepositor')
					),
				},
			},
		];
		filters.push({
			// authority = authority
			memcmp: {
				offset: 8 + 32 + 32,
				bytes: authority.toBase58(),
			},
		});
		// @ts-ignore
		return (await this.program.account.vaultDepositor.all(
			filters
		)) as ProgramAccount<VaultDepositor>[];
	}

	public async getSubscribedVaultUser(vaultDriftUserAccountPubKey: PublicKey) {
		return this.vaultUsers.mustGet(vaultDriftUserAccountPubKey.toBase58(), {
			type: 'websocket',
		});
	}

	/// useful for syncing state during tests.
	public async syncVaultUsers() {
		for (const user of this.vaultUsers.values()) {
			await user.fetchAccounts();
		}
	}

	/**
	 *
	 * @param vault pubkey
	 * @param factorUnrealizedPNL add unrealized pnl to net balance
	 * @returns vault equity, in USDC
	 */
	public async calculateVaultEquity(params: {
		address?: PublicKey;
		vault?: Vault;
		factorUnrealizedPNL?: boolean;
		includeManagerBorrowedValue?: boolean;
	}): Promise<BN> {
		try {
			// defaults to true if undefined
			let factorUnrealizedPNL = true;
			if (params.factorUnrealizedPNL !== undefined) {
				factorUnrealizedPNL = params.factorUnrealizedPNL;
			}

			let includeManagerBorrowedValue = true;
			if (params.includeManagerBorrowedValue !== undefined) {
				includeManagerBorrowedValue = params.includeManagerBorrowedValue;
			}

			let vaultAccount: Vault;
			if (params.address !== undefined) {
				// @ts-ignore
				vaultAccount = await this.program.account.vault.fetch(params.address);
			} else if (params.vault !== undefined) {
				vaultAccount = params.vault;
			} else {
				throw new Error('Must supply address or vault');
			}

			const user = await this.getSubscribedVaultUser(vaultAccount.user);

			let netSpotValue = user.getNetSpotMarketValue();

			if (factorUnrealizedPNL) {
				const unrealizedPnl = user.getUnrealizedPNL(true, undefined, undefined);
				netSpotValue = netSpotValue.add(unrealizedPnl);
			}

			if (includeManagerBorrowedValue) {
				netSpotValue = netSpotValue.add(vaultAccount.managerBorrowedValue);
			}

			return netSpotValue;
		} catch (err) {
			console.error('VaultClient ~ err:', err);
			return ZERO;
		}
	}

	public async calculateVaultAllTimeNotionalPnl(params: {
		address?: PublicKey;
		vault?: Vault;
	}): Promise<BN> {
		try {
			let vaultAccount: Vault;
			if (params.address !== undefined) {
				// @ts-ignore
				vaultAccount = await this.program.account.vault.fetch(params.address);
			} else if (params.vault !== undefined) {
				vaultAccount = params.vault;
			} else {
				throw new Error('Must supply address or vault');
			}

			const user = await this.getSubscribedVaultUser(vaultAccount.user);
			const allTimeTotalPnl = user.getTotalAllTimePnl();

			return allTimeTotalPnl;
		} catch (err) {
			console.error('VaultClient ~ err:', err);
			return ZERO;
		}
	}

	/**
	 *
	 * @param vault pubkey
	 * @param factorUnrealizedPNL add unrealized pnl to existing equity
	 * @returns total vault equity, in spot deposit asset
	 */
	public async calculateVaultEquityInDepositAsset(params: {
		address?: PublicKey;
		vault?: Vault;
		factorUnrealizedPNL?: boolean;
	}): Promise<BN> {
		let vaultAccount: Vault;
		if (params.address !== undefined) {
			vaultAccount = await this.program.account.vault.fetch(params.address);
		} else if (params.vault !== undefined) {
			vaultAccount = params.vault;
		} else {
			throw new Error('Must supply address or vault');
		}
		const vaultEquity = await this.calculateVaultEquity({
			vault: vaultAccount,
			factorUnrealizedPNL: params.factorUnrealizedPNL,
		});
		const spotMarket = this.velocityClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		const spotOracle = this.velocityClient.getOracleDataForSpotMarket(
			vaultAccount.spotMarketIndex
		);
		const spotPrecision = TEN.pow(new BN(spotMarket!.decimals));

		return vaultEquity.mul(spotPrecision).div(spotOracle.price);
	}

	/**
	 * @param params
	 * @returns vault depositor equity, in spot market value (which is usually USDC)
	 */
	public async calculateWithdrawableVaultDepositorEquity(params: {
		vaultDepositorAddress?: PublicKey;
		vaultDepositor?: VaultDepositor;
		vaultAddress?: PublicKey;
		vault?: Vault;
	}): Promise<BN> {
		let vaultAccount: Vault;
		if (params.vaultAddress !== undefined) {
			vaultAccount = await this.program.account.vault.fetch(
				params.vaultAddress
			);
		} else if (params.vault !== undefined) {
			vaultAccount = params.vault;
		} else {
			throw new Error('Must supply vaultAddress or vault');
		}

		let vaultDepositorAccount: VaultDepositor;
		if (params.vaultDepositorAddress !== undefined) {
			vaultDepositorAccount = await this.program.account.vaultDepositor.fetch(
				params.vaultDepositorAddress
			);
		} else if (params.vaultDepositor !== undefined) {
			vaultDepositorAccount = params.vaultDepositor;
		} else {
			throw new Error('Must supply vaultDepositorAddress or vaultDepositor');
		}

		const vaultEquity = await this.calculateVaultEquity({
			vault: vaultAccount,
			factorUnrealizedPNL: false,
		});
		return calculateRealizedVaultDepositorEquity(
			vaultDepositorAccount,
			vaultEquity,
			vaultAccount
		);
	}

	public async calculateWithdrawableVaultDepositorEquityInDepositAsset(params: {
		vaultDepositorAddress?: PublicKey;
		vaultDepositor?: VaultDepositor;
		vaultAddress?: PublicKey;
		vault?: Vault;
	}): Promise<BN> {
		let vaultAccount: Vault;
		if (params.vaultAddress !== undefined) {
			vaultAccount = await this.program.account.vault.fetch(
				params.vaultAddress
			);
		} else if (params.vault !== undefined) {
			vaultAccount = params.vault;
		} else {
			throw new Error('Must supply vaultAddress or vault');
		}

		let vaultDepositorAccount: VaultDepositor;
		if (params.vaultDepositorAddress !== undefined) {
			vaultDepositorAccount = await this.program.account.vaultDepositor.fetch(
				params.vaultDepositorAddress
			);
		} else if (params.vaultDepositor !== undefined) {
			vaultDepositorAccount = params.vaultDepositor;
		} else {
			throw new Error('Must supply vaultDepositorAddress or vaultDepositor');
		}

		let vaultProtocol: VaultProtocol | undefined = undefined;
		if (vaultAccount.vaultProtocol) {
			vaultProtocol = await this.program.account.vaultProtocol.fetch(
				this.getVaultProtocolAddress(vaultAccount.pubkey)
			);
		}

		const vaultEquity = await this.calculateVaultEquity({
			vault: vaultAccount,
			factorUnrealizedPNL: false,
		});
		const vdEquity = calculateRealizedVaultDepositorEquity(
			vaultDepositorAccount,
			vaultEquity,
			vaultAccount,
			vaultProtocol
		);

		const spotMarket = this.velocityClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		const spotOracle = this.velocityClient.getOracleDataForSpotMarket(
			vaultAccount.spotMarketIndex
		);
		const spotPrecision = TEN.pow(new BN(spotMarket!.decimals));

		return vdEquity.mul(spotPrecision).div(spotOracle.price);
	}

	public async calculateVaultProtocolEquity(params: {
		vault: PublicKey;
	}): Promise<BN> {
		const vaultAccount = await this.program.account.vault.fetch(params.vault);
		const vaultTotalEquity = await this.calculateVaultEquity({
			vault: vaultAccount,
		});
		const vaultProtocol = this.getVaultProtocolAddress(params.vault);
		const vpAccount = await this.program.account.vaultProtocol.fetch(
			vaultProtocol
		);
		return depositSharesToVaultAmount(
			vpAccount.protocolProfitAndFeeShares,
			vaultAccount.totalShares,
			vaultTotalEquity
		);
	}

	public async initializeVault(
		params: {
			name: number[];
			spotMarketIndex: number;
			redeemPeriod: BN;
			maxTokens: BN;
			minDepositAmount: BN;
			managementFee: BN;
			profitShare: number;
			hurdleRate: number;
			permissioned: boolean;
			vaultProtocol?: VaultProtocolParams;
			manager?: PublicKey;
		},
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getInitializeVaultIx(params);
		return await this.createAndSendTxn([ix], uiTxParams);
	}

	public async getInitializeVaultIx(params: {
		name: number[];
		spotMarketIndex: number;
		redeemPeriod: BN;
		maxTokens: BN;
		minDepositAmount: BN;
		managementFee: BN;
		profitShare: number;
		hurdleRate: number;
		permissioned: boolean;
		vaultProtocol?: VaultProtocolParams;
		manager?: PublicKey;
	}): Promise<TransactionInstruction> {
		const { vaultProtocol: vaultProtocolParams, ...vaultParams } = params;
		const vault = getVaultAddressSync(this.program.programId, params.name);
		const tokenAccount = getTokenVaultAddressSync(
			this.program.programId,
			vault
		);

		const driftState = await this.velocityClient.getStatePublicKey();
		const spotMarket = this.velocityClient.getSpotMarketAccount(
			params.spotMarketIndex
		);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${params.spotMarketIndex} not found on velocityClient`
			);
		}

		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const userKey = getUserAccountPublicKeySync(
			this.velocityClient.program.programId,
			vault
		);

		const accounts = {
			driftSpotMarket: spotMarket.pubkey,
			driftSpotMarketMint: spotMarket.mint,
			driftUserStats: userStatsKey,
			driftUser: userKey,
			driftState,
			vault,
			tokenAccount,
			driftProgram: this.velocityClient.program.programId,
		};

		if (vaultProtocolParams) {
			const _params: VaultWithProtocolParams = {
				...vaultParams,
				vaultProtocol: vaultProtocolParams,
			};

			const uiAuthority = this.velocityClient.wallet.publicKey;
			const initializeVaultWithProtocolIx = await this.program.methods
				.initializeVaultWithProtocol(_params)
				.accounts({
					...accounts,
					payer: params.manager ?? uiAuthority,
					manager: params.manager ?? uiAuthority,
				})
				.instruction();
			return initializeVaultWithProtocolIx;
		} else {
			const _params: VaultParams = vaultParams;

			const uiAuthority = this.velocityClient.wallet.publicKey;
			const initializeVaultIx = await this.program.methods
				.initializeVault(_params)
				.accounts({
					...accounts,
					payer: params.manager ?? uiAuthority,
					manager: params.manager ?? uiAuthority,
				})
				.instruction();
			return initializeVaultIx;
		}
	}

	/**
	 * Updates the delegate address for a vault. The delegate address will be allowed to trade
	 * on behalf of the vault.
	 * @param vault vault address to update
	 * @param delegate delegate address to update to
	 * @returns
	 */
	public async updateDelegate(
		vault: PublicKey,
		delegate: PublicKey,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const vaultAccount = await this.program.account.vault.fetch(vault);
		const updateDelegateIx = await this.getUpdateDelegateIx(
			vault,
			delegate,
			vaultAccount.user,
			vaultAccount.manager
		);
		return await this.createAndSendTxn([updateDelegateIx], uiTxParams);
	}

	public async getUpdateDelegateIx(
		vault: PublicKey,
		delegate: PublicKey,
		vaultDriftUser: PublicKey,
		vaultManager: PublicKey
	): Promise<TransactionInstruction> {
		const accounts = {
			vault: vault,
			driftUser: vaultDriftUser,
			driftProgram: this.velocityClient.program.programId,
		};

		return await this.program.methods
			.updateDelegate(delegate)
			.accounts({ ...accounts, manager: vaultManager })
			.instruction();
	}

	/**
	 * Updates the vault margin trading status.
	 * @param vault vault address to update
	 * @param enabled whether to enable margin trading
	 * @returns
	 */
	public async updateMarginTradingEnabled(
		vault: PublicKey,
		enabled: boolean,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const updateMarginTradingEnabledIx =
			await this.getUpdateMarginTradingEnabledIx(vault, enabled);
		return await this.createAndSendTxn(
			[updateMarginTradingEnabledIx],
			uiTxParams
		);
	}

	public async getUpdateMarginTradingEnabledIx(
		vault: PublicKey,
		enabled: boolean
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);
		const accounts = {
			vault: vault,
			driftUser: vaultAccount.user,
			driftProgram: this.velocityClient.program.programId,
		};

		const user = await this.getSubscribedVaultUser(vaultAccount.user);

		const remainingAccounts: AccountMeta[] = [];
		try {
			const userStatsKey = getUserStatsAccountPublicKey(
				this.velocityClient.program.programId,
				vault
			);
			const driftProgram = this.velocityClient.program as any;
			const userStats = (await driftProgram.account.userStats.fetch(
				userStatsKey
			)) as UserStatsAccount;
			remainingAccounts.push(
				...this.getRemainingAccountsForUser(
					[user.getUserAccount()!],
					[],
					vaultAccount,
					userStats
				)
			);
		} catch (err) {
			console.error('failed to get remaining accounts', err);
			// do nothing
		}

		return await this.program.methods
			.updateMarginTradingEnabled(enabled)
			.accounts({ ...accounts, manager: vaultAccount.manager })
			.remainingAccounts(remainingAccounts)
			.instruction();
	}

	/**
	 * Updates the vault's pool id (for isolated pools).
	 * @param vault vault address to update
	 * @param poolId pool id to update to
	 * @returns
	 */
	public async updateUserPoolId(
		vault: PublicKey,
		poolId: number,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const vaultAccount = await this.program.account.vault.fetch(vault);
		const updatePoolIdIx = await this.getUpdatePoolIdIx(
			vault,
			poolId,
			vaultAccount
		);
		return await this.createAndSendTxn([updatePoolIdIx], uiTxParams);
	}

	/**
	 * Gets the instruction to update the pool id for a vault.
	 * @param vault vault address to update
	 * @param vaultAccount vault account data (optional, will be fetched if not provided)
	 * @param poolId pool id to update to
	 * @returns instruction to update pool id
	 */
	public async getUpdatePoolIdIx(
		vault: PublicKey,
		poolId: number,
		vaultAccount?: any
	): Promise<TransactionInstruction> {
		if (!vaultAccount) {
			vaultAccount = await this.program.account.vault.fetch(vault);
		}

		const accounts = {
			vault: vault,
			driftUser: vaultAccount.user,
			driftProgram: this.velocityClient.program.programId,
		};

		const user = await this.getSubscribedVaultUser(vaultAccount.user);

		const remainingAccounts: AccountMeta[] = [];
		try {
			const userStatsKey = getUserStatsAccountPublicKey(
				this.velocityClient.program.programId,
				vault
			);
			const driftProgram = this.velocityClient.program as any;
			const userStats = (await driftProgram.account.userStats.fetch(
				userStatsKey
			)) as UserStatsAccount;
			remainingAccounts.push(
				...this.getRemainingAccountsForUser(
					[user.getUserAccount()!],
					[],
					vaultAccount,
					userStats
				)
			);
		} catch (err) {
			console.error('failed to get remaining accounts', err);
			// do nothing
		}

		return await this.program.methods
			.updateUserPoolId(poolId)
			.accounts({ ...accounts, manager: vaultAccount.manager })
			.remainingAccounts(remainingAccounts)
			.instruction();
	}

	private async handleWSolMovement(
		amount: BN,
		driftSpotMarket: SpotMarketAccount,
		userTokenAccount: PublicKey
	) {
		const isSolDeposit = driftSpotMarket.mint.equals(WRAPPED_SOL_MINT);
		const preIxs: TransactionInstruction[] = [];
		const postIxs: TransactionInstruction[] = [];

		if (isSolDeposit) {
			const { ixs: createWSolAccountIxs, pubkey } =
				await this.velocityClient.getWrappedSolAccountCreationIxs(amount, true);

			userTokenAccount = pubkey;

			preIxs.push(...createWSolAccountIxs);
			postIxs.push(
				createCloseAccountInstruction(
					userTokenAccount,
					this.velocityClient.wallet.publicKey,
					this.velocityClient.wallet.publicKey,
					[]
				)
			);
		}

		return { userTokenAccount, preIxs, postIxs };
	}

	/**
	 *
	 * @param vault vault address to deposit to
	 * @param amount amount to deposit
	 * @returns
	 */
	public async managerDeposit(
		vault: PublicKey,
		amount: BN,
		uiTxParams?: TxParams,
		managerTokenAccount?: PublicKey
	): Promise<TransactionSignature> {
		const managerDepositIxs = await this.getManagerDepositIx(
			vault,
			amount,
			managerTokenAccount
		);
		return await this.createAndSendTxn(managerDepositIxs, uiTxParams);
	}

	/**
	 *
	 * @param vault vault address to deposit to
	 * @param amount amount to deposit
	 * @returns
	 */
	public async getManagerDepositIx(
		vault: PublicKey,
		amount: BN,
		managerTokenAccount?: PublicKey
	): Promise<Array<TransactionInstruction>> {
		const vaultAccount = await this.program.account.vault.fetch(vault);
		const driftSpotMarket = this.velocityClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		if (!driftSpotMarket) {
			throw new Error(
				`Spot market ${vaultAccount.spotMarketIndex} not found on velocityClient`
			);
		}

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			true
		);

		const accounts = {
			vault,
			vaultTokenAccount: vaultAccount.tokenAccount,
			driftUser: await getUserAccountPublicKey(
				this.velocityClient.program.programId,
				vault
			),
			driftUserStats: getUserStatsAccountPublicKey(
				this.velocityClient.program.programId,
				vault
			),
			driftProgram: this.velocityClient.program.programId,
			driftState: await this.velocityClient.getStatePublicKey(),
			driftSpotMarketVault: driftSpotMarket.vault,
			userTokenAccount:
				managerTokenAccount ??
				getAssociatedTokenAddressSync(
					driftSpotMarket.mint,
					vaultAccount.manager,
					true
				),
			tokenProgram: TOKEN_PROGRAM_ID,
		};

		const { userTokenAccount, preIxs, postIxs } = await this.handleWSolMovement(
			amount,
			driftSpotMarket,
			accounts.userTokenAccount
		);

		const managerDepositIx = await this.program.methods
			.managerDeposit(amount)
			.accounts({
				...accounts,
				userTokenAccount,
				manager: vaultAccount.manager,
			})
			.remainingAccounts(remainingAccounts)
			.instruction();
		return [...preIxs, managerDepositIx, ...postIxs];
	}

	public async managerRequestWithdraw(
		vault: PublicKey,
		amount: BN,
		withdrawUnit: WithdrawUnit,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const requestWithdrawIx = await this.getManagerRequestWithdrawIx(
			vault,
			amount,
			withdrawUnit
		);
		return await this.createAndSendTxn([requestWithdrawIx], uiTxParams);
	}

	public async getManagerRequestWithdrawIx(
		vault: PublicKey,
		amount: BN,
		withdrawUnit: WithdrawUnit
	): Promise<TransactionInstruction> {
		this.program.idl.types;
		// @ts-ignore
		const vaultAccount = (await this.program.account.vault.fetch(
			vault
		)) as Vault;

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			true
		);

		const accounts = {
			vault,
			driftUser: vaultAccount.user,
			driftUserStats: userStatsKey,
		};

		return this.program.instruction.managerRequestWithdraw(
			// @ts-ignore
			amount,
			withdrawUnit,
			{
				accounts: {
					manager: vaultAccount.manager,
					...accounts,
				},
				remainingAccounts,
			}
		);
	}

	public async managerCancelWithdrawRequest(
		vault: PublicKey,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getManagerCancelWithdrawRequestIx(vault);
		return await this.createAndSendTxn([ix], uiTxParams);
	}

	public async getManagerCancelWithdrawRequestIx(
		vault: PublicKey
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);

		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);

		const accounts = {
			manager: vaultAccount.manager,
			vault,
			driftUser: vaultAccount.user,
			driftUserStats: userStatsKey,
		};

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[],
			vaultAccount,
			userStats,
			false,
			true
		);

		return this.program.instruction.mangerCancelWithdrawRequest({
			accounts,
			remainingAccounts,
		});
	}

	public async managerWithdraw(
		vault: PublicKey,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.getManagerWithdrawIx(vault);
		return this.createAndSendTxn(ixs, uiTxParams);
	}

	public async getManagerWithdrawIx(
		vault: PublicKey
	): Promise<TransactionInstruction[]> {
		const vaultAccount = await this.program.account.vault.fetch(vault);

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			false
		);

		const spotMarket = this.velocityClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${vaultAccount.spotMarketIndex} not found on velocityClient`
			);
		}

		const isSolMarket = spotMarket.mint.equals(WRAPPED_SOL_MINT);
		let userAta = getAssociatedTokenAddressSync(
			spotMarket.mint,
			vaultAccount.manager,
			true
		);

		const preIxs: TransactionInstruction[] = [];
		const postIxs: TransactionInstruction[] = [];

		if (isSolMarket) {
			const { ixs, pubkey } =
				await this.velocityClient.getWrappedSolAccountCreationIxs(ZERO, false);

			userAta = pubkey;
			preIxs.push(...ixs);
			postIxs.push(createSyncNativeInstruction(userAta));
			postIxs.push(
				createCloseAccountInstruction(
					userAta,
					vaultAccount.manager,
					vaultAccount.manager,
					[]
				)
			);
		} else {
			const userAtaExists = await this.velocityClient.connection.getAccountInfo(
				userAta
			);
			if (userAtaExists === null) {
				preIxs.push(
					createAssociatedTokenAccountInstruction(
						vaultAccount.manager,
						userAta,
						vaultAccount.manager,
						spotMarket.mint
					)
				);
			}
		}

		const withdrawIx = await this.program.instruction.managerWithdraw({
			accounts: {
				vault,
				manager: vaultAccount.manager,
				vaultTokenAccount: vaultAccount.tokenAccount,
				driftUser: await getUserAccountPublicKey(
					this.velocityClient.program.programId,
					vault
				),
				driftProgram: this.velocityClient.program.programId,
				driftUserStats: getUserStatsAccountPublicKey(
					this.velocityClient.program.programId,
					vault
				),
				driftState: await this.velocityClient.getStatePublicKey(),
				driftSpotMarketVault: spotMarket.vault,
				userTokenAccount: userAta,
				driftSigner: this.velocityClient.getStateAccount().signer,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
			remainingAccounts,
		});

		return [...preIxs, withdrawIx, ...postIxs];
	}

	public async managerBorrow(
		vault: PublicKey,
		borrowSpotMarketIndex: number,
		borrowAmount: BN,
		managerTokenAccount?: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.getManagerBorrowIx(
			vault,
			borrowSpotMarketIndex,
			borrowAmount,
			managerTokenAccount
		);
		return await this.createAndSendTxn(ixs, txParams);
	}

	public async getManagerBorrowIx(
		vault: PublicKey,
		borrowSpotMarketIndex: number,
		borrowAmount: BN,
		managerTokenAccount?: PublicKey
	): Promise<TransactionInstruction[]> {
		const vaultAccount = await this.program.account.vault.fetch(vault);

		const spotMarket = this.velocityClient.getSpotMarketAccount(
			borrowSpotMarketIndex
		);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${borrowSpotMarketIndex} not found on velocityClient`
			);
		}

		if (!managerTokenAccount) {
			managerTokenAccount = getAssociatedTokenAddressSync(
				spotMarket.mint,
				this.velocityClient.wallet.publicKey,
				true
			);
		}

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[borrowSpotMarketIndex, vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			false
		);

		const preIxs = [];
		const postIxs = [];

		const managerTokenAccountExists =
			await this.velocityClient.connection.getAccountInfo(managerTokenAccount);
		if (managerTokenAccountExists === null) {
			preIxs.push(
				createAssociatedTokenAccountInstruction(
					vaultAccount.manager,
					managerTokenAccount,
					vaultAccount.manager,
					spotMarket.mint
				)
			);
		}

		const vaultBorrowTokenAccount = getAssociatedTokenAddressSync(
			spotMarket.mint,
			vault,
			true
		);
		const vaultBorrowTokenAccountExists =
			await this.velocityClient.connection.getAccountInfo(
				vaultBorrowTokenAccount
			);
		if (vaultBorrowTokenAccountExists === null) {
			preIxs.push(
				createAssociatedTokenAccountInstruction(
					this.velocityClient.wallet.publicKey,
					vaultBorrowTokenAccount,
					vault,
					spotMarket.mint
				)
			);
		}

		if (spotMarket.mint.equals(WRAPPED_SOL_MINT)) {
			postIxs.push(
				createCloseAccountInstruction(
					managerTokenAccount,
					vaultAccount.manager,
					vaultAccount.manager,
					[]
				)
			);
		}

		return [
			...preIxs,
			await this.program.methods
				.managerBorrow(borrowSpotMarketIndex, borrowAmount)
				.accounts({
					vault,
					vaultTokenAccount: vaultBorrowTokenAccount,
					manager: vaultAccount.manager,
					driftUserStats: userStatsKey,
					driftUser: vaultAccount.user,
					driftState: await this.velocityClient.getStatePublicKey(),
					driftSpotMarketVault: spotMarket.vault,
					driftSigner: this.velocityClient.getStateAccount().signer,
					userTokenAccount: managerTokenAccount,
				})
				.remainingAccounts(remainingAccounts)
				.instruction(),
			...postIxs,
		];
	}

	public async managerRepay(
		vault: PublicKey,
		repaySpotMarketIndex: number,
		repayAmount: BN,
		repayValue: BN | null,
		managerTokenAccount?: PublicKey,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.getManagerRepayIxs(
			vault,
			repaySpotMarketIndex,
			repayAmount,
			repayValue,
			managerTokenAccount
		);
		return this.createAndSendTxn(ixs, uiTxParams);
	}

	/**
	 * Get the instructions for the manager repay transaction
	 * @param vault - The vault to repay
	 * @param repaySpotMarketIndex - The spot market index to repay
	 * @param repayAmount - The amount to repay
	 * @param repayValue - The value of the repay
	 * @param managerTokenAccount - The manager token account to use, if depositing SOL, leave undefined to automatically wrap the SOL
	 * @returns The instructions for the manager repay transaction
	 */
	public async getManagerRepayIxs(
		vault: PublicKey,
		repaySpotMarketIndex: number,
		repayAmount: BN,
		repayValue: BN | null,
		managerTokenAccount?: PublicKey
	): Promise<TransactionInstruction[]> {
		const vaultAccount = await this.program.account.vault.fetch(vault);
		const spotMarket =
			this.velocityClient.getSpotMarketAccount(repaySpotMarketIndex);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${repaySpotMarketIndex} not found on velocityClient`
			);
		}
		const isSolMarket = spotMarket.mint.equals(WRAPPED_SOL_MINT);

		const preIxs: TransactionInstruction[] = [];
		const postIxs: TransactionInstruction[] = [];
		let createdWsolAccount = false;

		if (!managerTokenAccount) {
			if (isSolMarket) {
				// create wSOL
				const { ixs, pubkey } =
					await this.velocityClient.getWrappedSolAccountCreationIxs(
						repayAmount,
						true
					);
				preIxs.push(...ixs);
				managerTokenAccount = pubkey;
				createdWsolAccount = true;
			} else {
				managerTokenAccount = getAssociatedTokenAddressSync(
					spotMarket.mint,
					vaultAccount.manager,
					true
				);
			}
		}

		const vaultRepayTokenAccount = getAssociatedTokenAddressSync(
			spotMarket.mint,
			vault,
			true
		);
		const vaultRepayTokenAccountExists =
			await this.velocityClient.connection.getAccountInfo(
				vaultRepayTokenAccount
			);
		if (vaultRepayTokenAccountExists === null) {
			preIxs.push(
				createAssociatedTokenAccountInstruction(
					this.velocityClient.wallet.publicKey,
					vaultRepayTokenAccount,
					vault,
					spotMarket.mint
				)
			);
		}

		if (createdWsolAccount) {
			postIxs.push(
				createCloseAccountInstruction(
					managerTokenAccount!,
					vaultAccount.manager,
					vaultAccount.manager,
					[]
				)
			);
		}

		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[repaySpotMarketIndex, vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			false
		);

		return [
			...preIxs,
			await this.program.methods
				.managerRepay(repaySpotMarketIndex, repayAmount, repayValue)
				.accounts({
					vault,
					vaultTokenAccount: vaultRepayTokenAccount,
					manager: vaultAccount.manager,
					driftUserStats: userStatsKey,
					driftUser: vaultAccount.user,
					driftState: await this.velocityClient.getStatePublicKey(),
					driftSpotMarketVault: spotMarket.vault,
					driftSigner: this.velocityClient.getStateAccount().signer,
					userTokenAccount: managerTokenAccount!,
				})
				.remainingAccounts(remainingAccounts)
				.instruction(),
			...postIxs,
		];
	}

	public async managerUpdateBorrow(
		vault: PublicKey,
		newBorrowValue: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getManagerUpdateBorrowIx(vault, newBorrowValue);
		return await this.createAndSendTxn([ix], txParams);
	}

	public async getManagerUpdateBorrowIx(
		vault: PublicKey,
		newBorrowValue: BN
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[],
			vaultAccount,
			userStats,
			false,
			false
		);

		return this.program.instruction.managerUpdateBorrow(newBorrowValue, {
			accounts: {
				vault,
				manager: vaultAccount.manager,
				driftUserStats: userStatsKey,
				driftUser: vaultAccount.user,
			},
			remainingAccounts,
		});
	}

	public async managerUpdateVault(
		vault: PublicKey,
		params: {
			redeemPeriod: BN | null;
			maxTokens: BN | null;
			managementFee: BN | null;
			minDepositAmount: BN | null;
			profitShare: number | null;
			hurdleRate: number | null;
			permissioned: boolean | null;
		},
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getManagerUpdateVaultIx(vault, params);
		return this.createAndSendTxn([ix], uiTxParams);
	}

	public async getManagerUpdateVaultIx(
		vault: PublicKey,
		params: {
			redeemPeriod: BN | null;
			maxTokens: BN | null;
			managementFee: BN | null;
			minDepositAmount: BN | null;
			profitShare: number | null;
			hurdleRate: number | null;
			permissioned: boolean | null;
		}
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);
		return this.program.instruction.updateVault(params, {
			accounts: {
				vault,
				manager: vaultAccount.manager,
			},
		});
	}

	public async managerUpdateVaultManager(
		vault: PublicKey,
		manager: PublicKey,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getManagerUpdateVaultManagerIx(vault, manager);
		return this.createAndSendTxn([ix], uiTxParams);
	}

	public async getManagerUpdateVaultManagerIx(
		vault: PublicKey,
		manager: PublicKey
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);
		return this.program.instruction.updateVaultManager(manager, {
			accounts: {
				vault,
				manager: vaultAccount.manager,
			},
		});
	}

	public async applyProfitShare(
		vault: PublicKey,
		vaultDepositor: PublicKey,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getApplyProfitShareIx(vault, vaultDepositor);
		return this.createAndSendTxn([ix], uiTxParams);
	}

	public async getApplyProfitShareIx(
		vault: PublicKey,
		vaultDepositor: PublicKey
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);

		const user = await this.getSubscribedVaultUser(vaultAccount.user);

		const spotMarket = this.velocityClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${vaultAccount.spotMarketIndex} not found on velocityClient`
			);
		}

		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			false
		);

		const accounts = {
			vault,
			vaultDepositor,
			manager: vaultAccount.manager,
			driftUserStats: getUserStatsAccountPublicKey(
				this.velocityClient.program.programId,
				vault
			),
			driftUser: await getUserAccountPublicKey(
				this.velocityClient.program.programId,
				vault
			),
			driftState: await this.velocityClient.getStatePublicKey(),
			driftSigner: this.velocityClient.getStateAccount().signer,
			driftProgram: this.velocityClient.program.programId,
		};

		return this.program.instruction.applyProfitShare({
			accounts: {
				...accounts,
			},
			remainingAccounts,
		});
	}

	public async getApplyRebaseTokenizedDepositorIx(
		vault: PublicKey,
		tokenizedVaultDepositor: PublicKey
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);

		const user = await this.getSubscribedVaultUser(vaultAccount.user);

		const spotMarket = this.velocityClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${vaultAccount.spotMarketIndex} not found on velocityClient`
			);
		}

		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			true
		);

		const accounts = {
			vault,
			tokenizedVaultDepositor,
			driftUser: await getUserAccountPublicKey(
				this.velocityClient.program.programId,
				vault
			),
			driftState: await this.velocityClient.getStatePublicKey(),
			driftSigner: this.velocityClient.getStateAccount().signer,
			driftProgram: this.velocityClient.program.programId,
		};

		return this.program.instruction.applyRebaseTokenizedDepositor({
			accounts: {
				...accounts,
			},
			remainingAccounts,
		});
	}

	public async applyRebase(
		vault: PublicKey,
		vaultDepositor: PublicKey
	): Promise<TransactionSignature> {
		return await this.createAndSendTxn([
			await this.getApplyRebaseIx(vault, vaultDepositor),
		]);
	}

	public async getApplyRebaseIx(
		vault: PublicKey,
		vaultDepositor: PublicKey
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);

		const user = await this.getSubscribedVaultUser(vaultAccount.user);

		const spotMarket = this.velocityClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${vaultAccount.spotMarketIndex} not found on velocityClient`
			);
		}

		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			true
		);

		const accounts = {
			vault,
			vaultDepositor,
			driftUser: await getUserAccountPublicKey(
				this.velocityClient.program.programId,
				vault
			),
			driftState: await this.velocityClient.getStatePublicKey(),
			driftSigner: this.velocityClient.getStateAccount().signer,
			driftProgram: this.velocityClient.program.programId,
		};

		return this.program.instruction.applyRebase({
			accounts: {
				...accounts,
			},
			remainingAccounts,
		});
	}

	public async applyRebaseTokenizedDepositor(
		vault: PublicKey,
		tokenizedVaultDepositor: PublicKey
	): Promise<TransactionSignature> {
		return await this.createAndSendTxn([
			await this.getApplyRebaseTokenizedDepositorIx(
				vault,
				tokenizedVaultDepositor
			),
		]);
	}

	private createInitVaultDepositorIx(
		vault: PublicKey,
		authority?: PublicKey,
		payer?: PublicKey
	) {
		const vaultDepositor = getVaultDepositorAddressSync(
			this.program.programId,
			vault,
			authority || this.velocityClient.wallet.publicKey
		);

		const accounts = {
			vaultDepositor,
			vault,
			authority: authority || this.velocityClient.wallet.publicKey,
		};

		const initIx = this.program.instruction.initializeVaultDepositor({
			accounts: {
				...accounts,
				payer: payer || authority || this.velocityClient.wallet.publicKey,
				rent: SYSVAR_RENT_PUBKEY,
				systemProgram: SystemProgram.programId,
			},
		});

		return initIx;
	}

	/**
	 * Initializes the vault depositor account. This account is used to deposit funds into a vault.
	 * @param vault the vault address to deposit into
	 * @param authority the authority allowed to make deposits into the vault
	 * @returns
	 */
	public async initializeVaultDepositor(
		vault: PublicKey,
		authority?: PublicKey,
		payer?: PublicKey,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const initIx = this.createInitVaultDepositorIx(vault, authority, payer);
		return await this.createAndSendTxn([initIx], uiTxParams);
	}

	public async initializeTokenizedVaultDepositor(
		params: {
			vault: PublicKey;
			tokenName: string;
			tokenSymbol: string;
			tokenUri: string;
			decimals?: number;
			sharesBase?: number;
		},
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		if (!this.metaplex) {
			throw new Error(
				'Metaplex instance is required when constructing VaultClient to initialize a tokenized vault depositor'
			);
		}

		let spotMarketDecimals = 6;
		let sharesBase = 0;
		if (params.decimals === undefined || params.sharesBase === undefined) {
			const vault = await this.program.account.vault.fetch(params.vault);
			const spotMarketAccount = this.velocityClient.getSpotMarketAccount(
				vault.spotMarketIndex
			);
			if (!spotMarketAccount) {
				throw new Error(
					`VelocityClient failed to load vault's spot market (marketIndex: ${vault.spotMarketIndex})`
				);
			}
			spotMarketDecimals = spotMarketAccount.decimals;
			sharesBase = vault.sharesBase;
		}

		const mintAddress = getTokenizedVaultMintAddressSync(
			this.program.programId,
			params.vault,
			sharesBase
		);

		const vaultAccount = await this.program.account.vault.fetch(params.vault);

		const accounts = {
			vault: params.vault,
			vaultDepositor: getTokenizedVaultAddressSync(
				this.program.programId,
				params.vault,
				sharesBase
			),
			mintAccount: mintAddress,
			metadataAccount: this.metaplex.nfts().pdas().metadata({
				mint: mintAddress,
			}),
			tokenMetadataProgram: this.metaplex.programs().getTokenMetadata().address,
			payer: vaultAccount.manager,
		};

		const vaultTokenAta = getAssociatedTokenAddressSync(
			mintAddress,
			params.vault,
			true
		);
		const createAtaIx = createAssociatedTokenAccountInstruction(
			vaultAccount.manager,
			vaultTokenAta,
			params.vault,
			mintAddress
		);

		return await this.createAndSendTxn(
			[
				await this.program.methods
					.initializeTokenizedVaultDepositor({
						...params,
						decimals: params.decimals ?? spotMarketDecimals,
					})
					.accounts(accounts)
					.instruction(),
				createAtaIx,
			],
			uiTxParams
		);
	}

	public async createTokenizeSharesIx(
		vaultDepositor: PublicKey,
		amount: BN,
		unit: WithdrawUnit,
		mint?: PublicKey
	): Promise<TransactionInstruction[]> {
		const vaultDepositorAccount =
			await this.program.account.vaultDepositor.fetch(vaultDepositor);
		const vaultAccount = await this.program.account.vault.fetch(
			vaultDepositorAccount.vault
		);

		mint =
			mint ??
			getTokenizedVaultMintAddressSync(
				this.program.programId,
				vaultDepositorAccount.vault,
				vaultAccount.sharesBase
			);

		const userAta = getAssociatedTokenAddressSync(
			mint,
			this.velocityClient.wallet.publicKey,
			true
		);

		const ixs: TransactionInstruction[] = [];

		const userAtaExists = await this.velocityClient.connection.getAccountInfo(
			userAta
		);
		if (userAtaExists === null) {
			ixs.push(
				createAssociatedTokenAccountInstruction(
					this.velocityClient.wallet.publicKey,
					userAta,
					this.velocityClient.wallet.publicKey,
					mint
				)
			);
		}

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vaultDepositorAccount.vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			true
		);

		ixs.push(
			await this.program.methods
				// anchor idl bug: https://github.com/coral-xyz/anchor/issues/2914
				// @ts-ignore args tuple vs anchor 0.32 IDL recursion limit
				.tokenizeShares(amount, unit)
				// `mint` is auto-resolved from IDL seeds, but anchor 1.0's IDL
				// generator can't encode `vault.shares_base.to_string().as_bytes()`
				// and emits broken seeds. Pass it explicitly to override.
				.accountsPartial({
					authority: this.velocityClient.wallet.publicKey,
					vault: vaultDepositorAccount.vault,
					tokenizedVaultDepositor: getTokenizedVaultAddressSync(
						this.program.programId,
						vaultDepositorAccount.vault,
						vaultAccount.sharesBase
					),
					mint,
					userTokenAccount: userAta,
					driftUser: vaultAccount.user,
				})
				.remainingAccounts(remainingAccounts)
				.instruction()
		);

		return ixs;
	}

	public async tokenizeShares(
		vaultDepositor: PublicKey,
		amount: BN,
		unit: WithdrawUnit,
		mint?: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.createTokenizeSharesIx(
			vaultDepositor,
			amount,
			unit,
			mint
		);
		return await this.createAndSendTxn(ixs, txParams);
	}

	public async createTransferVaultDepositorSharesIx(
		fromVaultDepositor: PublicKey,
		toVaultDepositor: PublicKey,
		amount: BN,
		withdrawUnit: WithdrawUnit
	): Promise<TransactionInstruction[]> {
		const vaultDepositorAccount =
			await this.program.account.vaultDepositor.fetch(fromVaultDepositor);
		const vaultAccount = await this.program.account.vault.fetch(
			vaultDepositorAccount.vault
		);

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vaultDepositorAccount.vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			true
		);

		const ixs: TransactionInstruction[] = [];

		ixs.push(
			await this.program.methods
				// @ts-ignore args tuple vs anchor 0.32 IDL recursion limit
				.transferVaultDepositorShares(amount, withdrawUnit)
				.accounts({
					vault: vaultDepositorAccount.vault,
					authority: this.velocityClient.wallet.publicKey,
					toVaultDepositor,
					driftUser: vaultAccount.user,
				})
				.remainingAccounts(remainingAccounts)
				.instruction()
		);

		return ixs;
	}

	public async transferVaultDepositorShares(
		fromVaultDepositor: PublicKey,
		toVaultDepositor: PublicKey,
		amount: BN,
		withdrawUnit: WithdrawUnit,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.createTransferVaultDepositorSharesIx(
			fromVaultDepositor,
			toVaultDepositor,
			amount,
			withdrawUnit
		);
		return await this.createAndSendTxn(ixs, txParams);
	}

	public async createRedeemTokensIx(
		vaultDepositor: PublicKey,
		tokensToBurn: BN,
		sharesBase?: number
	): Promise<TransactionInstruction> {
		const vaultDepositorAccount =
			await this.program.account.vaultDepositor.fetch(vaultDepositor);
		const vaultAccount = await this.program.account.vault.fetch(
			vaultDepositorAccount.vault
		);

		const mint = getTokenizedVaultMintAddressSync(
			this.program.programId,
			vaultDepositorAccount.vault,
			sharesBase ?? vaultAccount.sharesBase
		);

		const userAta = getAssociatedTokenAddressSync(
			mint,
			this.velocityClient.wallet.publicKey,
			true
		);

		const vaultTokenAta = getAssociatedTokenAddressSync(
			mint,
			vaultDepositorAccount.vault,
			true
		);

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vaultDepositorAccount.vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			true
		);

		return await this.program.methods
			.redeemTokens(tokensToBurn)
			.accounts({
				authority: this.velocityClient.wallet.publicKey,
				vault: vaultDepositorAccount.vault,
				tokenizedVaultDepositor: getTokenizedVaultAddressSync(
					this.program.programId,
					vaultDepositorAccount.vault,
					sharesBase ?? vaultAccount.sharesBase
				),
				mint,
				userTokenAccount: userAta,
				vaultTokenAccount: vaultTokenAta,
				driftUser: vaultAccount.user,
			})
			.remainingAccounts(remainingAccounts)
			.instruction();
	}

	/**
	 * Redeems tokens from the vault.
	 * @param vaultDepositor
	 * @param tokensToBurn
	 * @param mint optionally provide a mint, or infer the mint from the current vault share base
	 * @param txParams
	 * @returns
	 */
	public async redeemTokens(
		vaultDepositor: PublicKey,
		tokensToBurn: BN,
		sharesBase?: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.createRedeemTokensIx(
			vaultDepositor,
			tokensToBurn,
			sharesBase
		);
		return await this.createAndSendTxn([ix], txParams);
	}

	public async prepDepositTx(
		vaultDepositor: PublicKey,
		amount: BN,
		initVaultDepositor?: {
			authority: PublicKey;
			vault: PublicKey;
		},
		depositTokenAccount?: PublicKey
	) {
		let vaultPubKey: PublicKey;
		if (initVaultDepositor) {
			vaultPubKey = initVaultDepositor.vault;
		} else {
			const vaultDepositorAccount =
				await this.program.account.vaultDepositor.fetch(vaultDepositor);
			vaultPubKey = vaultDepositorAccount.vault;
		}

		const vaultAccount = await this.program.account.vault.fetch(vaultPubKey);

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vaultPubKey
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			false
		);

		const driftStateKey = await this.velocityClient.getStatePublicKey();

		const spotMarket = this.velocityClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${vaultAccount.spotMarketIndex} not found on velocityClient`
			);
		}

		const nonWSolUserTokenAccount =
			depositTokenAccount ??
			getAssociatedTokenAddressSync(
				spotMarket.mint,
				this.velocityClient.wallet.publicKey,
				true
			);

		const { userTokenAccount, preIxs, postIxs } = await this.handleWSolMovement(
			amount,
			spotMarket,
			nonWSolUserTokenAccount
		);

		const accounts = {
			vault: vaultPubKey,
			vaultDepositor,
			vaultTokenAccount: vaultAccount.tokenAccount,
			driftUserStats: userStatsKey,
			driftUser: vaultAccount.user,
			driftState: driftStateKey,
			driftSpotMarketVault: spotMarket.vault,
			userTokenAccount: userTokenAccount,
			driftProgram: this.velocityClient.program.programId,
			tokenProgram: TOKEN_PROGRAM_ID,
		};

		return {
			vaultAccount,
			accounts,
			remainingAccounts,
			preIxs,
			postIxs,
		};
	}

	/**
	 * Creates a transaction to deposit funds into the specified vault.
	 * Uses the associated token account of the vault depositor authority and spot market mint,
	 * and assumes it exists before calling this function.
	 * @param vaultDepositor
	 * @param amount
	 * @param initVaultDepositor If true, will initialize the vault depositor account
	 * @returns transaction
	 */
	public async createDepositTx(
		vaultDepositor: PublicKey,
		amount: BN,
		initVaultDepositor?: {
			authority: PublicKey;
			vault: PublicKey;
		},
		txParams?: TxParams,
		userTokenAccount?: PublicKey
	): Promise<VersionedTransaction> {
		const { vaultAccount, accounts, remainingAccounts, preIxs, postIxs } =
			await this.prepDepositTx(
				vaultDepositor,
				amount,
				initVaultDepositor,
				userTokenAccount
			);

		const ixs: TransactionInstruction[] = [];

		if (initVaultDepositor) {
			ixs.push(
				this.createInitVaultDepositorIx(
					vaultAccount.pubkey,
					initVaultDepositor.authority
				)
			);
		}

		const depositIx = await this.program.methods
			.deposit(amount)
			.accounts({
				authority: this.velocityClient.wallet.publicKey,
				...accounts,
			})
			.remainingAccounts(remainingAccounts)
			.instruction();
		ixs.push(...preIxs);
		ixs.push(depositIx);
		ixs.push(...postIxs);

		if (txParams?.noLut ? txParams.noLut : false) {
			return await this.createTxnNoLut(ixs, txParams);
		} else {
			return await this.createTxn(ixs, txParams);
		}
	}

	/**
	 * Depositor funds into the specified vault.
	 * @param vaultDepositor
	 * @param amount
	 * @param initVaultDepositor If true, will initialize the vault depositor account
	 * @param txParams
	 * @returns
	 */
	public async deposit(
		vaultDepositor: PublicKey,
		amount: BN,
		initVaultDepositor?: {
			authority: PublicKey;
			vault: PublicKey;
		},
		txParams?: TxParams,
		userTokenAccount?: PublicKey
	): Promise<TransactionSignature> {
		const depositTxn = await this.createDepositTx(
			vaultDepositor,
			amount,
			initVaultDepositor,
			txParams,
			userTokenAccount
		);

		return this.sendTxn(depositTxn, txParams?.simulateTransaction);
	}

	public async requestWithdraw(
		vaultDepositor: PublicKey,
		amount: BN,
		withdrawUnit: WithdrawUnit,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.getRequestWithdrawIx(
			vaultDepositor,
			amount,
			withdrawUnit,
			txParams?.oracleFeedsToCrank
		);
		return await this.createAndSendTxn(ixs, txParams);
	}

	public async getRequestWithdrawIx(
		vaultDepositor: PublicKey,
		amount: BN,
		withdrawUnit: WithdrawUnit,
		oracleFeedsToCrank?: TxParams['oracleFeedsToCrank']
	): Promise<TransactionInstruction[]> {
		const vaultDepositorAccount =
			await this.program.account.vaultDepositor.fetch(vaultDepositor);
		const vaultAccount = await this.program.account.vault.fetch(
			vaultDepositorAccount.vault
		);

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vaultDepositorAccount.vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			false
		);

		const accounts = {
			vault: vaultDepositorAccount.vault,
			vaultDepositor,
			driftUser: vaultAccount.user,
			driftUserStats: userStatsKey,
		};

		const oracleFeedsToCrankIxs = await this.getOracleFeedsToCrankIxs(
			oracleFeedsToCrank
		);

		const requestWithdrawIx = this.program.instruction.requestWithdraw(
			// @ts-ignore
			amount,
			withdrawUnit,
			{
				accounts: {
					authority: this.velocityClient.wallet.publicKey,
					...accounts,
				},
				remainingAccounts,
			}
		);

		return [...oracleFeedsToCrankIxs, requestWithdrawIx];
	}

	public async withdraw(
		vaultDepositor: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.getWithdrawIx(
			vaultDepositor,
			txParams?.oracleFeedsToCrank
		);
		return await this.createAndSendTxn(ixs, {
			cuLimit: 850_000, // overestimating to be safe
			...txParams,
		});
	}

	public async getWithdrawIx(
		vaultDepositor: PublicKey,
		oracleFeedsToCrank?: TxParams['oracleFeedsToCrank']
	): Promise<TransactionInstruction[]> {
		const vaultDepositorAccount =
			await this.program.account.vaultDepositor.fetch(vaultDepositor);
		const vaultAccount = await this.program.account.vault.fetch(
			vaultDepositorAccount.vault
		);

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vaultDepositorAccount.vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			false
		);

		const driftStateKey = await this.velocityClient.getStatePublicKey();

		const spotMarket = this.velocityClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${vaultAccount.spotMarketIndex} not found on velocityClient`
			);
		}

		const isSolMarket = spotMarket.mint.equals(WRAPPED_SOL_MINT);

		// let createAtaIx: TransactionInstruction | undefined = undefined;
		let userAta = getAssociatedTokenAddressSync(
			spotMarket.mint,
			this.velocityClient.wallet.publicKey,
			true
		);

		const preIxs: TransactionInstruction[] = [];
		const postIxs: TransactionInstruction[] = [];

		if (isSolMarket) {
			const { ixs, pubkey } =
				await this.velocityClient.getWrappedSolAccountCreationIxs(ZERO, false);

			userAta = pubkey;
			preIxs.push(...ixs);
			postIxs.push(createSyncNativeInstruction(userAta));
			postIxs.push(
				createCloseAccountInstruction(
					userAta,
					this.velocityClient.wallet.publicKey,
					this.velocityClient.wallet.publicKey,
					[]
				)
			);
		} else {
			const userAtaExists = await this.velocityClient.connection.getAccountInfo(
				userAta
			);
			if (userAtaExists === null) {
				preIxs.push(
					createAssociatedTokenAccountInstruction(
						this.velocityClient.wallet.publicKey,
						userAta,
						this.velocityClient.wallet.publicKey,
						spotMarket.mint
					)
				);
			}
		}

		const accounts = {
			vault: vaultDepositorAccount.vault,
			vaultDepositor,
			vaultTokenAccount: vaultAccount.tokenAccount,
			driftUserStats: userStatsKey,
			driftUser: vaultAccount.user,
			driftState: driftStateKey,
			driftSpotMarketVault: spotMarket.vault,
			driftSigner: this.velocityClient.getStateAccount().signer,
			userTokenAccount: userAta,
			driftProgram: this.velocityClient.program.programId,
			tokenProgram: TOKEN_PROGRAM_ID,
		};

		const oracleFeedsToCrankIxs = await this.getOracleFeedsToCrankIxs(
			oracleFeedsToCrank
		);

		const ixs = [
			...oracleFeedsToCrankIxs,
			...preIxs,
			await this.program.methods
				.withdraw()
				.accounts({
					authority: this.velocityClient.wallet.publicKey,
					...accounts,
				})
				.remainingAccounts(remainingAccounts)
				.instruction(),
			...postIxs,
		];

		return ixs;
	}

	public async forceWithdraw(
		vaultDepositor: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getForceWithdrawIx(vaultDepositor);
		return await this.createAndSendTxn(ix, txParams);
	}

	public async getForceWithdrawIx(
		vaultDepositor: PublicKey
	): Promise<TransactionInstruction[]> {
		const vaultDepositorAccount =
			await this.program.account.vaultDepositor.fetch(vaultDepositor);
		const vaultAccount = await this.program.account.vault.fetch(
			vaultDepositorAccount.vault
		);

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vaultDepositorAccount.vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			false
		);
		if (vaultAccount.vaultProtocol) {
			const vaultProtocol = this.getVaultProtocolAddress(
				vaultDepositorAccount.vault
			);
			remainingAccounts.push({
				pubkey: vaultProtocol,
				isSigner: false,
				isWritable: true,
			});
		}

		const driftStateKey = await this.velocityClient.getStatePublicKey();

		const spotMarket = this.velocityClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${vaultAccount.spotMarketIndex} not found on velocityClient`
			);
		}

		const [userTokenAccount, createAtaIx] = await getOrCreateATAInstruction(
			spotMarket.mint,
			vaultDepositorAccount.authority,
			this.velocityClient.connection,
			true,
			this.velocityClient.wallet.publicKey
		);

		if (createAtaIx) {
			console.log(
				`Creating ATA for ${vaultDepositorAccount.authority.toBase58()} to ${userTokenAccount.toBase58()}`
			);
		}

		const accounts = {
			manager: vaultAccount.manager,
			vault: vaultDepositorAccount.vault,
			vaultDepositor,
			vaultTokenAccount: vaultAccount.tokenAccount,
			driftUserStats: userStatsKey,
			driftUser: vaultAccount.user,
			driftState: driftStateKey,
			driftSpotMarketVault: spotMarket.vault,
			driftSigner: this.velocityClient.getStateAccount().signer,
			userTokenAccount,
			driftProgram: this.velocityClient.program.programId,
			tokenProgram: TOKEN_PROGRAM_ID,
		};

		const ixs: TransactionInstruction[] = [];

		if (createAtaIx) {
			ixs.push(createAtaIx);
		}

		ixs.push(
			await this.program.methods
				.forceWithdraw()
				.accounts(accounts)
				.remainingAccounts(remainingAccounts)
				.instruction()
		);

		return ixs;
	}

	public async cancelRequestWithdraw(
		vaultDepositor: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.getCancelRequestWithdrawIx(
			vaultDepositor,
			txParams?.oracleFeedsToCrank
		);
		return await this.createAndSendTxn(ixs, txParams);
	}

	public async getCancelRequestWithdrawIx(
		vaultDepositor: PublicKey,
		oracleFeedsToCrank: TxParams['oracleFeedsToCrank']
	): Promise<TransactionInstruction[]> {
		const vaultDepositorAccount =
			await this.program.account.vaultDepositor.fetch(vaultDepositor);
		const vaultAccount = await this.program.account.vault.fetch(
			vaultDepositorAccount.vault
		);

		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vaultDepositorAccount.vault
		);

		const accounts = {
			vault: vaultDepositorAccount.vault,
			vaultDepositor,
			driftUserStats: userStatsKey,
			driftUser: vaultAccount.user,
		};

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			false
		);

		if (this.cliMode) {
			return [
				await this.program.methods
					.cancelRequestWithdraw()
					.accounts(accounts)
					.remainingAccounts(remainingAccounts)
					.instruction(),
			];
		} else {
			const oracleFeedsToCrankIxs = await this.getOracleFeedsToCrankIxs(
				oracleFeedsToCrank
			);

			const cancelRequestWithdrawIx =
				this.program.instruction.cancelRequestWithdraw({
					accounts: {
						authority: this.velocityClient.wallet.publicKey,
						...accounts,
					},
					remainingAccounts,
				});

			return [...oracleFeedsToCrankIxs, cancelRequestWithdrawIx];
		}
	}

	/**
	 * Liquidates (become delegate for) a vault.
	 * @param
	 * @param
	 * @returns
	 */
	public async liquidate(
		vaultDepositor: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getLiquidateIx(vaultDepositor);
		return await this.createAndSendTxn([ix], txParams);
	}

	public async getLiquidateIx(
		vaultDepositor: PublicKey
	): Promise<TransactionInstruction> {
		if (!this.velocityClient.wallet.publicKey.equals(VAULT_ADMIN_KEY)) {
			throw new Error('Only vault admin can liquidate');
		}
		const vaultDepositorAccount =
			await this.program.account.vaultDepositor.fetch(vaultDepositor);
		const vault = vaultDepositorAccount.vault;

		const vaultAccount = await this.program.account.vault.fetch(vault);

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[vaultAccount.spotMarketIndex],
			vaultAccount,
			userStats,
			false,
			true
		);

		const driftStateKey = await this.velocityClient.getStatePublicKey();

		const accounts = {
			vault,
			vaultDepositor,
			vaultTokenAccount: vaultAccount.tokenAccount,
			driftUserStats: userStatsKey,
			driftUser: vaultAccount.user,
			driftState: driftStateKey,
			driftProgram: this.velocityClient.program.programId,
			authority: vaultDepositorAccount.authority,
		};

		if (this.cliMode) {
			return await this.program.methods
				.liquidate()
				.accounts(accounts)
				.remainingAccounts(remainingAccounts)
				.instruction();
		} else {
			return this.program.instruction.liquidate({
				accounts: {
					...accounts,
					admin: this.velocityClient.wallet.publicKey,
				},
				remainingAccounts,
			});
		}
	}

	public async createTxn(
		vaultIxs: TransactionInstruction[],
		txParams?: TxParams
	): Promise<VersionedTransaction> {
		const ixs = [
			ComputeBudgetProgram.setComputeUnitLimit({
				units: txParams?.cuLimit ?? 400_000,
			}),
			ComputeBudgetProgram.setComputeUnitPrice({
				microLamports:
					txParams?.cuPriceMicroLamports === undefined
						? 50_000
						: txParams.cuPriceMicroLamports,
			}),
			...vaultIxs,
		];

		return (await this.velocityClient.txHandler.buildTransaction({
			connection: this.velocityClient.connection,
			instructions: ixs,
			lookupTables: txParams?.lookupTables ?? [],
			preFlightCommitment: 'confirmed',
			forceVersionedTransaction: true,
			txVersion: 0,
			fetchAllMarketLookupTableAccounts:
				this.velocityClient.fetchAllLookupTableAccounts.bind(
					this.velocityClient
				),
		})) as VersionedTransaction;
	}

	public async createTxnNoLut(
		vaultIxs: TransactionInstruction[],
		txParams?: TxParams
	): Promise<VersionedTransaction> {
		const ixs = [
			ComputeBudgetProgram.setComputeUnitLimit({
				units: txParams?.cuLimit ?? 400_000,
			}),
			ComputeBudgetProgram.setComputeUnitPrice({
				microLamports:
					txParams?.cuPriceMicroLamports === undefined
						? 50_000
						: txParams.cuPriceMicroLamports,
			}),
			...vaultIxs,
		];

		const recentBlockhash =
			await this.velocityClient.connection.getLatestBlockhash();

		return this.velocityClient.txHandler.generateVersionedTransaction(
			recentBlockhash,
			ixs,
			[],
			this.velocityClient.wallet
		);
	}

	public async sendTxn(
		transaction: VersionedTransaction,
		simulateTransaction?: boolean
	): Promise<TransactionSignature> {
		let txSig = bs58.encode(transaction.signatures[0]);
		if (simulateTransaction) {
			try {
				const resp = await this.velocityClient.connection.simulateTransaction(
					transaction,
					{
						sigVerify: false,
						commitment: this.velocityClient.connection.commitment,
					}
				);
				console.log(`Simulated transaction:\n${JSON.stringify(resp, null, 2)}`);
			} catch (e) {
				const err = e as Error;
				console.error(
					`Error simulating transaction: ${err.message}\n:${err.stack ?? ''}`
				);
			}
		} else {
			const resp = await this.velocityClient.sendTransaction(
				transaction,
				[],
				this.velocityClient.opts
			);
			if (resp.txSig !== txSig) {
				txSig = resp.txSig;
			}
		}

		return txSig!;
	}

	/**
	 * Used for UI wallet adapters compatibility
	 */
	public async createAndSendTxn(
		vaultIxs: TransactionInstruction[],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		let tx: VersionedTransaction;
		if (txParams?.noLut ? txParams.noLut : false) {
			tx = await this.createTxnNoLut(vaultIxs, txParams);
			// @ts-ignore
			tx.sign([this.velocityClient.wallet.payer]);
		} else {
			tx = await this.createTxn(vaultIxs, txParams);
		}
		const txSig = await this.sendTxn(tx, txParams?.simulateTransaction);

		return txSig;
	}

	/**
	 * Initializes an insurance fund stake for the vault.
	 * @param vault vault address to update
	 * @param spotMarketIndex spot market index of the insurance fund stake
	 * @returns
	 */
	public async initializeInsuranceFundStake(
		vault: PublicKey,
		spotMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.getInitializeInsuranceFundStakeIx(
			vault,
			spotMarketIndex
		);
		return await this.createAndSendTxn([ixs], txParams);
	}

	public async getInitializeInsuranceFundStakeIx(
		vault: PublicKey,
		spotMarketIndex: number
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);

		const _ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.velocityClient.program.programId,
			vault,
			spotMarketIndex
		);

		const spotMarket =
			this.velocityClient.getSpotMarketAccount(spotMarketIndex);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${spotMarketIndex} not found on velocityClient`
			);
		}

		const _ifVaultTokenAccount = getInsuranceFundTokenVaultAddressSync(
			this.program.programId,
			vault,
			spotMarketIndex
		);

		return await this.program.methods
			.initializeInsuranceFundStake(spotMarketIndex)
			.accounts({
				vault: vault,
				driftSpotMarketMint: spotMarket.mint,
				driftUserStats: vaultAccount.userStats,
				driftState: await this.velocityClient.getStatePublicKey(),
			})
			.instruction();
	}

	/**
	 * Adds an amount to an insurance fund stake for the vault.
	 * @param vault vault address to update
	 * @param spotMarketIndex spot market index of the insurance fund stake
	 * @param amount amount to add to the insurance fund stake, in spotMarketIndex precision
	 * @returns
	 */
	public async addToInsuranceFundStake(
		vault: PublicKey,
		spotMarketIndex: number,
		amount: BN,
		managerTokenAccount?: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.getAddToInsuranceFundStakeIx(
			vault,
			spotMarketIndex,
			amount,
			managerTokenAccount
		);
		return await this.createAndSendTxn([ixs], txParams);
	}

	public async getAddToInsuranceFundStakeIx(
		vault: PublicKey,
		spotMarketIndex: number,
		amount: BN,
		managerTokenAccount?: PublicKey
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);

		if (!vaultAccount.manager.equals(this.velocityClient.wallet.publicKey)) {
			throw new Error(
				`Only the manager of the vault can add to the insurance fund stake.`
			);
		}

		const _ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.velocityClient.program.programId,
			vault,
			spotMarketIndex
		);
		const _ifVaultPublicKey = await getInsuranceFundVaultPublicKey(
			this.velocityClient.program.programId,
			spotMarketIndex
		);

		const spotMarket =
			this.velocityClient.getSpotMarketAccount(spotMarketIndex);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${spotMarketIndex} not found on velocityClient`
			);
		}

		if (!managerTokenAccount) {
			managerTokenAccount = getAssociatedTokenAddressSync(
				spotMarket.mint,
				vaultAccount.manager,
				true
			);
		}

		const _ifVaultTokenAccount = getInsuranceFundTokenVaultAddressSync(
			this.program.programId,
			vault,
			spotMarketIndex
		);

		return await this.program.methods
			.addInsuranceFundStake(spotMarketIndex, amount)
			.accounts({
				vault: vault,
				managerTokenAccount,
				driftUserStats: vaultAccount.userStats,
				driftState: await this.velocityClient.getStatePublicKey(),
				driftSigner: this.velocityClient.getStateAccount().signer,
			})
			.instruction();
	}

	public async requestRemoveInsuranceFundStake(
		vault: PublicKey,
		spotMarketIndex: number,
		amount: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getRequestRemoveInsuranceFundStakeIx(
			vault,
			spotMarketIndex,
			amount
		);
		return await this.createAndSendTxn([ix], txParams);
	}

	public async getRequestRemoveInsuranceFundStakeIx(
		vault: PublicKey,
		spotMarketIndex: number,
		amount: BN
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);
		const _ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.velocityClient.program.programId,
			vault,
			spotMarketIndex
		);
		const _ifVaultPublicKey = await getInsuranceFundVaultPublicKey(
			this.velocityClient.program.programId,
			spotMarketIndex
		);

		const spotMarket =
			this.velocityClient.getSpotMarketAccount(spotMarketIndex);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${spotMarketIndex} not found on velocityClient`
			);
		}

		return await this.program.methods
			.requestRemoveInsuranceFundStake(spotMarketIndex, amount)
			.accounts({
				vault,
				manager: vaultAccount.manager,
				driftUserStats: vaultAccount.userStats,
			})
			.instruction();
	}

	public async cancelRequestRemoveInsuranceFundStake(
		vault: PublicKey,
		spotMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getCancelRequestRemoveInsuranceFundStakeIx(
			vault,
			spotMarketIndex
		);
		return await this.createAndSendTxn([ix], txParams);
	}

	public async getCancelRequestRemoveInsuranceFundStakeIx(
		vault: PublicKey,
		spotMarketIndex: number
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);
		const _ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.velocityClient.program.programId,
			vault,
			spotMarketIndex
		);
		const _ifVaultPublicKey = await getInsuranceFundVaultPublicKey(
			this.velocityClient.program.programId,
			spotMarketIndex
		);
		const spotMarket =
			this.velocityClient.getSpotMarketAccount(spotMarketIndex);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${spotMarketIndex} not found on velocityClient`
			);
		}

		return await this.program.methods
			.cancelRequestRemoveInsuranceFundStake(spotMarketIndex)
			.accounts({
				vault: vault,
				manager: vaultAccount.manager,
				driftUserStats: vaultAccount.userStats,
			})
			.instruction();
	}

	public async removeInsuranceFundStake(
		vault: PublicKey,
		spotMarketIndex: number,
		managerTokenAccount?: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.getRemoveInsuranceFundStakeIx(
			vault,
			spotMarketIndex,
			managerTokenAccount
		);
		return await this.createAndSendTxn([ixs], txParams);
	}

	public async getRemoveInsuranceFundStakeIx(
		vault: PublicKey,
		spotMarketIndex: number,
		managerTokenAccount?: PublicKey
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);
		const _ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.velocityClient.program.programId,
			vault,
			spotMarketIndex
		);
		const _ifVaultPublicKey = await getInsuranceFundVaultPublicKey(
			this.velocityClient.program.programId,
			spotMarketIndex
		);
		const spotMarket =
			this.velocityClient.getSpotMarketAccount(spotMarketIndex);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${spotMarketIndex} not found on velocityClient`
			);
		}

		if (!managerTokenAccount) {
			managerTokenAccount = getAssociatedTokenAddressSync(
				spotMarket.mint,
				vaultAccount.manager,
				true
			);
		}

		const _ifVaultTokenAccount = getInsuranceFundTokenVaultAddressSync(
			this.program.programId,
			vault,
			spotMarketIndex
		);

		return await this.program.methods
			.removeInsuranceFundStake(spotMarketIndex)
			.accounts({
				vault: vault,
				managerTokenAccount,
				driftState: await this.velocityClient.getStatePublicKey(),
				driftUserStats: vaultAccount.userStats,
				driftSigner: this.velocityClient.getStateAccount().signer,
			})
			.instruction();
	}

	public async protocolRequestWithdraw(
		vault: PublicKey,
		amount: BN,
		withdrawUnit: WithdrawUnit,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getProtocolRequestWithdrawIx(
			vault,
			amount,
			withdrawUnit
		);
		return await this.createAndSendTxn([ix], txParams);
	}

	public async getProtocolRequestWithdrawIx(
		vault: PublicKey,
		amount: BN,
		withdrawUnit: WithdrawUnit
	): Promise<TransactionInstruction> {
		// @ts-ignore
		const vaultAccount = (await this.program.account.vault.fetch(
			vault
		)) as Vault;
		const vp = this.getVaultProtocolAddress(vault);
		const vpAccount = (await this.program.account.vaultProtocol.fetch(
			vp
		)) as VaultProtocol;

		if (!this.velocityClient.wallet.publicKey.equals(vpAccount.protocol)) {
			throw new Error(`Only the protocol of the vault can request a withdraw.`);
		}

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[],
			vaultAccount,
			userStats,
			false,
			true
		);

		const accounts = {
			vault,
			driftUserStats: userStatsKey,
			driftUser: vaultAccount.user,
		};

		if (this.cliMode) {
			return await this.program.methods
				// @ts-ignore, 0.29.0 anchor issues..
				.managerRequestWithdraw(amount, withdrawUnit)
				.accounts(accounts)
				.remainingAccounts(remainingAccounts)
				.instruction();
		} else {
			const requestWithdrawIx = this.program.instruction.managerRequestWithdraw(
				// @ts-ignore
				amount,
				withdrawUnit,
				{
					accounts: {
						manager: vaultAccount.manager,
						...accounts,
					},
					remainingAccounts,
				}
			);

			return requestWithdrawIx;
		}
	}

	public async protocolCancelWithdrawRequest(
		vault: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.getProtocolCancelWithdrawRequestIx(vault);
		return await this.createAndSendTxn(ixs, txParams);
	}

	public async getProtocolCancelWithdrawRequestIx(
		vault: PublicKey
	): Promise<TransactionInstruction[]> {
		const vaultAccount = await this.program.account.vault.fetch(vault);

		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);

		const accounts = {
			manager: vaultAccount.manager,
			vault,
			driftUserStats: userStatsKey,
			driftUser: vaultAccount.user,
		};

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[],
			vaultAccount,
			userStats,
			false,
			true
		);

		if (this.cliMode) {
			return [
				await this.program.methods
					.mangerCancelWithdrawRequest()
					.accounts(accounts)
					.remainingAccounts(remainingAccounts)
					.instruction(),
			];
		} else {
			const cancelRequestWithdrawIx =
				this.program.instruction.mangerCancelWithdrawRequest({
					accounts: {
						...accounts,
						manager: vaultAccount.manager,
					},
					remainingAccounts,
				});

			return [cancelRequestWithdrawIx];
		}
	}

	public async protocolWithdraw(
		vault: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.getProtocolWithdrawIx(vault);
		return await this.createAndSendTxn(ixs, txParams);
	}

	public async getProtocolWithdrawIx(
		vault: PublicKey
	): Promise<TransactionInstruction[]> {
		const vaultAccount = await this.program.account.vault.fetch(vault);

		if (!this.velocityClient.wallet.publicKey.equals(vaultAccount.manager)) {
			throw new Error(`Only the manager of the vault can request a withdraw.`);
		}

		const user = await this.getSubscribedVaultUser(vaultAccount.user);
		const userStatsKey = getUserStatsAccountPublicKey(
			this.velocityClient.program.programId,
			vault
		);
		const userStats = (await (
			this.velocityClient.program as any
		).account.userStats.fetch(userStatsKey)) as UserStatsAccount;
		const remainingAccounts = this.getRemainingAccountsForUser(
			[user.getUserAccount()!],
			[],
			vaultAccount,
			userStats,
			false,
			true
		);

		const spotMarket = this.velocityClient.getSpotMarketAccount(
			vaultAccount.spotMarketIndex
		);
		if (!spotMarket) {
			throw new Error(
				`Spot market ${vaultAccount.spotMarketIndex} not found on velocityClient`
			);
		}

		const ix = this.program.instruction.managerWithdraw({
			accounts: {
				vault,
				manager: vaultAccount.manager,
				vaultTokenAccount: vaultAccount.tokenAccount,
				driftUser: await getUserAccountPublicKey(
					this.velocityClient.program.programId,
					vault
				),
				driftProgram: this.velocityClient.program.programId,
				driftUserStats: userStatsKey,
				driftState: await this.velocityClient.getStatePublicKey(),
				driftSpotMarketVault: spotMarket.vault,
				userTokenAccount: getAssociatedTokenAddressSync(
					spotMarket.mint,
					this.velocityClient.wallet.publicKey
				),
				driftSigner: this.velocityClient.getStateAccount().signer,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
			remainingAccounts,
		});
		return [ix];
	}

	private async getPythLazerOracleCrankIxs(
		oracleFeedsToCrank: OracleFeedConfig[] = [],
		pythLazerMsgHexGetter?: (feedIds: number[]) => Promise<string>
	) {
		try {
			const isPythLazerOracle = (oracleSource: OracleSource) => {
				const pythLazerStr = JSON.stringify(OracleSource.PYTH_LAZER);
				const pythLazer1kStr = JSON.stringify(OracleSource.PYTH_LAZER_1K);
				const pythLazer1mStr = JSON.stringify(OracleSource.PYTH_LAZER_1M);
				const pythLazerStableCoinStr = JSON.stringify(
					OracleSource.PYTH_LAZER_STABLE_COIN
				);
				const targetOracleSourceStr = JSON.stringify(oracleSource);
				return (
					targetOracleSourceStr === pythLazerStr ||
					targetOracleSourceStr === pythLazer1kStr ||
					targetOracleSourceStr === pythLazer1mStr ||
					targetOracleSourceStr === pythLazerStableCoinStr
				);
			};

			const pythLazerOracles = oracleFeedsToCrank.filter((config) =>
				isPythLazerOracle(config.oracleSource)
			);

			if (pythLazerOracles.length === 0) {
				return [];
			}

			if (!pythLazerMsgHexGetter) {
				console.error(
					'pythLazerMsgHexGetter is required to crank pyth lazer oracles'
				);
				return [];
			}

			const pythLazerFeedIds = pythLazerOracles
				.map((config) => config.pythLazerId)
				.filter(Boolean) as number[];
			const pythLazerMsgHex = await pythLazerMsgHexGetter(pythLazerFeedIds);

			const oracleUpdateIxs =
				await this.velocityClient.getPostPythLazerOracleUpdateIxs(
					pythLazerFeedIds,
					pythLazerMsgHex,
					undefined,
					3
				);

			return oracleUpdateIxs;
		} catch (err) {
			console.error('Error cranking pyth lazer oracles', err);
			return [];
		}
	}

	public async getOracleFeedsToCrankIxs(
		oracleFeedsToCrank: TxParams['oracleFeedsToCrank']
	) {
		if (!oracleFeedsToCrank?.feedsToCrank) {
			return [];
		}

		return await this.getPythLazerOracleCrankIxs(
			oracleFeedsToCrank.feedsToCrank,
			oracleFeedsToCrank.pythLazerMsgHexGetter
		);
	}

	public async updateVaultProtocol(
		vault: PublicKey,
		params: {
			protocolFee: BN | null;
			protocolProfitShare: number | null;
		},
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getUpdateVaultProtocolIx(vault, params);
		return await this.createAndSendTxn([ix], txParams);
	}

	public async getUpdateVaultProtocolIx(
		vault: PublicKey,
		params: {
			protocolFee: BN | null;
			protocolProfitShare: number | null;
		}
	): Promise<TransactionInstruction> {
		return this.program.methods
			.updateVaultProtocol(params)
			.accounts({
				vault,
				vaultProtocol: this.getVaultProtocolAddress(vault),
			})
			.instruction();
	}

	public async adminInitFeeUpdate(
		vault: PublicKey,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getAdminInitFeeUpdateIx(vault);
		return await this.createAndSendTxn([ix], uiTxParams);
	}

	public async getAdminInitFeeUpdateIx(
		vault: PublicKey
	): Promise<TransactionInstruction> {
		const feeUpdate = getFeeUpdateAddressSync(this.program.programId, vault);

		return this.program.instruction.adminInitFeeUpdate({
			accounts: {
				vault,
				admin: this.velocityClient.wallet.publicKey,
				feeUpdate,
				systemProgram: SystemProgram.programId,
			},
		});
	}

	public async adminDeleteFeeUpdate(
		vault: PublicKey,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getAdminDeleteFeeUpdateIx(vault);
		return await this.createAndSendTxn([ix], uiTxParams);
	}

	public async getAdminDeleteFeeUpdateIx(
		vault: PublicKey
	): Promise<TransactionInstruction> {
		const feeUpdate = getFeeUpdateAddressSync(this.program.programId, vault);

		return this.program.instruction.adminDeleteFeeUpdate({
			accounts: {
				vault,
				admin: this.velocityClient.wallet.publicKey,
				feeUpdate,
			},
		});
	}

	public async adminUpdateVaultClass(
		vault: PublicKey,
		newVaultClass: VaultClass,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getAdminUpdateVaultClassIx(vault, newVaultClass);
		return await this.createAndSendTxn([ix], uiTxParams);
	}

	public async getAdminUpdateVaultClassIx(
		vault: PublicKey,
		newVaultClass: VaultClass
	): Promise<TransactionInstruction> {
		return this.program.methods
			.adminUpdateVaultClass(newVaultClass as any)
			.accounts({
				vault,
				admin: this.velocityClient.wallet.publicKey,
			})
			.instruction();
	}

	public async managerUpdateFees(
		vault: PublicKey,
		params: {
			timelockDuration: BN;
			newManagementFee: BN | null;
			newProfitShare: number | null;
			newHurdleRate: number | null;
		},
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const feeUpdate = getFeeUpdateAddressSync(this.program.programId, vault);
		const ixs: TransactionInstruction[] = [];
		if (!(await this.checkIfAccountExists(feeUpdate))) {
			throw new Error(
				'Fee update account does not exist, it must be created by an admin first'
			);
		}
		ixs.push(await this.getManagerUpdateFeesIx(vault, params));
		return await this.createAndSendTxn(ixs, uiTxParams);
	}

	public async getManagerUpdateFeesIx(
		vault: PublicKey,
		params: {
			timelockDuration: BN;
			newManagementFee: BN | null;
			newProfitShare: number | null;
			newHurdleRate: number | null;
		}
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);
		const feeUpdate = getFeeUpdateAddressSync(this.program.programId, vault);

		return this.program.instruction.managerUpdateFees(params, {
			accounts: {
				vault,
				manager: vaultAccount.manager,
				feeUpdate,
			},
		});
	}

	public async managerCancelFeeUpdate(
		vault: PublicKey,
		uiTxParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getManagerCancelFeeUpdateIx(vault);
		return await this.createAndSendTxn([ix], uiTxParams);
	}

	public async getManagerCancelFeeUpdateIx(
		vault: PublicKey
	): Promise<TransactionInstruction> {
		const vaultAccount = await this.program.account.vault.fetch(vault);
		const feeUpdate = getFeeUpdateAddressSync(this.program.programId, vault);

		return this.program.instruction.managerCancelFeeUpdate({
			accounts: {
				vault,
				manager: vaultAccount.manager,
				feeUpdate,
			},
		});
	}

	/**
	 * Calculate the vault share price (base value per share)
	 * @param params vault address or vault account, and precision exponent
	 * @returns BigNum representing the base value per share
	 */
	public async calcVaultSharePrice(params: {
		address?: PublicKey;
		vault?: Vault;
	}): Promise<BigNum> {
		let spotPrecisionExp = QUOTE_PRECISION_EXP;

		try {
			let vaultAccount: Vault;
			if (params.address !== undefined) {
				vaultAccount = await this.program.account.vault.fetch(params.address);
			} else if (params.vault !== undefined) {
				vaultAccount = params.vault;
			} else {
				throw new Error('Must supply address or vault');
			}

			const spotMarket = this.velocityClient.getSpotMarketAccount(
				vaultAccount.spotMarketIndex
			);
			spotPrecisionExp = new BN(spotMarket!.decimals);

			const totalAccountValue = await this.calculateVaultEquityInDepositAsset({
				vault: vaultAccount,
				factorUnrealizedPNL: true,
			});

			const vaultTotalShares = vaultAccount.totalShares.toString();
			const totalAccountValueStr = totalAccountValue.toString();

			return vaultTotalShares === '0'
				? BigNum.from(0, spotPrecisionExp)
				: new BigNum(totalAccountValueStr, spotPrecisionExp)
						.shift(VAULT_SHARES_PRECISION_EXP)
						.div(new BigNum(vaultTotalShares, VAULT_SHARES_PRECISION_EXP));
		} catch (err) {
			console.error('VaultClient calcVaultSharePrice error:', err);
			return BigNum.from(0, spotPrecisionExp);
		}
	}
}
