import { AnchorProvider, BN, Program, ProgramAccount } from '@coral-xyz/anchor';
import { Program as Program30, Idl as Idl30 } from '@coral-xyz/anchor-30';
import {
	AddressLookupTableAccount,
	BlockhashWithExpiryBlockHeight,
	ConfirmOptions,
	Connection,
	PublicKey,
	Signer,
	TransactionInstruction,
	TransactionSignature,
	TransactionVersion,
	Transaction,
	VersionedTransaction,
	AccountMeta,
	Keypair,
} from '@solana/web3.js';
import {
	DriftClientMetricsEvents,
	HighLeverageModeConfig,
	IWallet,
	MakerInfo,
	MarketType,
	OpenbookV2FulfillmentConfigAccount,
	OptionalOrderParams,
	OracleSource,
	Order,
	OrderParams,
	PerpMarketAccount,
	PerpMarketExtendedInfo,
	PhoenixV1FulfillmentConfigAccount,
	PlaceAndTakeOrderSuccessCondition,
	PositionDirection,
	ReferrerInfo,
	ReferrerNameAccount,
	SerumV3FulfillmentConfigAccount,
	SettlePnlMode,
	SpotMarketAccount,
	SpotPosition,
	StateAccount,
	SignedMsgOrderParamsMessage,
	TakerInfo,
	TxParams,
	UserAccount,
	UserStatsAccount,
	ProtectedMakerModeConfig,
	SignedMsgOrderParamsDelegateMessage,
	SignedMsgOrderParams,
	SwapReduceOnly,
	OrderTriggerCondition,
	ModifyOrderPolicy,
} from '../types';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	DataAndSlot,
	DriftClientAccountEvents,
	DriftClientAccountSubscriber,
} from '../accounts/types';
import { TxSender, TxSigAndSlot } from '../tx/types';
import { OraclePriceData } from '../oracles/types';
import { UserSubscriptionConfig } from '../user/types';
import { DriftEnv } from '../config/types';
import { IUserStats } from '../userStats/types';
import { UserStatsSubscriptionConfig } from '../userStatsConfig';
import { PythSolanaReceiver } from '@pythnetwork/pyth-solana-receiver/lib/idl/pyth_solana_receiver';
import { WormholeCoreBridgeSolana } from '@pythnetwork/pyth-solana-receiver/lib/idl/wormhole_core_bridge_solana';
import { Slothash } from '../slot/SlothashSubscriber';
import { TokenFaucet } from '../tokenFaucet';
import {
	JupiterClient,
	QuoteResponse,
	SwapMode,
} from '../jupiter/jupiterClient';
import { TxHandler } from '../tx/txHandler';
import { IUser } from '../user/types';

type RemainingAccountParams = {
	userAccounts: UserAccount[];
	writablePerpMarketIndexes?: number[];
	writableSpotMarketIndexes?: number[];
	readablePerpMarketIndex?: number | number[];
	readableSpotMarketIndexes?: number[];
	useMarketLastSlotCache?: boolean;
};

export interface IDriftClient {
	// Properties
	connection: Connection;
	wallet: IWallet;
	program: Program;
	provider: AnchorProvider;
	env: DriftEnv;
	opts?: ConfirmOptions;
	useHotWalletAdmin?: boolean;
	users: Map<string, IUser>;
	userStats?: IUserStats;
	activeSubAccountId: number;
	userAccountSubscriptionConfig: UserSubscriptionConfig;
	userStatsAccountSubscriptionConfig: UserStatsSubscriptionConfig;
	accountSubscriber: DriftClientAccountSubscriber;
	eventEmitter: StrictEventEmitter<EventEmitter, DriftClientAccountEvents>;
	metricsEventEmitter: StrictEventEmitter<
		EventEmitter,
		DriftClientMetricsEvents
	>;
	txSender: TxSender;
	perpMarketLastSlotCache: Map<number, number>;
	spotMarketLastSlotCache: Map<number, number>;
	mustIncludePerpMarketIndexes: Set<number>;
	mustIncludeSpotMarketIndexes: Set<number>;
	authority: PublicKey;
	/** @deprecated use marketLookupTables */
	marketLookupTable: PublicKey;
	/** @deprecated use lookupTableAccounts */
	lookupTableAccount: AddressLookupTableAccount;
	marketLookupTables: PublicKey[];
	lookupTableAccounts: AddressLookupTableAccount[];
	includeDelegates?: boolean;
	authoritySubAccountMap?: Map<string, number[]>;
	skipLoadUsers?: boolean;
	txVersion: TransactionVersion;
	txParams: TxParams;
	enableMetricsEvents?: boolean;
	receiverProgram?: Program<PythSolanaReceiver>;
	wormholeProgram?: Program<WormholeCoreBridgeSolana>;
	sbOnDemandProgramdId: PublicKey;
	sbOnDemandProgram?: Program30<Idl30>;
	sbProgramFeedConfigs?: Map<string, any>;
	statePublicKey?: PublicKey;
	signerPublicKey?: PublicKey;

	get isSubscribed(): boolean;
	set isSubscribed(val: boolean);

	// Methods
	getUserMapKey(subAccountId: number, authority: PublicKey): string;
	createUser(
		subAccountId: number,
		accountSubscriptionConfig: UserSubscriptionConfig,
		authority?: PublicKey
	): IUser;
	subscribe(): Promise<boolean>;
	subscribeUsers(): Promise<boolean>[];

	/**
	 * Forces the accountSubscriber to fetch account updates from rpc
	 */
	fetchAccounts(): Promise<void>;

	unsubscribe(): Promise<void>;
	unsubscribeUsers(): Promise<void>[];
	getStatePublicKey(): Promise<PublicKey>;
	getSignerPublicKey(): PublicKey;
	getStateAccount(): StateAccount;

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 */
	forceGetStateAccount(): Promise<StateAccount>;

	getPerpMarketAccount(marketIndex: number): PerpMarketAccount | undefined;

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 * @param marketIndex
	 */
	forceGetPerpMarketAccount(
		marketIndex: number
	): Promise<PerpMarketAccount | undefined>;

	getPerpMarketAccounts(): PerpMarketAccount[];
	getSpotMarketAccount(marketIndex: number): SpotMarketAccount | undefined;

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 * @param marketIndex
	 */
	forceGetSpotMarketAccount(
		marketIndex: number
	): Promise<SpotMarketAccount | undefined>;

	getSpotMarketAccounts(): SpotMarketAccount[];
	getQuoteSpotMarketAccount(): SpotMarketAccount;
	getOraclePriceDataAndSlot(
		oraclePublicKey: PublicKey,
		oracleSource: OracleSource
	): DataAndSlot<OraclePriceData> | undefined;
	getSerumV3FulfillmentConfig(
		serumMarket: PublicKey
	): Promise<SerumV3FulfillmentConfigAccount>;
	getSerumV3FulfillmentConfigs(): Promise<SerumV3FulfillmentConfigAccount[]>;
	getPhoenixV1FulfillmentConfig(
		phoenixMarket: PublicKey
	): Promise<PhoenixV1FulfillmentConfigAccount>;
	getPhoenixV1FulfillmentConfigs(): Promise<
		PhoenixV1FulfillmentConfigAccount[]
	>;
	getOpenbookV2FulfillmentConfig(
		openbookMarket: PublicKey
	): Promise<OpenbookV2FulfillmentConfigAccount>;
	getOpenbookV2FulfillmentConfigs(): Promise<
		OpenbookV2FulfillmentConfigAccount[]
	>;

	/** @deprecated use fetchAllLookupTableAccounts() */
	fetchMarketLookupTableAccount(): Promise<AddressLookupTableAccount>;

	fetchAllLookupTableAccounts(): Promise<AddressLookupTableAccount[]>;

	/**
	 * Update the wallet to use for drift transactions and linked user account
	 * @param newWallet
	 * @param subAccountIds
	 * @param activeSubAccountId
	 * @param includeDelegates
	 */
	updateWallet(
		newWallet: IWallet,
		subAccountIds?: number[],
		activeSubAccountId?: number,
		includeDelegates?: boolean,
		authoritySubaccountMap?: Map<string, number[]>
	): Promise<boolean>;

	/**
	 * Update the subscribed accounts to a given authority, while leaving the
	 * connected wallet intact. This allows a user to emulate another user's
	 * account on the UI and sign permissionless transactions with their own wallet.
	 * @param emulateAuthority
	 */
	emulateAccount(emulateAuthority: PublicKey): Promise<boolean>;

	switchActiveUser(subAccountId: number, authority?: PublicKey): Promise<void>;
	addUser(
		subAccountId: number,
		authority?: PublicKey,
		userAccount?: UserAccount
	): Promise<boolean>;

	/**
	 * Adds and subscribes to users based on params set by the constructor or by updateWallet.
	 */
	addAndSubscribeToUsers(authority?: PublicKey): Promise<boolean>;

	/**
	 * Returns the instructions to initialize a user account and the public key of the user account.
	 * @param subAccountId
	 * @param name
	 * @param referrerInfo
	 * @returns [instructions, userAccountPublicKey]
	 */
	getInitializeUserAccountIxs(
		subAccountId?: number,
		name?: string,
		referrerInfo?: ReferrerInfo,
		poolId?: number
	): Promise<[TransactionInstruction[], PublicKey]>;

	/**
	 * Initializes a user account and returns the transaction signature and the public key of the user account.
	 * @param subAccountId
	 * @param name
	 * @param referrerInfo
	 * @param txParams
	 * @returns [transactionSignature, userAccountPublicKey]
	 */
	initializeUserAccount(
		subAccountId?: number,
		name?: string,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<[TransactionSignature, PublicKey]>;

	getInitializeUserStatsIx(): Promise<TransactionInstruction>;
	initializeSignedMsgUserOrders(
		authority: PublicKey,
		numOrders: number,
		txParams?: TxParams
	): Promise<[TransactionSignature, PublicKey]>;
	getInitializeSignedMsgUserOrdersAccountIx(
		authority: PublicKey,
		numOrders: number
	): Promise<[PublicKey, TransactionInstruction]>;
	resizeSignedMsgUserOrders(
		authority: PublicKey,
		numOrders: number,
		userSubaccountId?: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getResizeSignedMsgUserOrdersInstruction(
		authority: PublicKey,
		numOrders: number,
		userSubaccountId?: number
	): Promise<TransactionInstruction>;
	initializeSignedMsgWsDelegatesAccount(
		authority: PublicKey,
		delegates?: PublicKey[],
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getInitializeSignedMsgWsDelegatesAccountIx(
		authority: PublicKey,
		delegates?: PublicKey[]
	): Promise<TransactionInstruction>;
	addSignedMsgWsDelegate(
		authority: PublicKey,
		delegate: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getAddSignedMsgWsDelegateIx(
		authority: PublicKey,
		delegate: PublicKey
	): Promise<TransactionInstruction>;
	removeSignedMsgWsDelegate(
		authority: PublicKey,
		delegate: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getRemoveSignedMsgWsDelegateIx(
		authority: PublicKey,
		delegate: PublicKey
	): Promise<TransactionInstruction>;
	initializeFuelOverflow(authority?: PublicKey): Promise<TransactionSignature>;
	getInitializeFuelOverflowIx(
		authority?: PublicKey
	): Promise<TransactionInstruction>;
	sweepFuel(authority?: PublicKey): Promise<TransactionSignature>;
	getSweepFuelIx(authority?: PublicKey): Promise<TransactionInstruction>;
	getNextSubAccountId(): Promise<number>;
	initializeReferrerName(name: string): Promise<TransactionSignature>;
	updateUserName(
		name: string,
		subAccountId?: number
	): Promise<TransactionSignature>;
	updateUserCustomMarginRatio(
		updates: { marginRatio: number; subAccountId: number }[],
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getUpdateUserCustomMarginRatioIx(
		marginRatio: number,
		subAccountId?: number
	): Promise<TransactionInstruction>;
	getUpdateUserMarginTradingEnabledIx(
		marginTradingEnabled: boolean,
		subAccountId?: number,
		userAccountPublicKey?: PublicKey
	): Promise<TransactionInstruction>;
	updateUserMarginTradingEnabled(
		updates: { marginTradingEnabled: boolean; subAccountId: number }[]
	): Promise<TransactionSignature>;
	updateUserDelegate(
		delegate: PublicKey,
		subAccountId?: number
	): Promise<TransactionSignature>;
	updateUserAdvancedLp(
		updates: { advancedLp: boolean; subAccountId: number }[]
	): Promise<TransactionSignature>;
	getUpdateAdvancedDlpIx(
		advancedLp: boolean,
		subAccountId: number
	): Promise<TransactionInstruction>;
	updateUserReduceOnly(
		updates: { reduceOnly: boolean; subAccountId: number }[]
	): Promise<TransactionSignature>;
	getUpdateUserReduceOnlyIx(
		reduceOnly: boolean,
		subAccountId: number
	): Promise<TransactionInstruction>;
	updateUserPoolId(
		updates: { poolId: number; subAccountId: number }[]
	): Promise<TransactionSignature>;
	getUpdateUserPoolIdIx(
		poolId: number,
		subAccountId: number
	): Promise<TransactionInstruction>;
	fetchAllUserAccounts(
		includeIdle?: boolean
	): Promise<ProgramAccount<UserAccount>[]>;
	getUserAccountsForDelegate(delegate: PublicKey): Promise<UserAccount[]>;
	getUserAccountsAndAddressesForAuthority(
		authority: PublicKey
	): Promise<ProgramAccount<UserAccount>[]>;
	getUserAccountsForAuthority(authority: PublicKey): Promise<UserAccount[]>;
	getReferredUserStatsAccountsByReferrer(
		referrer: PublicKey
	): Promise<UserStatsAccount[]>;
	getReferrerNameAccountsForAuthority(
		authority: PublicKey
	): Promise<ReferrerNameAccount[]>;
	deleteUser(
		subAccountId?: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getUserDeletionIx(
		userAccountPublicKey: PublicKey
	): Promise<TransactionInstruction>;
	forceDeleteUser(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getForceDeleteUserIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount
	): Promise<TransactionInstruction>;
	deleteSignedMsgUserOrders(txParams?: TxParams): Promise<TransactionSignature>;
	getSignedMsgUserOrdersDeletionIx(
		authority: PublicKey
	): Promise<TransactionInstruction>;

	/**
	 * Checks if a SignedMsg User Orders account exists for the given authority.
	 * The account pubkey is derived using the program ID and authority as seeds.
	 * Makes an RPC call to check if the account exists on-chain.
	 *
	 * @param authority The authority public key to check for
	 * @returns Promise that resolves to true if the account exists, false otherwise
	 */
	isSignedMsgUserOrdersAccountInitialized(
		authority: PublicKey
	): Promise<boolean>;

	reclaimRent(
		subAccountId?: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getReclaimRentIx(
		userAccountPublicKey: PublicKey
	): Promise<TransactionInstruction>;
	getUser(subAccountId?: number, authority?: PublicKey): IUser;
	hasUser(subAccountId?: number, authority?: PublicKey): boolean;
	getUsers(): IUser[];
	getUserStats(): IUserStats;
	fetchReferrerNameAccount(
		name: string
	): Promise<ReferrerNameAccount | undefined>;
	getUserStatsAccountPublicKey(): PublicKey;
	getUserAccountPublicKey(
		subAccountId?: number,
		authority?: PublicKey
	): Promise<PublicKey>;
	getUserAccount(
		subAccountId?: number,
		authority?: PublicKey
	): UserAccount | undefined;

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 * @param subAccountId
	 */
	forceGetUserAccount(
		subAccountId?: number,
		authority?: PublicKey
	): Promise<UserAccount | undefined>;

	getUserAccountAndSlot(
		subAccountId?: number,
		authority?: PublicKey
	): DataAndSlot<UserAccount> | undefined;
	getSpotPosition(
		marketIndex: number,
		subAccountId?: number
	): SpotPosition | undefined;
	getQuoteAssetTokenAmount(): BN;

	/**
	 * Returns the token amount for a given market. The spot market precision is based on the token mint decimals.
	 * Positive if it is a deposit, negative if it is a borrow.
	 * @param marketIndex
	 */
	getTokenAmount(marketIndex: number): BN;

	/**
	 * Converts an amount to the spot precision for a given market. The spot market precision is based on the token mint decimals.
	 * @param marketIndex
	 * @param amount
	 */
	convertToSpotPrecision(marketIndex: number, amount: BN | number): BN;

	/**
	 * Converts an amount to the perp precision. The perp market precision is {@link BASE_PRECISION} (1e9).
	 * @param amount
	 */
	convertToPerpPrecision(amount: BN | number): BN;

	/**
	 * Converts an amount to the price precision. The perp market precision is {@link PRICE_PRECISION} (1e6).
	 * @param amount
	 */
	convertToPricePrecision(amount: BN | number): BN;

	/**
	 * Each drift instruction must include perp and sport market accounts in the ix remaining accounts.
	 * Use this function to force a subset of markets to be included in the remaining accounts for every ix
	 *
	 * @param perpMarketIndexes
	 * @param spotMarketIndexes
	 */
	mustIncludeMarketsInIx(params: {
		perpMarketIndexes: number[];
		spotMarketIndexes: number[];
	}): void;

	getRemainingAccounts(params: RemainingAccountParams): AccountMeta[];
	addPerpMarketToRemainingAccountMaps(
		marketIndex: number,
		writable: boolean,
		oracleAccountMap: Map<string, AccountMeta>,
		spotMarketAccountMap: Map<number, AccountMeta>,
		perpMarketAccountMap: Map<number, AccountMeta>
	): void;
	addSpotMarketToRemainingAccountMaps(
		marketIndex: number,
		writable: boolean,
		oracleAccountMap: Map<string, AccountMeta>,
		spotMarketAccountMap: Map<number, AccountMeta>
	): void;
	getRemainingAccountMapsForUsers(userAccounts: UserAccount[]): {
		oracleAccountMap: Map<string, AccountMeta>;
		spotMarketAccountMap: Map<number, AccountMeta>;
		perpMarketAccountMap: Map<number, AccountMeta>;
	};
	getOrder(orderId: number, subAccountId?: number): Order | undefined;
	getOrderByUserId(
		userOrderId: number,
		subAccountId?: number
	): Order | undefined;

	/**
	 * Get the associated token address for the given spot market
	 * @param marketIndex
	 * @param useNative
	 * @param tokenProgram
	 */
	getAssociatedTokenAccount(
		marketIndex: number,
		useNative?: boolean,
		tokenProgram?: PublicKey
	): Promise<PublicKey>;

	createAssociatedTokenAccountIdempotentInstruction(
		account: PublicKey,
		payer: PublicKey,
		owner: PublicKey,
		mint: PublicKey,
		tokenProgram?: PublicKey
	): TransactionInstruction;
	getDepositTxnIx(
		amount: BN,
		marketIndex: number,
		associatedTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly?: boolean
	): Promise<TransactionInstruction[]>;
	createDepositTxn(
		amount: BN,
		marketIndex: number,
		associatedTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly?: boolean,
		txParams?: TxParams,
		initSwiftAccount?: boolean
	): Promise<VersionedTransaction | Transaction>;

	/**
	 * Deposit funds into the given spot market
	 *
	 * @param amount to deposit
	 * @param marketIndex spot market index to deposit into
	 * @param associatedTokenAccount can be the wallet public key if using native sol
	 * @param subAccountId subaccountId to deposit
	 * @param reduceOnly if true, deposit must not increase account risk
	 */
	deposit(
		amount: BN,
		marketIndex: number,
		associatedTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly?: boolean,
		txParams?: TxParams,
		initSwiftAccount?: boolean
	): Promise<TransactionSignature>;

	getDepositInstruction(
		amount: BN,
		marketIndex: number,
		userTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly?: boolean,
		userInitialized?: boolean
	): Promise<TransactionInstruction>;
	getWrappedSolAccountCreationIxs(
		amount: BN,
		includeRent?: boolean
	): Promise<{
		ixs: TransactionInstruction[];
		/** @deprecated - this array is always going to be empty, in the current implementation */ signers: Signer[];
		pubkey: PublicKey;
	}>;
	getTokenProgramForSpotMarket(spotMarketAccount: SpotMarketAccount): PublicKey;
	isToken2022(spotMarketAccount: SpotMarketAccount): boolean;
	isTransferHook(spotMarketAccount: SpotMarketAccount): boolean;
	addTokenMintToRemainingAccounts(
		spotMarketAccount: SpotMarketAccount,
		remainingAccounts: AccountMeta[]
	): void;
	addExtraAccountMetasToRemainingAccounts(
		mint: PublicKey,
		remainingAccounts: AccountMeta[]
	): Promise<void>;
	getAssociatedTokenAccountCreationIx(
		tokenMintAddress: PublicKey,
		associatedTokenAddress: PublicKey,
		tokenProgram: PublicKey
	): TransactionInstruction;
	createInitializeUserAccountAndDepositCollateralIxs(
		amount: BN,
		userTokenAccount: PublicKey,
		marketIndex?: number,
		subAccountId?: number,
		name?: string,
		fromSubAccountId?: number,
		referrerInfo?: ReferrerInfo,
		donateAmount?: BN,
		customMaxMarginRatio?: number,
		poolId?: number
	): Promise<{
		ixs: TransactionInstruction[];
		userAccountPublicKey: PublicKey;
	}>;
	createInitializeUserAccountAndDepositCollateral(
		amount: BN,
		userTokenAccount: PublicKey,
		marketIndex?: number,
		subAccountId?: number,
		name?: string,
		fromSubAccountId?: number,
		referrerInfo?: ReferrerInfo,
		donateAmount?: BN,
		txParams?: TxParams,
		customMaxMarginRatio?: number,
		poolId?: number
	): Promise<[Transaction | VersionedTransaction, PublicKey]>;

	/**
	 * Creates the User account for a user, and deposits some initial collateral
	 * @param amount
	 * @param userTokenAccount
	 * @param marketIndex
	 * @param subAccountId
	 * @param name
	 * @param fromSubAccountId
	 * @param referrerInfo
	 * @param donateAmount
	 * @param txParams
	 * @returns
	 */
	initializeUserAccountAndDepositCollateral(
		amount: BN,
		userTokenAccount: PublicKey,
		marketIndex?: number,
		subAccountId?: number,
		name?: string,
		fromSubAccountId?: number,
		referrerInfo?: ReferrerInfo,
		donateAmount?: BN,
		txParams?: TxParams,
		customMaxMarginRatio?: number,
		poolId?: number
	): Promise<[TransactionSignature, PublicKey]>;

	initializeUserAccountForDevnet(
		subAccountId?: number,
		name?: string,
		marketIndex?: number,
		tokenFaucet?: TokenFaucet,
		amount?: BN,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<[TransactionSignature, PublicKey]>;
	getWithdrawalIxs(
		amount: BN,
		marketIndex: number,
		associatedTokenAddress: PublicKey,
		reduceOnly?: boolean,
		subAccountId?: number,
		updateFuel?: boolean
	): Promise<TransactionInstruction[]>;

	/**
	 * Withdraws from a user account. If deposit doesn't already exist, creates a borrow
	 * @param amount
	 * @param marketIndex
	 * @param associatedTokenAddress - the token account to withdraw to. can be the wallet public key if using native sol
	 * @param reduceOnly
	 */
	withdraw(
		amount: BN,
		marketIndex: number,
		associatedTokenAddress: PublicKey,
		reduceOnly?: boolean,
		subAccountId?: number,
		txParams?: TxParams,
		updateFuel?: boolean
	): Promise<TransactionSignature>;

	withdrawAllDustPositions(
		subAccountId?: number,
		txParams?: TxParams,
		opts?: { dustPositionCountCallback?: (count: number) => void }
	): Promise<TransactionSignature | undefined>;
	getWithdrawIx(
		amount: BN,
		marketIndex: number,
		userTokenAccount: PublicKey,
		reduceOnly?: boolean,
		subAccountId?: number
	): Promise<TransactionInstruction>;

	/**
	 * Withdraws from the fromSubAccount and deposits into the toSubAccount
	 * @param amount
	 * @param marketIndex
	 * @param fromSubAccountId
	 * @param toSubAccountId
	 * @param txParams
	 */
	transferDeposit(
		amount: BN,
		marketIndex: number,
		fromSubAccountId: number,
		toSubAccountId: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;

	getTransferDepositIx(
		amount: BN,
		marketIndex: number,
		fromSubAccountId: number,
		toSubAccountId: number
	): Promise<TransactionInstruction>;
	transferPools(
		depositFromMarketIndex: number,
		depositToMarketIndex: number,
		borrowFromMarketIndex: number,
		borrowToMarketIndex: number,
		depositAmount: BN | undefined,
		borrowAmount: BN | undefined,
		fromSubAccountId: number,
		toSubAccountId: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getTransferPoolsIx(
		depositFromMarketIndex: number,
		depositToMarketIndex: number,
		borrowFromMarketIndex: number,
		borrowToMarketIndex: number,
		depositAmount: BN | undefined,
		borrowAmount: BN | undefined,
		fromSubAccountId: number,
		toSubAccountId: number,
		isToNewSubAccount?: boolean
	): Promise<TransactionInstruction>;
	transferPerpPosition(
		fromSubAccountId: number,
		toSubAccountId: number,
		marketIndex: number,
		amount: BN,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getTransferPerpPositionIx(
		fromSubAccountId: number,
		toSubAccountId: number,
		marketIndex: number,
		amount: BN
	): Promise<TransactionInstruction>;
	updateSpotMarketCumulativeInterest(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	updateSpotMarketCumulativeInterestIx(
		marketIndex: number
	): Promise<TransactionInstruction>;
	settleLP(
		settleeUserAccountPublicKey: PublicKey,
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	settleLPIx(
		settleeUserAccountPublicKey: PublicKey,
		marketIndex: number
	): Promise<TransactionInstruction>;
	removePerpLpShares(
		marketIndex: number,
		sharesToBurn?: BN,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	removePerpLpSharesInExpiringMarket(
		marketIndex: number,
		userAccountPublicKey: PublicKey,
		sharesToBurn?: BN,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getRemovePerpLpSharesInExpiringMarket(
		marketIndex: number,
		userAccountPublicKey: PublicKey,
		sharesToBurn?: BN
	): Promise<TransactionInstruction>;
	getRemovePerpLpSharesIx(
		marketIndex: number,
		sharesToBurn?: BN,
		subAccountId?: number
	): Promise<TransactionInstruction>;
	addPerpLpShares(
		amount: BN,
		marketIndex: number,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	getAddPerpLpSharesIx(
		amount: BN,
		marketIndex: number,
		subAccountId?: number
	): Promise<TransactionInstruction>;
	getQuoteValuePerLpShare(marketIndex: number): BN;

	/**
	 * @deprecated use {@link placePerpOrder} or {@link placeAndTakePerpOrder} instead
	 */
	openPosition(
		direction: PositionDirection,
		amount: BN,
		marketIndex: number,
		limitPrice?: BN,
		subAccountId?: number
	): Promise<TransactionSignature>;

	sendSignedTx(
		tx: Transaction | VersionedTransaction,
		opts?: ConfirmOptions
	): Promise<TransactionSignature>;
	prepareMarketOrderTxs(
		orderParams: OptionalOrderParams,
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		makerInfo?: MakerInfo | MakerInfo[],
		txParams?: TxParams,
		bracketOrdersParams?: OptionalOrderParams[],
		referrerInfo?: ReferrerInfo,
		cancelExistingOrders?: boolean,
		settlePnl?: boolean
	): Promise<{
		cancelExistingOrdersTx?: Transaction | VersionedTransaction;
		settlePnlTx?: Transaction | VersionedTransaction;
		fillTx?: Transaction | VersionedTransaction;
		marketOrderTx: Transaction | VersionedTransaction;
	}>;

	/**
	 * Sends a market order and returns a signed tx which can fill the order against the vamm, which the caller can use to fill their own order if required.
	 * @param orderParams
	 * @param userAccountPublicKey
	 * @param userAccount
	 * @param makerInfo
	 * @param txParams
	 * @param bracketOrdersParams
	 * @param cancelExistingOrders - Builds and returns an extra transaciton to cancel the existing orders in the same perp market. Intended use is to auto-cancel TP/SL orders when closing a position. Ignored if orderParams.marketType is not MarketType.PERP
	 * @returns
	 */
	sendMarketOrderAndGetSignedFillTx(
		orderParams: OptionalOrderParams,
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		makerInfo?: MakerInfo | MakerInfo[],
		txParams?: TxParams,
		bracketOrdersParams?: OptionalOrderParams[],
		referrerInfo?: ReferrerInfo,
		cancelExistingOrders?: boolean,
		settlePnl?: boolean
	): Promise<{
		txSig: TransactionSignature;
		signedFillTx?: Transaction;
		signedCancelExistingOrdersTx?: Transaction;
		signedSettlePnlTx?: Transaction;
	}>;

	placePerpOrder(
		orderParams: OptionalOrderParams,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	getPlacePerpOrderIx(
		orderParams: OptionalOrderParams,
		subAccountId?: number,
		depositToTradeArgs?: {
			isMakingNewAccount: boolean;
			depositMarketIndex: number;
		}
	): Promise<TransactionInstruction>;
	updateAMMs(
		marketIndexes: number[],
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getUpdateAMMsIx(marketIndexes: number[]): Promise<TransactionInstruction>;
	settleExpiredMarket(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getSettleExpiredMarketIx(
		marketIndex: number
	): Promise<TransactionInstruction>;
	settleExpiredMarketPoolsToRevenuePool(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getSettleExpiredMarketPoolsToRevenuePoolIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction>;
	cancelOrder(
		orderId?: number,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	getCancelOrderIx(
		orderId?: number,
		subAccountId?: number
	): Promise<TransactionInstruction>;
	cancelOrderByUserId(
		userOrderId: number,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	getCancelOrderByUserIdIx(
		userOrderId: number,
		subAccountId?: number
	): Promise<TransactionInstruction>;
	cancelOrdersByIds(
		orderIds?: number[],
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	getCancelOrdersByIdsIx(
		orderIds?: number[],
		subAccountId?: number
	): Promise<TransactionInstruction>;
	cancelOrders(
		marketType?: MarketType,
		marketIndex?: number,
		direction?: PositionDirection,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	getCancelOrdersIx(
		marketType: MarketType | null,
		marketIndex: number | null,
		direction: PositionDirection | null,
		subAccountId?: number
	): Promise<TransactionInstruction>;
	cancelAndPlaceOrders(
		cancelOrderParams: {
			marketType?: MarketType;
			marketIndex?: number;
			direction?: PositionDirection;
		},
		placeOrderParams: OrderParams[],
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	placeOrders(
		params: OrderParams[],
		txParams?: TxParams,
		subAccountId?: number,
		optionalIxs?: TransactionInstruction[]
	): Promise<TransactionSignature>;
	preparePlaceOrdersTx(
		params: OrderParams[],
		txParams?: TxParams,
		subAccountId?: number,
		optionalIxs?: TransactionInstruction[]
	): Promise<{
		placeOrdersTx: Transaction | VersionedTransaction;
	}>;
	getPlaceOrdersIx(
		params: OptionalOrderParams[],
		subAccountId?: number
	): Promise<TransactionInstruction>;
	fillPerpOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order?: Pick<Order, 'marketIndex' | 'orderId'>,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		fillerSubAccountId?: number,
		fillerAuthority?: PublicKey
	): Promise<TransactionSignature>;
	getFillPerpOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order: Pick<Order, 'marketIndex' | 'orderId'>,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		fillerSubAccountId?: number,
		isSignedMsg?: boolean,
		fillerAuthority?: PublicKey
	): Promise<TransactionInstruction>;
	getRevertFillIx(fillerPublicKey?: PublicKey): Promise<TransactionInstruction>;
	placeSpotOrder(
		orderParams: OptionalOrderParams,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	preparePlaceSpotOrderTx(
		orderParams: OptionalOrderParams,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<{
		placeSpotOrderTx: Transaction | VersionedTransaction;
	}>;
	getPlaceSpotOrderIx(
		orderParams: OptionalOrderParams,
		subAccountId?: number
	): Promise<TransactionInstruction>;
	fillSpotOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order?: Pick<Order, 'marketIndex' | 'orderId'>,
		fulfillmentConfig?:
			| SerumV3FulfillmentConfigAccount
			| PhoenixV1FulfillmentConfigAccount
			| OpenbookV2FulfillmentConfigAccount,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getFillSpotOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order?: Pick<Order, 'marketIndex' | 'orderId'>,
		fulfillmentConfig?:
			| SerumV3FulfillmentConfigAccount
			| PhoenixV1FulfillmentConfigAccount
			| OpenbookV2FulfillmentConfigAccount,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction>;
	addSpotFulfillmentAccounts(
		marketIndex: number,
		remainingAccounts: AccountMeta[],
		fulfillmentConfig?:
			| SerumV3FulfillmentConfigAccount
			| PhoenixV1FulfillmentConfigAccount
			| OpenbookV2FulfillmentConfigAccount
	): void;
	addSerumRemainingAccounts(
		marketIndex: number,
		remainingAccounts: AccountMeta[],
		fulfillmentConfig: SerumV3FulfillmentConfigAccount
	): void;
	addPhoenixRemainingAccounts(
		marketIndex: number,
		remainingAccounts: AccountMeta[],
		fulfillmentConfig: PhoenixV1FulfillmentConfigAccount
	): void;
	addOpenbookRemainingAccounts(
		marketIndex: number,
		remainingAccounts: AccountMeta[],
		fulfillmentConfig: OpenbookV2FulfillmentConfigAccount
	): void;

	/**
	 * Swap tokens in drift account using jupiter
	 * @param jupiterClient jupiter client to find routes and jupiter instructions
	 * @param outMarketIndex the market index of the token you're buying
	 * @param inMarketIndex the market index of the token you're selling
	 * @param outAssociatedTokenAccount the token account to receive the token being sold on jupiter
	 * @param inAssociatedTokenAccount the token account to
	 * @param amount the amount of TokenIn, regardless of swapMode
	 * @param slippageBps the max slippage passed to jupiter api
	 * @param swapMode jupiter swapMode (ExactIn or ExactOut), default is ExactIn
	 * @param route the jupiter route to use for the swap
	 * @param reduceOnly specify if In or Out token on the drift account must reduceOnly, checked at end of swap
	 * @param v6 pass in the quote response from Jupiter quote's API (deprecated, use quote instead)
	 * @param quote pass in the quote response from Jupiter quote's API
	 * @param txParams
	 */
	swap({
		jupiterClient,
		outMarketIndex,
		inMarketIndex,
		outAssociatedTokenAccount,
		inAssociatedTokenAccount,
		amount,
		slippageBps,
		swapMode,
		reduceOnly,
		txParams,
		v6,
		quote,
		onlyDirectRoutes,
	}: {
		jupiterClient: JupiterClient;
		outMarketIndex: number;
		inMarketIndex: number;
		outAssociatedTokenAccount?: PublicKey;
		inAssociatedTokenAccount?: PublicKey;
		amount: BN;
		slippageBps?: number;
		swapMode?: SwapMode;
		reduceOnly?: SwapReduceOnly;
		txParams?: TxParams;
		onlyDirectRoutes?: boolean;
		v6?: {
			quote?: QuoteResponse;
		};
		quote?: QuoteResponse;
	}): Promise<TransactionSignature>;

	getJupiterSwapIxV6({
		jupiterClient,
		outMarketIndex,
		inMarketIndex,
		outAssociatedTokenAccount,
		inAssociatedTokenAccount,
		amount,
		slippageBps,
		swapMode,
		onlyDirectRoutes,
		quote,
		reduceOnly,
		userAccountPublicKey,
	}: {
		jupiterClient: JupiterClient;
		outMarketIndex: number;
		inMarketIndex: number;
		outAssociatedTokenAccount?: PublicKey;
		inAssociatedTokenAccount?: PublicKey;
		amount: BN;
		slippageBps?: number;
		swapMode?: SwapMode;
		onlyDirectRoutes?: boolean;
		quote?: QuoteResponse;
		reduceOnly?: SwapReduceOnly;
		userAccountPublicKey?: PublicKey;
	}): Promise<{
		ixs: TransactionInstruction[];
		lookupTables: AddressLookupTableAccount[];
	}>;

	/**
	 * Get the drift begin_swap and end_swap instructions
	 *
	 * @param outMarketIndex the market index of the token you're buying
	 * @param inMarketIndex the market index of the token you're selling
	 * @param amountIn the amount of the token to sell
	 * @param inTokenAccount the token account to move the tokens being sold
	 * @param outTokenAccount the token account to receive the tokens being bought
	 * @param limitPrice the limit price of the swap
	 * @param reduceOnly
	 * @param userAccountPublicKey optional, specify a custom userAccountPublicKey to use instead of getting the current user account; can be helpful if the account is being created within the current tx
	 */
	getSwapIx({
		outMarketIndex,
		inMarketIndex,
		amountIn,
		inTokenAccount,
		outTokenAccount,
		limitPrice,
		reduceOnly,
		userAccountPublicKey,
	}: {
		outMarketIndex: number;
		inMarketIndex: number;
		amountIn: BN;
		inTokenAccount: PublicKey;
		outTokenAccount: PublicKey;
		limitPrice?: BN;
		reduceOnly?: SwapReduceOnly;
		userAccountPublicKey?: PublicKey;
	}): Promise<{
		beginSwapIx: TransactionInstruction;
		endSwapIx: TransactionInstruction;
	}>;

	stakeForMSOL(params: { amount: BN }): Promise<TxSigAndSlot>;
	getStakeForMSOLIx({
		amount,
		userAccountPublicKey,
	}: {
		amount: BN;
		userAccountPublicKey?: PublicKey;
	}): Promise<TransactionInstruction[]>;
	triggerOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order: Order,
		txParams?: TxParams,
		fillerPublicKey?: PublicKey
	): Promise<TransactionSignature>;
	getTriggerOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order: Order,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction>;
	forceCancelOrders(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		txParams?: TxParams,
		fillerPublicKey?: PublicKey
	): Promise<TransactionSignature>;
	getForceCancelOrdersIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction>;
	updateUserIdle(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		txParams?: TxParams,
		fillerPublicKey?: PublicKey
	): Promise<TransactionSignature>;
	getUpdateUserIdleIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction>;
	logUserBalances(
		userAccountPublicKey: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getLogUserBalancesIx(
		userAccountPublicKey: PublicKey
	): Promise<TransactionInstruction>;
	updateUserFuelBonus(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		userAuthority: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getUpdateUserFuelBonusIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		userAuthority: PublicKey
	): Promise<TransactionInstruction>;
	updateUserStatsReferrerStatus(
		userAuthority: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getUpdateUserStatsReferrerStatusIx(
		userAuthority: PublicKey
	): Promise<TransactionInstruction>;
	updateUserOpenOrdersCount(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		txParams?: TxParams,
		fillerPublicKey?: PublicKey
	): Promise<TransactionSignature>;
	getUpdateUserOpenOrdersCountIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction>;
	placeAndTakePerpOrder(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		successCondition?: PlaceAndTakeOrderSuccessCondition,
		auctionDurationPercentage?: number,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	preparePlaceAndTakePerpOrderWithAdditionalOrders(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		bracketOrdersParams?: OptionalOrderParams[],
		txParams?: TxParams,
		subAccountId?: number,
		cancelExistingOrders?: boolean,
		settlePnl?: boolean,
		exitEarlyIfSimFails?: boolean,
		auctionDurationPercentage?: number,
		optionalIxs?: TransactionInstruction[]
	): Promise<{
		placeAndTakeTx: Transaction | VersionedTransaction;
		cancelExistingOrdersTx: Transaction | VersionedTransaction;
		settlePnlTx: Transaction | VersionedTransaction;
	}>;
	placeAndTakePerpWithAdditionalOrders(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		bracketOrdersParams?: OptionalOrderParams[],
		txParams?: TxParams,
		subAccountId?: number,
		cancelExistingOrders?: boolean,
		settlePnl?: boolean,
		exitEarlyIfSimFails?: boolean
	): Promise<{
		txSig: TransactionSignature;
		signedCancelExistingOrdersTx?: Transaction;
		signedSettlePnlTx?: Transaction;
	}>;
	getPlaceAndTakePerpOrderIx(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		successCondition?: PlaceAndTakeOrderSuccessCondition,
		auctionDurationPercentage?: number,
		subAccountId?: number
	): Promise<TransactionInstruction>;
	placeAndMakePerpOrder(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	getPlaceAndMakePerpOrderIx(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		referrerInfo?: ReferrerInfo,
		subAccountId?: number
	): Promise<TransactionInstruction>;
	signSignedMsgOrderParamsMessage(
		orderParamsMessage:
			| SignedMsgOrderParamsMessage
			| SignedMsgOrderParamsDelegateMessage,
		delegateSigner?: boolean
	): SignedMsgOrderParams;

	/*
	 * Borsh encode signedMsg taker order params
	 */
	encodeSignedMsgOrderParamsMessage(
		orderParamsMessage:
			| SignedMsgOrderParamsMessage
			| SignedMsgOrderParamsDelegateMessage,
		delegateSigner?: boolean
	): Buffer;

	/*
	 * Decode signedMsg taker order params from borsh buffer
	 */
	decodeSignedMsgOrderParamsMessage(
		encodedMessage: Buffer,
		delegateSigner?: boolean
	): SignedMsgOrderParamsMessage | SignedMsgOrderParamsDelegateMessage;

	signMessage(message: Uint8Array, keypair?: Keypair): Buffer;
	placeSignedMsgTakerOrder(
		signedSignedMsgOrderParams: SignedMsgOrderParams,
		marketIndex: number,
		takerInfo: {
			taker: PublicKey;
			takerStats: PublicKey;
			takerUserAccount: UserAccount;
			signingAuthority: PublicKey;
		},
		precedingIxs?: TransactionInstruction[],
		overrideCustomIxIndex?: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getPlaceSignedMsgTakerPerpOrderIxs(
		signedSignedMsgOrderParams: SignedMsgOrderParams,
		marketIndex: number,
		takerInfo: {
			taker: PublicKey;
			takerStats: PublicKey;
			takerUserAccount: UserAccount;
			signingAuthority: PublicKey;
		},
		precedingIxs?: TransactionInstruction[],
		overrideCustomIxIndex?: number
	): Promise<TransactionInstruction[]>;
	placeAndMakeSignedMsgPerpOrder(
		signedSignedMsgOrderParams: SignedMsgOrderParams,
		signedMsgOrderUuid: Uint8Array,
		takerInfo: {
			taker: PublicKey;
			takerStats: PublicKey;
			takerUserAccount: UserAccount;
			signingAuthority: PublicKey;
		},
		orderParams: OptionalOrderParams,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number,
		precedingIxs?: TransactionInstruction[],
		overrideCustomIxIndex?: number
	): Promise<TransactionSignature>;
	getPlaceAndMakeSignedMsgPerpOrderIxs(
		signedSignedMsgOrderParams: SignedMsgOrderParams,
		signedMsgOrderUuid: Uint8Array,
		takerInfo: {
			taker: PublicKey;
			takerStats: PublicKey;
			takerUserAccount: UserAccount;
			signingAuthority: PublicKey;
		},
		orderParams: OptionalOrderParams,
		referrerInfo?: ReferrerInfo,
		subAccountId?: number,
		precedingIxs?: TransactionInstruction[],
		overrideCustomIxIndex?: number
	): Promise<TransactionInstruction[]>;
	preparePlaceAndTakeSpotOrder(
		orderParams: OptionalOrderParams,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<{
		placeAndTakeSpotOrderTx: Transaction | VersionedTransaction;
	}>;
	placeAndTakeSpotOrder(
		orderParams: OptionalOrderParams,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	getPlaceAndTakeSpotOrderIx(
		orderParams: OptionalOrderParams,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		subAccountId?: number
	): Promise<TransactionInstruction>;
	placeAndMakeSpotOrder(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;
	getPlaceAndMakeSpotOrderIx(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		referrerInfo?: ReferrerInfo,
		subAccountId?: number
	): Promise<TransactionInstruction>;

	/**
	 * @deprecated use {@link placePerpOrder} or {@link placeAndTakePerpOrder} instead
	 */
	closePosition(
		marketIndex: number,
		limitPrice?: BN,
		subAccountId?: number
	): Promise<TransactionSignature>;

	/**
	 * Modifies an open order by closing it and replacing it with a new order.
	 * @deprecated use modifyOrder instead
	 * @param orderId: The open order to modify
	 * @param newBaseAmount: The new base amount for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newLimitPice: The new limit price for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newOraclePriceOffset: The new oracle price offset for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @returns
	 */
	modifyPerpOrder(
		orderId: number,
		newBaseAmount?: BN,
		newLimitPrice?: BN,
		newOraclePriceOffset?: number
	): Promise<TransactionSignature>;

	/**
	 * Modifies an open order by closing it and replacing it with a new order.
	 * @deprecated use modifyOrderByUserOrderId instead
	 * @param userOrderId: The open order to modify
	 * @param newBaseAmount: The new base amount for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newLimitPice: The new limit price for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newOraclePriceOffset: The new oracle price offset for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @returns
	 */
	modifyPerpOrderByUserOrderId(
		userOrderId: number,
		newBaseAmount?: BN,
		newLimitPrice?: BN,
		newOraclePriceOffset?: number
	): Promise<TransactionSignature>;

	/**
	 * Modifies an open order (spot or perp) by closing it and replacing it with a new order.
	 * @param orderParams.orderId: The open order to modify
	 * @param orderParams.newDirection: The new direction for the order
	 * @param orderParams.newBaseAmount: The new base amount for the order
	 * @param orderParams.newLimitPice: The new limit price for the order
	 * @param orderParams.newOraclePriceOffset: The new oracle price offset for the order
	 * @param orderParams.newTriggerPrice: Optional - Thew new trigger price for the order.
	 * @param orderParams.auctionDuration:
	 * @param orderParams.auctionStartPrice:
	 * @param orderParams.auctionEndPrice:
	 * @param orderParams.reduceOnly:
	 * @param orderParams.postOnly:
	 * @param orderParams.bitFlags:
	 * @param orderParams.policy:
	 * @param orderParams.maxTs:
	 * @returns
	 */
	modifyOrder(
		orderParams: {
			orderId: number;
			newDirection?: PositionDirection;
			newBaseAmount?: BN;
			newLimitPrice?: BN;
			newOraclePriceOffset?: number;
			newTriggerPrice?: BN;
			newTriggerCondition?: OrderTriggerCondition;
			auctionDuration?: number;
			auctionStartPrice?: BN;
			auctionEndPrice?: BN;
			reduceOnly?: boolean;
			postOnly?: boolean;
			bitFlags?: number;
			maxTs?: BN;
			policy?: number;
		},
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;

	getModifyOrderIx(
		orderParams: {
			orderId: number;
			newDirection?: PositionDirection;
			newBaseAmount?: BN;
			newLimitPrice?: BN;
			newOraclePriceOffset?: number;
			newTriggerPrice?: BN;
			newTriggerCondition?: OrderTriggerCondition;
			auctionDuration?: number;
			auctionStartPrice?: BN;
			auctionEndPrice?: BN;
			reduceOnly?: boolean;
			postOnly?: boolean;
			bitFlags?: number;
			maxTs?: BN;
			policy?: number;
		},
		subAccountId?: number
	): Promise<TransactionInstruction>;

	/**
	 * Modifies an open order by closing it and replacing it with a new order.
	 * @param orderParams.userOrderId: The open order to modify
	 * @param orderParams.newDirection: The new direction for the order
	 * @param orderParams.newBaseAmount: The new base amount for the order
	 * @param orderParams.newLimitPice: The new limit price for the order
	 * @param orderParams.newOraclePriceOffset: The new oracle price offset for the order
	 * @param orderParams.newTriggerPrice: Optional - Thew new trigger price for the order.
	 * @param orderParams.auctionDuration: Only required if order type changed to market from something else
	 * @param orderParams.auctionStartPrice: Only required if order type changed to market from something else
	 * @param orderParams.auctionEndPrice: Only required if order type changed to market from something else
	 * @param orderParams.reduceOnly:
	 * @param orderParams.postOnly:
	 * @param orderParams.bitFlags:
	 * @param orderParams.policy:
	 * @param orderParams.maxTs:
	 * @returns
	 */
	modifyOrderByUserOrderId(
		orderParams: {
			userOrderId: number;
			newDirection?: PositionDirection;
			newBaseAmount?: BN;
			newLimitPrice?: BN;
			newOraclePriceOffset?: number;
			newTriggerPrice?: BN;
			newTriggerCondition?: OrderTriggerCondition;
			auctionDuration?: number;
			auctionStartPrice?: BN;
			auctionEndPrice?: BN;
			reduceOnly?: boolean;
			postOnly?: boolean;
			bitFlags?: number;
			policy?: ModifyOrderPolicy;
			maxTs?: BN;
		},
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature>;

	getModifyOrderByUserIdIx(
		orderParams: {
			userOrderId: number;
			newDirection?: PositionDirection;
			newBaseAmount?: BN;
			newLimitPrice?: BN;
			newOraclePriceOffset?: number;
			newTriggerPrice?: BN;
			newTriggerCondition?: OrderTriggerCondition;
			auctionDuration?: number;
			auctionStartPrice?: BN;
			auctionEndPrice?: BN;
			reduceOnly?: boolean;
			postOnly?: boolean;
			bitFlags?: number;
			policy?: ModifyOrderPolicy;
			maxTs?: BN;
			txParams?: TxParams;
		},
		subAccountId?: number
	): Promise<TransactionInstruction>;
	settlePNLs(
		users: {
			settleeUserAccountPublicKey: PublicKey;
			settleeUserAccount: UserAccount;
		}[],
		marketIndexes: number[],
		opts?: {
			filterInvalidMarkets?: boolean;
		},
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getSettlePNLsIxs(
		users: {
			settleeUserAccountPublicKey: PublicKey;
			settleeUserAccount: UserAccount;
		}[],
		marketIndexes: number[]
	): Promise<TransactionInstruction[]>;
	settlePNL(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: number,
		txParams?: TxParams,
		optionalIxs?: TransactionInstruction[]
	): Promise<TransactionSignature>;
	settlePNLIx(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: number
	): Promise<TransactionInstruction>;
	settleMultiplePNLs(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndexes: number[],
		mode: SettlePnlMode,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	settleMultiplePNLsMultipleTxs(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndexes: number[],
		mode: SettlePnlMode,
		txParams?: TxParams,
		optionalIxs?: TransactionInstruction[]
	): Promise<TransactionSignature[]>;
	settleMultiplePNLsIx(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndexes: number[],
		mode: SettlePnlMode
	): Promise<TransactionInstruction>;
	getSetUserStatusToBeingLiquidatedIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount
	): Promise<TransactionInstruction>;
	setUserStatusToBeingLiquidated(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount
	): Promise<TransactionSignature>;
	liquidatePerp(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		maxBaseAssetAmount: BN,
		limitPrice?: BN,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature>;
	getLiquidatePerpIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		maxBaseAssetAmount: BN,
		limitPrice?: BN,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction>;
	liquidatePerpWithFill(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		makerInfos: MakerInfo[],
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature>;
	getLiquidatePerpWithFillIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		makerInfos: MakerInfo[],
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction>;
	liquidateSpot(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		assetMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature>;
	getLiquidateSpotIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		assetMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction>;
	getJupiterLiquidateSpotWithSwapIxV6(params: {
		jupiterClient: JupiterClient;
		liabilityMarketIndex: number;
		assetMarketIndex: number;
		swapAmount: BN;
		assetTokenAccount?: PublicKey;
		liabilityTokenAccount?: PublicKey;
		slippageBps?: number;
		swapMode?: SwapMode;
		onlyDirectRoutes?: boolean;
		quote?: QuoteResponse;
		userAccount: UserAccount;
		userAccountPublicKey: PublicKey;
		userStatsAccountPublicKey: PublicKey;
		liquidatorSubAccountId?: number;
		maxAccounts?: number;
	}): Promise<{
		ixs: TransactionInstruction[];
		lookupTables: AddressLookupTableAccount[];
	}>;

	/**
	 * Get the drift liquidate_spot_with_swap instructions
	 *
	 * @param liabilityMarketIndex the market index of the token you're buying
	 * @param assetMarketIndex the market index of the token you're selling
	 * @param amountIn the amount of the token to sell
	 * @param assetTokenAccount the token account to move the tokens being sold
	 * @param liabilityTokenAccount the token account to receive the tokens being bought
	 * @param userAccount
	 * @param userAccountPublicKey
	 * @param userStatsAccountPublicKey
	 */
	getLiquidateSpotWithSwapIx(params: {
		liabilityMarketIndex: number;
		assetMarketIndex: number;
		swapAmount: BN;
		assetTokenAccount: PublicKey;
		liabilityTokenAccount: PublicKey;
		userAccount: UserAccount;
		userAccountPublicKey: PublicKey;
		userStatsAccountPublicKey: PublicKey;
		liquidatorSubAccountId?: number;
	}): Promise<{
		beginSwapIx: TransactionInstruction;
		endSwapIx: TransactionInstruction;
	}>;

	getInsuranceFundSwapIx(params: {
		inMarketIndex: number;
		outMarketIndex: number;
		amountIn: BN;
		inTokenAccount: PublicKey;
		outTokenAccount: PublicKey;
	}): Promise<{
		beginSwapIx: TransactionInstruction;
		endSwapIx: TransactionInstruction;
	}>;
	liquidateBorrowForPerpPnl(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature>;
	getLiquidateBorrowForPerpPnlIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction>;
	liquidatePerpPnlForDeposit(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		assetMarketIndex: number,
		maxPnlTransfer: BN,
		limitPrice?: BN,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature>;
	getLiquidatePerpPnlForDepositIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		assetMarketIndex: number,
		maxPnlTransfer: BN,
		limitPrice?: BN,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction>;
	resolvePerpBankruptcy(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature>;
	getResolvePerpBankruptcyIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction>;
	resolveSpotBankruptcy(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature>;
	getResolveSpotBankruptcyIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction>;
	updateFundingRate(
		perpMarketIndex: number,
		oracle: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getUpdateFundingRateIx(
		perpMarketIndex: number,
		oracle: PublicKey
	): Promise<TransactionInstruction>;
	updatePrelaunchOracle(
		perpMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getUpdatePrelaunchOracleIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction>;
	updatePerpBidAskTwap(
		perpMarketIndex: number,
		makers: [PublicKey, PublicKey][],
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getUpdatePerpBidAskTwapIx(
		perpMarketIndex: number,
		makers: [PublicKey, PublicKey][]
	): Promise<TransactionInstruction>;
	settleFundingPayment(
		userAccountPublicKey: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getSettleFundingPaymentIx(
		userAccountPublicKey: PublicKey
	): Promise<TransactionInstruction>;
	triggerEvent(eventName: keyof DriftClientAccountEvents, data?: any): void;
	getOracleDataForPerpMarket(marketIndex: number): OraclePriceData;
	getMMOracleDataForPerpMarket(marketIndex: number): OraclePriceData;
	getOracleDataForSpotMarket(marketIndex: number): OraclePriceData;
	initializeInsuranceFundStake(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getInitializeInsuranceFundStakeIx(
		marketIndex: number
	): Promise<TransactionInstruction>;
	getAddInsuranceFundStakeIx(
		marketIndex: number,
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionInstruction>;

	/**
	 * Add to an insurance fund stake and optionally initialize the account
	 */
	addInsuranceFundStake(params: {
		/**
		 * Spot market index
		 */
		marketIndex: number;
		amount: BN;
		/**
		 * The account where the funds to stake come from. Usually an associated token account
		 */
		collateralAccountPublicKey: PublicKey;
		/**
		 * Add instructions to initialize the staking account -- required if its the first time the currrent authority has staked in this market
		 */
		initializeStakeAccount?: boolean;
		/**
		 * Optional -- withdraw from current subaccount to fund stake amount, instead of wallet balance
		 */
		fromSubaccount?: boolean;
		txParams?: TxParams;
	}): Promise<TransactionSignature>;

	/**
	 * Get instructions to add to an insurance fund stake and optionally initialize the account
	 */
	getAddInsuranceFundStakeIxs(params: {
		/**
		 * Spot market index
		 */
		marketIndex: number;
		amount: BN;
		/**
		 * The account where the funds to stake come from. Usually an associated token account
		 */
		collateralAccountPublicKey: PublicKey;
		/**
		 * Add instructions to initialize the staking account -- required if its the first time the currrent authority has staked in this market
		 */
		initializeStakeAccount?: boolean;
		/**
		 * Optional -- withdraw from current subaccount to fund stake amount, instead of wallet balance
		 */
		fromSubaccount?: boolean;
	}): Promise<TransactionInstruction[]>;

	requestRemoveInsuranceFundStake(
		marketIndex: number,
		amount: BN,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	cancelRequestRemoveInsuranceFundStake(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	removeInsuranceFundStake(
		marketIndex: number,
		collateralAccountPublicKey: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	updateUserQuoteAssetInsuranceStake(
		authority: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getUpdateUserQuoteAssetInsuranceStakeIx(
		authority: PublicKey
	): Promise<TransactionInstruction>;
	updateUserGovTokenInsuranceStake(
		authority: PublicKey,
		txParams?: TxParams,
		env?: DriftEnv
	): Promise<TransactionSignature>;
	getUpdateUserGovTokenInsuranceStakeIx(
		authority: PublicKey
	): Promise<TransactionInstruction>;
	getUpdateUserGovTokenInsuranceStakeDevnetIx(
		authority: PublicKey,
		amount?: BN
	): Promise<TransactionInstruction>;
	settleRevenueToInsuranceFund(
		spotMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getSettleRevenueToInsuranceFundIx(
		spotMarketIndex: number
	): Promise<TransactionInstruction>;
	resolvePerpPnlDeficit(
		spotMarketIndex: number,
		perpMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getResolvePerpPnlDeficitIx(
		spotMarketIndex: number,
		perpMarketIndex: number
	): Promise<TransactionInstruction>;
	getDepositIntoSpotMarketRevenuePoolIx(
		marketIndex: number,
		amount: BN,
		userTokenAccountPublicKey: PublicKey
	): Promise<TransactionInstruction>;

	/**
	 * This ix will donate your funds to drift revenue pool. It does not deposit into your user account
	 * @param marketIndex
	 * @param amount
	 * @param userTokenAccountPublicKey
	 * @returns
	 */
	depositIntoSpotMarketRevenuePool(
		marketIndex: number,
		amount: BN,
		userTokenAccountPublicKey: PublicKey
	): Promise<TransactionSignature>;

	getPerpMarketExtendedInfo(marketIndex: number): PerpMarketExtendedInfo;

	/**
	 * Calculates taker / maker fee (as a percentage, e.g. .001 = 10 basis points) for particular marketType
	 * @param marketType
	 * @param positionMarketIndex
	 * @returns : {takerFee: number, makerFee: number} Precision None
	 */
	getMarketFees(
		marketType: MarketType,
		marketIndex?: number,
		user?: IUser,
		enteringHighLeverageMode?: boolean
	): { takerFee: number; makerFee: number };

	/**
	 * Returns the market index and type for a given market name
	 * E.g. "SOL-PERP" -> { marketIndex: 0, marketType: MarketType.PERP }
	 *
	 * @param name
	 */
	getMarketIndexAndType(
		name: string
	): { marketIndex: number; marketType: MarketType } | undefined;

	getReceiverProgram(): Program<PythSolanaReceiver>;
	getSwitchboardOnDemandProgram(): Promise<Program30<Idl30>>;
	postPythPullOracleUpdateAtomic(
		vaaString: string,
		feedId: string
	): Promise<TransactionSignature>;
	postMultiPythPullOracleUpdatesAtomic(
		vaaString: string,
		feedIds: string[]
	): Promise<TransactionSignature>;
	getPostPythPullOracleUpdateAtomicIxs(
		vaaString: string,
		feedIds: string | string[],
		numSignatures?: number
	): Promise<TransactionInstruction[]>;
	updatePythPullOracle(
		vaaString: string,
		feedId: string
	): Promise<TransactionSignature>;
	getUpdatePythPullOracleIxs(
		params: {
			merklePriceUpdate: {
				message: Buffer;
				proof: number[][];
			};
		},
		feedId: string,
		encodedVaaAddress: PublicKey
	): Promise<TransactionInstruction>;
	postPythLazerOracleUpdate(
		feedIds: number[],
		pythMessageHex: string
	): Promise<string>;
	getPostPythLazerOracleUpdateIxs(
		feedIds: number[],
		pythMessageHex: string,
		precedingIxs?: TransactionInstruction[],
		overrideCustomIxIndex?: number
	): Promise<TransactionInstruction[]>;
	getPostManySwitchboardOnDemandUpdatesAtomicIxs(
		feeds: PublicKey[],
		recentSlothash?: Slothash,
		numSignatures?: number
	): Promise<TransactionInstruction[] | undefined>;

	// @deprecated use getPostManySwitchboardOnDemandUpdatesAtomicIxs instead. This function no longer returns the required ixs due to upstream sdk changes.
	getPostSwitchboardOnDemandUpdateAtomicIx(
		feed: PublicKey,
		recentSlothash?: Slothash,
		numSignatures?: number
	): Promise<TransactionInstruction | undefined>;

	postSwitchboardOnDemandUpdate(
		feed: PublicKey,
		recentSlothash?: Slothash,
		numSignatures?: number
	): Promise<TransactionSignature>;
	enableUserHighLeverageMode(
		subAccountId: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getEnableHighLeverageModeIx(
		subAccountId: number,
		depositToTradeArgs?: {
			isMakingNewAccount: boolean;
			depositMarketIndex: number;
			orderMarketIndex: number;
		}
	): Promise<TransactionInstruction>;
	disableUserHighLeverageMode(
		user: PublicKey,
		userAccount?: UserAccount,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getDisableHighLeverageModeIx(
		user: PublicKey,
		userAccount?: UserAccount
	): Promise<TransactionInstruction>;
	fetchHighLeverageModeConfig(): Promise<HighLeverageModeConfig>;
	fetchProtectedMakerModeConfig(): Promise<ProtectedMakerModeConfig>;
	updateUserProtectedMakerOrders(
		subAccountId: number,
		protectedOrders: boolean,
		authority?: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	getUpdateUserProtectedMakerOrdersIx(
		subAccountId: number,
		protectedOrders: boolean,
		authority?: PublicKey
	): Promise<TransactionInstruction>;
	getPauseSpotMarketDepositWithdrawIx(
		spotMarketIndex: number
	): Promise<TransactionInstruction>;
	pauseSpotMarketDepositWithdraw(
		spotMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature>;
	updateMmOracleNative(
		marketIndex: number,
		oraclePrice: BN,
		oracleSequenceId: BN
	): Promise<TransactionSignature>;
	getUpdateMmOracleNativeIx(
		marketIndex: number,
		oraclePrice: BN,
		oracleSequenceId: BN
	): Promise<TransactionInstruction>;
	updateAmmSpreadAdjustmentNative(
		marketIndex: number,
		ammSpreadAdjustment: number
	): Promise<TransactionSignature>;
	getUpdateAmmSpreadAdjustmentNativeIx(
		marketIndex: number,
		ammSpreadAdjustment: number
	): TransactionInstruction;

	/**
	 * Send a transaction.
	 *
	 * @param tx
	 * @param additionalSigners
	 * @param opts :: Will fallback to DriftClient's opts if not provided
	 * @param preSigned
	 * @returns
	 */
	sendTransaction(
		tx: Transaction | VersionedTransaction,
		additionalSigners?: Signer[],
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot>;

	buildTransaction(
		instructions: TransactionInstruction | TransactionInstruction[],
		txParams?: TxParams,
		txVersion?: TransactionVersion,
		lookupTables?: AddressLookupTableAccount[],
		forceVersionedTransaction?: boolean,
		recentBlockhash?: BlockhashWithExpiryBlockHeight,
		optionalIxs?: TransactionInstruction[]
	): Promise<Transaction | VersionedTransaction>;
	buildBulkTransactions(
		instructions: (TransactionInstruction | TransactionInstruction[])[],
		txParams?: TxParams,
		txVersion?: TransactionVersion,
		lookupTables?: AddressLookupTableAccount[],
		forceVersionedTransaction?: boolean
	): Promise<(Transaction | VersionedTransaction)[]>;
	buildTransactionsMap(
		instructionsMap: Record<
			string,
			TransactionInstruction | TransactionInstruction[]
		>,
		txParams?: TxParams,
		txVersion?: TransactionVersion,
		lookupTables?: AddressLookupTableAccount[],
		forceVersionedTransaction?: boolean
	): ReturnType<TxHandler['buildTransactionsMap']>;
	buildAndSignTransactionsMap(
		instructionsMap: Record<
			string,
			TransactionInstruction | TransactionInstruction[]
		>,
		txParams?: TxParams,
		txVersion?: TransactionVersion,
		lookupTables?: AddressLookupTableAccount[],
		forceVersionedTransaction?: boolean
	): ReturnType<TxHandler['buildAndSignTransactionMap']>;
}
