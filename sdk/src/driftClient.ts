import { AnchorProvider, BN, Idl, Program } from '@project-serum/anchor';
import bs58 from 'bs58';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	Token,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	StateAccount,
	IWallet,
	PositionDirection,
	UserAccount,
	PerpMarketAccount,
	OrderParams,
	Order,
	SpotMarketAccount,
	SpotPosition,
	MakerInfo,
	TakerInfo,
	OptionalOrderParams,
	DefaultOrderParams,
	OrderType,
	ReferrerInfo,
	MarketType,
	TxParams,
	SerumV3FulfillmentConfigAccount,
	isVariant,
	OrderTriggerCondition,
	isOneOfVariant,
} from './types';
import * as anchor from '@project-serum/anchor';
import driftIDL from './idl/drift.json';

import {
	Connection,
	PublicKey,
	TransactionSignature,
	ConfirmOptions,
	Transaction,
	TransactionInstruction,
	AccountMeta,
	Keypair,
	LAMPORTS_PER_SOL,
	Signer,
	SystemProgram,
	ComputeBudgetProgram,
	AddressLookupTableAccount,
} from '@solana/web3.js';

import { TokenFaucet } from './tokenFaucet';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	getDriftSignerPublicKey,
	getDriftStateAccountPublicKey,
	getInsuranceFundStakeAccountPublicKey,
	getPerpMarketPublicKey,
	getSerumFulfillmentConfigPublicKey,
	getSerumSignerPublicKey,
	getSpotMarketPublicKey,
	getUserAccountPublicKey,
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
} from './addresses/pda';
import {
	DriftClientAccountSubscriber,
	DriftClientAccountEvents,
	DataAndSlot,
} from './accounts/types';
import { TxSender, TxSigAndSlot } from './tx/types';
import { wrapInTx } from './tx/utils';
import { QUOTE_SPOT_MARKET_INDEX, ZERO } from './constants/numericConstants';
import { findDirectionToClose, positionIsAvailable } from './math/position';
import { getTokenAmount } from './math/spotBalance';
import { DEFAULT_USER_NAME, encodeName } from './userName';
import { OraclePriceData } from './oracles/types';
import { DriftClientConfig } from './driftClientConfig';
import { PollingDriftClientAccountSubscriber } from './accounts/pollingDriftClientAccountSubscriber';
import { WebSocketDriftClientAccountSubscriber } from './accounts/webSocketDriftClientAccountSubscriber';
import { RetryTxSender } from './tx/retryTxSender';
import { User } from './user';
import { UserSubscriptionConfig } from './userConfig';
import { configs, getMarketsAndOraclesForSubscription } from './config';
import { WRAPPED_SOL_MINT } from './constants/spotMarkets';
import { UserStats } from './userStats';
import { isSpotPositionAvailable } from './math/spotPosition';

type RemainingAccountParams = {
	userAccounts: UserAccount[];
	writablePerpMarketIndexes?: number[];
	writableSpotMarketIndexes?: number[];
	readablePerpMarketIndex?: number;
	readableSpotMarketIndexes?: number[];
	useMarketLastSlotCache?: boolean;
};

/**
 * # DriftClient
 * This class is the main way to interact with Drift Protocol. It allows you to subscribe to the various accounts where the Market's state is stored, as well as: opening positions, liquidating, settling funding, depositing & withdrawing, and more.
 */
export class DriftClient {
	connection: Connection;
	wallet: IWallet;
	public program: Program;
	provider: AnchorProvider;
	opts?: ConfirmOptions;
	users = new Map<number, User>();
	userStats?: UserStats;
	activeSubAccountId: number;
	userAccountSubscriptionConfig: UserSubscriptionConfig;
	accountSubscriber: DriftClientAccountSubscriber;
	eventEmitter: StrictEventEmitter<EventEmitter, DriftClientAccountEvents>;
	_isSubscribed = false;
	txSender: TxSender;
	perpMarketLastSlotCache = new Map<number, number>();
	spotMarketLastSlotCache = new Map<number, number>();
	authority: PublicKey;
	marketLookupTable: PublicKey;

	public get isSubscribed() {
		return this._isSubscribed && this.accountSubscriber.isSubscribed;
	}

	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	public constructor(config: DriftClientConfig) {
		this.connection = config.connection;
		this.wallet = config.wallet;
		this.opts = config.opts || AnchorProvider.defaultOptions();
		this.provider = new AnchorProvider(
			config.connection,
			config.wallet,
			this.opts
		);
		this.program = new Program(
			driftIDL as Idl,
			config.programID,
			this.provider
		);

		this.authority = config.authority ?? this.wallet.publicKey;
		const subAccountIds = config.subAccountIds ?? [0];
		this.activeSubAccountId = config.activeSubAccountId ?? subAccountIds[0];
		this.userAccountSubscriptionConfig =
			config.accountSubscription?.type === 'polling'
				? {
						type: 'polling',
						accountLoader: config.accountSubscription.accountLoader,
				  }
				: {
						type: 'websocket',
				  };
		this.createUsers(subAccountIds, this.userAccountSubscriptionConfig);
		if (config.userStats) {
			this.userStats = new UserStats({
				driftClient: this,
				userStatsAccountPublicKey: getUserStatsAccountPublicKey(
					this.program.programId,
					this.authority
				),
				accountSubscription: this.userAccountSubscriptionConfig,
			});
		}

		let perpMarketIndexes = config.perpMarketIndexes;
		let spotMarketIndexes = config.spotMarketIndexes;
		let oracleInfos = config.oracleInfos;
		if (config.env) {
			const {
				perpMarketIndexes: envPerpMarketIndexes,
				spotMarketIndexes: envSpotMarketIndexes,
				oracleInfos: envOracleInfos,
			} = getMarketsAndOraclesForSubscription(config.env);
			perpMarketIndexes = perpMarketIndexes
				? perpMarketIndexes
				: envPerpMarketIndexes;
			spotMarketIndexes = spotMarketIndexes
				? spotMarketIndexes
				: envSpotMarketIndexes;
			oracleInfos = oracleInfos ? oracleInfos : envOracleInfos;
		}

		this.marketLookupTable = config.marketLookupTable;
		if (config.env && !this.marketLookupTable) {
			this.marketLookupTable = new PublicKey(
				configs[config.env].MARKET_LOOKUP_TABLE
			);
		}

		if (config.accountSubscription?.type === 'polling') {
			this.accountSubscriber = new PollingDriftClientAccountSubscriber(
				this.program,
				config.accountSubscription.accountLoader,
				perpMarketIndexes ?? [],
				spotMarketIndexes ?? [],
				oracleInfos ?? []
			);
		} else {
			this.accountSubscriber = new WebSocketDriftClientAccountSubscriber(
				this.program,
				perpMarketIndexes ?? [],
				spotMarketIndexes ?? [],
				oracleInfos ?? []
			);
		}
		this.eventEmitter = this.accountSubscriber.eventEmitter;
		this.txSender = new RetryTxSender(
			this.provider,
			config.txSenderConfig?.timeout,
			config.txSenderConfig?.retrySleep,
			config.txSenderConfig?.additionalConnections
		);
	}

	createUsers(
		subAccountIds: number[],
		accountSubscriptionConfig: UserSubscriptionConfig
	): void {
		for (const subAccountId of subAccountIds) {
			const user = this.createUser(subAccountId, accountSubscriptionConfig);
			this.users.set(subAccountId, user);
		}
	}

	createUser(
		subAccountId: number,
		accountSubscriptionConfig: UserSubscriptionConfig
	): User {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.authority,
			subAccountId
		);

		return new User({
			driftClient: this,
			userAccountPublicKey,
			accountSubscription: accountSubscriptionConfig,
		});
	}

	public async subscribe(): Promise<boolean> {
		let subscribePromises = this.subscribeUsers().concat(
			this.accountSubscriber.subscribe()
		);
		if (this.userStats !== undefined) {
			subscribePromises = subscribePromises.concat(this.userStats.subscribe());
		}
		this.isSubscribed = (await Promise.all(subscribePromises)).reduce(
			(success, prevSuccess) => success && prevSuccess
		);
		return this.isSubscribed;
	}

	subscribeUsers(): Promise<boolean>[] {
		return [...this.users.values()].map((user) => user.subscribe());
	}

	/**
	 *	Forces the accountSubscriber to fetch account updates from rpc
	 */
	public async fetchAccounts(): Promise<void> {
		let promises = [...this.users.values()]
			.map((user) => user.fetchAccounts())
			.concat(this.accountSubscriber.fetch());
		if (this.userStats) {
			promises = promises.concat(this.userStats.fetchAccounts());
		}
		await Promise.all(promises);
	}

	public async unsubscribe(): Promise<void> {
		let unsubscribePromises = this.unsubscribeUsers().concat(
			this.accountSubscriber.unsubscribe()
		);
		if (this.userStats !== undefined) {
			unsubscribePromises = unsubscribePromises.concat(
				this.userStats.unsubscribe()
			);
		}
		await Promise.all(unsubscribePromises);
		this.isSubscribed = false;
	}

	unsubscribeUsers(): Promise<void>[] {
		return [...this.users.values()].map((user) => user.unsubscribe());
	}

	statePublicKey?: PublicKey;
	public async getStatePublicKey(): Promise<PublicKey> {
		if (this.statePublicKey) {
			return this.statePublicKey;
		}
		this.statePublicKey = await getDriftStateAccountPublicKey(
			this.program.programId
		);
		return this.statePublicKey;
	}

	signerPublicKey?: PublicKey;
	public getSignerPublicKey(): PublicKey {
		if (this.signerPublicKey) {
			return this.signerPublicKey;
		}
		this.signerPublicKey = getDriftSignerPublicKey(this.program.programId);
		return this.signerPublicKey;
	}

	public getStateAccount(): StateAccount {
		return this.accountSubscriber.getStateAccountAndSlot().data;
	}

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 */
	public async forceGetStateAccount(): Promise<StateAccount> {
		await this.accountSubscriber.fetch();
		return this.accountSubscriber.getStateAccountAndSlot().data;
	}

	public getPerpMarketAccount(
		marketIndex: number
	): PerpMarketAccount | undefined {
		return this.accountSubscriber.getMarketAccountAndSlot(marketIndex)?.data;
	}

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 * @param marketIndex
	 */
	public async forceGetPerpMarketAccount(
		marketIndex: number
	): Promise<PerpMarketAccount | undefined> {
		await this.accountSubscriber.fetch();
		let data =
			this.accountSubscriber.getMarketAccountAndSlot(marketIndex)?.data;
		let i = 0;
		while (data === undefined && i < 10) {
			await this.accountSubscriber.fetch();
			data = this.accountSubscriber.getMarketAccountAndSlot(marketIndex)?.data;
			i++;
		}
		return data;
	}

	public getPerpMarketAccounts(): PerpMarketAccount[] {
		return this.accountSubscriber
			.getMarketAccountsAndSlots()
			.map((value) => value.data);
	}

	public getSpotMarketAccount(
		marketIndex: number
	): SpotMarketAccount | undefined {
		return this.accountSubscriber.getSpotMarketAccountAndSlot(marketIndex).data;
	}

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 * @param marketIndex
	 */
	public async forceGetSpotMarketAccount(
		marketIndex: number
	): Promise<SpotMarketAccount | undefined> {
		await this.accountSubscriber.fetch();
		return this.accountSubscriber.getSpotMarketAccountAndSlot(marketIndex).data;
	}

	public getSpotMarketAccounts(): SpotMarketAccount[] {
		return this.accountSubscriber
			.getSpotMarketAccountsAndSlots()
			.map((value) => value.data);
	}

	public getQuoteSpotMarketAccount(): SpotMarketAccount {
		return this.accountSubscriber.getSpotMarketAccountAndSlot(
			QUOTE_SPOT_MARKET_INDEX
		).data;
	}

	public getOraclePriceDataAndSlot(
		oraclePublicKey: PublicKey
	): DataAndSlot<OraclePriceData> | undefined {
		return this.accountSubscriber.getOraclePriceDataAndSlot(oraclePublicKey);
	}

	public async getSerumV3FulfillmentConfig(
		serumMarket: PublicKey
	): Promise<SerumV3FulfillmentConfigAccount> {
		const address = await getSerumFulfillmentConfigPublicKey(
			this.program.programId,
			serumMarket
		);
		return (await this.program.account.serumV3FulfillmentConfig.fetch(
			address
		)) as SerumV3FulfillmentConfigAccount;
	}

	public async fetchMarketLookupTableAccount(): Promise<AddressLookupTableAccount> {
		if (!this.marketLookupTable) {
			throw Error('Market lookup table address not set');
		}

		return (await this.connection.getAddressLookupTable(this.marketLookupTable))
			.value;
	}

	/**
	 * Update the wallet to use for drift transactions and linked user account
	 * @param newWallet
	 * @param subAccountIds
	 * @param activeSubAccountId
	 */
	public async updateWallet(
		newWallet: IWallet,
		subAccountIds = [0],
		activeSubAccountId = 0
	): Promise<void> {
		const newProvider = new AnchorProvider(
			this.connection,
			newWallet,
			this.opts
		);
		const newProgram = new Program(
			driftIDL as Idl,
			this.program.programId,
			newProvider
		);

		// Update provider for txSender with new wallet details
		this.txSender.provider = newProvider;

		this.wallet = newWallet;
		this.provider = newProvider;
		this.program = newProgram;
		this.authority = newWallet.publicKey;

		if (this.isSubscribed) {
			await Promise.all(this.unsubscribeUsers());

			if (this.userStats) {
				await this.userStats.unsubscribe();

				this.userStats = new UserStats({
					driftClient: this,
					userStatsAccountPublicKey: getUserStatsAccountPublicKey(
						this.program.programId,
						this.authority
					),
					accountSubscription: this.userAccountSubscriptionConfig,
				});
			}
		}
		this.users.clear();
		this.createUsers(subAccountIds, this.userAccountSubscriptionConfig);
		if (this.isSubscribed) {
			await Promise.all(this.subscribeUsers());

			if (this.userStats) {
				await this.userStats.subscribe();
			}
		}

		this.activeSubAccountId = activeSubAccountId;
		this.userStatsAccountPublicKey = undefined;
	}

	public async switchActiveUser(subAccountId: number): Promise<void> {
		this.activeSubAccountId = subAccountId;
	}

	public async addUser(subAccountId: number): Promise<void> {
		if (this.users.has(subAccountId)) {
			return;
		}

		const user = this.createUser(
			subAccountId,
			this.userAccountSubscriptionConfig
		);
		await user.subscribe();
		this.users.set(subAccountId, user);
	}

	public async initializeUserAccount(
		subAccountId = 0,
		name = DEFAULT_USER_NAME,
		referrerInfo?: ReferrerInfo
	): Promise<[TransactionSignature, PublicKey]> {
		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(
				subAccountId,
				name,
				referrerInfo
			);

		const tx = new Transaction();
		if (subAccountId === 0) {
			if (
				!(await this.checkIfAccountExists(this.getUserStatsAccountPublicKey()))
			) {
				tx.add(await this.getInitializeUserStatsIx());
			}
		}
		tx.add(initializeUserAccountIx);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return [txSig, userAccountPublicKey];
	}

	async getInitializeUserInstructions(
		subAccountId = 0,
		name = DEFAULT_USER_NAME,
		referrerInfo?: ReferrerInfo
	): Promise<[PublicKey, TransactionInstruction]> {
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			subAccountId
		);

		const remainingAccounts = new Array<AccountMeta>();
		if (referrerInfo !== undefined) {
			remainingAccounts.push({
				pubkey: referrerInfo.referrer,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: referrerInfo.referrerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		const state = this.getStateAccount();
		if (!state.whitelistMint.equals(PublicKey.default)) {
			const associatedTokenPublicKey = await Token.getAssociatedTokenAddress(
				ASSOCIATED_TOKEN_PROGRAM_ID,
				TOKEN_PROGRAM_ID,
				state.whitelistMint,
				this.wallet.publicKey
			);
			remainingAccounts.push({
				pubkey: associatedTokenPublicKey,
				isWritable: false,
				isSigner: false,
			});
		}

		const nameBuffer = encodeName(name);
		const initializeUserAccountIx =
			await this.program.instruction.initializeUser(subAccountId, nameBuffer, {
				accounts: {
					user: userAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					payer: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					state: await this.getStatePublicKey(),
				},
				remainingAccounts,
			});

		return [userAccountPublicKey, initializeUserAccountIx];
	}

	async getInitializeUserStatsIx(): Promise<TransactionInstruction> {
		return await this.program.instruction.initializeUserStats({
			accounts: {
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
				payer: this.wallet.publicKey,
				rent: anchor.web3.SYSVAR_RENT_PUBKEY,
				systemProgram: anchor.web3.SystemProgram.programId,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateUserName(
		name: string,
		subAccountId = 0
	): Promise<TransactionSignature> {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			subAccountId
		);

		const nameBuffer = encodeName(name);
		const tx = await this.program.transaction.updateUserName(
			subAccountId,
			nameBuffer,
			{
				accounts: {
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
				},
			}
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async updateUserCustomMarginRatio(
		marginRatio: number,
		subAccountId = 0
	): Promise<TransactionSignature> {
		const tx = await this.program.transaction.updateUserCustomMarginRatio(
			subAccountId,
			marginRatio,
			{
				accounts: {
					user: await this.getUserAccountPublicKey(),
					authority: this.wallet.publicKey,
				},
			}
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async updateUserMarginTradingEnabled(
		marginTradingEnabled: boolean,
		subAccountId = 0
	): Promise<TransactionSignature> {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			subAccountId
		);

		await this.addUser(subAccountId);
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
		});

		const tx = await this.program.transaction.updateUserMarginTradingEnabled(
			subAccountId,
			marginTradingEnabled,
			{
				accounts: {
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async updateUserDelegate(
		delegate: PublicKey,
		subAccountId = 0
	): Promise<TransactionSignature> {
		const tx = await this.program.transaction.updateUserDelegate(
			subAccountId,
			delegate,
			{
				accounts: {
					user: await this.getUserAccountPublicKey(),
					authority: this.wallet.publicKey,
				},
			}
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUserAccountsForDelegate(
		delegate: PublicKey
	): Promise<UserAccount[]> {
		const programAccounts = await this.program.account.user.all([
			{
				memcmp: {
					offset: 40,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(delegate.toBuffer()),
				},
			},
		]);

		return programAccounts.map(
			(programAccount) => programAccount.account as UserAccount
		);
	}

	public async getUserAccountsForAuthority(
		authority: PublicKey
	): Promise<UserAccount[]> {
		const programAccounts = await this.program.account.user.all([
			{
				memcmp: {
					offset: 8,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(authority.toBuffer()),
				},
			},
		]);

		return programAccounts.map(
			(programAccount) => programAccount.account as UserAccount
		);
	}

	public async deleteUser(
		subAccountId = 0,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			subAccountId
		);

		const ix = await this.program.instruction.deleteUser({
			accounts: {
				user: userAccountPublicKey,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});

		const { txSig } = await this.sendTransaction(
			wrapInTx(ix, txParams?.computeUnits, txParams?.computeUnitsPrice),
			[],
			this.opts
		);

		await this.users.get(subAccountId)?.unsubscribe();
		this.users.delete(subAccountId);

		return txSig;
	}

	public getUser(subAccountId?: number): User {
		subAccountId = subAccountId ?? this.activeSubAccountId;
		if (!this.users.has(subAccountId)) {
			throw new Error(`Clearing House has no user for user id ${subAccountId}`);
		}
		return this.users.get(subAccountId);
	}

	public getUsers(): User[] {
		return [...this.users.values()];
	}

	public getUserStats(): UserStats {
		return this.userStats;
	}

	userStatsAccountPublicKey: PublicKey;
	public getUserStatsAccountPublicKey(): PublicKey {
		if (this.userStatsAccountPublicKey) {
			return this.userStatsAccountPublicKey;
		}

		this.userStatsAccountPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			this.authority
		);
		return this.userStatsAccountPublicKey;
	}

	public async getUserAccountPublicKey(): Promise<PublicKey> {
		return this.getUser().userAccountPublicKey;
	}

	public getUserAccount(subAccountId?: number): UserAccount | undefined {
		return this.getUser(subAccountId).getUserAccount();
	}

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 * @param subAccountId
	 */
	public async forceGetUserAccount(
		subAccountId?: number
	): Promise<UserAccount | undefined> {
		await this.getUser(subAccountId).fetchAccounts();
		return this.getUser(subAccountId).getUserAccount();
	}

	public getUserAccountAndSlot(
		subAccountId?: number
	): DataAndSlot<UserAccount> | undefined {
		return this.getUser(subAccountId).getUserAccountAndSlot();
	}

	public getSpotPosition(marketIndex: number): SpotPosition | undefined {
		return this.getUserAccount().spotPositions.find(
			(spotPosition) => spotPosition.marketIndex === marketIndex
		);
	}

	public getQuoteAssetTokenAmount(): BN {
		const spotMarket = this.getSpotMarketAccount(QUOTE_SPOT_MARKET_INDEX);
		const spotPosition = this.getSpotPosition(QUOTE_SPOT_MARKET_INDEX);
		return getTokenAmount(
			spotPosition.scaledBalance,
			spotMarket,
			spotPosition.balanceType
		);
	}

	public getTokenAmount(marketIndex: number): BN {
		const spotPosition = this.getSpotPosition(marketIndex);
		if (spotPosition === undefined) {
			return ZERO;
		}
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		return getTokenAmount(
			spotPosition.scaledBalance,
			spotMarket,
			spotPosition.balanceType
		);
	}

	getRemainingAccounts(params: RemainingAccountParams): AccountMeta[] {
		const { oracleAccountMap, spotMarketAccountMap, perpMarketAccountMap } =
			this.getRemainingAccountMapsForUsers(params.userAccounts);

		if (params.useMarketLastSlotCache) {
			const lastUserSlot = this.getUserAccountAndSlot()?.slot;
			for (const [
				marketIndex,
				slot,
			] of this.perpMarketLastSlotCache.entries()) {
				// if cache has more recent slot than user positions account slot, add market to remaining accounts
				// otherwise remove from slot
				if (slot > lastUserSlot) {
					const marketAccount = this.getPerpMarketAccount(marketIndex);
					perpMarketAccountMap.set(marketIndex, {
						pubkey: marketAccount.pubkey,
						isSigner: false,
						isWritable: false,
					});
					oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
						pubkey: marketAccount.amm.oracle,
						isSigner: false,
						isWritable: false,
					});
				} else {
					this.perpMarketLastSlotCache.delete(marketIndex);
				}
			}

			for (const [
				marketIndex,
				slot,
			] of this.spotMarketLastSlotCache.entries()) {
				// if cache has more recent slot than user positions account slot, add market to remaining accounts
				// otherwise remove from slot
				if (slot > lastUserSlot) {
					const marketAccount = this.getSpotMarketAccount(marketIndex);
					spotMarketAccountMap.set(marketIndex, {
						pubkey: marketAccount.pubkey,
						isSigner: false,
						isWritable: false,
					});
					if (!marketAccount.oracle.equals(PublicKey.default)) {
						oracleAccountMap.set(marketAccount.oracle.toString(), {
							pubkey: marketAccount.oracle,
							isSigner: false,
							isWritable: false,
						});
					}
				} else {
					this.spotMarketLastSlotCache.delete(marketIndex);
				}
			}
		}

		if (params.readablePerpMarketIndex !== undefined) {
			const marketAccount = this.getPerpMarketAccount(
				params.readablePerpMarketIndex
			);
			perpMarketAccountMap.set(params.readablePerpMarketIndex, {
				pubkey: marketAccount.pubkey,
				isSigner: false,
				isWritable: false,
			});
			oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
				pubkey: marketAccount.amm.oracle,
				isSigner: false,
				isWritable: false,
			});
		}

		if (params.writablePerpMarketIndexes !== undefined) {
			for (const writablePerpMarketIndex of params.writablePerpMarketIndexes) {
				const marketAccount = this.getPerpMarketAccount(
					writablePerpMarketIndex
				);
				perpMarketAccountMap.set(writablePerpMarketIndex, {
					pubkey: marketAccount.pubkey,
					isSigner: false,
					isWritable: true,
				});
				oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
					pubkey: marketAccount.amm.oracle,
					isSigner: false,
					isWritable: false,
				});
			}
		}

		if (params.readableSpotMarketIndexes !== undefined) {
			for (const readableSpotMarketIndex of params.readableSpotMarketIndexes) {
				const spotMarketAccount = this.getSpotMarketAccount(
					readableSpotMarketIndex
				);
				spotMarketAccountMap.set(readableSpotMarketIndex, {
					pubkey: spotMarketAccount.pubkey,
					isSigner: false,
					isWritable: false,
				});
				if (spotMarketAccount.marketIndex !== 0) {
					oracleAccountMap.set(spotMarketAccount.oracle.toString(), {
						pubkey: spotMarketAccount.oracle,
						isSigner: false,
						isWritable: false,
					});
				}
			}
		}

		if (params.writableSpotMarketIndexes !== undefined) {
			for (const writableSpotMarketIndex of params.writableSpotMarketIndexes) {
				const spotMarketAccount = this.getSpotMarketAccount(
					writableSpotMarketIndex
				);
				spotMarketAccountMap.set(spotMarketAccount.marketIndex, {
					pubkey: spotMarketAccount.pubkey,
					isSigner: false,
					isWritable: true,
				});
				if (!spotMarketAccount.oracle.equals(PublicKey.default)) {
					oracleAccountMap.set(spotMarketAccount.oracle.toString(), {
						pubkey: spotMarketAccount.oracle,
						isSigner: false,
						isWritable: false,
					});
				}
			}
		}

		return [
			...oracleAccountMap.values(),
			...spotMarketAccountMap.values(),
			...perpMarketAccountMap.values(),
		];
	}

	getRemainingAccountMapsForUsers(userAccounts: UserAccount[]): {
		oracleAccountMap: Map<string, AccountMeta>;
		spotMarketAccountMap: Map<number, AccountMeta>;
		perpMarketAccountMap: Map<number, AccountMeta>;
	} {
		const oracleAccountMap = new Map<string, AccountMeta>();
		const spotMarketAccountMap = new Map<number, AccountMeta>();
		const perpMarketAccountMap = new Map<number, AccountMeta>();

		for (const userAccount of userAccounts) {
			for (const spotPosition of userAccount.spotPositions) {
				if (!isSpotPositionAvailable(spotPosition)) {
					const spotMarket = this.getSpotMarketAccount(
						spotPosition.marketIndex
					);
					spotMarketAccountMap.set(spotPosition.marketIndex, {
						pubkey: spotMarket.pubkey,
						isSigner: false,
						isWritable: false,
					});

					if (!spotMarket.oracle.equals(PublicKey.default)) {
						oracleAccountMap.set(spotMarket.oracle.toString(), {
							pubkey: spotMarket.oracle,
							isSigner: false,
							isWritable: false,
						});
					}

					if (
						!spotPosition.openAsks.eq(ZERO) ||
						!spotPosition.openBids.eq(ZERO)
					) {
						spotMarketAccountMap.set(QUOTE_SPOT_MARKET_INDEX, {
							pubkey: this.getQuoteSpotMarketAccount().pubkey,
							isSigner: false,
							isWritable: false,
						});
					}
				}
			}
			for (const position of userAccount.perpPositions) {
				if (!positionIsAvailable(position)) {
					const market = this.getPerpMarketAccount(position.marketIndex);
					perpMarketAccountMap.set(position.marketIndex, {
						pubkey: market.pubkey,
						isWritable: false,
						isSigner: false,
					});
					oracleAccountMap.set(market.amm.oracle.toString(), {
						pubkey: market.amm.oracle,
						isWritable: false,
						isSigner: false,
					});
				}
			}
		}

		return {
			oracleAccountMap,
			spotMarketAccountMap,
			perpMarketAccountMap,
		};
	}

	public getOrder(orderId: number): Order | undefined {
		return this.getUserAccount()?.orders.find(
			(order) => order.orderId === orderId
		);
	}

	public getOrderByUserId(userOrderId: number): Order | undefined {
		return this.getUserAccount()?.orders.find(
			(order) => order.userOrderId === userOrderId
		);
	}

	public async deposit(
		amount: BN,
		marketIndex: number,
		collateralAccountPublicKey: PublicKey,
		subAccountId?: number,
		reduceOnly = false
	): Promise<TransactionSignature> {
		const tx = new Transaction();
		tx.add(
			ComputeBudgetProgram.requestUnits({
				units: 600_000,
				additionalFee: 0,
			})
		);

		const additionalSigners: Array<Signer> = [];

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);

		const authority = this.authority;

		const createWSOLTokenAccount =
			isSolMarket && collateralAccountPublicKey.equals(authority);

		if (createWSOLTokenAccount) {
			const { ixs, signers, pubkey } =
				await this.getWrappedSolAccountCreationIxs(amount, true);

			collateralAccountPublicKey = pubkey;

			ixs.forEach((ix) => {
				tx.add(ix);
			});

			signers.forEach((signer) => additionalSigners.push(signer));
		}

		const depositCollateralIx = await this.getDepositInstruction(
			amount,
			marketIndex,
			collateralAccountPublicKey,
			subAccountId,
			reduceOnly,
			true
		);

		tx.add(depositCollateralIx);

		// Close the wrapped sol account at the end of the transaction
		if (createWSOLTokenAccount) {
			tx.add(
				Token.createCloseAccountInstruction(
					TOKEN_PROGRAM_ID,
					collateralAccountPublicKey,
					authority,
					authority,
					[]
				)
			);
		}

		const { txSig, slot } = await this.sendTransaction(
			tx,
			additionalSigners,
			this.opts
		);
		this.spotMarketLastSlotCache.set(marketIndex, slot);
		return txSig;
	}

	async getDepositInstruction(
		amount: BN,
		marketIndex: number,
		userTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly = false,
		userInitialized = true
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = subAccountId
			? await getUserAccountPublicKey(
					this.program.programId,
					this.authority,
					subAccountId
			  )
			: await this.getUserAccountPublicKey();

		let remainingAccounts = [];
		if (userInitialized) {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [await this.forceGetUserAccount()],
				useMarketLastSlotCache: true,
				writableSpotMarketIndexes: [marketIndex],
			});
		} else {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [],
				writableSpotMarketIndexes: [marketIndex],
			});
		}

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		return await this.program.instruction.deposit(
			marketIndex,
			amount,
			reduceOnly,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					spotMarketVault: spotMarketAccount.vault,
					user: userAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					userTokenAccount: userTokenAccount,
					authority: this.wallet.publicKey,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts,
			}
		);
	}

	private async checkIfAccountExists(account: PublicKey): Promise<boolean> {
		try {
			const accountInfo = await this.connection.getAccountInfo(account);
			return accountInfo != null;
		} catch (e) {
			// Doesn't already exist
			return false;
		}
	}

	private async getWrappedSolAccountCreationIxs(
		amount: BN,
		isDeposit?: boolean
	): Promise<{
		ixs: anchor.web3.TransactionInstruction[];
		signers: Signer[];
		pubkey: PublicKey;
	}> {
		const wrappedSolAccount = new Keypair();

		const result = {
			ixs: [],
			signers: [],
			pubkey: wrappedSolAccount.publicKey,
		};

		const rentSpaceLamports = new BN(LAMPORTS_PER_SOL / 100);

		const lamports = isDeposit
			? amount.add(rentSpaceLamports)
			: rentSpaceLamports;

		const authority = this.wallet.publicKey;

		result.ixs.push(
			SystemProgram.createAccount({
				fromPubkey: authority,
				newAccountPubkey: wrappedSolAccount.publicKey,
				lamports: lamports.toNumber(),
				space: 165,
				programId: TOKEN_PROGRAM_ID,
			})
		);

		result.ixs.push(
			Token.createInitAccountInstruction(
				TOKEN_PROGRAM_ID,
				WRAPPED_SOL_MINT,
				wrappedSolAccount.publicKey,
				authority
			)
		);

		result.signers.push(wrappedSolAccount);

		return result;
	}

	public getAssociatedTokenAccountCreationIx(
		tokenMintAddress: PublicKey,
		associatedTokenAddress: PublicKey
	): anchor.web3.TransactionInstruction {
		const createAssociatedAccountIx =
			Token.createAssociatedTokenAccountInstruction(
				ASSOCIATED_TOKEN_PROGRAM_ID,
				TOKEN_PROGRAM_ID,
				tokenMintAddress,
				associatedTokenAddress,
				this.wallet.publicKey,
				this.wallet.publicKey
			);

		return createAssociatedAccountIx;
	}

	/**
	 * Creates the Clearing House User account for a user, and deposits some initial collateral
	 * @param amount
	 * @param userTokenAccount
	 * @param marketIndex
	 * @param subAccountId
	 * @param name
	 * @param fromSubAccountId
	 * @returns
	 */
	public async initializeUserAccountAndDepositCollateral(
		amount: BN,
		userTokenAccount: PublicKey,
		marketIndex = 0,
		subAccountId = 0,
		name = DEFAULT_USER_NAME,
		fromSubAccountId?: number,
		referrerInfo?: ReferrerInfo
	): Promise<[TransactionSignature, PublicKey]> {
		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(
				subAccountId,
				name,
				referrerInfo
			);

		const additionalSigners: Array<Signer> = [];

		const spotMarket = this.getSpotMarketAccount(marketIndex);

		const isSolMarket = spotMarket.mint.equals(WRAPPED_SOL_MINT);

		const tx = new Transaction();

		const authority = this.wallet.publicKey;

		const createWSOLTokenAccount =
			isSolMarket && userTokenAccount.equals(authority);

		if (createWSOLTokenAccount) {
			const {
				ixs: startIxs,
				signers,
				pubkey,
			} = await this.getWrappedSolAccountCreationIxs(amount, true);

			userTokenAccount = pubkey;

			startIxs.forEach((ix) => {
				tx.add(ix);
			});

			signers.forEach((signer) => additionalSigners.push(signer));
		}

		const depositCollateralIx =
			fromSubAccountId != null
				? await this.getTransferDepositIx(
						amount,
						marketIndex,
						fromSubAccountId,
						subAccountId
				  )
				: await this.getDepositInstruction(
						amount,
						marketIndex,
						userTokenAccount,
						subAccountId,
						false,
						false
				  );

		if (subAccountId === 0) {
			if (
				!(await this.checkIfAccountExists(this.getUserStatsAccountPublicKey()))
			) {
				tx.add(await this.getInitializeUserStatsIx());
			}
		}
		tx.add(initializeUserAccountIx).add(depositCollateralIx);

		// Close the wrapped sol account at the end of the transaction
		if (createWSOLTokenAccount) {
			tx.add(
				Token.createCloseAccountInstruction(
					TOKEN_PROGRAM_ID,
					userTokenAccount,
					authority,
					authority,
					[]
				)
			);
		}

		const { txSig, slot } = await this.sendTransaction(
			tx,
			additionalSigners,
			this.opts
		);
		this.spotMarketLastSlotCache.set(marketIndex, slot);

		return [txSig, userAccountPublicKey];
	}

	public async initializeUserAccountForDevnet(
		subAccountId = 0,
		name = DEFAULT_USER_NAME,
		marketIndex: number,
		tokenFaucet: TokenFaucet,
		amount: BN,
		referrerInfo?: ReferrerInfo
	): Promise<[TransactionSignature, PublicKey]> {
		const [associateTokenPublicKey, createAssociatedAccountIx, mintToIx] =
			await tokenFaucet.createAssociatedTokenAccountAndMintToInstructions(
				this.wallet.publicKey,
				amount
			);

		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(
				subAccountId,
				name,
				referrerInfo
			);

		const depositCollateralIx = await this.getDepositInstruction(
			amount,
			marketIndex,
			associateTokenPublicKey,
			subAccountId,
			false,
			false
		);

		const tx = new Transaction().add(createAssociatedAccountIx).add(mintToIx);

		if (subAccountId === 0) {
			if (
				!(await this.checkIfAccountExists(this.getUserStatsAccountPublicKey()))
			) {
				tx.add(await this.getInitializeUserStatsIx());
			}
		}
		tx.add(initializeUserAccountIx).add(depositCollateralIx);

		const txSig = await this.program.provider.sendAndConfirm(tx, []);

		return [txSig, userAccountPublicKey];
	}

	public async withdraw(
		amount: BN,
		marketIndex: number,
		userTokenAccount: PublicKey,
		reduceOnly = false
	): Promise<TransactionSignature> {
		const tx = new Transaction();
		tx.add(
			ComputeBudgetProgram.requestUnits({
				units: 600_000,
				additionalFee: 0,
			})
		);

		const additionalSigners: Array<Signer> = [];

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);

		const authority = this.wallet.publicKey;

		const createWSOLTokenAccount =
			isSolMarket && userTokenAccount.equals(authority);

		if (createWSOLTokenAccount) {
			const { ixs, signers, pubkey } =
				await this.getWrappedSolAccountCreationIxs(amount, false);

			userTokenAccount = pubkey;

			ixs.forEach((ix) => {
				tx.add(ix);
			});

			signers.forEach((signer) => additionalSigners.push(signer));
		} else {
			const accountExists = await this.checkIfAccountExists(userTokenAccount);

			if (!accountExists) {
				const createAssociatedTokenAccountIx =
					this.getAssociatedTokenAccountCreationIx(
						spotMarketAccount.mint,
						userTokenAccount
					);

				tx.add(createAssociatedTokenAccountIx);
			}
		}

		const withdrawCollateral = await this.getWithdrawIx(
			amount,
			spotMarketAccount.marketIndex,
			userTokenAccount,
			reduceOnly
		);

		tx.add(withdrawCollateral);

		// Close the wrapped sol account at the end of the transaction
		if (createWSOLTokenAccount) {
			tx.add(
				Token.createCloseAccountInstruction(
					TOKEN_PROGRAM_ID,
					userTokenAccount,
					authority,
					authority,
					[]
				)
			);
		}

		const { txSig, slot } = await this.sendTransaction(
			tx,
			additionalSigners,
			this.opts
		);
		this.spotMarketLastSlotCache.set(marketIndex, slot);
		return txSig;
	}

	public async getWithdrawIx(
		amount: BN,
		marketIndex: number,
		userTokenAccount: PublicKey,
		reduceOnly = false
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [marketIndex],
			readableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		return await this.program.instruction.withdraw(
			marketIndex,
			amount,
			reduceOnly,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					spotMarketVault: spotMarketAccount.vault,
					driftSigner: this.getSignerPublicKey(),
					user: userAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					userTokenAccount: userTokenAccount,
					authority: this.wallet.publicKey,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts,
			}
		);
	}

	public async transferDeposit(
		amount: BN,
		marketIndex: number,
		fromSubAccountId: number,
		toSubAccountId: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			wrapInTx(
				await this.getTransferDepositIx(
					amount,
					marketIndex,
					fromSubAccountId,
					toSubAccountId
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		if (
			fromSubAccountId === this.activeSubAccountId ||
			toSubAccountId === this.activeSubAccountId
		) {
			this.spotMarketLastSlotCache.set(marketIndex, slot);
		}
		return txSig;
	}

	public async getTransferDepositIx(
		amount: BN,
		marketIndex: number,
		fromSubAccountId: number,
		toSubAccountId: number
	): Promise<TransactionInstruction> {
		const fromUser = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			fromSubAccountId
		);
		const toUser = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			toSubAccountId
		);

		let remainingAccounts;
		if (this.users.has(fromSubAccountId)) {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [this.users.get(fromSubAccountId).getUserAccount()],
				useMarketLastSlotCache: true,
				writableSpotMarketIndexes: [marketIndex],
			});
		} else {
			const userAccountPublicKey = getUserAccountPublicKeySync(
				this.program.programId,
				this.authority,
				fromSubAccountId
			);

			const fromUserAccount = (await this.program.account.user.fetch(
				userAccountPublicKey
			)) as UserAccount;
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [fromUserAccount],
				useMarketLastSlotCache: true,
				writableSpotMarketIndexes: [marketIndex],
			});
		}

		return await this.program.instruction.transferDeposit(marketIndex, amount, {
			accounts: {
				authority: this.wallet.publicKey,
				fromUser,
				toUser,
				userStats: this.getUserStatsAccountPublicKey(),
				state: await this.getStatePublicKey(),
				spotMarketVault: this.getSpotMarketAccount(marketIndex).vault,
			},
			remainingAccounts,
		});
	}

	public async updateSpotMarketCumulativeInterest(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.updateSpotMarketCumulativeInterestIx(marketIndex),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async updateSpotMarketCumulativeInterestIx(
		marketIndex: number
	): Promise<TransactionInstruction> {
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		return await this.program.instruction.updateSpotMarketCumulativeInterest({
			accounts: {
				state: await this.getStatePublicKey(),
				spotMarket: spotMarket.pubkey,
				oracle: spotMarket.oracle,
			},
		});
	}

	public async settleLP(
		settleeUserAccountPublicKey: PublicKey,
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.settleLPIx(settleeUserAccountPublicKey, marketIndex),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async settleLPIx(
		settleeUserAccountPublicKey: PublicKey,
		marketIndex: number
	): Promise<TransactionInstruction> {
		const settleeUserAccount = (await this.program.account.user.fetch(
			settleeUserAccountPublicKey
		)) as UserAccount;

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [settleeUserAccount],
			writablePerpMarketIndexes: [marketIndex],
		});

		return this.program.instruction.settleLp(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: settleeUserAccountPublicKey,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async removePerpLpShares(
		marketIndex: number,
		sharesToBurn?: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getRemovePerpLpSharesIx(marketIndex, sharesToBurn),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async removePerpLpSharesInExpiringMarket(
		marketIndex: number,
		userAccountPublicKey: PublicKey,
		sharesToBurn?: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getRemovePerpLpSharesInExpiringMarket(
					marketIndex,
					userAccountPublicKey,
					sharesToBurn
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getRemovePerpLpSharesInExpiringMarket(
		marketIndex: number,
		userAccountPublicKey: PublicKey,
		sharesToBurn?: BN
	): Promise<TransactionInstruction> {
		const userAccount = (await this.program.account.user.fetch(
			userAccountPublicKey
		)) as UserAccount;

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		if (sharesToBurn == undefined) {
			const perpPosition = userAccount.perpPositions.filter(
				(position) => position.marketIndex === marketIndex
			)[0];
			sharesToBurn = perpPosition.lpShares;
			console.log('burning lp shares:', sharesToBurn.toString());
		}

		return this.program.instruction.removePerpLpSharesInExpiringMarket(
			sharesToBurn,
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async getRemovePerpLpSharesIx(
		marketIndex: number,
		sharesToBurn?: BN
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		if (sharesToBurn == undefined) {
			const userAccount = this.getUserAccount();
			const perpPosition = userAccount.perpPositions.filter(
				(position) => position.marketIndex === marketIndex
			)[0];
			sharesToBurn = perpPosition.lpShares;
			console.log('burning lp shares:', sharesToBurn.toString());
		}

		return this.program.instruction.removePerpLpShares(
			sharesToBurn,
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async addPerpLpShares(
		amount: BN,
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			wrapInTx(
				await this.getAddPerpLpSharesIx(amount, marketIndex),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(marketIndex, slot);
		return txSig;
	}

	public async getAddPerpLpSharesIx(
		amount: BN,
		marketIndex: number
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		return this.program.instruction.addPerpLpShares(amount, marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async openPosition(
		direction: PositionDirection,
		amount: BN,
		marketIndex: number,
		limitPrice?: BN
	): Promise<TransactionSignature> {
		return await this.placeAndTakePerpOrder({
			orderType: OrderType.MARKET,
			marketIndex,
			direction,
			baseAssetAmount: amount,
			price: limitPrice,
		});
	}

	public async sendSignedTx(tx: Transaction): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			tx,
			undefined,
			this.opts,
			true
		);

		return txSig;
	}

	/**
	 * Sends a market order and returns a signed tx which can fill the order against the vamm, which the caller can use to fill their own order if required.
	 * @param orderParams
	 * @param userAccountPublicKey
	 * @param userAccount
	 * @param makerInfo
	 * @returns
	 */
	public async sendMarketOrderAndGetSignedFillTx(
		orderParams: OptionalOrderParams,
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		makerInfo?: MakerInfo,
		txParams?: TxParams
	): Promise<{ txSig: TransactionSignature; signedFillTx: Transaction }> {
		const marketIndex = orderParams.marketIndex;
		const orderId = userAccount.nextOrderId;

		const marketOrderTx = wrapInTx(
			await this.getPlacePerpOrderIx(orderParams),
			txParams?.computeUnits,
			txParams?.computeUnitsPrice
		);
		const fillTx = wrapInTx(
			await this.getFillPerpOrderIx(
				userAccountPublicKey,
				userAccount,
				{
					orderId,
					marketIndex,
				},
				makerInfo
			),
			txParams?.computeUnits,
			txParams?.computeUnitsPrice
		);

		// Apply the latest blockhash to the txs so that we can sign before sending them
		const currentBlockHash = (
			await this.connection.getLatestBlockhash('finalized')
		).blockhash;
		marketOrderTx.recentBlockhash = currentBlockHash;
		fillTx.recentBlockhash = currentBlockHash;

		marketOrderTx.feePayer = userAccount.authority;
		fillTx.feePayer = userAccount.authority;

		const [signedMarketOrderTx, signedFillTx] =
			await this.provider.wallet.signAllTransactions([marketOrderTx, fillTx]);

		const { txSig, slot } = await this.sendTransaction(
			signedMarketOrderTx,
			[],
			this.opts,
			true
		);

		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);

		return { txSig, signedFillTx };
	}

	public async placePerpOrder(
		orderParams: OptionalOrderParams,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			wrapInTx(
				await this.getPlacePerpOrderIx(orderParams),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);
		return txSig;
	}

	getOrderParams(
		optionalOrderParams: OptionalOrderParams,
		marketType: MarketType
	): OrderParams {
		return Object.assign({}, DefaultOrderParams, optionalOrderParams, {
			marketType,
		});
	}

	public async getPlacePerpOrderIx(
		orderParams: OptionalOrderParams
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams, MarketType.PERP);
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
			readablePerpMarketIndex: orderParams.marketIndex,
		});

		return await this.program.instruction.placePerpOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async updateAMMs(
		marketIndexes: number[],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getUpdateAMMsIx(marketIndexes),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateAMMsIx(
		marketIndexes: number[]
	): Promise<TransactionInstruction> {
		for (let i = marketIndexes.length; i < 5; i++) {
			marketIndexes.push(100);
		}
		const marketAccountInfos = [];
		const oracleAccountInfos = [];
		for (const marketIndex of marketIndexes) {
			if (marketIndex !== 100) {
				const market = this.getPerpMarketAccount(marketIndex);
				marketAccountInfos.push({
					pubkey: market.pubkey,
					isWritable: true,
					isSigner: false,
				});
				oracleAccountInfos.push({
					pubkey: market.amm.oracle,
					isWritable: false,
					isSigner: false,
				});
			}
		}
		const remainingAccounts = oracleAccountInfos.concat(marketAccountInfos);

		return await this.program.instruction.updateAmms(marketIndexes, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async settleExpiredMarket(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getSettleExpiredMarketIx(marketIndex),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettleExpiredMarketIx(
		marketIndex: number
	): Promise<TransactionInstruction> {
		const marketAccountInfos = [];
		const oracleAccountInfos = [];
		const spotMarketAccountInfos = [];
		const market = this.getPerpMarketAccount(marketIndex);
		marketAccountInfos.push({
			pubkey: market.pubkey,
			isWritable: true,
			isSigner: false,
		});
		oracleAccountInfos.push({
			pubkey: market.amm.oracle,
			isWritable: false,
			isSigner: false,
		});

		spotMarketAccountInfos.push({
			pubkey: this.getSpotMarketAccount(QUOTE_SPOT_MARKET_INDEX).pubkey,
			isSigner: false,
			isWritable: true,
		});

		const remainingAccounts = oracleAccountInfos
			.concat(spotMarketAccountInfos)
			.concat(marketAccountInfos);

		return await this.program.instruction.settleExpiredMarket(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async settleExpiredMarketPoolsToRevenuePool(
		perpMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		const spotMarketPublicKey = await getSpotMarketPublicKey(
			this.program.programId,
			QUOTE_SPOT_MARKET_INDEX
		);

		const ix =
			await this.program.instruction.settleExpiredMarketPoolsToRevenuePool({
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					spotMarket: spotMarketPublicKey,
					perpMarket: perpMarketPublicKey,
				},
			});

		const { txSig } = await this.sendTransaction(
			wrapInTx(ix, txParams?.computeUnits, txParams?.computeUnitsPrice),
			[],
			this.opts
		);

		return txSig;
	}

	public async cancelOrder(
		orderId?: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getCancelOrderIx(orderId),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrderIx(
		orderId?: number
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
		});

		return await this.program.instruction.cancelOrder(orderId ?? null, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async cancelOrderByUserId(
		userOrderId: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getCancelOrderByUserIdIx(userOrderId),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrderByUserIdIx(
		userOrderId: number
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const order = this.getOrderByUserId(userOrderId);
		const oracle = this.getPerpMarketAccount(order.marketIndex).amm.oracle;

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
		});

		return await this.program.instruction.cancelOrderByUserId(userOrderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				oracle,
			},
			remainingAccounts,
		});
	}

	public async cancelOrders(
		marketType?: MarketType,
		marketIndex?: number,
		direction?: PositionDirection,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getCancelOrdersIx(marketType, marketIndex, direction),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrdersIx(
		marketType: MarketType | null,
		marketIndex: number | null,
		direction: PositionDirection | null
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		let readablePerpMarketIndex = undefined;
		let readableSpotMarketIndexes = undefined;
		if (marketIndex) {
			if (marketType && isVariant(marketType, 'perp')) {
				readablePerpMarketIndex = marketIndex;
			} else if (marketType && isVariant(marketType, 'spot')) {
				readableSpotMarketIndexes = [marketIndex];
			}
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			readablePerpMarketIndex,
			readableSpotMarketIndexes,
			useMarketLastSlotCache: true,
		});

		return await this.program.instruction.cancelOrders(
			marketType ?? null,
			marketIndex ?? null,
			direction ?? null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async fillPerpOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order?: Pick<Order, 'marketIndex' | 'orderId'>,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getFillPerpOrderIx(
					userAccountPublicKey,
					user,
					order,
					makerInfo,
					referrerInfo
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getFillPerpOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order: Pick<Order, 'marketIndex' | 'orderId'>,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const fillerPublicKey = await this.getUserAccountPublicKey();
		const fillerStatsPublicKey = this.getUserStatsAccountPublicKey();

		const marketIndex = order
			? order.marketIndex
			: userAccount.orders.find(
					(order) => order.orderId === userAccount.nextOrderId - 1
			  ).marketIndex;

		const userAccounts = [userAccount];
		if (makerInfo !== undefined) {
			userAccounts.push(makerInfo.makerUserAccount);
		}
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			writablePerpMarketIndexes: [marketIndex],
		});

		if (makerInfo) {
			remainingAccounts.push({
				pubkey: makerInfo.maker,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: makerInfo.makerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		if (referrerInfo) {
			remainingAccounts.push({
				pubkey: referrerInfo.referrer,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: referrerInfo.referrerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		const orderId = order.orderId;
		const makerOrderId = makerInfo ? makerInfo.order.orderId : null;

		return await this.program.instruction.fillPerpOrder(orderId, makerOrderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				filler: fillerPublicKey,
				fillerStats: fillerStatsPublicKey,
				user: userAccountPublicKey,
				userStats: userStatsPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async placeSpotOrder(
		orderParams: OptionalOrderParams,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			wrapInTx(
				await this.getPlaceSpotOrderIx(orderParams),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		this.spotMarketLastSlotCache.set(orderParams.marketIndex, slot);
		this.spotMarketLastSlotCache.set(QUOTE_SPOT_MARKET_INDEX, slot);
		return txSig;
	}

	public async getPlaceSpotOrderIx(
		orderParams: OptionalOrderParams
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams, MarketType.SPOT);
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
			readableSpotMarketIndexes: [
				orderParams.marketIndex,
				QUOTE_SPOT_MARKET_INDEX,
			],
		});

		return await this.program.instruction.placeSpotOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async fillSpotOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order?: Order,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getFillSpotOrderIx(
					userAccountPublicKey,
					user,
					order,
					fulfillmentConfig,
					makerInfo,
					referrerInfo
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getFillSpotOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order?: Order,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const fillerPublicKey = await this.getUserAccountPublicKey();
		const fillerStatsPublicKey = this.getUserStatsAccountPublicKey();

		const marketIndex = order
			? order.marketIndex
			: userAccount.orders.find(
					(order) => order.orderId === userAccount.nextOrderId - 1
			  ).marketIndex;

		const userAccounts = [userAccount];
		if (makerInfo !== undefined) {
			userAccounts.push(makerInfo.makerUserAccount);
		}
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			writableSpotMarketIndexes: [marketIndex, QUOTE_SPOT_MARKET_INDEX],
		});

		if (makerInfo) {
			remainingAccounts.push({
				pubkey: makerInfo.maker,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: makerInfo.makerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		if (referrerInfo) {
			remainingAccounts.push({
				pubkey: referrerInfo.referrer,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: referrerInfo.referrerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		const orderId = order.orderId;
		const makerOrderId = makerInfo ? makerInfo.order.orderId : null;

		this.addSpotFulfillmentAccounts(
			marketIndex,
			remainingAccounts,
			fulfillmentConfig
		);

		return await this.program.instruction.fillSpotOrder(
			orderId,
			fulfillmentConfig ? fulfillmentConfig.fulfillmentType : null,
			makerOrderId,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					filler: fillerPublicKey,
					fillerStats: fillerStatsPublicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	addSpotFulfillmentAccounts(
		marketIndex: number,
		remainingAccounts: AccountMeta[],
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount
	) {
		if (fulfillmentConfig) {
			this.addSerumRemainingAccounts(
				marketIndex,
				remainingAccounts,
				fulfillmentConfig
			);
		} else {
			remainingAccounts.push({
				pubkey: this.getSpotMarketAccount(marketIndex).vault,
				isWritable: false,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: this.getQuoteSpotMarketAccount().vault,
				isWritable: false,
				isSigner: false,
			});
		}
	}

	addSerumRemainingAccounts(
		marketIndex: number,
		remainingAccounts: AccountMeta[],
		fulfillmentConfig: SerumV3FulfillmentConfigAccount
	) {
		remainingAccounts.push({
			pubkey: fulfillmentConfig.pubkey,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumProgramId,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumMarket,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumRequestQueue,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumEventQueue,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumBids,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumAsks,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumBaseVault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumQuoteVault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumOpenOrders,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: getSerumSignerPublicKey(
				fulfillmentConfig.serumProgramId,
				fulfillmentConfig.serumMarket,
				fulfillmentConfig.serumSignerNonce
			),
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getSignerPublicKey(),
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: TOKEN_PROGRAM_ID,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getSpotMarketAccount(marketIndex).vault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getQuoteSpotMarketAccount().vault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getStateAccount().srmVault,
			isWritable: false,
			isSigner: false,
		});
	}

	public async triggerOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order: Order,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getTriggerOrderIx(userAccountPublicKey, user, order),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getTriggerOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order: Order
	): Promise<TransactionInstruction> {
		const fillerPublicKey = await this.getUserAccountPublicKey();

		let remainingAccountsParams;
		if (isVariant(order.marketType, 'perp')) {
			remainingAccountsParams = {
				userAccounts: [userAccount],
				writablePerpMarketIndexes: [order.marketIndex],
			};
		} else {
			remainingAccountsParams = {
				userAccounts: [userAccount],
				writableSpotMarketIndexes: [order.marketIndex, QUOTE_SPOT_MARKET_INDEX],
			};
		}

		const remainingAccounts = this.getRemainingAccounts(
			remainingAccountsParams
		);

		const orderId = order.orderId;
		return await this.program.instruction.triggerOrder(orderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				filler: fillerPublicKey,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async forceCancelOrders(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getForceCancelOrdersIx(userAccountPublicKey, user),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getForceCancelOrdersIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount
	): Promise<TransactionInstruction> {
		const fillerPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		return await this.program.instruction.forceCancelOrders({
			accounts: {
				state: await this.getStatePublicKey(),
				filler: fillerPublicKey,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async placeAndTakePerpOrder(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			wrapInTx(
				await this.getPlaceAndTakePerpOrderIx(
					orderParams,
					makerInfo,
					referrerInfo
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);
		return txSig;
	}

	public async getPlaceAndTakePerpOrderIx(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams, MarketType.PERP);
		const userStatsPublicKey = await this.getUserStatsAccountPublicKey();
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const userAccounts = [this.getUserAccount()];
		if (makerInfo !== undefined) {
			userAccounts.push(makerInfo.makerUserAccount);
		}
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [orderParams.marketIndex],
		});

		let makerOrderId = null;
		if (makerInfo) {
			makerOrderId = makerInfo.order.orderId;
			remainingAccounts.push({
				pubkey: makerInfo.maker,
				isSigner: false,
				isWritable: true,
			});
			remainingAccounts.push({
				pubkey: makerInfo.makerStats,
				isSigner: false,
				isWritable: true,
			});
		}

		if (referrerInfo) {
			remainingAccounts.push({
				pubkey: referrerInfo.referrer,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: referrerInfo.referrerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		return await this.program.instruction.placeAndTakePerpOrder(
			orderParams,
			makerOrderId,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async placeAndMakePerpOrder(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			wrapInTx(
				await this.getPlaceAndMakePerpOrderIx(
					orderParams,
					takerInfo,
					referrerInfo
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);

		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);

		return txSig;
	}

	public async getPlaceAndMakePerpOrderIx(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		referrerInfo?: ReferrerInfo
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams, MarketType.PERP);
		const userStatsPublicKey = this.getUserStatsAccountPublicKey();
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(), takerInfo.takerUserAccount],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [orderParams.marketIndex],
		});

		if (referrerInfo) {
			remainingAccounts.push({
				pubkey: referrerInfo.referrer,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: referrerInfo.referrerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		const takerOrderId = takerInfo.order.orderId;
		return await this.program.instruction.placeAndMakePerpOrder(
			orderParams,
			takerOrderId,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					taker: takerInfo.taker,
					takerStats: takerInfo.takerStats,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async placeAndTakeSpotOrder(
		orderParams: OptionalOrderParams,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			wrapInTx(
				await this.getPlaceAndTakeSpotOrderIx(
					orderParams,
					fulfillmentConfig,
					makerInfo,
					referrerInfo
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		this.spotMarketLastSlotCache.set(orderParams.marketIndex, slot);
		this.spotMarketLastSlotCache.set(QUOTE_SPOT_MARKET_INDEX, slot);
		return txSig;
	}

	public async getPlaceAndTakeSpotOrderIx(
		orderParams: OptionalOrderParams,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams, MarketType.SPOT);
		const userStatsPublicKey = await this.getUserStatsAccountPublicKey();
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const userAccounts = [this.getUserAccount()];
		if (makerInfo !== undefined) {
			userAccounts.push(makerInfo.makerUserAccount);
		}
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [
				orderParams.marketIndex,
				QUOTE_SPOT_MARKET_INDEX,
			],
		});

		let makerOrderId = null;
		if (makerInfo) {
			makerOrderId = makerInfo.order.orderId;
			remainingAccounts.push({
				pubkey: makerInfo.maker,
				isSigner: false,
				isWritable: true,
			});
			remainingAccounts.push({
				pubkey: makerInfo.makerStats,
				isSigner: false,
				isWritable: true,
			});
		}

		if (referrerInfo) {
			remainingAccounts.push({
				pubkey: referrerInfo.referrer,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: referrerInfo.referrerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		this.addSpotFulfillmentAccounts(
			orderParams.marketIndex,
			remainingAccounts,
			fulfillmentConfig
		);

		return await this.program.instruction.placeAndTakeSpotOrder(
			orderParams,
			fulfillmentConfig ? fulfillmentConfig.fulfillmentType : null,
			makerOrderId,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async placeAndMakeSpotOrder(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			wrapInTx(
				await this.getPlaceAndMakeSpotOrderIx(
					orderParams,
					takerInfo,
					fulfillmentConfig,
					referrerInfo
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		this.spotMarketLastSlotCache.set(orderParams.marketIndex, slot);
		this.spotMarketLastSlotCache.set(QUOTE_SPOT_MARKET_INDEX, slot);
		return txSig;
	}

	public async getPlaceAndMakeSpotOrderIx(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		referrerInfo?: ReferrerInfo
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams, MarketType.SPOT);
		const userStatsPublicKey = this.getUserStatsAccountPublicKey();
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(), takerInfo.takerUserAccount],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [
				orderParams.marketIndex,
				QUOTE_SPOT_MARKET_INDEX,
			],
		});

		if (referrerInfo) {
			remainingAccounts.push({
				pubkey: referrerInfo.referrer,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: referrerInfo.referrerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		this.addSpotFulfillmentAccounts(
			orderParams.marketIndex,
			remainingAccounts,
			fulfillmentConfig
		);

		const takerOrderId = takerInfo.order.orderId;
		return await this.program.instruction.placeAndMakeSpotOrder(
			orderParams,
			takerOrderId,
			fulfillmentConfig ? fulfillmentConfig.fulfillmentType : null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					taker: takerInfo.taker,
					takerStats: takerInfo.takerStats,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	/**
	 * Close an entire position. If you want to reduce a position, use the {@link openPosition} method in the opposite direction of the current position.
	 * @param marketIndex
	 * @returns
	 */
	public async closePosition(
		marketIndex: number,
		limitPrice?: BN
	): Promise<TransactionSignature> {
		const userPosition = this.getUser().getPerpPosition(marketIndex);
		if (!userPosition) {
			throw Error(`No position in market ${marketIndex.toString()}`);
		}

		return await this.placeAndTakePerpOrder({
			orderType: OrderType.MARKET,
			marketIndex,
			direction: findDirectionToClose(userPosition),
			baseAssetAmount: userPosition.baseAssetAmount.abs(),
			reduceOnly: true,
			price: limitPrice,
		});
	}

	/**
	 * Modifies an open order by closing it and replacing it with a new order.
	 * @deprecated use modifyOrder instead
	 * @param orderId: The open order to modify
	 * @param newBaseAmount: The new base amount for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newLimitPice: The new limit price for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newOraclePriceOffset: The new oracle price offset for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @returns
	 */
	public async modifyPerpOrder(
		orderId: number,
		newBaseAmount?: BN,
		newLimitPrice?: BN,
		newOraclePriceOffset?: number
	): Promise<TransactionSignature> {
		return this.modifyOrder({
			orderId,
			newBaseAmount,
			newLimitPrice,
			newOraclePriceOffset,
		});
	}

	/**
	 * Modifies an open order by closing it and replacing it with a new order.
	 * @deprecated use modifyOrderByUserOrderId instead
	 * @param userOrderId: The open order to modify
	 * @param newBaseAmount: The new base amount for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newLimitPice: The new limit price for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newOraclePriceOffset: The new oracle price offset for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @returns
	 */
	public async modifyPerpOrderByUserOrderId(
		userOrderId: number,
		newBaseAmount?: BN,
		newLimitPrice?: BN,
		newOraclePriceOffset?: number
	): Promise<TransactionSignature> {
		return this.modifyOrderByUserOrderId({
			userOrderId,
			newBaseAmount,
			newLimitPrice,
			newOraclePriceOffset,
		});
	}

	/**
	 * Modifies an open order (spot or perp) by closing it and replacing it with a new order.
	 * @param orderId: The open order to modify
	 * @param newBaseAmount: The new base amount for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newLimitPice: The new limit price for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newOraclePriceOffset: The new oracle price offset for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newOrderType: Optional - New order type for the order.
	 * @param newTriggerPrice: Optional - Thew new trigger price for the order.
	 * @param isSpot: Optional - Set to true if the order is a spot order
	 * @param auctionDuration: Only required if order type changed to market from something else
	 * @param auctionStartPrice: Only required if order type changed to market from something else
	 * @param auctionEndPrice: Only required if order type changed to market from something else
	 * @returns
	 */
	public async modifyOrder({
		orderId,
		newBaseAmount,
		newLimitPrice,
		newOraclePriceOffset,
		newOrderType,
		newTriggerPrice,
		newTriggerCondition,
		isSpot,
		auctionDuration,
		auctionStartPrice,
		auctionEndPrice,
	}: {
		orderId: number;
		newBaseAmount?: BN;
		newLimitPrice?: BN;
		newOraclePriceOffset?: number;
		newOrderType?: OrderType;
		newTriggerPrice?: BN;
		newTriggerCondition?: OrderTriggerCondition;
		isSpot?: boolean;
		auctionDuration?: number;
		auctionStartPrice?: BN;
		auctionEndPrice?: BN;
	}): Promise<TransactionSignature> {
		if (!newBaseAmount && !newLimitPrice && !newOraclePriceOffset) {
			throw new Error(
				`Must provide newBaseAmount or newLimitPrice or newOraclePriceOffset to modify order`
			);
		}

		const openOrder = this.getUser().getOrder(orderId);
		if (!openOrder) {
			throw new Error(`No open order with id ${orderId.toString()}`);
		}
		const cancelOrderIx = await this.getCancelOrderIx(orderId);

		const orderTypeHasTrigger = newOrderType
			? isOneOfVariant(newOrderType, ['triggerlimit', 'triggerMarket'])
			: isOneOfVariant(openOrder.orderType, ['triggerLimit', 'triggerMarket']);
		const orderTypeHasLimitPrice = newOrderType
			? isOneOfVariant(newOrderType, ['triggerLimit', 'limit'])
			: isOneOfVariant(openOrder.orderType, ['triggerLimit', 'limit']);

		const newOrderParams: OptionalOrderParams = {
			orderType: newOrderType || openOrder.orderType,
			marketType: openOrder.marketType,
			direction: openOrder.direction,
			baseAssetAmount: newBaseAmount || openOrder.baseAssetAmount,
			price: orderTypeHasLimitPrice
				? newLimitPrice || openOrder.price
				: undefined,
			marketIndex: openOrder.marketIndex,
			reduceOnly: openOrder.reduceOnly,
			postOnly: openOrder.postOnly,
			immediateOrCancel: openOrder.immediateOrCancel,
			triggerPrice: orderTypeHasTrigger
				? newTriggerPrice || openOrder.triggerPrice
				: undefined,
			triggerCondition: orderTypeHasTrigger
				? newTriggerCondition || openOrder.triggerCondition
				: undefined,
			oraclePriceOffset: newOraclePriceOffset || openOrder.oraclePriceOffset,
			auctionDuration: auctionDuration || openOrder.auctionDuration,
			maxTs: openOrder.maxTs,
			auctionStartPrice: auctionStartPrice || openOrder.auctionStartPrice,
			auctionEndPrice: auctionEndPrice || openOrder.auctionEndPrice,
			userOrderId: openOrder.userOrderId,
		};
		const placeOrderIx = isSpot
			? await this.getPlaceSpotOrderIx(newOrderParams)
			: await this.getPlacePerpOrderIx(newOrderParams);

		const tx = new Transaction();
		tx.add(
			ComputeBudgetProgram.requestUnits({
				units: 1_000_000,
				additionalFee: 0,
			})
		);
		tx.add(cancelOrderIx);
		tx.add(placeOrderIx);
		const { txSig, slot } = await this.sendTransaction(tx, [], this.opts);

		if (isSpot) {
			this.spotMarketLastSlotCache.set(newOrderParams.marketIndex, slot);
			this.spotMarketLastSlotCache.set(QUOTE_SPOT_MARKET_INDEX, slot);
		} else {
			this.perpMarketLastSlotCache.set(newOrderParams.marketIndex, slot);
		}

		return txSig;
	}

	/**
	 * Modifies an open order by closing it and replacing it with a new order.
	 * @param userOrderId: The open order to modify
	 * @param newBaseAmount: The new base amount for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newLimitPice: The new limit price for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newOraclePriceOffset: The new oracle price offset for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newOrderType: Optional - New order type for the order.
	 * @param newTriggerPrice: Optional - Thew new trigger price for the order.
	 * @param isSpot: Set to true if the order is a spot order
	 * @param auctionDuration: Only required if order type changed to market from something else
	 * @param auctionStartPrice: Only required if order type changed to market from something else
	 * @param auctionEndPrice: Only required if order type changed to market from something else
	 * @returns
	 */
	public async modifyOrderByUserOrderId({
		userOrderId,
		newBaseAmount,
		newLimitPrice,
		newOraclePriceOffset,
		newOrderType,
		newTriggerPrice,
		newTriggerCondition,
		isSpot,
		auctionDuration,
		auctionStartPrice,
		auctionEndPrice,
	}: {
		userOrderId: number;
		newBaseAmount?: BN;
		newLimitPrice?: BN;
		newOraclePriceOffset?: number;
		newOrderType?: OrderType;
		newTriggerPrice?: BN;
		newTriggerCondition?: OrderTriggerCondition;
		isSpot?: boolean;
		auctionDuration?: number;
		auctionStartPrice?: BN;
		auctionEndPrice?: BN;
	}): Promise<TransactionSignature> {
		if (!newBaseAmount && !newLimitPrice && !newOraclePriceOffset) {
			throw new Error(
				`Must provide newBaseAmount or newLimitPrice or newOraclePriceOffset to modify order`
			);
		}

		const openOrder = this.getUser().getOrderByUserOrderId(userOrderId);
		if (!openOrder) {
			throw new Error(
				`No open order with user order id ${userOrderId.toString()}`
			);
		}
		const cancelOrderIx = await this.getCancelOrderByUserIdIx(userOrderId);

		const orderTypeHasTrigger = newOrderType
			? isOneOfVariant(newOrderType, ['triggerlimit', 'triggerMarket'])
			: isOneOfVariant(openOrder.orderType, ['triggerLimit', 'triggerMarket']);
		const orderTypeHasLimitPrice = newOrderType
			? isOneOfVariant(newOrderType, ['triggerLimit', 'limit'])
			: isOneOfVariant(openOrder.orderType, ['triggerLimit', 'limit']);

		const newOrderParams: OptionalOrderParams = {
			orderType: newOrderType || openOrder.orderType,
			marketType: openOrder.marketType,
			direction: openOrder.direction,
			baseAssetAmount: newBaseAmount || openOrder.baseAssetAmount,
			price: orderTypeHasLimitPrice
				? newLimitPrice || openOrder.price
				: undefined,
			marketIndex: openOrder.marketIndex,
			reduceOnly: openOrder.reduceOnly,
			postOnly: openOrder.postOnly,
			immediateOrCancel: openOrder.immediateOrCancel,
			triggerPrice: orderTypeHasTrigger
				? newTriggerPrice || openOrder.triggerPrice
				: undefined,
			triggerCondition: orderTypeHasTrigger
				? newTriggerCondition || openOrder.triggerCondition
				: undefined,
			oraclePriceOffset: newOraclePriceOffset || openOrder.oraclePriceOffset,
			auctionDuration: auctionDuration || openOrder.auctionDuration,
			maxTs: openOrder.maxTs,
			auctionStartPrice: auctionStartPrice || openOrder.auctionStartPrice,
			auctionEndPrice: auctionEndPrice || openOrder.auctionEndPrice,
			userOrderId: openOrder.userOrderId,
		};
		const placeOrderIx = isSpot
			? await this.getPlaceSpotOrderIx(newOrderParams)
			: await this.getPlacePerpOrderIx(newOrderParams);

		const tx = new Transaction();
		tx.add(
			ComputeBudgetProgram.requestUnits({
				units: 1_000_000,
				additionalFee: 0,
			})
		);
		tx.add(cancelOrderIx);
		tx.add(placeOrderIx);
		const { txSig, slot } = await this.sendTransaction(tx, [], this.opts);

		if (isSpot) {
			this.spotMarketLastSlotCache.set(newOrderParams.marketIndex, slot);
			this.spotMarketLastSlotCache.set(QUOTE_SPOT_MARKET_INDEX, slot);
		} else {
			this.perpMarketLastSlotCache.set(newOrderParams.marketIndex, slot);
		}

		return txSig;
	}

	public async settlePNLs(
		users: {
			settleeUserAccountPublicKey: PublicKey;
			settleeUserAccount: UserAccount;
		}[],
		marketIndex: number
	): Promise<TransactionSignature> {
		const ixs = [];
		for (const { settleeUserAccountPublicKey, settleeUserAccount } of users) {
			ixs.push(
				await this.settlePNLIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketIndex
				)
			);
		}

		const tx = new Transaction()
			.add(
				ComputeBudgetProgram.requestUnits({
					units: 1_000_000,
					additionalFee: 0,
				})
			)
			.add(...ixs);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async settlePNL(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.settlePNLIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketIndex
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async settlePNLIx(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: number
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [settleeUserAccount],
			writablePerpMarketIndexes: [marketIndex],
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		return await this.program.instruction.settlePnl(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: settleeUserAccountPublicKey,
				spotMarketVault: this.getQuoteSpotMarketAccount().vault,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async liquidatePerp(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		maxBaseAssetAmount: BN,
		limitPrice?: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			wrapInTx(
				await this.getLiquidatePerpIx(
					userAccountPublicKey,
					userAccount,
					marketIndex,
					maxBaseAssetAmount,
					limitPrice
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(marketIndex, slot);
		return txSig;
	}

	public async getLiquidatePerpIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		maxBaseAssetAmount: BN,
		limitPrice?: BN
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidatorPublicKey = await this.getUserAccountPublicKey();
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(), userAccount],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		return await this.program.instruction.liquidatePerp(
			marketIndex,
			maxBaseAssetAmount,
			limitPrice ?? null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					liquidator: liquidatorPublicKey,
					liquidatorStats: liquidatorStatsPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidateSpot(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		assetMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			wrapInTx(
				await this.getLiquidateSpotIx(
					userAccountPublicKey,
					userAccount,
					assetMarketIndex,
					liabilityMarketIndex,
					maxLiabilityTransfer,
					limitPrice
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		this.spotMarketLastSlotCache.set(assetMarketIndex, slot);
		this.spotMarketLastSlotCache.set(liabilityMarketIndex, slot);
		return txSig;
	}

	public async getLiquidateSpotIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		assetMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidatorPublicKey = await this.getUserAccountPublicKey();
		const liquidatorStatsPublicKey = await this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(), userAccount],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [liabilityMarketIndex, assetMarketIndex],
		});

		return await this.program.instruction.liquidateSpot(
			assetMarketIndex,
			liabilityMarketIndex,
			maxLiabilityTransfer,
			limitPrice || null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					liquidator: liquidatorPublicKey,
					liquidatorStats: liquidatorStatsPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidateBorrowForPerpPnl(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			wrapInTx(
				await this.getLiquidateBorrowForPerpPnlIx(
					userAccountPublicKey,
					userAccount,
					perpMarketIndex,
					liabilityMarketIndex,
					maxLiabilityTransfer,
					limitPrice
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(perpMarketIndex, slot);
		this.spotMarketLastSlotCache.set(liabilityMarketIndex, slot);
		return txSig;
	}

	public async getLiquidateBorrowForPerpPnlIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidatorPublicKey = await this.getUserAccountPublicKey();
		const liquidatorStatsPublicKey = await this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(), userAccount],
			writablePerpMarketIndexes: [perpMarketIndex],
			writableSpotMarketIndexes: [liabilityMarketIndex],
		});

		return await this.program.instruction.liquidateBorrowForPerpPnl(
			perpMarketIndex,
			liabilityMarketIndex,
			maxLiabilityTransfer,
			limitPrice || null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					liquidator: liquidatorPublicKey,
					liquidatorStats: liquidatorStatsPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidatePerpPnlForDeposit(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		assetMarketIndex: number,
		maxPnlTransfer: BN,
		limitPrice?: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			wrapInTx(
				await this.getLiquidatePerpPnlForDepositIx(
					userAccountPublicKey,
					userAccount,
					perpMarketIndex,
					assetMarketIndex,
					maxPnlTransfer,
					limitPrice
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(perpMarketIndex, slot);
		this.spotMarketLastSlotCache.set(assetMarketIndex, slot);
		return txSig;
	}

	public async getLiquidatePerpPnlForDepositIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		assetMarketIndex: number,
		maxPnlTransfer: BN,
		limitPrice?: BN
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidatorPublicKey = await this.getUserAccountPublicKey();
		const liquidatorStatsPublicKey = await this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(), userAccount],
			writablePerpMarketIndexes: [perpMarketIndex],
			writableSpotMarketIndexes: [assetMarketIndex],
		});

		return await this.program.instruction.liquidatePerpPnlForDeposit(
			perpMarketIndex,
			assetMarketIndex,
			maxPnlTransfer,
			limitPrice || null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					liquidator: liquidatorPublicKey,
					liquidatorStats: liquidatorStatsPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async resolvePerpBankruptcy(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getResolvePerpBankruptcyIx(
					userAccountPublicKey,
					userAccount,
					marketIndex
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getResolvePerpBankruptcyIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidatorPublicKey = await this.getUserAccountPublicKey();
		const liquidatorStatsPublicKey = await this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(), userAccount],
			writablePerpMarketIndexes: [marketIndex],
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		const spotMarket = this.getSpotMarketAccount(marketIndex);

		return await this.program.instruction.resolvePerpBankruptcy(
			QUOTE_SPOT_MARKET_INDEX,
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					liquidator: liquidatorPublicKey,
					liquidatorStats: liquidatorStatsPublicKey,
					spotMarketVault: spotMarket.vault,
					insuranceFundVault: spotMarket.insuranceFund.vault,
					driftSigner: this.getSignerPublicKey(),
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async resolveSpotBankruptcy(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getResolveSpotBankruptcyIx(
					userAccountPublicKey,
					userAccount,
					marketIndex
				),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getResolveSpotBankruptcyIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidatorPublicKey = await this.getUserAccountPublicKey();
		const liquidatorStatsPublicKey = await this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(), userAccount],
			writableSpotMarketIndexes: [marketIndex],
		});

		const spotMarket = this.getSpotMarketAccount(marketIndex);

		return await this.program.instruction.resolveSpotBankruptcy(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: userAccountPublicKey,
				userStats: userStatsPublicKey,
				liquidatorStats: liquidatorStatsPublicKey,
				liquidator: liquidatorPublicKey,
				spotMarketVault: spotMarket.vault,
				insuranceFundVault: spotMarket.insuranceFund.vault,
				driftSigner: this.getSignerPublicKey(),
				tokenProgram: TOKEN_PROGRAM_ID,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async updateFundingRate(
		perpMarketIndex: number,
		oracle: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getUpdateFundingRateIx(perpMarketIndex, oracle),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateFundingRateIx(
		perpMarketIndex: number,
		oracle: PublicKey
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);
		return await this.program.instruction.updateFundingRate(perpMarketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				perpMarket: perpMarketPublicKey,
				oracle: oracle,
			},
		});
	}

	public async settleFundingPayment(
		userAccountPublicKey: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getSettleFundingPaymentIx(userAccountPublicKey),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettleFundingPaymentIx(
		userAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const userAccount = (await this.program.account.user.fetch(
			userAccountPublicKey
		)) as UserAccount;

		const writablePerpMarketIndexes = [];
		for (const position of userAccount.perpPositions) {
			if (!positionIsAvailable(position)) {
				writablePerpMarketIndexes.push(position.marketIndex);
			}
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
			writablePerpMarketIndexes,
		});

		return await this.program.instruction.settleFundingPayment({
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
			},
			remainingAccounts,
		});
	}

	public triggerEvent(eventName: keyof DriftClientAccountEvents, data?: any) {
		this.eventEmitter.emit(eventName, data);
	}

	public getOracleDataForPerpMarket(marketIndex: number): OraclePriceData {
		const oracleKey = this.getPerpMarketAccount(marketIndex).amm.oracle;
		const oracleData = this.getOraclePriceDataAndSlot(oracleKey).data;

		return oracleData;
	}

	public getOracleDataForSpotMarket(marketIndex: number): OraclePriceData {
		const oracleKey = this.getSpotMarketAccount(marketIndex).oracle;
		const oracleData = this.getOraclePriceDataAndSlot(oracleKey).data;

		return oracleData;
	}

	public async initializeInsuranceFundStake(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getInitializeInsuranceFundStakeIx(marketIndex),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getInitializeInsuranceFundStakeIx(
		marketIndex: number
	): Promise<TransactionInstruction> {
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		return await this.program.instruction.initializeInsuranceFundStake(
			marketIndex,
			{
				accounts: {
					insuranceFundStake: ifStakeAccountPublicKey,
					spotMarket: this.getSpotMarketAccount(marketIndex).pubkey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					payer: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async addInsuranceFundStake(
		marketIndex: number,
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [marketIndex],
		});

		const tx = await this.program.transaction.addInsuranceFundStake(
			marketIndex,
			amount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarket.pubkey,
					insuranceFundStake: ifStakeAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					spotMarketVault: spotMarket.vault,
					insuranceFundVault: spotMarket.insuranceFund.vault,
					driftSigner: this.getSignerPublicKey(),
					userTokenAccount: collateralAccountPublicKey,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts,
			}
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async requestRemoveInsuranceFundStake(
		marketIndex: number,
		amount: BN
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [marketIndex],
		});

		const tx = await this.program.transaction.requestRemoveInsuranceFundStake(
			marketIndex,
			amount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					insuranceFundStake: ifStakeAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					insuranceFundVault: spotMarketAccount.insuranceFund.vault,
				},
				remainingAccounts,
			}
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async cancelRequestRemoveInsuranceFundStake(
		marketIndex: number
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [marketIndex],
		});

		const tx =
			await this.program.transaction.cancelRequestRemoveInsuranceFundStake(
				marketIndex,
				{
					accounts: {
						state: await this.getStatePublicKey(),
						spotMarket: spotMarketAccount.pubkey,
						insuranceFundStake: ifStakeAccountPublicKey,
						userStats: this.getUserStatsAccountPublicKey(),
						authority: this.wallet.publicKey,
						insuranceFundVault: spotMarketAccount.insuranceFund.vault,
					},
					remainingAccounts,
				}
			);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async removeInsuranceFundStake(
		marketIndex: number,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [marketIndex],
		});

		const tx = await this.program.transaction.removeInsuranceFundStake(
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					insuranceFundStake: ifStakeAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					insuranceFundVault: spotMarketAccount.insuranceFund.vault,
					driftSigner: this.getSignerPublicKey(),
					userTokenAccount: collateralAccountPublicKey,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts,
			}
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async settleRevenueToInsuranceFund(
		marketIndex: number
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [marketIndex],
		});

		const tx = await this.program.transaction.settleRevenueToInsuranceFund(
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					spotMarketVault: spotMarketAccount.vault,
					driftSigner: this.getSignerPublicKey(),
					insuranceFundVault: spotMarketAccount.insuranceFund.vault,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts,
			}
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async resolvePerpPnlDeficit(
		spotMarketIndex: number,
		perpMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			wrapInTx(
				await this.getResolvePerpPnlDeficitIx(spotMarketIndex, perpMarketIndex),
				txParams?.computeUnits,
				txParams?.computeUnitsPrice
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getResolvePerpPnlDeficitIx(
		spotMarketIndex: number,
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [perpMarketIndex],
			writableSpotMarketIndexes: [spotMarketIndex],
		});

		const spotMarket = this.getSpotMarketAccount(spotMarketIndex);

		return await this.program.instruction.resolvePerpPnlDeficit(
			spotMarketIndex,
			perpMarketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					spotMarketVault: spotMarket.vault,
					insuranceFundVault: spotMarket.insuranceFund.vault,
					driftSigner: this.getSignerPublicKey(),
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	sendTransaction(
		tx: Transaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot> {
		return this.txSender.send(tx, additionalSigners, opts, preSigned);
	}
}
