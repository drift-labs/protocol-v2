import { AnchorProvider, BN, Idl, Program } from '@project-serum/anchor';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
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
	SerumV3FulfillmentConfigAccount,
} from './types';
import * as anchor from '@project-serum/anchor';
import clearingHouseIDL from './idl/clearing_house.json';

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
} from '@solana/web3.js';

import { TokenFaucet } from './tokenFaucet';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	getClearingHouseSignerPublicKey,
	getClearingHouseStateAccountPublicKey,
	getInsuranceFundStakeAccountPublicKey,
	getMarketPublicKey,
	getSerumFulfillmentConfigPublicKey,
	getSerumSignerPublicKey,
	getUserAccountPublicKey,
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
} from './addresses/pda';
import {
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
	DataAndSlot,
} from './accounts/types';
import { TxSender } from './tx/types';
import { wrapInTx } from './tx/utils';
import {
	ONE,
	QUOTE_SPOT_MARKET_INDEX,
	ZERO,
} from './constants/numericConstants';
import { findDirectionToClose, positionIsAvailable } from './math/position';
import { getTokenAmount } from './math/spotBalance';
import { DEFAULT_USER_NAME, encodeName } from './userName';
import { OraclePriceData } from './oracles/types';
import { ClearingHouseConfig } from './clearingHouseConfig';
import { PollingClearingHouseAccountSubscriber } from './accounts/pollingClearingHouseAccountSubscriber';
import { WebSocketClearingHouseAccountSubscriber } from './accounts/webSocketClearingHouseAccountSubscriber';
import { RetryTxSender } from './tx/retryTxSender';
import { ClearingHouseUser } from './clearingHouseUser';
import { ClearingHouseUserAccountSubscriptionConfig } from './clearingHouseUserConfig';
import { getMarketsAndOraclesForSubscription } from './config';
import { WRAPPED_SOL_MINT } from './constants/spotMarkets';
import { ClearingHouseUserStats } from './clearingHouseUserStats';
import { isSpotPositionAvailable } from './math/spotPosition';

/**
 * # ClearingHouse
 * This class is the main way to interact with Drift Protocol. It allows you to subscribe to the various accounts where the Market's state is stored, as well as: opening positions, liquidating, settling funding, depositing & withdrawing, and more.
 */
export class ClearingHouse {
	connection: Connection;
	wallet: IWallet;
	public program: Program;
	provider: AnchorProvider;
	opts?: ConfirmOptions;
	users = new Map<number, ClearingHouseUser>();
	userStats?: ClearingHouseUserStats;
	activeUserId: number;
	userAccountSubscriptionConfig: ClearingHouseUserAccountSubscriptionConfig;
	accountSubscriber: ClearingHouseAccountSubscriber;
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	_isSubscribed = false;
	txSender: TxSender;
	marketLastSlotCache = new Map<number, number>();

	public get isSubscribed() {
		return this._isSubscribed && this.accountSubscriber.isSubscribed;
	}

	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	public constructor(config: ClearingHouseConfig) {
		this.connection = config.connection;
		this.wallet = config.wallet;
		this.opts = config.opts || AnchorProvider.defaultOptions();
		this.provider = new AnchorProvider(
			config.connection,
			config.wallet,
			this.opts
		);
		this.program = new Program(
			clearingHouseIDL as Idl,
			config.programID,
			this.provider
		);

		const userIds = config.userIds ?? [0];
		this.activeUserId = config.activeUserId ?? userIds[0];
		this.userAccountSubscriptionConfig =
			config.accountSubscription?.type === 'polling'
				? {
						type: 'polling',
						accountLoader: config.accountSubscription.accountLoader,
				  }
				: {
						type: 'websocket',
				  };
		this.createUsers(userIds, this.userAccountSubscriptionConfig);
		if (config.userStats) {
			this.userStats = new ClearingHouseUserStats({
				clearingHouse: this,
				userStatsAccountPublicKey: getUserStatsAccountPublicKey(
					this.program.programId,
					this.wallet.publicKey
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
				oracleInfos: envOralceInfos,
			} = getMarketsAndOraclesForSubscription(config.env);
			perpMarketIndexes = perpMarketIndexes
				? perpMarketIndexes
				: envPerpMarketIndexes;
			spotMarketIndexes = spotMarketIndexes
				? spotMarketIndexes
				: envSpotMarketIndexes;
			oracleInfos = oracleInfos ? oracleInfos : envOralceInfos;
		}

		if (config.accountSubscription?.type === 'polling') {
			this.accountSubscriber = new PollingClearingHouseAccountSubscriber(
				this.program,
				config.accountSubscription.accountLoader,
				perpMarketIndexes ?? [],
				spotMarketIndexes ?? [],
				oracleInfos ?? []
			);
		} else {
			this.accountSubscriber = new WebSocketClearingHouseAccountSubscriber(
				this.program,
				config.perpMarketIndexes ?? [],
				config.spotMarketIndexes ?? [],
				config.oracleInfos ?? []
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
		userIds: number[],
		accountSubscriptionConfig: ClearingHouseUserAccountSubscriptionConfig
	): void {
		for (const userId of userIds) {
			const user = this.createUser(userId, accountSubscriptionConfig);
			this.users.set(userId, user);
		}
	}

	createUser(
		userId: number,
		accountSubscriptionConfig: ClearingHouseUserAccountSubscriptionConfig
	): ClearingHouseUser {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			userId
		);

		return new ClearingHouseUser({
			clearingHouse: this,
			userAccountPublicKey,
			accountSubscription: accountSubscriptionConfig,
		});
	}

	public async subscribe(): Promise<boolean> {
		const subscribePromises = this.subscribeUsers().concat(
			this.accountSubscriber.subscribe()
		);
		if (this.userStats !== undefined) {
			subscribePromises.concat(this.userStats.subscribe());
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
		const promises = [...this.users.values()]
			.map((user) => user.fetchAccounts())
			.concat(this.accountSubscriber.fetch());
		if (this.userStats) {
			promises.concat(this.userStats.fetchAccounts());
		}
		await Promise.all(promises);
	}

	public async unsubscribe(): Promise<void> {
		const unsubscribePromises = this.unsubscribeUsers().concat(
			this.accountSubscriber.unsubscribe()
		);
		if (this.userStats !== undefined) {
			unsubscribePromises.concat(this.userStats.unsubscribe());
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
		this.statePublicKey = await getClearingHouseStateAccountPublicKey(
			this.program.programId
		);
		return this.statePublicKey;
	}

	signerPublicKey?: PublicKey;
	public getSignerPublicKey(): PublicKey {
		if (this.signerPublicKey) {
			return this.signerPublicKey;
		}
		this.signerPublicKey = getClearingHouseSignerPublicKey(
			this.program.programId
		);
		return this.signerPublicKey;
	}

	public getStateAccount(): StateAccount {
		return this.accountSubscriber.getStateAccountAndSlot().data;
	}

	public getPerpMarketAccount(
		marketIndex: BN | number
	): PerpMarketAccount | undefined {
		marketIndex = marketIndex instanceof BN ? marketIndex : new BN(marketIndex);
		return this.accountSubscriber.getMarketAccountAndSlot(marketIndex)?.data;
	}

	public getPerpMarketAccounts(): PerpMarketAccount[] {
		return this.accountSubscriber
			.getMarketAccountsAndSlots()
			.map((value) => value.data);
	}

	public getSpotMarketAccount(
		marketIndex: BN | number
	): SpotMarketAccount | undefined {
		marketIndex = marketIndex instanceof BN ? marketIndex : new BN(marketIndex);
		return this.accountSubscriber.getSpotMarketAccountAndSlot(marketIndex).data;
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

	/**
	 * Update the wallet to use for clearing house transactions and linked user account
	 * @param newWallet
	 * @param userIds
	 * @param activeUserId
	 */
	public async updateWallet(
		newWallet: IWallet,
		userIds = [0],
		activeUserId = 0
	): Promise<void> {
		const newProvider = new AnchorProvider(
			this.connection,
			newWallet,
			this.opts
		);
		const newProgram = new Program(
			clearingHouseIDL as Idl,
			this.program.programId,
			newProvider
		);

		// Update provider for txSender with new wallet details
		this.txSender.provider = newProvider;

		this.wallet = newWallet;
		this.provider = newProvider;
		this.program = newProgram;

		if (this.isSubscribed) {
			await Promise.all(this.unsubscribeUsers());
		}
		this.users.clear();
		this.createUsers(userIds, this.userAccountSubscriptionConfig);
		if (this.isSubscribed) {
			await Promise.all(this.subscribeUsers());
		}

		this.activeUserId = activeUserId;
		this.userStatsAccountPublicKey = undefined;
	}

	public async switchActiveUser(userId: number): Promise<void> {
		this.activeUserId = userId;
	}

	public async addUser(userId: number): Promise<void> {
		if (this.users.has(userId)) {
			return;
		}

		const user = this.createUser(userId, this.userAccountSubscriptionConfig);
		await user.subscribe();
		this.users.set(userId, user);
	}

	public async initializeUserAccount(
		userId = 0,
		name = DEFAULT_USER_NAME,
		referrerInfo?: ReferrerInfo
	): Promise<[TransactionSignature, PublicKey]> {
		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(userId, name, referrerInfo);

		const tx = new Transaction();
		if (userId === 0) {
			// not the safest assumption, can explicitly check if user stats account exists if it causes problems
			tx.add(await this.getInitializeUserStatsIx());
		}
		tx.add(initializeUserAccountIx);
		const { txSig } = await this.txSender.send(tx, [], this.opts);
		return [txSig, userAccountPublicKey];
	}

	async getInitializeUserInstructions(
		userId = 0,
		name = DEFAULT_USER_NAME,
		referrerInfo?: ReferrerInfo
	): Promise<[PublicKey, TransactionInstruction]> {
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			userId
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

		const nameBuffer = encodeName(name);
		const initializeUserAccountIx =
			await this.program.instruction.initializeUser(userId, nameBuffer, {
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

	public getUser(userId?: number): ClearingHouseUser {
		userId = userId ?? this.activeUserId;
		if (!this.users.has(userId)) {
			throw new Error(`Clearing House has no user for user id ${userId}`);
		}
		return this.users.get(userId);
	}

	public getUsers(): ClearingHouseUser[] {
		return [...this.users.values()];
	}

	public getUserStats(): ClearingHouseUserStats {
		return this.userStats;
	}

	userStatsAccountPublicKey: PublicKey;
	public getUserStatsAccountPublicKey(): PublicKey {
		if (this.userStatsAccountPublicKey) {
			return this.userStatsAccountPublicKey;
		}

		this.userStatsAccountPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey
		);
		return this.userStatsAccountPublicKey;
	}

	public async getUserAccountPublicKey(): Promise<PublicKey> {
		return this.getUser().userAccountPublicKey;
	}

	public getUserAccount(userId?: number): UserAccount | undefined {
		return this.getUser(userId).getUserAccount();
	}

	public getUserAccountAndSlot(
		userId?: number
	): DataAndSlot<UserAccount> | undefined {
		return this.getUser(userId).getUserAccountAndSlot();
	}

	public getSpotPosition(marketIndex: number | BN): SpotPosition | undefined {
		const marketIndexBN =
			marketIndex instanceof BN ? marketIndex : new BN(marketIndex);
		return this.getUserAccount().spotPositions.find((spotPosition) =>
			spotPosition.marketIndex.eq(marketIndexBN)
		);
	}

	public getQuoteAssetTokenAmount(): BN {
		const spotMarket = this.getSpotMarketAccount(QUOTE_SPOT_MARKET_INDEX);
		const spotPosition = this.getSpotPosition(QUOTE_SPOT_MARKET_INDEX);
		return getTokenAmount(
			spotPosition.balance,
			spotMarket,
			spotPosition.balanceType
		);
	}

	getRemainingAccounts(params: {
		writablePerpMarketIndex?: BN;
		writableSpotMarketIndex?: BN;
		readablePerpMarketIndex?: BN;
		readableSpotMarketIndex?: BN;
	}): AccountMeta[] {
		const userAccountAndSlot = this.getUserAccountAndSlot();
		if (!userAccountAndSlot) {
			throw Error(
				'No user account found. Most likely user account does not exist or failed to fetch account'
			);
		}
		const { data: userAccount, slot: lastUserPositionsSlot } =
			userAccountAndSlot;

		const oracleAccountMap = new Map<string, AccountMeta>();
		const spotMarketAccountMap = new Map<number, AccountMeta>();
		const perpMarketAccountMap = new Map<number, AccountMeta>();
		for (const [marketIndexNum, slot] of this.marketLastSlotCache.entries()) {
			// if cache has more recent slot than user positions account slot, add market to remaining accounts
			// otherwise remove from slot
			if (slot > lastUserPositionsSlot) {
				const marketAccount = this.getPerpMarketAccount(marketIndexNum);
				perpMarketAccountMap.set(marketIndexNum, {
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
				this.marketLastSlotCache.delete(marketIndexNum);
			}
		}

		for (const position of userAccount.perpPositions) {
			if (!positionIsAvailable(position)) {
				const marketIndexNum = position.marketIndex.toNumber();
				const marketAccount = this.getPerpMarketAccount(marketIndexNum);
				perpMarketAccountMap.set(marketIndexNum, {
					pubkey: marketAccount.pubkey,
					isSigner: false,
					isWritable: false,
				});
				oracleAccountMap.set(marketAccount.pubkey.toString(), {
					pubkey: marketAccount.amm.oracle,
					isSigner: false,
					isWritable: false,
				});
			}
		}

		if (params.readablePerpMarketIndex) {
			const marketAccount = this.getPerpMarketAccount(
				params.readablePerpMarketIndex.toNumber()
			);
			perpMarketAccountMap.set(params.readablePerpMarketIndex.toNumber(), {
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

		if (params.writablePerpMarketIndex) {
			const marketAccount = this.getPerpMarketAccount(
				params.writablePerpMarketIndex.toNumber()
			);
			perpMarketAccountMap.set(params.writablePerpMarketIndex.toNumber(), {
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

		for (const spotPosition of userAccount.spotPositions) {
			if (!isSpotPositionAvailable(spotPosition)) {
				const spotMarketAccount = this.getSpotMarketAccount(
					spotPosition.marketIndex
				);
				spotMarketAccountMap.set(spotPosition.marketIndex.toNumber(), {
					pubkey: spotMarketAccount.pubkey,
					isSigner: false,
					isWritable: false,
				});
				if (!spotMarketAccount.marketIndex.eq(ZERO)) {
					oracleAccountMap.set(spotMarketAccount.oracle.toString(), {
						pubkey: spotMarketAccount.oracle,
						isSigner: false,
						isWritable: false,
					});
				}
			}
		}

		if (params.readableSpotMarketIndex) {
			const spotMarketAccount = this.getSpotMarketAccount(
				params.readableSpotMarketIndex
			);
			spotMarketAccountMap.set(params.readableSpotMarketIndex.toNumber(), {
				pubkey: spotMarketAccount.pubkey,
				isSigner: false,
				isWritable: false,
			});
			if (!spotMarketAccount.marketIndex.eq(ZERO)) {
				oracleAccountMap.set(spotMarketAccount.oracle.toString(), {
					pubkey: spotMarketAccount.oracle,
					isSigner: false,
					isWritable: false,
				});
			}
		}

		if (params.writableSpotMarketIndex) {
			const spotMarketAccount = this.getSpotMarketAccount(
				params.writableSpotMarketIndex
			);
			spotMarketAccountMap.set(params.writableSpotMarketIndex.toNumber(), {
				pubkey: spotMarketAccount.pubkey,
				isSigner: false,
				isWritable: true,
			});
			if (!spotMarketAccount.marketIndex.eq(ZERO)) {
				oracleAccountMap.set(spotMarketAccount.oracle.toString(), {
					pubkey: spotMarketAccount.oracle,
					isSigner: false,
					isWritable: false,
				});
			}
		}

		return [
			...oracleAccountMap.values(),
			...spotMarketAccountMap.values(),
			...perpMarketAccountMap.values(),
		];
	}

	public getOrder(orderId: BN | number): Order | undefined {
		const orderIdBN = orderId instanceof BN ? orderId : new BN(orderId);
		return this.getUserAccount()?.orders.find((order) =>
			order.orderId.eq(orderIdBN)
		);
	}

	public getOrderByUserId(userOrderId: number): Order | undefined {
		return this.getUserAccount()?.orders.find(
			(order) => order.userOrderId === userOrderId
		);
	}

	public async deposit(
		amount: BN,
		marketIndex: BN,
		collateralAccountPublicKey: PublicKey,
		userId?: number,
		reduceOnly = false
	): Promise<TransactionSignature> {
		const tx = new Transaction();
		const additionalSigners: Array<Signer> = [];

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);

		const authority = this.wallet.publicKey;

		const createWSOLTokenAccount =
			isSolMarket && collateralAccountPublicKey.equals(authority);

		if (createWSOLTokenAccount) {
			const { ixs, signers, pubkey } =
				await this.getWrappedSolAccountCreationIxs(amount);

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
			userId,
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

		const { txSig } = await this.txSender.send(
			tx,
			additionalSigners,
			this.opts
		);
		return txSig;
	}

	async getDepositInstruction(
		amount: BN,
		marketIndex: BN,
		userTokenAccount: PublicKey,
		userId?: number,
		reduceOnly = false,
		userInitialized = true
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = userId
			? await getUserAccountPublicKey(
					this.program.programId,
					this.wallet.publicKey,
					userId
			  )
			: await this.getUserAccountPublicKey();

		let remainingAccounts = [];
		if (userInitialized) {
			remainingAccounts = this.getRemainingAccounts({
				writableSpotMarketIndex: marketIndex,
			});
		} else {
			const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
			if (!spotMarketAccount.oracle.equals(PublicKey.default)) {
				remainingAccounts.push({
					pubkey: spotMarketAccount.oracle,
					isSigner: false,
					isWritable: false,
				});
			}
			remainingAccounts.push({
				pubkey: spotMarketAccount.pubkey,
				isSigner: false,
				isWritable: true,
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

	private async checkIfAccountExists(account: PublicKey) {
		try {
			const accountInfo = await this.connection.getAccountInfo(account);
			return accountInfo && true;
		} catch (e) {
			// Doesn't already exist
			return false;
		}
	}

	private async getSolWithdrawalIxs(
		marketIndex: BN,
		amount: BN
	): Promise<{
		ixs: anchor.web3.TransactionInstruction[];
		signers: Signer[];
		pubkey: PublicKey;
	}> {
		const result = {
			ixs: [],
			signers: [],
			pubkey: PublicKey.default,
		};

		// Create a temporary wrapped SOL account to store the SOL that we're withdrawing

		const authority = this.wallet.publicKey;

		const { ixs, signers, pubkey } = await this.getWrappedSolAccountCreationIxs(
			amount
		);
		result.pubkey = pubkey;

		ixs.forEach((ix) => {
			result.ixs.push(ix);
		});

		signers.forEach((ix) => {
			result.signers.push(ix);
		});

		const withdrawIx = await this.getWithdrawIx(
			amount,
			marketIndex,
			pubkey,
			true
		);

		result.ixs.push(withdrawIx);

		result.ixs.push(
			Token.createCloseAccountInstruction(
				TOKEN_PROGRAM_ID,
				pubkey,
				authority,
				authority,
				[]
			)
		);

		return result;
	}

	private async getWrappedSolAccountCreationIxs(amount: BN): Promise<{
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

		const depositAmountLamports = amount.add(rentSpaceLamports);

		const authority = this.wallet.publicKey;

		result.ixs.push(
			SystemProgram.createAccount({
				fromPubkey: authority,
				newAccountPubkey: wrappedSolAccount.publicKey,
				lamports: depositAmountLamports.toNumber(),
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

	/**
	 * Creates the Clearing House User account for a user, and deposits some initial collateral
	 * @param amount
	 * @param userTokenAccount
	 * @param marketIndex
	 * @param userId
	 * @param name
	 * @param fromUserId
	 * @returns
	 */
	public async initializeUserAccountAndDepositCollateral(
		amount: BN,
		userTokenAccount: PublicKey,
		marketIndex = new BN(0),
		userId = 0,
		name = DEFAULT_USER_NAME,
		fromUserId?: number,
		referrerInfo?: ReferrerInfo
	): Promise<[TransactionSignature, PublicKey]> {
		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(userId, name, referrerInfo);

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
			} = await this.getWrappedSolAccountCreationIxs(amount);

			userTokenAccount = pubkey;

			startIxs.forEach((ix) => {
				tx.add(ix);
			});

			signers.forEach((signer) => additionalSigners.push(signer));
		}

		const depositCollateralIx =
			fromUserId != null
				? await this.getTransferDepositIx(
						amount,
						marketIndex,
						fromUserId,
						userId
				  )
				: await this.getDepositInstruction(
						amount,
						marketIndex,
						userTokenAccount,
						userId,
						false,
						false
				  );

		if (userId === 0) {
			tx.add(await this.getInitializeUserStatsIx());
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

		const { txSig } = await this.txSender.send(
			tx,
			additionalSigners,
			this.opts
		);

		return [txSig, userAccountPublicKey];
	}

	public async initializeUserAccountForDevnet(
		userId = 0,
		name = DEFAULT_USER_NAME,
		marketIndex: BN,
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
			await this.getInitializeUserInstructions(userId, name, referrerInfo);

		const depositCollateralIx = await this.getDepositInstruction(
			amount,
			marketIndex,
			associateTokenPublicKey,
			userId,
			false,
			false
		);

		const tx = new Transaction().add(createAssociatedAccountIx).add(mintToIx);

		if (userId === 0) {
			tx.add(await this.getInitializeUserStatsIx());
		}
		tx.add(initializeUserAccountIx).add(depositCollateralIx);

		const txSig = await this.program.provider.sendAndConfirm(tx, []);

		return [txSig, userAccountPublicKey];
	}

	public async withdraw(
		amount: BN,
		marketIndex: BN,
		userTokenAccount: PublicKey,
		reduceOnly = false
	): Promise<TransactionSignature> {
		const tx = new Transaction();
		const additionalSigners: Array<Signer> = [];

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);

		const authority = this.wallet.publicKey;

		const createWSOLTokenAccount =
			isSolMarket && userTokenAccount.equals(authority);

		if (createWSOLTokenAccount) {
			const { ixs, signers, pubkey } =
				await this.getWrappedSolAccountCreationIxs(amount);

			userTokenAccount = pubkey;

			ixs.forEach((ix) => {
				tx.add(ix);
			});

			signers.forEach((signer) => additionalSigners.push(signer));
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

		const { txSig } = await this.txSender.send(
			tx,
			additionalSigners,
			this.opts
		);
		return txSig;
	}

	public async getWithdrawIx(
		amount: BN,
		marketIndex: BN,
		userTokenAccount: PublicKey,
		reduceOnly = false
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			writableSpotMarketIndex: marketIndex,
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
					clearingHouseSigner: this.getSignerPublicKey(),
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
		marketIndex: BN,
		fromUserId: number,
		toUserId: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getTransferDepositIx(
					amount,
					marketIndex,
					fromUserId,
					toUserId
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getTransferDepositIx(
		amount: BN,
		marketIndex: BN,
		fromUserId: number,
		toUserId: number
	): Promise<TransactionInstruction> {
		const fromUser = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			fromUserId
		);
		const toUser = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			toUserId
		);

		const remainingAccounts = this.getRemainingAccounts({
			writableSpotMarketIndex: marketIndex,
		});

		return await this.program.instruction.transferDeposit(marketIndex, amount, {
			accounts: {
				authority: this.wallet.publicKey,
				fromUser,
				toUser,
				userStats: this.getUserStatsAccountPublicKey(),
				state: await this.getStatePublicKey(),
			},
			remainingAccounts,
		});
	}

	public async updateSpotMarketCumulativeInterest(
		marketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.updateSpotMarketCumulativeInterestIx(marketIndex)),
			[],
			this.opts
		);
		return txSig;
	}

	public async updateSpotMarketCumulativeInterestIx(
		marketIndex: BN
	): Promise<TransactionInstruction> {
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		return await this.program.instruction.updateSpotMarketCumulativeInterest({
			accounts: {
				spotMarket: spotMarket.pubkey,
			},
		});
	}

	public async settleLP(
		settleeUserAccountPublicKey: PublicKey,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.settleLPIx(settleeUserAccountPublicKey, marketIndex)),
			[],
			this.opts
		);
		return txSig;
	}

	public async settleLPIx(
		settleeUserAccountPublicKey: PublicKey,
		marketIndex: BN
	): Promise<TransactionInstruction> {
		const settleeUserAccount = (await this.program.account.user.fetch(
			settleeUserAccountPublicKey
		)) as UserAccount;
		const userPositions = settleeUserAccount.perpPositions;
		const remainingAccounts = [];

		let foundMarket = false;
		for (const position of userPositions) {
			if (!positionIsAvailable(position)) {
				const marketPublicKey = await getMarketPublicKey(
					this.program.programId,
					position.marketIndex
				);
				remainingAccounts.push({
					pubkey: marketPublicKey,
					isWritable: true,
					isSigner: false,
				});

				if (marketIndex.eq(position.marketIndex)) {
					foundMarket = true;
				}
			}
		}

		if (!foundMarket) {
			console.log(
				'Warning: lp is not in the market specified -- tx will likely fail'
			);
		}

		return this.program.instruction.settleLp(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: settleeUserAccountPublicKey,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async removeLiquidity(
		marketIndex: BN,
		sharesToBurn?: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getRemoveLiquidityIx(marketIndex, sharesToBurn)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getRemoveLiquidityIx(
		marketIndex: BN,
		sharesToBurn?: BN
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			writablePerpMarketIndex: marketIndex,
		});

		if (sharesToBurn == undefined) {
			const userAccount = this.getUserAccount();
			const perpPosition = userAccount.perpPositions.filter((position) =>
				position.marketIndex.eq(marketIndex)
			)[0];
			sharesToBurn = perpPosition.lpShares;
			console.log('burning lp shares:', sharesToBurn.toString());
		}

		return this.program.instruction.removeLiquidity(sharesToBurn, marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async addLiquidity(
		amount: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(await this.getAddLiquidityIx(amount, marketIndex)),
			[],
			this.opts
		);
		this.marketLastSlotCache.set(marketIndex.toNumber(), slot);
		return txSig;
	}

	public async getAddLiquidityIx(
		amount: BN,
		marketIndex: BN
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const remainingAccounts = this.getRemainingAccounts({
			writablePerpMarketIndex: marketIndex,
		});

		return this.program.instruction.addLiquidity(amount, marketIndex, {
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
		marketIndex: BN,
		limitPrice?: BN
	): Promise<TransactionSignature> {
		return await this.placeAndTake({
			orderType: OrderType.MARKET,
			marketIndex,
			direction,
			baseAssetAmount: amount,
			price: limitPrice,
		});
	}

	public async sendSignedTx(tx: Transaction): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(tx, undefined, this.opts, true);

		return txSig;
	}

	/**
	 * Sends a market order and returns a signed tx which can fill the order against the vamm, which the caller can use to fill their own order if required.
	 * @param orderParams
	 * @param userAccountPublicKey
	 * @param userAccount
	 * @returns
	 */
	public async sendMarketOrderAndGetSignedFillTx(
		orderParams: OptionalOrderParams,
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount
	): Promise<{ txSig: TransactionSignature; signedFillTx: Transaction }> {
		const marketIndex = orderParams.marketIndex;
		const orderId = userAccount.nextOrderId;

		const marketOrderTx = wrapInTx(await this.getPlaceOrderIx(orderParams));
		const fillTx = wrapInTx(
			await this.getFillOrderIx(userAccountPublicKey, userAccount, {
				orderId,
				marketIndex,
			})
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

		const { txSig, slot } = await this.txSender.send(
			signedMarketOrderTx,
			[],
			this.opts,
			true
		);

		this.marketLastSlotCache.set(orderParams.marketIndex.toNumber(), slot);

		return { txSig, signedFillTx };
	}

	public async placeOrder(
		orderParams: OptionalOrderParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(await this.getPlaceOrderIx(orderParams)),
			[],
			this.opts
		);
		this.marketLastSlotCache.set(orderParams.marketIndex.toNumber(), slot);
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

	public async getPlaceOrderIx(
		orderParams: OptionalOrderParams
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams, MarketType.PERP);
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			readablePerpMarketIndex: orderParams.marketIndex,
		});

		return await this.program.instruction.placeOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async updateAMMs(marketIndexes: BN[]): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getUpdateAMMsIx(marketIndexes)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateAMMsIx(
		marketIndexes: BN[]
	): Promise<TransactionInstruction> {
		for (let i = marketIndexes.length; i < 5; i++) {
			marketIndexes.push(new BN(100));
		}
		const marketAccountInfos = [];
		const oracleAccountInfos = [];
		for (const marketIndex of marketIndexes) {
			if (!marketIndex.eq(new BN(100))) {
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
		marketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getSettleExpiredMarketIx(marketIndex)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettleExpiredMarketIx(
		marketIndex: BN
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

	public async cancelOrder(orderId?: BN): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getCancelOrderIx(orderId)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrderIx(orderId?: BN): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({});

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
		userOrderId: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getCancelOrderByUserIdIx(userOrderId)),
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

		const remainingAccounts = this.getRemainingAccounts({});

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

	public async fillOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order?: Order,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getFillOrderIx(
					userAccountPublicKey,
					user,
					order,
					makerInfo,
					referrerInfo
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getFillOrderIx(
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
			: userAccount.orders.find((order) =>
					order.orderId.eq(userAccount.nextOrderId.sub(ONE))
			  ).marketIndex;
		const marketAccount = this.getPerpMarketAccount(marketIndex);

		const oracleAccountMap = new Map<string, AccountMeta>();
		const spotMarketAccountMap = new Map<number, AccountMeta>();
		const perpMarketAccountMap = new Map<number, AccountMeta>();

		for (const spotPosition of userAccount.spotPositions) {
			if (!isSpotPositionAvailable(spotPosition)) {
				const spotMarketAccount = this.getSpotMarketAccount(
					spotPosition.marketIndex
				);
				spotMarketAccountMap.set(spotPosition.marketIndex.toNumber(), {
					pubkey: spotMarketAccount.pubkey,
					isSigner: false,
					isWritable: false,
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

		for (const position of userAccount.perpPositions) {
			if (
				!positionIsAvailable(position) &&
				!position.marketIndex.eq(order.marketIndex)
			) {
				const market = this.getPerpMarketAccount(position.marketIndex);
				perpMarketAccountMap.set(position.marketIndex.toNumber(), {
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

		perpMarketAccountMap.set(marketIndex.toNumber(), {
			pubkey: marketAccount.pubkey,
			isWritable: true,
			isSigner: false,
		});
		oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
			pubkey: marketAccount.amm.oracle,
			isWritable: false,
			isSigner: false,
		});

		const remainingAccounts = [
			...oracleAccountMap.values(),
			...spotMarketAccountMap.values(),
			...perpMarketAccountMap.values(),
		];

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

		return await this.program.instruction.fillOrder(orderId, makerOrderId, {
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
		orderParams: OptionalOrderParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getPlaceSpotOrderIx(orderParams)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getPlaceSpotOrderIx(
		orderParams: OptionalOrderParams
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams, MarketType.SPOT);
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			readableSpotMarketIndex: orderParams.marketIndex,
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
		referrerInfo?: ReferrerInfo
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getFillSpotOrderIx(
					userAccountPublicKey,
					user,
					order,
					fulfillmentConfig,
					makerInfo,
					referrerInfo
				)
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
			: userAccount.orders.find((order) =>
					order.orderId.eq(userAccount.nextOrderId.sub(ONE))
			  ).marketIndex;

		const oracleAccountMap = new Map<string, AccountMeta>();
		const spotMarketAccountMap = new Map<number, AccountMeta>();
		const perpMarketAccountMap = new Map<number, AccountMeta>();

		for (const spotPosition of userAccount.spotPositions) {
			if (!isSpotPositionAvailable(spotPosition)) {
				const spotMarket = this.getSpotMarketAccount(spotPosition.marketIndex);
				spotMarketAccountMap.set(spotPosition.marketIndex.toNumber(), {
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
			}
		}

		for (const position of userAccount.perpPositions) {
			if (
				!positionIsAvailable(position) &&
				!position.marketIndex.eq(order.marketIndex)
			) {
				const market = this.getPerpMarketAccount(position.marketIndex);
				perpMarketAccountMap.set(position.marketIndex.toNumber(), {
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

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		spotMarketAccountMap.set(marketIndex.toNumber(), {
			pubkey: spotMarketAccount.pubkey,
			isWritable: true,
			isSigner: false,
		});
		if (!spotMarketAccount.oracle.equals(PublicKey.default)) {
			oracleAccountMap.set(spotMarketAccount.oracle.toString(), {
				pubkey: spotMarketAccount.oracle,
				isWritable: false,
				isSigner: false,
			});
		}
		const quoteMarketAccount = this.getQuoteSpotMarketAccount();
		spotMarketAccountMap.set(quoteMarketAccount.marketIndex.toNumber(), {
			pubkey: quoteMarketAccount.pubkey,
			isWritable: true,
			isSigner: false,
		});

		const remainingAccounts = [
			...oracleAccountMap.values(),
			...spotMarketAccountMap.values(),
			...perpMarketAccountMap.values(),
		];

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

		if (fulfillmentConfig) {
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
				pubkey: spotMarketAccount.vault,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: quoteMarketAccount.vault,
				isWritable: true,
				isSigner: false,
			});
		}

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

	public async triggerOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order: Order
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getTriggerOrderIx(userAccountPublicKey, user, order)),
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

		const marketIndex = order.marketIndex;
		const marketAccount = this.getPerpMarketAccount(marketIndex);

		const oracleAccountMap = new Map<string, AccountMeta>();
		const spotMarketAccountMap = new Map<number, AccountMeta>();
		const perpMarketAccountMap = new Map<number, AccountMeta>();

		for (const spotPosition of userAccount.spotPositions) {
			if (!isSpotPositionAvailable(spotPosition)) {
				const spotMarketAccount = this.getSpotMarketAccount(
					spotPosition.marketIndex
				);
				spotMarketAccountMap.set(spotPosition.marketIndex.toNumber(), {
					pubkey: spotMarketAccount.pubkey,
					isSigner: false,
					isWritable: false,
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

		for (const position of userAccount.perpPositions) {
			if (
				!positionIsAvailable(position) &&
				!position.marketIndex.eq(order.marketIndex)
			) {
				const market = this.getPerpMarketAccount(position.marketIndex);
				perpMarketAccountMap.set(position.marketIndex.toNumber(), {
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

		perpMarketAccountMap.set(marketIndex.toNumber(), {
			pubkey: marketAccount.pubkey,
			isWritable: true,
			isSigner: false,
		});
		oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
			pubkey: marketAccount.amm.oracle,
			isWritable: false,
			isSigner: false,
		});

		const remainingAccounts = [
			...oracleAccountMap.values(),
			...spotMarketAccountMap.values(),
			...perpMarketAccountMap.values(),
		];

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

	public async triggerSpotOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order: Order
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getTriggerSpotOrderIx(userAccountPublicKey, user, order)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getTriggerSpotOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order: Order
	): Promise<TransactionInstruction> {
		const fillerPublicKey = await this.getUserAccountPublicKey();

		const marketIndex = order.marketIndex;
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		const oracleAccountMap = new Map<string, AccountMeta>();
		const spotMarketAccountMap = new Map<number, AccountMeta>();
		const perpMarketAccountMap = new Map<number, AccountMeta>();

		for (const spotPosition of userAccount.spotPositions) {
			if (!isSpotPositionAvailable(spotPosition)) {
				const spotMarketAccount = this.getSpotMarketAccount(
					spotPosition.marketIndex
				);
				spotMarketAccountMap.set(spotPosition.marketIndex.toNumber(), {
					pubkey: spotMarketAccount.pubkey,
					isSigner: false,
					isWritable: false,
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

		for (const position of userAccount.perpPositions) {
			if (
				!positionIsAvailable(position) &&
				!position.marketIndex.eq(order.marketIndex)
			) {
				const market = this.getPerpMarketAccount(position.marketIndex);
				perpMarketAccountMap.set(position.marketIndex.toNumber(), {
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

		const quoteSpotMarket = this.getQuoteSpotMarketAccount();
		spotMarketAccountMap.set(quoteSpotMarket.marketIndex.toNumber(), {
			pubkey: quoteSpotMarket.pubkey,
			isWritable: true,
			isSigner: false,
		});
		spotMarketAccountMap.set(marketIndex.toNumber(), {
			pubkey: spotMarketAccount.pubkey,
			isWritable: false,
			isSigner: false,
		});
		oracleAccountMap.set(spotMarketAccount.oracle.toString(), {
			pubkey: spotMarketAccount.oracle,
			isWritable: false,
			isSigner: false,
		});

		const remainingAccounts = [
			...oracleAccountMap.values(),
			...spotMarketAccountMap.values(),
			...perpMarketAccountMap.values(),
		];

		const orderId = order.orderId;
		return await this.program.instruction.triggerSpotOrder(orderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				filler: fillerPublicKey,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async placeAndTake(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(
				await this.getPlaceAndTakeIx(orderParams, makerInfo, referrerInfo)
			),
			[],
			this.opts
		);
		this.marketLastSlotCache.set(orderParams.marketIndex.toNumber(), slot);
		return txSig;
	}

	public async getPlaceAndTakeIx(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams, MarketType.PERP);
		const userStatsPublicKey = await this.getUserStatsAccountPublicKey();
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			writablePerpMarketIndex: orderParams.marketIndex,
			writableSpotMarketIndex: QUOTE_SPOT_MARKET_INDEX,
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

		return await this.program.instruction.placeAndTake(
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

	public async placeAndMake(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		referrerInfo?: ReferrerInfo
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(
				await this.getPlaceAndMakeIx(orderParams, takerInfo, referrerInfo)
			),
			[],
			this.opts
		);

		this.marketLastSlotCache.set(orderParams.marketIndex.toNumber(), slot);

		return txSig;
	}

	public async getPlaceAndMakeIx(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		referrerInfo?: ReferrerInfo
	): Promise<TransactionInstruction> {
		orderParams = this.getOrderParams(orderParams, MarketType.PERP);
		const userStatsPublicKey = this.getUserStatsAccountPublicKey();
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		// todo merge this with getRemainingAccounts
		const remainingAccounts = this.getRemainingAccountsWithCounterparty({
			counterPartyUserAccount: takerInfo.takerUserAccount,
			writablePerpMarketIndex: orderParams.marketIndex,
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

		const takerOrderId = takerInfo!.order!.orderId;
		return await this.program.instruction.placeAndMake(
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

	/**
	 * Close an entire position. If you want to reduce a position, use the {@link openPosition} method in the opposite direction of the current position.
	 * @param marketIndex
	 * @returns
	 */
	public async closePosition(
		marketIndex: BN,
		limitPrice?: BN
	): Promise<TransactionSignature> {
		const userPosition = this.getUser().getUserPosition(marketIndex);
		if (!userPosition) {
			throw Error(`No position in market ${marketIndex.toString()}`);
		}

		return await this.placeAndTake({
			orderType: OrderType.MARKET,
			marketIndex,
			direction: findDirectionToClose(userPosition),
			baseAssetAmount: userPosition.baseAssetAmount.abs(),
			reduceOnly: true,
			price: limitPrice,
		});
	}

	public async settlePNLs(
		users: {
			settleeUserAccountPublicKey: PublicKey;
			settleeUserAccount: UserAccount;
		}[],
		marketIndex: BN
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

		const { txSig } = await this.txSender.send(tx, [], this.opts);
		return txSig;
	}

	public async settlePNL(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.settlePNLIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketIndex
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async settlePNLIx(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: BN
	): Promise<TransactionInstruction> {
		const perpMarketAccountMap = new Map<number, AccountMeta>();
		const oracleAccountMap = new Map<string, AccountMeta>();
		const spotMarketAccountMap = new Map<number, AccountMeta>();

		for (const position of settleeUserAccount.perpPositions) {
			if (!positionIsAvailable(position)) {
				const market = this.getPerpMarketAccount(position.marketIndex);
				perpMarketAccountMap.set(position.marketIndex.toNumber(), {
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

		for (const spotPosition of settleeUserAccount.spotPositions) {
			if (!isSpotPositionAvailable(spotPosition)) {
				const spotMarketAccount = this.getSpotMarketAccount(
					spotPosition.marketIndex
				);
				spotMarketAccountMap.set(spotPosition.marketIndex.toNumber(), {
					pubkey: spotMarketAccount.pubkey,
					isSigner: false,
					isWritable: false,
				});
				if (!spotMarketAccount.marketIndex.eq(ZERO)) {
					oracleAccountMap.set(spotMarketAccount.oracle.toString(), {
						pubkey: spotMarketAccount.oracle,
						isSigner: false,
						isWritable: false,
					});
				}
			}
		}

		const marketAccount = this.getPerpMarketAccount(marketIndex.toNumber());
		perpMarketAccountMap.set(marketIndex.toNumber(), {
			pubkey: marketAccount.pubkey,
			isSigner: false,
			isWritable: true,
		});
		oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
			pubkey: marketAccount.amm.oracle,
			isSigner: false,
			isWritable: false,
		});

		spotMarketAccountMap.set(QUOTE_SPOT_MARKET_INDEX.toNumber(), {
			pubkey: this.getSpotMarketAccount(QUOTE_SPOT_MARKET_INDEX).pubkey,
			isSigner: false,
			isWritable: true,
		});

		const remainingAccounts = [
			...oracleAccountMap.values(),
			...spotMarketAccountMap.values(),
			...perpMarketAccountMap.values(),
		];

		return await this.program.instruction.settlePnl(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: settleeUserAccountPublicKey,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async settleExpiredPosition(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getSettleExpiredPositionIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketIndex
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettleExpiredPositionIx(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: BN
	): Promise<TransactionInstruction> {
		const marketAccountMap = new Map<number, AccountMeta>();
		const oracleAccountMap = new Map<string, AccountMeta>();
		const spotMarketAccountMap = new Map<number, AccountMeta>();
		for (const position of settleeUserAccount.perpPositions) {
			if (!positionIsAvailable(position)) {
				const market = this.getPerpMarketAccount(position.marketIndex);
				marketAccountMap.set(position.marketIndex.toNumber(), {
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

		for (const userBankBalance of settleeUserAccount.spotPositions) {
			if (!userBankBalance.balance.eq(ZERO)) {
				const bankAccount = this.getSpotMarketAccount(
					userBankBalance.marketIndex
				);
				spotMarketAccountMap.set(userBankBalance.marketIndex.toNumber(), {
					pubkey: bankAccount.pubkey,
					isSigner: false,
					isWritable: false,
				});
				if (!bankAccount.marketIndex.eq(ZERO)) {
					oracleAccountMap.set(bankAccount.oracle.toString(), {
						pubkey: bankAccount.oracle,
						isSigner: false,
						isWritable: false,
					});
				}
			}
		}

		const marketAccount = this.getPerpMarketAccount(marketIndex.toNumber());
		marketAccountMap.set(marketIndex.toNumber(), {
			pubkey: marketAccount.pubkey,
			isSigner: false,
			isWritable: true,
		});
		oracleAccountMap.set(marketAccount.amm.oracle.toString(), {
			pubkey: marketAccount.amm.oracle,
			isSigner: false,
			isWritable: false,
		});

		spotMarketAccountMap.set(QUOTE_SPOT_MARKET_INDEX.toNumber(), {
			pubkey: this.getSpotMarketAccount(QUOTE_SPOT_MARKET_INDEX).pubkey,
			isSigner: false,
			isWritable: true,
		});

		const remainingAccounts = [
			...oracleAccountMap.values(),
			...spotMarketAccountMap.values(),
			...marketAccountMap.values(),
		];

		return await this.program.instruction.settleExpiredPosition(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: settleeUserAccountPublicKey,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async liquidatePerp(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: BN,
		maxBaseAssetAmount: BN
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(
				await this.getLiquidatePerpIx(
					userAccountPublicKey,
					userAccount,
					marketIndex,
					maxBaseAssetAmount
				)
			),
			[],
			this.opts
		);
		this.marketLastSlotCache.set(marketIndex.toNumber(), slot);
		return txSig;
	}

	public async getLiquidatePerpIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: BN,
		maxBaseAssetAmount: BN
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidatorPublicKey = await this.getUserAccountPublicKey();
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccountsWithCounterparty({
			writablePerpMarketIndex: marketIndex,
			counterPartyUserAccount: userAccount,
		});

		return await this.program.instruction.liquidatePerp(
			marketIndex,
			maxBaseAssetAmount,
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

	public async liquidateBorrow(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		assetmarketIndex: BN,
		liabilitymarketIndex: BN,
		maxLiabilityTransfer: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getLiquidateBorrowIx(
					userAccountPublicKey,
					userAccount,
					assetmarketIndex,
					liabilitymarketIndex,
					maxLiabilityTransfer
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getLiquidateBorrowIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		assetmarketIndex: BN,
		liabilitymarketIndex: BN,
		maxLiabilityTransfer: BN
	): Promise<TransactionInstruction> {
		const liquidatorPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccountsWithCounterparty({
			counterPartyUserAccount: userAccount,
			writableSpotMarketIndexes: [liabilitymarketIndex, assetmarketIndex],
		});

		return await this.program.instruction.liquidateBorrow(
			assetmarketIndex,
			liabilitymarketIndex,
			maxLiabilityTransfer,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					liquidator: liquidatorPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidateBorrowForPerpPnl(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: BN,
		liabilitymarketIndex: BN,
		maxLiabilityTransfer: BN
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(
				await this.getLiquidateBorrowForPerpPnlIx(
					userAccountPublicKey,
					userAccount,
					perpMarketIndex,
					liabilitymarketIndex,
					maxLiabilityTransfer
				)
			),
			[],
			this.opts
		);
		this.marketLastSlotCache.set(perpMarketIndex.toNumber(), slot);
		return txSig;
	}

	public async getLiquidateBorrowForPerpPnlIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: BN,
		liabilitymarketIndex: BN,
		maxLiabilityTransfer: BN
	): Promise<TransactionInstruction> {
		const liquidatorPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccountsWithCounterparty({
			counterPartyUserAccount: userAccount,
			writablePerpMarketIndex: perpMarketIndex,
			writableSpotMarketIndexes: [liabilitymarketIndex],
		});

		return await this.program.instruction.liquidateBorrowForPerpPnl(
			perpMarketIndex,
			liabilitymarketIndex,
			maxLiabilityTransfer,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					liquidator: liquidatorPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidatePerpPnlForDeposit(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: BN,
		assetMarketIndex: BN,
		maxPnlTransfer: BN
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.txSender.send(
			wrapInTx(
				await this.getLiquidatePerpPnlForDepositIx(
					userAccountPublicKey,
					userAccount,
					perpMarketIndex,
					assetMarketIndex,
					maxPnlTransfer
				)
			),
			[],
			this.opts
		);
		this.marketLastSlotCache.set(perpMarketIndex.toNumber(), slot);
		return txSig;
	}

	public async getLiquidatePerpPnlForDepositIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: BN,
		assetMarketIndex: BN,
		maxPnlTransfer: BN
	): Promise<TransactionInstruction> {
		const liquidatorPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccountsWithCounterparty({
			counterPartyUserAccount: userAccount,
			writablePerpMarketIndex: perpMarketIndex,
			writableSpotMarketIndexes: [assetMarketIndex],
		});

		return await this.program.instruction.liquidatePerpPnlForDeposit(
			perpMarketIndex,
			assetMarketIndex,
			maxPnlTransfer,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					liquidator: liquidatorPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async resolvePerpBankruptcy(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getResolvePerpBankruptcyIx(
					userAccountPublicKey,
					userAccount,
					marketIndex
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getResolvePerpBankruptcyIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: BN
	): Promise<TransactionInstruction> {
		const liquidatorPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccountsWithCounterparty({
			writablePerpMarketIndex: marketIndex,
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
			counterPartyUserAccount: userAccount,
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
					liquidator: liquidatorPublicKey,
					spotMarketVault: spotMarket.vault,
					insuranceFundVault: spotMarket.insuranceFundVault,
					clearingHouseSigner: this.getSignerPublicKey(),
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async resolveBorrowBankruptcy(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getResolveBorrowBankruptcyIx(
					userAccountPublicKey,
					userAccount,
					marketIndex
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getResolveBorrowBankruptcyIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: BN
	): Promise<TransactionInstruction> {
		const liquidatorPublicKey = await this.getUserAccountPublicKey();

		const remainingAccounts = this.getRemainingAccountsWithCounterparty({
			writableSpotMarketIndexes: [marketIndex],
			counterPartyUserAccount: userAccount,
		});

		const spotMarket = this.getSpotMarketAccount(marketIndex);

		return await this.program.instruction.resolveBorrowBankruptcy(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: userAccountPublicKey,
				liquidator: liquidatorPublicKey,
				spotMarketVault: spotMarket.vault,
				insuranceFundVault: spotMarket.insuranceFundVault,
				clearingHouseSigner: this.getSignerPublicKey(),
				tokenProgram: TOKEN_PROGRAM_ID,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	getRemainingAccountsWithCounterparty(params: {
		counterPartyUserAccount: UserAccount;
		writablePerpMarketIndex?: BN;
		writableSpotMarketIndexes?: BN[];
	}): AccountMeta[] {
		const counterPartyUserAccount = params.counterPartyUserAccount;

		const oracleAccountMap = new Map<string, AccountMeta>();
		const spotMarketAccountMap = new Map<number, AccountMeta>();
		const marketAccountMap = new Map<number, AccountMeta>();
		for (const spotPosition of counterPartyUserAccount.spotPositions) {
			if (!isSpotPositionAvailable(spotPosition)) {
				const spotMarket = this.getSpotMarketAccount(spotPosition.marketIndex);
				spotMarketAccountMap.set(spotPosition.marketIndex.toNumber(), {
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
			}
		}
		for (const position of counterPartyUserAccount.perpPositions) {
			if (!positionIsAvailable(position)) {
				const market = this.getPerpMarketAccount(position.marketIndex);
				marketAccountMap.set(position.marketIndex.toNumber(), {
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

		const userAccountAndSlot = this.getUserAccountAndSlot();
		if (!userAccountAndSlot) {
			throw Error(
				'No user account found. Most likely user account does not exist or failed to fetch account'
			);
		}
		const { data: userAccount, slot: lastUserPositionsSlot } =
			userAccountAndSlot;

		for (const [marketIndexNum, slot] of this.marketLastSlotCache.entries()) {
			// if cache has more recent slot than user positions account slot, add market to remaining accounts
			// otherwise remove from slot
			if (slot > lastUserPositionsSlot) {
				const marketAccount = this.getPerpMarketAccount(marketIndexNum);
				marketAccountMap.set(marketIndexNum, {
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
				this.marketLastSlotCache.delete(marketIndexNum);
			}
		}
		for (const spotPosition of userAccount.spotPositions) {
			if (!isSpotPositionAvailable(spotPosition)) {
				const spotMarket = this.getSpotMarketAccount(spotPosition.marketIndex);
				spotMarketAccountMap.set(spotPosition.marketIndex.toNumber(), {
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
			}
		}
		for (const position of userAccount.perpPositions) {
			if (!positionIsAvailable(position)) {
				const market = this.getPerpMarketAccount(position.marketIndex);
				marketAccountMap.set(position.marketIndex.toNumber(), {
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

		if (params.writablePerpMarketIndex) {
			const market = this.getPerpMarketAccount(params.writablePerpMarketIndex);
			marketAccountMap.set(market.marketIndex.toNumber(), {
				pubkey: market.pubkey,
				isSigner: false,
				isWritable: true,
			});
			oracleAccountMap.set(market.amm.oracle.toString(), {
				pubkey: market.amm.oracle,
				isSigner: false,
				isWritable: false,
			});
		}

		if (params.writableSpotMarketIndexes) {
			for (const writableSpotMarketIndex of params.writableSpotMarketIndexes) {
				const spotMarketAccount = this.getSpotMarketAccount(
					writableSpotMarketIndex
				);
				spotMarketAccountMap.set(spotMarketAccount.marketIndex.toNumber(), {
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
			...marketAccountMap.values(),
		];
	}

	public async updateFundingRate(
		oracle: PublicKey,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getUpdateFundingRateIx(oracle, marketIndex)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateFundingRateIx(
		oracle: PublicKey,
		marketIndex: BN
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateFundingRate(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				market: await getMarketPublicKey(this.program.programId, marketIndex),
				oracle: oracle,
			},
		});
	}

	public async settleFundingPayment(
		userAccount: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getSettleFundingPaymentIx(userAccount)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettleFundingPaymentIx(
		userAccount: PublicKey
	): Promise<TransactionInstruction> {
		const user = (await this.program.account.user.fetch(
			userAccount
		)) as UserAccount;

		const userPositions = user.perpPositions;

		const remainingAccounts = [];
		for (const position of userPositions) {
			if (!positionIsAvailable(position)) {
				const marketPublicKey = await getMarketPublicKey(
					this.program.programId,
					position.marketIndex
				);
				remainingAccounts.push({
					pubkey: marketPublicKey,
					isWritable: false,
					isSigner: false,
				});
			}
		}

		return await this.program.instruction.settleFundingPayment({
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccount,
			},
			remainingAccounts,
		});
	}

	public triggerEvent(eventName: keyof ClearingHouseAccountEvents, data?: any) {
		this.eventEmitter.emit(eventName, data);
	}

	public getOracleDataForMarket(marketIndex: BN): OraclePriceData {
		const oracleKey = this.getPerpMarketAccount(marketIndex).amm.oracle;
		const oracleData = this.getOraclePriceDataAndSlot(oracleKey).data;

		return oracleData;
	}

	public async initializeInsuranceFundStake(
		marketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(await this.getInitializeInsuranceFundStakeIx(marketIndex)),
			[],
			this.opts
		);
		return txSig;
	}

	public async getInitializeInsuranceFundStakeIx(
		marketIndex: BN
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
		marketIndex: BN,
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
			writableSpotMarketIndex: marketIndex,
		});

		return await this.program.rpc.addInsuranceFundStake(marketIndex, amount, {
			accounts: {
				state: await this.getStatePublicKey(),
				spotMarket: spotMarket.pubkey,
				insuranceFundStake: ifStakeAccountPublicKey,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
				insuranceFundVault: spotMarket.insuranceFundVault,
				userTokenAccount: collateralAccountPublicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
			remainingAccounts,
		});
	}

	public async requestRemoveInsuranceFundStake(
		marketIndex: BN,
		amount: BN
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const remainingAccounts = this.getRemainingAccounts({
			writableSpotMarketIndex: marketIndex,
		});

		return await this.program.rpc.requestRemoveInsuranceFundStake(
			marketIndex,
			amount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					insuranceFundStake: ifStakeAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					insuranceFundVault: spotMarketAccount.insuranceFundVault,
					// userTokenAccount: collateralAccountPublicKey,
					// tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts,
			}
		);
	}

	public async cancelRequestRemoveInsuranceFundStake(
		marketIndex: BN
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const remainingAccounts = this.getRemainingAccounts({
			writableSpotMarketIndex: marketIndex,
		});

		return await this.program.rpc.cancelRequestRemoveInsuranceFundStake(
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					insuranceFundStake: ifStakeAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					insuranceFundVault: spotMarketAccount.insuranceFundVault,
					// userTokenAccount: collateralAccountPublicKey,
					// tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts,
			}
		);
	}

	public async removeInsuranceFundStake(
		marketIndex: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const remainingAccounts = this.getRemainingAccounts({
			writableSpotMarketIndex: marketIndex,
		});

		return await this.program.rpc.removeInsuranceFundStake(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				spotMarket: spotMarketAccount.pubkey,
				insuranceFundStake: ifStakeAccountPublicKey,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
				insuranceFundVault: spotMarketAccount.insuranceFundVault,
				clearingHouseSigner: this.getSignerPublicKey(),
				userTokenAccount: collateralAccountPublicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
			remainingAccounts,
		});
	}

	public async settleRevenueToInsuranceFund(
		marketIndex: BN
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		const remainingAccounts = this.getRemainingAccounts({
			writableSpotMarketIndex: marketIndex,
		});

		return await this.program.rpc.settleRevenueToInsuranceFund(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				spotMarket: spotMarketAccount.pubkey,
				spotMarketVault: spotMarketAccount.vault,
				clearingHouseSigner: this.getSignerPublicKey(),
				insuranceFundVault: spotMarketAccount.insuranceFundVault,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
			remainingAccounts,
		});
	}

	public async resolvePerpPnlDeficit(
		spotMarketIndex: BN,
		perpMarketIndex: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.txSender.send(
			wrapInTx(
				await this.getResolvePerpPnlDeficitIx(spotMarketIndex, perpMarketIndex)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getResolvePerpPnlDeficitIx(
		spotMarketIndex: BN,
		perpMarketIndex: BN
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			writablePerpMarketIndex: perpMarketIndex,
			writableSpotMarketIndex: spotMarketIndex,
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
					insuranceFundVault: spotMarket.insuranceFundVault,
					clearingHouseSigner: this.getSignerPublicKey(),
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}
}
