/**
 * VelocityClient — main SDK entry point for all trading and keeper operations.
 *
 * Responsibilities:
 *   - Builds and sends all on-chain instructions (place/cancel/fill orders, deposits, withdrawals,
 *     settle PnL, update funding rate, liquidations).
 *   - Manages the program account subscription lifecycle (markets, oracles, user accounts).
 *   - Provides oracle price reads, market config lookups, and PDA derivation helpers.
 *
 * Admin operations (market init, fee updates, oracle config) live in {@link AdminClient} (adminClient.ts).
 * Read-only user account queries (margin, positions, PnL) live in {@link User} (user.ts).
 *
 * Instruction → on-chain handler mapping: see ARCHITECTURE.md § SDK↔Instruction Mapping.
 */
import { AnchorProvider, BN, Program } from './isomorphic/anchor';
import type { ProgramAccount } from '@coral-xyz/anchor';
import bs58 from 'bs58';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	createAssociatedTokenAccountInstruction,
	createAssociatedTokenAccountIdempotentInstruction,
	createCloseAccountInstruction,
	createInitializeAccountInstruction,
	getAssociatedTokenAddress,
	TOKEN_2022_PROGRAM_ID,
	TOKEN_PROGRAM_ID,
	getAssociatedTokenAddressSync,
	getMint,
	getTransferHook,
	getExtraAccountMetaAddress,
	getExtraAccountMetas,
	resolveExtraAccountMeta,
} from '@solana/spl-token';
import {
	VelocityClientMetricsEvents,
	isVariant,
	IWallet,
	MakerInfo,
	MappedRecord,
	MarketType,
	ModifyOrderParams,
	ModifyOrderPolicy,
	OptionalOrderParams,
	OracleSource,
	Order,
	OrderParams,
	OrderTriggerCondition,
	OrderType,
	PerpMarketAccount,
	PerpMarketExtendedInfo,
	PlaceAndTakeOrderSuccessCondition,
	PositionDirection,
	ReferrerInfo,
	ReferrerNameAccount,
	RevenueShareEscrowAccount,
	ScaleOrderParams,
	SettlePnlMode,
	SignedTxData,
	SpotBalanceType,
	SpotMarketAccount,
	SpotPosition,
	StateAccount,
	SwapReduceOnly,
	SignedMsgOrderParamsMessage,
	TxParams,
	UserAccount,
	UserStatsAccount,
	SignedMsgOrderParamsDelegateMessage,
	TokenProgramFlag,
	PostOnlyParams,
	LPPoolAccount,
	ConstituentAccount,
	ConstituentTargetBaseAccount,
	AmmCache,
} from './types';
import { VelocityCore } from './core/VelocityCore';

/** Client-side guardrail; mirrors on-chain `ErrorCode::SpotDlobTradingDisabled`. */
const SPOT_DLOB_TRADING_DISABLED_MSG =
	'Spot DLOB trading is disabled; spot balances, deposits, and swaps remain available.';

import {
	AccountMeta,
	AddressLookupTableAccount,
	BlockhashWithExpiryBlockHeight,
	ConfirmOptions,
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	Signer,
	SystemProgram,
	SYSVAR_CLOCK_PUBKEY,
	SYSVAR_INSTRUCTIONS_PUBKEY,
	SYSVAR_RENT_PUBKEY,
	Transaction,
	TransactionInstruction,
	TransactionSignature,
	TransactionVersion,
	VersionedTransaction,
} from '@solana/web3.js';

import { TokenFaucet } from './tokenFaucet';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	getVelocitySignerPublicKey,
	getVelocityStateAccountPublicKey,
	getInsuranceFundStakeAccountPublicKey,
	getPerpMarketPublicKey,
	getPythLazerOraclePublicKey,
	getReferrerNamePublicKeySync,
	getSpotMarketPublicKey,
	getSignedMsgUserAccountPublicKey,
	getUserAccountPublicKey,
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
	getSignedMsgWsDelegatesAccountPublicKey,
	getRevenueShareAccountPublicKey,
	getRevenueShareEscrowAccountPublicKey,
	getConstituentTargetBasePublicKey,
	getAmmConstituentMappingPublicKey,
	getLpPoolPublicKey,
	getConstituentPublicKey,
	getAmmCachePublicKey,
	getLpPoolTokenVaultPublicKey,
	getConstituentVaultPublicKey,
	getConstituentCorrelationsPublicKey,
	getLpPoolTokenTokenAccountPublicKey,
} from './addresses/pda';
import {
	DataAndSlot,
	DelistedMarketSetting,
	VelocityClientAccountEvents,
	VelocityClientAccountSubscriber,
} from './accounts/types';
import { TxSender, TxSigAndSlot } from './tx/types';
import {
	BASE_PRECISION,
	MARGIN_PRECISION,
	MIN_I64,
	ONE,
	PERCENTAGE_PRECISION,
	PRICE_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
	ZERO,
} from './constants/numericConstants';
import {
	calculateClaimablePnl,
	findDirectionToClose,
	positionIsAvailable,
} from './math/position';
import { getSignedTokenAmount, getTokenAmount } from './math/spotBalance';
import { decodeName, DEFAULT_USER_NAME, encodeName } from './userName';
import { MMOraclePriceData, OraclePriceData } from './oracles/types';
import { VelocityClientConfig } from './velocityClientConfig';
import { PollingVelocityClientAccountSubscriber } from './accounts/pollingVelocityClientAccountSubscriber';
import { WebSocketVelocityClientAccountSubscriber } from './accounts/webSocketVelocityClientAccountSubscriber';
import { RetryTxSender } from './tx/retryTxSender';
import { User } from './user';
import { UserSubscriptionConfig } from './userConfig';
import {
	configs,
	DEFAULT_CONFIRMATION_OPTS,
	VelocityEnv,
	VelocityProgram,
	PYTH_LAZER_STORAGE_ACCOUNT_KEY,
} from './config';
import { Velocity } from './idl/velocity';
import { WRAPPED_SOL_MINT } from './constants/spotMarkets';
import { UserStats } from './userStats';
import { isSpotPositionAvailable } from './math/spotPosition';
import { calculateMarketMaxAvailableInsurance } from './math/market';
import { fetchUserStatsAccount } from './accounts/fetch';
import { castNumberToSpotPrecision } from './math/spotMarket';
import { JupiterClient, QuoteResponse } from './jupiter/jupiterClient';
import { SwapMode, UnifiedQuoteResponse } from './swap/UnifiedSwapClient';
import { getNonIdleUserFilter } from './memcmp';
import { UserStatsSubscriptionConfig } from './userStatsConfig';
import { getMarinadeDepositIx, getMarinadeFinanceProgram } from './marinade';
import { getOrderParams } from './orderParams';
import { numberToSafeBN } from './math/utils';
import { TransactionParamProcessor } from './tx/txParamProcessor';
import { isOracleTooDivergent, isOracleValid } from './math/oracles';
import { TxHandler } from './tx/txHandler';
import { createMinimalEd25519VerifyIx } from './util/ed25519Utils';
import {
	createNativeInstructionDiscriminatorBuffer,
	isVersionedTransaction,
	MAX_TX_BYTE_SIZE,
} from './tx/utils';
import { grpcVelocityClientAccountSubscriber } from './accounts/grpcVelocityClientAccountSubscriber';
import nacl from 'tweetnacl';
import { getOracleId } from './oracles/oracleId';
import { SignedMsgOrderParams } from './types';
import { TakerInfo } from './types';
import { getOracleConfidenceFromMMOracleData } from './oracles/utils';
import { ConstituentMap } from './constituentMap/constituentMap';
import { hasBuilder } from './math/orders';
import { RevenueShareEscrowMap } from './userMap/revenueShareEscrowMap';
import {
	isBuilderOrderReferral,
	isBuilderOrderCompleted,
	escrowHasReferrer,
	hasBuilderParams,
} from './math/builder';
import { TitanClient, SwapMode as TitanSwapMode } from './titan/titanClient';
import { UnifiedSwapClient } from './swap/UnifiedSwapClient';
/**
 * Union type for swap clients (Titan and Jupiter) - Legacy type
 * @deprecated Use UnifiedSwapClient class instead
 */
export type SwapClient = TitanClient | JupiterClient;

type RemainingAccountParams =
	import('./core/remainingAccounts').RemainingAccountParams;

/**
 * # VelocityClient
 * This class is the main way to interact with Velocity Exchange. It allows you to subscribe to the various accounts where the Market's state is stored, as well as: opening positions, liquidating, settling funding, depositing & withdrawing, and more.
 */
export class VelocityClient {
	connection: Connection;
	wallet: IWallet;
	public program: VelocityProgram;
	provider: AnchorProvider;
	env: VelocityEnv;
	opts: ConfirmOptions;
	useHotWalletAdmin?: boolean;
	users = new Map<string, User>();
	userStats?: UserStats;
	userStatsAccountPublicKey?: PublicKey;
	activeSubAccountId: number | undefined;
	userAccountSubscriptionConfig: UserSubscriptionConfig;
	userStatsAccountSubscriptionConfig: UserStatsSubscriptionConfig;
	accountSubscriber: VelocityClientAccountSubscriber;
	eventEmitter: StrictEventEmitter<EventEmitter, VelocityClientAccountEvents>;
	metricsEventEmitter: StrictEventEmitter<
		EventEmitter,
		VelocityClientMetricsEvents
	>;
	_isSubscribed = false;
	txSender: TxSender;
	perpMarketLastSlotCache = new Map<number, number>();
	spotMarketLastSlotCache = new Map<number, number>();
	mustIncludePerpMarketIndexes = new Set<number>();
	mustIncludeSpotMarketIndexes = new Set<number>();
	authority: PublicKey;

	marketLookupTables: PublicKey[];
	lookupTableAccounts?: AddressLookupTableAccount[];

	includeDelegates?: boolean;
	authoritySubAccountMap?: Map<string, number[]>;
	skipLoadUsers?: boolean;
	txVersion: TransactionVersion;
	txParams: TxParams;
	enableMetricsEvents?: boolean;

	txHandler: TxHandler;

	public get isSubscribed() {
		return this._isSubscribed && this.accountSubscriber.isSubscribed;
	}

	private async getPrePlaceOrderIxs(
		orderParams: OptionalOrderParams,
		userAccount: UserAccount,
		options?: { positionMaxLev?: number; isolatedPositionDepositAmount?: BN }
	): Promise<TransactionInstruction[]> {
		const preIxs: TransactionInstruction[] = [];

		if (isVariant(orderParams.marketType, 'perp')) {
			const { positionMaxLev, isolatedPositionDepositAmount } = options ?? {};

			if (
				isolatedPositionDepositAmount?.gt?.(ZERO) &&
				this.isOrderIncreasingPosition(orderParams, userAccount.subAccountId)
			) {
				preIxs.push(
					await this.getTransferIsolatedPerpPositionDepositIx(
						isolatedPositionDepositAmount as BN,
						orderParams.marketIndex,
						userAccount.subAccountId
					)
				);
			}

			if (positionMaxLev) {
				const marginRatio = Math.floor(
					(1 / positionMaxLev) * MARGIN_PRECISION.toNumber()
				);
				preIxs.push(
					await this.getUpdateUserPerpPositionCustomMarginRatioIx(
						orderParams.marketIndex,
						marginRatio,
						userAccount.subAccountId
					)
				);
			}
		}

		return preIxs;
	}

	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	public constructor(config: VelocityClientConfig) {
		this.connection = config.connection;
		this.wallet = config.wallet;
		this.env = config.env ?? 'mainnet-beta';
		this.opts = config.opts || {
			...DEFAULT_CONFIRMATION_OPTS,
		};
		this.useHotWalletAdmin = config.useHotWalletAdmin ?? false;
		if (config?.connection?.commitment) {
			// At the moment this ensures that our transaction simulations (which use Connection object) will use the same commitment level as our Transaction blockhashes (which use these opts)
			this.opts.commitment = config.connection.commitment;
			this.opts.preflightCommitment = config.connection.commitment;
		}
		this.provider = new AnchorProvider(
			config.connection,
			// @ts-ignore
			config.wallet,
			this.opts
		);
		this.program = new Program<Velocity>(
			VelocityCore.defaultIdl() as unknown as Velocity,
			this.provider,
			config.coder
		);

		this.authority = config.authority ?? this.wallet.publicKey;
		this.activeSubAccountId = config.activeSubAccountId ?? 0;
		this.skipLoadUsers = config.skipLoadUsers ?? false;
		this.txVersion =
			config.txVersion ?? this.getTxVersionForNewWallet(config.wallet);
		this.txParams = {
			computeUnits: config.txParams?.computeUnits ?? 600_000,
			computeUnitsPrice: config.txParams?.computeUnitsPrice ?? 0,
		};

		this.txHandler =
			config?.txHandler ??
			new TxHandler({
				connection: this.connection,
				// @ts-ignore
				wallet: this.provider.wallet,
				confirmationOptions: this.opts,
				opts: {
					returnBlockHeightsWithSignedTxCallbackData:
						config.enableMetricsEvents,
					onSignedCb: this.handleSignedTransaction.bind(this),
					preSignedCb: this.handlePreSignedTransaction.bind(this),
				},
				config: config.txHandlerConfig,
			});

		if (config.includeDelegates && config.subAccountIds) {
			throw new Error(
				'Can only pass one of includeDelegates or subAccountIds. If you want to specify subaccount ids for multiple authorities, pass authoritySubaccountMap instead'
			);
		}

		if (config.authoritySubAccountMap && config.subAccountIds) {
			throw new Error(
				'Can only pass one of authoritySubaccountMap or subAccountIds'
			);
		}

		if (config.authoritySubAccountMap && config.includeDelegates) {
			throw new Error(
				'Can only pass one of authoritySubaccountMap or includeDelegates'
			);
		}

		this.authoritySubAccountMap = config.authoritySubAccountMap
			? config.authoritySubAccountMap
			: config.subAccountIds
			? new Map([[this.authority.toString(), config.subAccountIds]])
			: new Map<string, number[]>();

		this.includeDelegates = config.includeDelegates ?? false;
		if (config.accountSubscription?.type === 'polling') {
			this.userAccountSubscriptionConfig = {
				type: 'polling',
				accountLoader: config.accountSubscription.accountLoader,
			};
			this.userStatsAccountSubscriptionConfig = {
				type: 'polling',
				accountLoader: config.accountSubscription.accountLoader,
			};
		} else if (config.accountSubscription?.type === 'grpc') {
			this.userAccountSubscriptionConfig = {
				type: 'grpc',
				resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
				logResubMessages: config.accountSubscription?.logResubMessages,
				grpcConfigs: config.accountSubscription?.grpcConfigs,
				grpcMultiUserAccountSubscriber:
					config.accountSubscription?.grpcMultiUserAccountSubscriber,
			};
			this.userStatsAccountSubscriptionConfig = {
				type: 'grpc',
				grpcConfigs: config.accountSubscription?.grpcConfigs,
				resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
				logResubMessages: config.accountSubscription?.logResubMessages,
			};
		} else {
			this.userAccountSubscriptionConfig = {
				type: 'websocket',
				resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
				logResubMessages: config.accountSubscription?.logResubMessages,
				commitment: config.accountSubscription?.commitment,
				programUserAccountSubscriber:
					config.accountSubscription?.programUserAccountSubscriber,
			};
			this.userStatsAccountSubscriptionConfig = {
				type: 'websocket',
				resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
				logResubMessages: config.accountSubscription?.logResubMessages,
				commitment: config.accountSubscription?.commitment,
			};
		}

		if (config.userStats) {
			this.userStats = new UserStats({
				velocityClient: this,
				userStatsAccountPublicKey: getUserStatsAccountPublicKey(
					this.program.programId,
					this.authority
				),
				accountSubscription: this.userAccountSubscriptionConfig,
			});
		}

		this.marketLookupTables =
			config.marketLookupTables ??
			configs[this.env].MARKET_LOOKUP_TABLES.map(
				(tableAddr) => new PublicKey(tableAddr)
			);

		const delistedMarketSetting =
			config.delistedMarketSetting || DelistedMarketSetting.Unsubscribe;
		const noMarketsAndOraclesSpecified =
			config.perpMarketIndexes === undefined &&
			config.spotMarketIndexes === undefined &&
			config.oracleInfos === undefined;
		if (config.accountSubscription?.type === 'polling') {
			this.accountSubscriber = new PollingVelocityClientAccountSubscriber(
				this.program,
				config.accountSubscription.accountLoader,
				config.perpMarketIndexes ?? [],
				config.spotMarketIndexes ?? [],
				config.oracleInfos ?? [],
				noMarketsAndOraclesSpecified,
				delistedMarketSetting
			);
		} else if (config.accountSubscription?.type === 'grpc') {
			const accountSubscriberClass: any =
				config.accountSubscription?.velocityClientAccountSubscriber ??
				grpcVelocityClientAccountSubscriber;
			this.accountSubscriber = new accountSubscriberClass(
				config.accountSubscription.grpcConfigs,
				this.program as any,
				config.perpMarketIndexes ?? [],
				config.spotMarketIndexes ?? [],
				config.oracleInfos ?? [],
				noMarketsAndOraclesSpecified,
				delistedMarketSetting,
				{
					resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
					logResubMessages: config.accountSubscription?.logResubMessages,
				}
			);
		} else {
			const accountSubscriberClass: any =
				config.accountSubscription?.velocityClientAccountSubscriber ??
				WebSocketVelocityClientAccountSubscriber;
			this.accountSubscriber = new accountSubscriberClass(
				this.program as any,
				config.perpMarketIndexes ?? [],
				config.spotMarketIndexes ?? [],
				config.oracleInfos ?? [],
				noMarketsAndOraclesSpecified,
				delistedMarketSetting,
				{
					resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
					logResubMessages: config.accountSubscription?.logResubMessages,
				},
				config.accountSubscription?.commitment
			);
		}
		this.eventEmitter = this.accountSubscriber.eventEmitter;

		this.metricsEventEmitter = new EventEmitter();

		if (config.enableMetricsEvents) {
			this.enableMetricsEvents = true;
		}

		this.txSender =
			config.txSender ??
			new RetryTxSender({
				connection: this.connection,
				wallet: this.wallet,
				opts: this.opts,
				txHandler: this.txHandler,
			});
	}

	public getUserMapKey(subAccountId: number, authority: PublicKey): string {
		return `${subAccountId}_${authority.toString()}`;
	}

	createUser(
		subAccountId: number,
		accountSubscriptionConfig: UserSubscriptionConfig,
		authority?: PublicKey
	): User {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			authority ?? this.authority,
			subAccountId
		);

		return new User({
			velocityClient: this,
			userAccountPublicKey,
			accountSubscription: accountSubscriptionConfig,
		});
	}

	public async subscribe(): Promise<boolean> {
		let subscribePromises = [this.addAndSubscribeToUsers()].concat(
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
		this.statePublicKey = await getVelocityStateAccountPublicKey(
			this.program.programId
		);
		return this.statePublicKey;
	}

	signerPublicKey?: PublicKey;
	public getSignerPublicKey(): PublicKey {
		if (this.signerPublicKey) {
			return this.signerPublicKey;
		}
		this.signerPublicKey = getVelocitySignerPublicKey(this.program.programId);
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
	 * Like {@link getPerpMarketAccount} but throws if the market is not loaded,
	 * for call sites that require a guaranteed account.
	 */
	public getPerpMarketAccountOrThrow(marketIndex: number): PerpMarketAccount {
		const perpMarketAccount = this.getPerpMarketAccount(marketIndex);
		if (!perpMarketAccount) {
			throw new Error(`Perp market ${marketIndex} not found`);
		}
		return perpMarketAccount;
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
			.filter((value) => value !== undefined)
			.map((value) => value.data);
	}

	public getSpotMarketAccount(
		marketIndex: number
	): SpotMarketAccount | undefined {
		return this.accountSubscriber.getSpotMarketAccountAndSlot(marketIndex)
			?.data;
	}

	/**
	 * Like {@link getSpotMarketAccount} but throws if the market is not loaded,
	 * for call sites that require a guaranteed account.
	 */
	public getSpotMarketAccountOrThrow(marketIndex: number): SpotMarketAccount {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		if (!spotMarketAccount) {
			throw new Error(`Spot market ${marketIndex} not found`);
		}
		return spotMarketAccount;
	}

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 * @param marketIndex
	 */
	public async forceGetSpotMarketAccount(
		marketIndex: number
	): Promise<SpotMarketAccount | undefined> {
		await this.accountSubscriber.fetch();
		return this.accountSubscriber.getSpotMarketAccountAndSlot(marketIndex)
			?.data;
	}

	public getSpotMarketAccounts(): SpotMarketAccount[] {
		return this.accountSubscriber
			.getSpotMarketAccountsAndSlots()
			.filter((value) => value !== undefined)
			.map((value) => value.data);
	}

	public getQuoteSpotMarketAccount(): SpotMarketAccount {
		return this.getSpotMarketAccountOrThrow(QUOTE_SPOT_MARKET_INDEX);
	}

	public getOraclePriceDataAndSlot(
		oraclePublicKey: PublicKey,
		oracleSource: OracleSource
	): DataAndSlot<OraclePriceData> | undefined {
		return this.accountSubscriber.getOraclePriceDataAndSlot(
			getOracleId(oraclePublicKey, oracleSource)
		);
	}

	public async fetchAllLookupTableAccounts(): Promise<
		AddressLookupTableAccount[]
	> {
		if (this.lookupTableAccounts) return this.lookupTableAccounts;

		if (!this.marketLookupTables) {
			console.log('Market lookup table address not set');
			return [];
		}

		const lookupTableAccountResults = await Promise.all(
			this.marketLookupTables.map((lookupTable) =>
				this.connection.getAddressLookupTable(lookupTable)
			)
		);

		// Filter out null values - lookup tables may not exist on-chain
		const lookupTableAccounts = lookupTableAccountResults
			.map((result) => result.value)
			.filter(
				(account): account is AddressLookupTableAccount => account !== null
			);
		this.lookupTableAccounts = lookupTableAccounts;

		return lookupTableAccounts;
	}

	private getTxVersionForNewWallet(newWallet: IWallet) {
		if (!newWallet?.supportedTransactionVersions) return 0; // Assume versioned txs supported if wallet doesn't have a supportedTransactionVersions property

		const walletSupportsVersionedTxns =
			newWallet.supportedTransactionVersions?.has(0) ||
			(newWallet.supportedTransactionVersions?.size ?? 0) > 1;

		return walletSupportsVersionedTxns ? 0 : 'legacy';
	}

	/**
	 * Update the wallet to use for velocity transactions and linked user account
	 * @param newWallet
	 * @param subAccountIds
	 * @param activeSubAccountId
	 * @param includeDelegates
	 */
	public async updateWallet(
		newWallet: IWallet,
		subAccountIds?: number[],
		activeSubAccountId?: number,
		includeDelegates?: boolean,
		authoritySubaccountMap?: Map<string, number[]>
	): Promise<boolean> {
		const newProvider = new AnchorProvider(
			this.connection,
			// @ts-ignore
			newWallet,
			this.opts
		);
		const newProgram = new Program<Velocity>(
			VelocityCore.defaultIdl() as unknown as Velocity,
			newProvider
		);

		this.skipLoadUsers = false;
		// Update provider for txSender with new wallet details
		this.txSender.wallet = newWallet;
		this.wallet = newWallet;
		this.txHandler.updateWallet(newWallet);
		this.provider = newProvider;
		this.program = newProgram;
		this.authority = newWallet.publicKey;
		this.activeSubAccountId = activeSubAccountId;
		this.userStatsAccountPublicKey = undefined;
		this.includeDelegates = includeDelegates ?? false;
		this.txVersion = this.getTxVersionForNewWallet(this.wallet);

		if (includeDelegates && subAccountIds) {
			throw new Error(
				'Can only pass one of includeDelegates or subAccountIds. If you want to specify subaccount ids for multiple authorities, pass authoritySubaccountMap instead'
			);
		}

		if (authoritySubaccountMap && subAccountIds) {
			throw new Error(
				'Can only pass one of authoritySubaccountMap or subAccountIds'
			);
		}

		if (authoritySubaccountMap && includeDelegates) {
			throw new Error(
				'Can only pass one of authoritySubaccountMap or includeDelegates'
			);
		}

		this.authoritySubAccountMap = authoritySubaccountMap
			? authoritySubaccountMap
			: subAccountIds
			? new Map([[this.authority.toString(), subAccountIds]])
			: new Map<string, number[]>();

		/* Reset user stats account */
		if (this.userStats?.isSubscribed) {
			await this.userStats.unsubscribe();
		}

		this.userStats = undefined;

		this.userStats = new UserStats({
			velocityClient: this,
			userStatsAccountPublicKey: this.getUserStatsAccountPublicKey(),
			accountSubscription: this.userStatsAccountSubscriptionConfig,
		});

		const subscriptionPromises: Promise<any>[] = [this.userStats.subscribe()];

		let success = true;

		if (this.isSubscribed) {
			const reSubscribeUsersPromise = async () => {
				await Promise.all(this.unsubscribeUsers());
				this.users.clear();
				success = await this.addAndSubscribeToUsers();
			};

			subscriptionPromises.push(reSubscribeUsersPromise());
		}

		await Promise.all(subscriptionPromises);

		return success;
	}

	/**
	 * Update the subscribed accounts to a given authority, while leaving the
	 * connected wallet intact. This allows a user to emulate another user's
	 * account on the UI and sign permissionless transactions with their own wallet.
	 * @param emulateAuthority
	 */
	public async emulateAccount(emulateAuthority: PublicKey): Promise<boolean> {
		this.skipLoadUsers = false;
		// Update provider for txSender with new wallet details
		this.authority = emulateAuthority;
		this.userStatsAccountPublicKey = undefined;
		this.includeDelegates = true;
		this.txVersion = this.getTxVersionForNewWallet(this.wallet);

		this.authoritySubAccountMap = new Map<string, number[]>();

		/* Reset user stats account */
		if (this.userStats?.isSubscribed) {
			await this.userStats.unsubscribe();
		}

		this.userStats = undefined;

		this.userStats = new UserStats({
			velocityClient: this,
			userStatsAccountPublicKey: this.getUserStatsAccountPublicKey(),
			accountSubscription: this.userStatsAccountSubscriptionConfig,
		});

		await this.userStats.subscribe();

		let success = true;

		if (this.isSubscribed) {
			await Promise.all(this.unsubscribeUsers());
			this.users.clear();
			success = await this.addAndSubscribeToUsers(emulateAuthority);
		}

		return success;
	}

	public async switchActiveUser(subAccountId: number, authority?: PublicKey) {
		const authorityChanged = authority && !this.authority?.equals(authority);

		this.activeSubAccountId = subAccountId;
		this.authority = authority ?? this.authority;
		const userStatsAccountPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			this.authority
		);
		this.userStatsAccountPublicKey = userStatsAccountPublicKey;

		/* If changing the user authority ie switching from delegate to non-delegate account, need to re-subscribe to the user stats account */
		if (authorityChanged && this.userStats) {
			if (this.userStats.isSubscribed) {
				await this.userStats.unsubscribe();
			}

			this.userStats = new UserStats({
				velocityClient: this,
				userStatsAccountPublicKey: userStatsAccountPublicKey,
				accountSubscription: this.userStatsAccountSubscriptionConfig,
			});

			this.userStats.subscribe();
		}
	}

	public async addUser(
		subAccountId: number,
		authority?: PublicKey,
		userAccount?: UserAccount
	): Promise<boolean> {
		authority = authority ?? this.authority;
		const userKey = this.getUserMapKey(subAccountId, authority);

		if (this.users.has(userKey) && this.users.get(userKey)?.isSubscribed) {
			return true;
		}

		const user = this.createUser(
			subAccountId,
			this.userAccountSubscriptionConfig,
			authority
		);

		const result = await user.subscribe(userAccount);

		if (result) {
			this.users.set(userKey, user);
			return true;
		} else {
			return false;
		}
	}

	/**
	 * Adds and subscribes to users based on params set by the constructor or by updateWallet.
	 */
	public async addAndSubscribeToUsers(authority?: PublicKey): Promise<boolean> {
		// save the rpc calls if velocityclient is initialized without a real wallet
		if (this.skipLoadUsers) return true;

		let result = true;

		if (this.authoritySubAccountMap && this.authoritySubAccountMap.size > 0) {
			this.authoritySubAccountMap.forEach(async (value, key) => {
				for (const subAccountId of value) {
					result =
						result && (await this.addUser(subAccountId, new PublicKey(key)));
				}
			});

			if (this.activeSubAccountId == undefined) {
				this.switchActiveUser(
					[...this.authoritySubAccountMap.values()][0][0] ?? 0,
					new PublicKey(
						[...this.authoritySubAccountMap.keys()][0] ??
							this.authority.toString()
					)
				);
			}
		} else {
			let userAccounts: UserAccount[] = [];
			let delegatedAccounts: UserAccount[] = [];

			const userAccountsPromise = this.getUserAccountsForAuthority(
				authority ?? this.wallet.publicKey
			);

			if (this.includeDelegates) {
				const delegatedAccountsPromise = this.getUserAccountsForDelegate(
					authority ?? this.wallet.publicKey
				);
				[userAccounts, delegatedAccounts] = await Promise.all([
					userAccountsPromise,
					delegatedAccountsPromise,
				]);

				!userAccounts && (userAccounts = []);
				!delegatedAccounts && (delegatedAccounts = []);
			} else {
				userAccounts = (await userAccountsPromise) ?? [];
			}

			const allAccounts = userAccounts.concat(delegatedAccounts);
			const addAllAccountsPromise = allAccounts.map((acc) =>
				this.addUser(acc.subAccountId, acc.authority, acc)
			);

			const addAllAccountsResults = await Promise.all(addAllAccountsPromise);
			result = addAllAccountsResults.every((res) => !!res);

			if (this.activeSubAccountId == undefined) {
				this.switchActiveUser(
					userAccounts.concat(delegatedAccounts)[0]?.subAccountId ?? 0,
					userAccounts.concat(delegatedAccounts)[0]?.authority ?? this.authority
				);
			}
		}

		return result;
	}

	/**
	 * Returns the instructions to initialize a user account and the public key of the user account.
	 * @param subAccountId
	 * @param name
	 * @param referrerInfo
	 * @returns [instructions, userAccountPublicKey]
	 */
	public async getInitializeUserAccountIxs(
		subAccountId = 0,
		name?: string,
		referrerInfo?: ReferrerInfo,
		poolId?: number
	): Promise<[TransactionInstruction[], PublicKey]> {
		const initializeIxs: TransactionInstruction[] = [];

		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(
				subAccountId,
				name,
				referrerInfo
			);

		if (subAccountId === 0) {
			if (
				!(await this.checkIfAccountExists(this.getUserStatsAccountPublicKey()))
			) {
				initializeIxs.push(await this.getInitializeUserStatsIx());
			}
		}

		initializeIxs.push(initializeUserAccountIx);

		if (poolId) {
			initializeIxs.push(
				await this.getUpdateUserPoolIdIx(poolId, subAccountId)
			);
		}

		return [initializeIxs, userAccountPublicKey];
	}

	/**
	 * Initializes a user account and returns the transaction signature and the public key of the user account.
	 * @param subAccountId
	 * @param name
	 * @param referrerInfo
	 * @param txParams
	 * @returns [transactionSignature, userAccountPublicKey]
	 */
	public async initializeUserAccount(
		subAccountId = 0,
		name?: string,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<[TransactionSignature, PublicKey]> {
		const [initializeIxs, userAccountPublicKey] =
			await this.getInitializeUserAccountIxs(subAccountId, name, referrerInfo);

		const tx = await this.buildTransaction(initializeIxs, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		await this.addUser(subAccountId);

		return [txSig, userAccountPublicKey];
	}

	async getInitializeUserStatsIx(overrides?: {
		/**
		 * Optional external wallet to use as payer. If provided, this wallet will pay
		 * for the account creation instead of the default wallet.
		 */
		externalWallet?: PublicKey;
	}): Promise<TransactionInstruction> {
		const payer = overrides?.externalWallet ?? this.wallet.publicKey;
		const authority = this.authority;
		return await this.program.instruction.initializeUserStats({
			accounts: {
				userStats: getUserStatsAccountPublicKey(
					this.program.programId,
					authority
				),
				authority,
				payer,
				rent: SYSVAR_RENT_PUBKEY,
				systemProgram: SystemProgram.programId,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async initializeSignedMsgUserOrders(
		authority: PublicKey,
		numOrders: number,
		txParams?: TxParams
	): Promise<[TransactionSignature, PublicKey]> {
		const initializeIxs = [];

		const [signedMsgUserAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeSignedMsgUserOrdersAccountIx(
				authority,
				numOrders
			);
		initializeIxs.push(initializeUserAccountIx);
		const tx = await this.buildTransaction(initializeIxs, txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return [txSig, signedMsgUserAccountPublicKey];
	}

	async getInitializeSignedMsgUserOrdersAccountIx(
		authority: PublicKey,
		numOrders: number,
		overrides?: {
			/**
			 * Optional external wallet to use as payer. If provided, this wallet will pay
			 * for the account creation instead of the default wallet.
			 */
			externalWallet?: PublicKey;
		}
	): Promise<[PublicKey, TransactionInstruction]> {
		const payer = overrides?.externalWallet ?? this.wallet.publicKey;
		const signedMsgUserAccountPublicKey = getSignedMsgUserAccountPublicKey(
			this.program.programId,
			authority
		);
		const initializeUserAccountIx =
			await this.program.instruction.initializeSignedMsgUserOrders(numOrders, {
				accounts: {
					signedMsgUserOrders: signedMsgUserAccountPublicKey,
					authority,
					payer,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: SystemProgram.programId,
				},
			});

		return [signedMsgUserAccountPublicKey, initializeUserAccountIx];
	}

	public async resizeSignedMsgUserOrders(
		authority: PublicKey,
		numOrders: number,
		userSubaccountId?: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const resizeUserAccountIx =
			await this.getResizeSignedMsgUserOrdersInstruction(
				authority,
				numOrders,
				userSubaccountId
			);
		const tx = await this.buildTransaction([resizeUserAccountIx], txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	async getResizeSignedMsgUserOrdersInstruction(
		authority: PublicKey,
		numOrders: number,
		userSubaccountId?: number
	): Promise<TransactionInstruction> {
		const signedMsgUserAccountPublicKey = getSignedMsgUserAccountPublicKey(
			this.program.programId,
			authority
		);
		const resizeUserAccountIx =
			await this.program.instruction.resizeSignedMsgUserOrders(numOrders, {
				accounts: {
					signedMsgUserOrders: signedMsgUserAccountPublicKey,
					authority,
					payer: this.wallet.publicKey,
					systemProgram: SystemProgram.programId,
					user: await getUserAccountPublicKey(
						this.program.programId,
						authority,
						userSubaccountId
					),
				},
			});

		return resizeUserAccountIx;
	}

	public async initializeSignedMsgWsDelegatesAccount(
		authority: PublicKey,
		delegates: PublicKey[] = [],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getInitializeSignedMsgWsDelegatesAccountIx(
			authority,
			delegates
		);
		const tx = await this.buildTransaction([ix], txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getInitializeSignedMsgWsDelegatesAccountIx(
		authority: PublicKey,
		delegates: PublicKey[] = []
	): Promise<TransactionInstruction> {
		const signedMsgWsDelegates = getSignedMsgWsDelegatesAccountPublicKey(
			this.program.programId,
			authority
		);
		const ix = await this.program.instruction.initializeSignedMsgWsDelegates(
			delegates,
			{
				accounts: {
					signedMsgWsDelegates,
					authority: this.wallet.publicKey,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: SystemProgram.programId,
				},
			}
		);
		return ix;
	}

	public async initializeRevenueShare(
		authority: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getInitializeRevenueShareIx(authority);
		const tx = await this.buildTransaction([ix], txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getInitializeRevenueShareIx(
		authority: PublicKey,
		overrides?: {
			payer?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		const revenueShare = getRevenueShareAccountPublicKey(
			this.program.programId,
			authority
		);
		return this.program.instruction.initializeRevenueShare({
			accounts: {
				revenueShare,
				authority,
				payer: overrides?.payer ?? this.wallet.publicKey,
				rent: SYSVAR_RENT_PUBKEY,
				systemProgram: SystemProgram.programId,
			},
		});
	}

	public async initializeRevenueShareEscrow(
		authority: PublicKey,
		numOrders: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getInitializeRevenueShareEscrowIx(
			authority,
			numOrders
		);
		const tx = await this.buildTransaction([ix], txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getInitializeRevenueShareEscrowIx(
		authority: PublicKey,
		numOrders: number,
		overrides?: {
			payer?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		const escrow = getRevenueShareEscrowAccountPublicKey(
			this.program.programId,
			authority
		);
		return this.program.instruction.initializeRevenueShareEscrow(numOrders, {
			accounts: {
				escrow,
				authority,
				payer: overrides?.payer ?? this.wallet.publicKey,
				userStats: getUserStatsAccountPublicKey(
					this.program.programId,
					authority
				),
				state: await this.getStatePublicKey(),
				rent: SYSVAR_RENT_PUBKEY,
				systemProgram: SystemProgram.programId,
			},
		});
	}

	public async resizeRevenueShareEscrowOrders(
		authority: PublicKey,
		numOrders: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getResizeRevenueShareEscrowOrdersIx(
			authority,
			numOrders
		);
		const tx = await this.buildTransaction([ix], txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getResizeRevenueShareEscrowOrdersIx(
		authority: PublicKey,
		numOrders: number
	): Promise<TransactionInstruction> {
		const escrow = getRevenueShareEscrowAccountPublicKey(
			this.program.programId,
			authority
		);
		return this.program.instruction.resizeRevenueShareEscrowOrders(numOrders, {
			accounts: {
				escrow,
				authority,
				payer: this.wallet.publicKey,
				systemProgram: SystemProgram.programId,
			},
		});
	}

	/**
	 * Creates the transaction to add or update an approved builder.
	 * This allows the builder to receive revenue share from referrals.
	 *
	 * @param builder - The public key of the builder to add or update.
	 * @param maxFeeTenthBps - The maximum fee tenth bps to set for the builder.
	 * @param add - Whether to add or update the builder. If the builder already exists, `add = true` will update the `maxFeeTenthBps`, otherwise it will add the builder. If `add = false`, the builder's `maxFeeTenthBps` will be set to 0.
	 * @param txParams - The transaction parameters to use for the transaction.
	 * @returns The transaction to add or update an approved builder.
	 */
	public async changeApprovedBuilder(
		builder: PublicKey,
		maxFeeTenthBps: number,
		add: boolean,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getChangeApprovedBuilderIx(
			builder,
			maxFeeTenthBps,
			add
		);
		const tx = await this.buildTransaction([ix], txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Creates the transaction instruction to add or update an approved builder.
	 * This allows the builder to receive revenue share from referrals.
	 *
	 * @param builder - The public key of the builder to add or update.
	 * @param maxFeeTenthBps - The maximum fee tenth bps to set for the builder.
	 * @param add - Whether to add or update the builder. If the builder already exists, `add = true` will update the `maxFeeTenthBps`, otherwise it will add the builder. If `add = false`, the builder's `maxFeeTenthBps` will be set to 0.
	 * @returns The transaction instruction to add or update an approved builder.
	 */
	public async getChangeApprovedBuilderIx(
		builder: PublicKey,
		maxFeeTenthBps: number,
		add: boolean,
		overrides?: {
			authority?: PublicKey;
			payer?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		const authority = overrides?.authority ?? this.wallet.publicKey;
		const payer = overrides?.payer ?? this.wallet.publicKey;
		const escrow = getRevenueShareEscrowAccountPublicKey(
			this.program.programId,
			authority
		);
		return this.program.instruction.changeApprovedBuilder(
			builder,
			maxFeeTenthBps,
			add,
			{
				accounts: {
					escrow,
					authority,
					payer,
					systemProgram: SystemProgram.programId,
				},
			}
		);
	}

	public async addSignedMsgWsDelegate(
		authority: PublicKey,
		delegate: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getAddSignedMsgWsDelegateIx(authority, delegate);
		const tx = await this.buildTransaction([ix], txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getAddSignedMsgWsDelegateIx(
		authority: PublicKey,
		delegate: PublicKey
	): Promise<TransactionInstruction> {
		const signedMsgWsDelegates = getSignedMsgWsDelegatesAccountPublicKey(
			this.program.programId,
			authority
		);
		const ix = await this.program.instruction.changeSignedMsgWsDelegateStatus(
			delegate,
			true,
			{
				accounts: {
					signedMsgWsDelegates,
					authority: this.wallet.publicKey,
					systemProgram: SystemProgram.programId,
				},
			}
		);
		return ix;
	}

	public async removeSignedMsgWsDelegate(
		authority: PublicKey,
		delegate: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getRemoveSignedMsgWsDelegateIx(authority, delegate);
		const tx = await this.buildTransaction([ix], txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getRemoveSignedMsgWsDelegateIx(
		authority: PublicKey,
		delegate: PublicKey
	): Promise<TransactionInstruction> {
		const signedMsgWsDelegates = getSignedMsgWsDelegatesAccountPublicKey(
			this.program.programId,
			authority
		);
		const ix = await this.program.instruction.changeSignedMsgWsDelegateStatus(
			delegate,
			false,
			{
				accounts: {
					signedMsgWsDelegates,
					authority: this.wallet.publicKey,
					systemProgram: SystemProgram.programId,
				},
			}
		);
		return ix;
	}

	private async getInitializeUserInstructions(
		subAccountId = 0,
		name?: string,
		referrerInfo?: ReferrerInfo,
		overrides?: {
			externalWallet?: PublicKey;
		}
	): Promise<[PublicKey, TransactionInstruction]> {
		// Use external wallet as payer if provided, otherwise use the wallet
		const payer = overrides?.externalWallet ?? this.wallet.publicKey;
		// The authority is the account owner (this.authority), not the payer
		const accountAuthority = this.authority;

		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			accountAuthority,
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
			const associatedTokenPublicKey = await getAssociatedTokenAddress(
				state.whitelistMint,
				payer
			);
			remainingAccounts.push({
				pubkey: associatedTokenPublicKey,
				isWritable: false,
				isSigner: false,
			});
		}

		if (name === undefined) {
			if (subAccountId === 0) {
				name = DEFAULT_USER_NAME;
			} else {
				name = `Subaccount ${subAccountId + 1}`;
			}
		}

		const nameBuffer = encodeName(name);
		const initializeUserAccountIx =
			await this.program.instruction.initializeUser(subAccountId, nameBuffer, {
				accounts: {
					user: userAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: accountAuthority,
					payer: payer,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: SystemProgram.programId,
					state: await this.getStatePublicKey(),
				},
				remainingAccounts,
			});

		return [userAccountPublicKey, initializeUserAccountIx];
	}

	async getNextSubAccountId(): Promise<number> {
		const userStats = this.getUserStats();
		let userStatsAccount: UserStatsAccount | undefined;
		if (!userStats) {
			userStatsAccount = await fetchUserStatsAccount(
				this.connection,
				this.program,
				this.wallet.publicKey
			);
		} else {
			const account = userStats.getAccount();
			if (!account) {
				userStatsAccount = await fetchUserStatsAccount(
					this.connection,
					this.program,
					this.wallet.publicKey
				);
			} else {
				userStatsAccount = account;
			}
		}
		if (!userStatsAccount) {
			throw new Error('UserStats account does not exist');
		}
		return userStatsAccount.numberOfSubAccountsCreated;
	}

	public async initializeReferrerName(
		name: string
	): Promise<TransactionSignature> {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			0
		);

		const nameBuffer = encodeName(name);

		const referrerNameAccountPublicKey = getReferrerNamePublicKeySync(
			this.program.programId,
			nameBuffer
		);

		const tx = await this.program.transaction.initializeReferrerName(
			nameBuffer,
			{
				accounts: {
					referrerName: referrerNameAccountPublicKey,
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					payer: this.wallet.publicKey,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: SystemProgram.programId,
				},
			}
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
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
		updates: { marginRatio: number; subAccountId: number }[],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await Promise.all(
			updates.map(async ({ marginRatio, subAccountId }) => {
				const ix = await this.getUpdateUserCustomMarginRatioIx(
					marginRatio,
					subAccountId
				);
				return ix;
			})
		);

		const tx = await this.buildTransaction(ixs, txParams ?? this.txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}
	public async getUpdateUserCustomMarginRatioIx(
		marginRatio: number,
		subAccountId = 0
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			subAccountId
		);

		await this.addUser(subAccountId, this.wallet.publicKey);

		const ix = this.program.instruction.updateUserCustomMarginRatio(
			subAccountId,
			marginRatio,
			{
				accounts: {
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
				},
			}
		);

		return ix;
	}

	public async getUpdateUserPerpPositionCustomMarginRatioIx(
		perpMarketIndex: number,
		marginRatio: number,
		subAccountId = 0,
		overrides?: {
			userAccountPublicKey?: PublicKey;
			authority?: PublicKey;
			signingAuthority?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		let userAccountPublicKey = overrides?.userAccountPublicKey;
		if (!userAccountPublicKey) {
			userAccountPublicKey = getUserAccountPublicKeySync(
				this.program.programId,
				overrides?.authority ?? this.authority,
				subAccountId
			);
		}

		const signingAuthority =
			overrides?.signingAuthority ?? this.wallet.publicKey;

		const ix = this.program.instruction.updateUserPerpPositionCustomMarginRatio(
			subAccountId,
			perpMarketIndex,
			marginRatio,
			{
				accounts: {
					user: userAccountPublicKey,
					authority: signingAuthority,
				},
			}
		);

		return ix;
	}

	public async updateUserPerpPositionCustomMarginRatio(
		perpMarketIndex: number,
		marginRatio: number,
		subAccountId = 0,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const updateIx = await this.getUpdateUserPerpPositionCustomMarginRatioIx(
			perpMarketIndex,
			marginRatio,
			subAccountId
		);
		const tx = await this.buildTransaction(updateIx, txParams ?? this.txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUpdateUserMarginTradingEnabledIx(
		marginTradingEnabled: boolean,
		subAccountId = 0,
		userAccountPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKeyToUse =
			userAccountPublicKey ||
			getUserAccountPublicKeySync(
				this.program.programId,
				this.wallet.publicKey,
				subAccountId
			);

		await this.addUser(subAccountId, this.wallet.publicKey);

		let remainingAccounts: AccountMeta[];
		try {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [this.getUserAccountOrThrow(subAccountId)],
			});
		} catch (err) {
			remainingAccounts = [];
		}

		return await this.program.instruction.updateUserMarginTradingEnabled(
			subAccountId,
			marginTradingEnabled,
			{
				accounts: {
					user: userAccountPublicKeyToUse,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async updateUserMarginTradingEnabled(
		updates: { marginTradingEnabled: boolean; subAccountId: number }[]
	): Promise<TransactionSignature> {
		const ixs = await Promise.all(
			updates.map(async ({ marginTradingEnabled, subAccountId }) => {
				return await this.getUpdateUserMarginTradingEnabledIx(
					marginTradingEnabled,
					subAccountId
				);
			})
		);

		const tx = await this.buildTransaction(ixs, this.txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUpdateUserDelegateIx(
		delegate: PublicKey,
		overrides: {
			subAccountId?: number;
			userAccountPublicKey?: PublicKey;
			authority?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		const subAccountId = overrides.subAccountId ?? this.activeSubAccountId;
		const userAccountPublicKey =
			overrides.userAccountPublicKey ?? (await this.getUserAccountPublicKey());
		const authority = overrides.authority ?? this.wallet.publicKey;

		return await this.program.instruction.updateUserDelegate(
			subAccountId,
			delegate,
			{
				accounts: {
					user: userAccountPublicKey,
					authority,
				},
			}
		);
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

	public async getUpdateUserAllowDelegateTransferIx(
		allowDelegateTransfer: boolean
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateUserAllowDelegateTransfer(
			allowDelegateTransfer,
			{
				accounts: {
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
				},
			}
		);
	}

	public async updateUserAllowDelegateTransfer(
		allowDelegateTransfer: boolean
	): Promise<TransactionSignature> {
		const tx = await this.buildTransaction(
			await this.getUpdateUserAllowDelegateTransferIx(allowDelegateTransfer),
			this.txParams
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async updateUserAdvancedLp(
		updates: { advancedLp: boolean; subAccountId: number }[]
	): Promise<TransactionSignature> {
		const ixs = await Promise.all(
			updates.map(async ({ advancedLp, subAccountId }) => {
				return await this.getUpdateAdvancedDlpIx(advancedLp, subAccountId);
			})
		);

		const tx = await this.buildTransaction(ixs, this.txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUpdateAdvancedDlpIx(
		advancedLp: boolean,
		subAccountId: number
	) {
		const ix = await (this.program.instruction as any).updateUserAdvancedLp(
			subAccountId,
			advancedLp,
			{
				accounts: {
					user: getUserAccountPublicKeySync(
						this.program.programId,
						this.wallet.publicKey,
						subAccountId
					),
					authority: this.wallet.publicKey,
				},
			}
		);

		return ix;
	}

	public async updateUserReduceOnly(
		updates: { reduceOnly: boolean; subAccountId: number }[]
	): Promise<TransactionSignature> {
		const ixs = await Promise.all(
			updates.map(async ({ reduceOnly, subAccountId }) => {
				return await this.getUpdateUserReduceOnlyIx(reduceOnly, subAccountId);
			})
		);

		const tx = await this.buildTransaction(ixs, this.txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUpdateUserReduceOnlyIx(
		reduceOnly: boolean,
		subAccountId: number
	) {
		const ix = await this.program.instruction.updateUserReduceOnly(
			subAccountId,
			reduceOnly,
			{
				accounts: {
					user: getUserAccountPublicKeySync(
						this.program.programId,
						this.wallet.publicKey,
						subAccountId
					),
					authority: this.wallet.publicKey,
				},
			}
		);

		return ix;
	}

	public async updateUserPoolId(
		updates: { poolId: number; subAccountId: number }[]
	): Promise<TransactionSignature> {
		const ixs = await Promise.all(
			updates.map(async ({ poolId, subAccountId }) => {
				return await this.getUpdateUserPoolIdIx(poolId, subAccountId);
			})
		);

		const tx = await this.buildTransaction(ixs, this.txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUpdateUserPoolIdIx(poolId: number, subAccountId: number) {
		const ix = await this.program.instruction.updateUserPoolId(
			subAccountId,
			poolId,
			{
				accounts: {
					user: getUserAccountPublicKeySync(
						this.program.programId,
						this.wallet.publicKey,
						subAccountId
					),
					authority: this.wallet.publicKey,
				},
			}
		);

		return ix;
	}

	public async fetchAllUserAccounts(
		includeIdle = true
	): Promise<ProgramAccount<UserAccount>[]> {
		let filters = undefined;
		if (!includeIdle) {
			filters = [getNonIdleUserFilter()];
		}
		return (await (this.program.account as any).user.all(
			filters
		)) as ProgramAccount<UserAccount>[];
	}

	public async getUserAccountsForDelegate(
		delegate: PublicKey
	): Promise<UserAccount[]> {
		const programAccounts: ProgramAccount<UserAccount>[] = await (
			this.program.account as any
		).user.all([
			{
				memcmp: {
					offset: 40,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(delegate.toBuffer()),
				},
			},
		]);

		return programAccounts
			.map((programAccount) => programAccount.account as UserAccount)
			.sort((a, b) => a.subAccountId - b.subAccountId);
	}

	public async getUserAccountsAndAddressesForAuthority(
		authority: PublicKey
	): Promise<ProgramAccount<UserAccount>[]> {
		const programAccounts: ProgramAccount<UserAccount>[] = await (
			this.program.account as any
		).user.all([
			{
				memcmp: {
					offset: 8,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(authority.toBuffer()),
				},
			},
		]);

		return programAccounts.map(
			(programAccount) => programAccount as ProgramAccount<UserAccount>
		);
	}

	public async getUserAccountsForAuthority(
		authority: PublicKey
	): Promise<UserAccount[]> {
		const programAccounts: ProgramAccount<UserAccount>[] = await (
			this.program.account as any
		).user.all([
			{
				memcmp: {
					offset: 8,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(authority.toBuffer()),
				},
			},
		]);

		return programAccounts
			.map((programAccount) => programAccount.account as UserAccount)
			.sort((a, b) => a.subAccountId - b.subAccountId);
	}

	public async getReferredUserStatsAccountsByReferrer(
		referrer: PublicKey
	): Promise<UserStatsAccount[]> {
		const programAccounts: ProgramAccount<UserStatsAccount>[] = await (
			this.program.account as any
		).userStats.all([
			{
				memcmp: {
					offset: 40,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(referrer.toBuffer()),
				},
			},
		]);

		return programAccounts.map(
			(programAccount) => programAccount.account as unknown as UserStatsAccount
		);
	}

	public async getReferrerNameAccountsForAuthority(
		authority: PublicKey
	): Promise<ReferrerNameAccount[]> {
		const programAccounts: ProgramAccount<ReferrerNameAccount>[] = await (
			this.program.account as any
		).referrerName.all([
			{
				memcmp: {
					offset: 8,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(authority.toBuffer()),
				},
			},
		]);

		return programAccounts.map(
			(programAccount) => programAccount.account as ReferrerNameAccount
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

		const ix = await this.getUserDeletionIx(userAccountPublicKey);

		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(ix, txParams),
			[],
			this.opts
		);

		const userMapKey = this.getUserMapKey(subAccountId, this.wallet.publicKey);
		await this.users.get(userMapKey)?.unsubscribe();
		this.users.delete(userMapKey);

		return txSig;
	}

	public async getUserDeletionIx(userAccountPublicKey: PublicKey) {
		const ix = await this.program.instruction.deleteUser({
			accounts: {
				user: userAccountPublicKey,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});

		return ix;
	}

	public async forceDeleteUser(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const tx = await this.buildTransaction(
			await this.getForceDeleteUserIx(userAccountPublicKey, userAccount),
			txParams
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getForceDeleteUserIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount
	) {
		const writableSpotMarketIndexes = [];
		for (const spotPosition of userAccount.spotPositions) {
			if (isSpotPositionAvailable(spotPosition)) {
				continue;
			}
			writableSpotMarketIndexes.push(spotPosition.marketIndex);
		}
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
			writableSpotMarketIndexes,
		});

		for (const order of userAccount.orders) {
			if (hasBuilder(order)) {
				remainingAccounts.push({
					pubkey: getRevenueShareEscrowAccountPublicKey(
						this.program.programId,
						userAccount.authority
					),
					isWritable: true,
					isSigner: false,
				});
				break;
			}
		}

		const tokenPrograms = new Set<string>();
		for (const spotPosition of userAccount.spotPositions) {
			if (isSpotPositionAvailable(spotPosition)) {
				continue;
			}
			const spotMarket = this.getSpotMarketAccountOrThrow(
				spotPosition.marketIndex
			);
			remainingAccounts.push({
				isSigner: false,
				isWritable: true,
				pubkey: spotMarket.vault,
			});
			const tokenProgram = this.getTokenProgramForSpotMarket(spotMarket);
			const keeperVault = await this.getAssociatedTokenAccount(
				spotPosition.marketIndex,
				false,
				tokenProgram
			);
			remainingAccounts.push({
				isSigner: false,
				isWritable: true,
				pubkey: keeperVault,
			});
			tokenPrograms.add(tokenProgram.toBase58());

			this.addTokenMintToRemainingAccounts(spotMarket, remainingAccounts);
		}

		for (const tokenProgram of tokenPrograms) {
			remainingAccounts.push({
				isSigner: false,
				isWritable: false,
				pubkey: new PublicKey(tokenProgram),
			});
		}

		const authority = userAccount.authority;
		const userStats = getUserStatsAccountPublicKey(
			this.program.programId,
			authority
		);
		const ix = await this.program.instruction.forceDeleteUser({
			accounts: {
				user: userAccountPublicKey,
				userStats,
				authority,
				state: await this.getStatePublicKey(),
				velocitySigner: this.getSignerPublicKey(),
				keeper: this.wallet.publicKey,
			},
			remainingAccounts,
		});

		return ix;
	}

	public async deleteSignedMsgUserOrders(
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getSignedMsgUserOrdersDeletionIx(
			this.wallet.publicKey
		);

		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(ix, txParams),
			[],
			this.opts
		);

		return txSig;
	}

	public async getSignedMsgUserOrdersDeletionIx(authority: PublicKey) {
		const ix = await (
			this.program.instruction as any
		).deleteSignedMsgUserOrders({
			accounts: {
				user: authority,
				signedMsgUserOrders: getSignedMsgUserAccountPublicKey(
					this.program.programId,
					authority
				),
				authority: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});

		return ix;
	}

	/**
	 * Checks if a SignedMsg User Orders account exists for the given authority.
	 * The account pubkey is derived using the program ID and authority as seeds.
	 * Makes an RPC call to check if the account exists on-chain.
	 *
	 * @param authority The authority public key to check for
	 * @returns Promise that resolves to true if the account exists, false otherwise
	 */
	public async isSignedMsgUserOrdersAccountInitialized(
		authority: PublicKey
	): Promise<boolean> {
		const signedMsgUserOrdersAccountPublicKey =
			getSignedMsgUserAccountPublicKey(this.program.programId, authority);
		return this.checkIfAccountExists(signedMsgUserOrdersAccountPublicKey);
	}

	public async reclaimRent(
		subAccountId = 0,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			subAccountId
		);

		const ix = await this.getReclaimRentIx(userAccountPublicKey);

		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(ix, txParams),
			[],
			this.opts
		);

		return txSig;
	}

	public async getReclaimRentIx(userAccountPublicKey: PublicKey) {
		return await this.program.instruction.reclaimRent({
			accounts: {
				user: userAccountPublicKey,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				rent: SYSVAR_RENT_PUBKEY,
			},
		});
	}

	public getUser(subAccountId?: number, authority?: PublicKey): User {
		subAccountId = subAccountId ?? this.activeSubAccountId;
		authority = authority ?? this.authority;

		if (subAccountId === undefined || authority === undefined) {
			throw new Error('Subaccount ID and authority are required');
		}

		const userMapKey = this.getUserMapKey(subAccountId, authority);

		const user = this.users.get(userMapKey);
		if (!user) {
			throw new Error(`VelocityClient has no user for user id ${userMapKey}`);
		}
		return user;
	}

	public hasUser(subAccountId?: number, authority?: PublicKey): boolean {
		subAccountId = subAccountId ?? this.activeSubAccountId;
		authority = authority ?? this.authority;
		if (subAccountId === undefined || authority === undefined) {
			return false;
		}
		const userMapKey = this.getUserMapKey(subAccountId, authority);

		return this.users.has(userMapKey);
	}

	public getUsers(): User[] {
		// delegate users get added to the end
		return [...this.users.values()]
			.filter(
				(acct) => acct.getUserAccount()?.authority.equals(this.wallet.publicKey)
			)
			.concat(
				[...this.users.values()].filter(
					(acct) =>
						!acct.getUserAccount()?.authority.equals(this.wallet.publicKey)
				)
			);
	}

	public getUserStats(): UserStats | undefined {
		return this.userStats;
	}

	/**
	 * Like {@link getUserStats} but throws if there is no UserStats
	 * subscription, for call sites that require a guaranteed account.
	 */
	public getUserStatsOrThrow(): UserStats {
		if (!this.userStats) {
			throw new Error('VelocityClient has no UserStats subscription');
		}
		return this.userStats;
	}

	public async fetchReferrerNameAccount(
		name: string
	): Promise<ReferrerNameAccount | undefined> {
		const nameBuffer = encodeName(name);
		const referrerNameAccountPublicKey = getReferrerNamePublicKeySync(
			this.program.programId,
			nameBuffer
		);
		return (await (this.program.account as any).referrerName.fetch(
			referrerNameAccountPublicKey
		)) as ReferrerNameAccount;
	}

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

	public async getUserAccountPublicKey(
		subAccountId?: number,
		authority?: PublicKey
	): Promise<PublicKey> {
		return this.getUser(subAccountId, authority).userAccountPublicKey;
	}

	public getUserAccount(
		subAccountId?: number,
		authority?: PublicKey
	): UserAccount | undefined {
		return this.getUser(subAccountId, authority).getUserAccount();
	}

	/**
	 * Like {@link getUserAccount} but throws a named error instead of returning
	 * `undefined` when the account has not been loaded yet. Use at call sites
	 * that structurally require a loaded account.
	 */
	public getUserAccountOrThrow(
		subAccountId?: number,
		authority?: PublicKey
	): UserAccount {
		return this.getUser(subAccountId, authority).getUserAccountOrThrow();
	}

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 * @param subAccountId
	 */
	public async forceGetUserAccount(
		subAccountId?: number,
		authority?: PublicKey
	): Promise<UserAccount | undefined> {
		await this.getUser(subAccountId, authority).fetchAccounts();
		return this.getUser(subAccountId, authority).getUserAccount();
	}

	public getUserAccountAndSlot(
		subAccountId?: number,
		authority?: PublicKey
	): DataAndSlot<UserAccount> | undefined {
		return this.getUser(subAccountId, authority).getUserAccountAndSlot();
	}

	public getSpotPosition(
		marketIndex: number,
		subAccountId?: number
	): SpotPosition | undefined {
		return this.getUserAccountOrThrow(subAccountId).spotPositions.find(
			(spotPosition) => spotPosition.marketIndex === marketIndex
		);
	}

	public getQuoteAssetTokenAmount(): BN {
		return this.getTokenAmount(QUOTE_SPOT_MARKET_INDEX);
	}

	public getIsolatedPerpPositionTokenAmount(
		perpMarketIndex: number,
		subAccountId?: number
	): BN {
		return this.getUser(subAccountId).getIsolatePerpPositionTokenAmount(
			perpMarketIndex
		);
	}

	/**
	 * Returns the token amount for a given market. The spot market precision is based on the token mint decimals.
	 * Positive if it is a deposit, negative if it is a borrow.
	 * @param marketIndex
	 */
	public getTokenAmount(marketIndex: number): BN {
		const spotPosition = this.getSpotPosition(marketIndex);
		if (spotPosition === undefined) {
			return ZERO;
		}
		const spotMarket = this.getSpotMarketAccountOrThrow(marketIndex);
		return getSignedTokenAmount(
			getTokenAmount(
				spotPosition.scaledBalance,
				spotMarket,
				spotPosition.balanceType
			),
			spotPosition.balanceType
		);
	}

	/**
	 * Converts an amount to the spot precision for a given market. The spot market precision is based on the token mint decimals.
	 * @param marketIndex
	 * @param amount
	 */
	public convertToSpotPrecision(marketIndex: number, amount: BN | number): BN {
		const spotMarket = this.getSpotMarketAccountOrThrow(marketIndex);
		return castNumberToSpotPrecision(amount, spotMarket);
	}

	/**
	 * Converts an amount to the perp precision. The perp market precision is {@link BASE_PRECISION} (1e9).
	 * @param amount
	 */
	public convertToPerpPrecision(amount: BN | number): BN {
		if (typeof amount === 'number') {
			return numberToSafeBN(amount, BASE_PRECISION);
		} else {
			return amount.mul(BASE_PRECISION);
		}
	}

	/**
	 * Converts an amount to the price precision. The perp market precision is {@link PRICE_PRECISION} (1e6).
	 * @param amount
	 */
	public convertToPricePrecision(amount: BN | number): BN {
		if (typeof amount === 'number') {
			return numberToSafeBN(amount, PRICE_PRECISION);
		} else {
			return amount.mul(BASE_PRECISION);
		}
	}

	/**
	 * Each velocity instruction must include perp and sport market accounts in the ix remaining accounts.
	 * Use this function to force a subset of markets to be included in the remaining accounts for every ix
	 *
	 * @param perpMarketIndexes
	 * @param spotMarketIndexes
	 */
	public mustIncludeMarketsInIx({
		perpMarketIndexes,
		spotMarketIndexes,
	}: {
		perpMarketIndexes: number[];
		spotMarketIndexes: number[];
	}): void {
		perpMarketIndexes.forEach((perpMarketIndex) => {
			this.mustIncludePerpMarketIndexes.add(perpMarketIndex);
		});

		spotMarketIndexes.forEach((spotMarketIndex) => {
			this.mustIncludeSpotMarketIndexes.add(spotMarketIndex);
		});
	}
	private cachePerpMarketSlot(
		slot: number | undefined,
		...marketIndexes: number[]
	): void {
		for (const marketIndex of marketIndexes) {
			if (slot !== undefined) {
				this.perpMarketLastSlotCache.set(marketIndex, slot);
			} else {
				this.perpMarketLastSlotCache.delete(marketIndex);
			}
		}
	}

	private cacheSpotMarketSlot(
		slot: number | undefined,
		...marketIndexes: number[]
	): void {
		for (const marketIndex of marketIndexes) {
			if (slot !== undefined) {
				this.spotMarketLastSlotCache.set(marketIndex, slot);
			} else {
				this.spotMarketLastSlotCache.delete(marketIndex);
			}
		}
	}

	getRemainingAccounts(params: RemainingAccountParams): AccountMeta[] {
		return VelocityCore.remainingAccounts.getRemainingAccounts(
			{
				getPerpMarketAccount: (marketIndex: number) =>
					this.getPerpMarketAccountOrThrow(marketIndex),
				getSpotMarketAccount: (marketIndex: number) =>
					this.getSpotMarketAccountOrThrow(marketIndex),
				getUserAccountAndSlot: (
					subAccountId: number | undefined,
					authority: PublicKey
				) => this.getUserAccountAndSlot(subAccountId, authority),
				activeSubAccountId: this.activeSubAccountId,
				authority: this.authority,
				perpMarketLastSlotCache: this.perpMarketLastSlotCache,
				spotMarketLastSlotCache: this.spotMarketLastSlotCache,
				mustIncludePerpMarketIndexes: this.mustIncludePerpMarketIndexes,
				mustIncludeSpotMarketIndexes: this.mustIncludeSpotMarketIndexes,
			},
			params
		);
	}

	addPerpMarketToRemainingAccountMaps(
		marketIndex: number,
		writable: boolean,
		oracleAccountMap: Map<string, AccountMeta>,
		spotMarketAccountMap: Map<number, AccountMeta>,
		perpMarketAccountMap: Map<number, AccountMeta>
	): void {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(marketIndex);
		perpMarketAccountMap.set(marketIndex, {
			pubkey: perpMarketAccount.pubkey,
			isSigner: false,
			isWritable: writable,
		});
		const oracleWritable =
			writable && isVariant(perpMarketAccount.oracleSource, 'prelaunch');
		oracleAccountMap.set(perpMarketAccount.oracle.toString(), {
			pubkey: perpMarketAccount.oracle,
			isSigner: false,
			isWritable: oracleWritable,
		});
		this.addSpotMarketToRemainingAccountMaps(
			perpMarketAccount.quoteSpotMarketIndex,
			false,
			oracleAccountMap,
			spotMarketAccountMap
		);
	}

	addSpotMarketToRemainingAccountMaps(
		marketIndex: number,
		writable: boolean,
		oracleAccountMap: Map<string, AccountMeta>,
		spotMarketAccountMap: Map<number, AccountMeta>
	): void {
		const spotMarketAccount = this.getSpotMarketAccountOrThrow(marketIndex);
		spotMarketAccountMap.set(spotMarketAccount.marketIndex, {
			pubkey: spotMarketAccount.pubkey,
			isSigner: false,
			isWritable: writable,
		});
		if (!spotMarketAccount.oracle.equals(PublicKey.default)) {
			oracleAccountMap.set(spotMarketAccount.oracle.toString(), {
				pubkey: spotMarketAccount.oracle,
				isSigner: false,
				isWritable: false,
			});
		}
	}

	addBuilderToRemainingAccounts(
		builders: PublicKey[],
		remainingAccounts: AccountMeta[]
	): void {
		for (const builder of builders) {
			// Add User account for the builder. Dedupe by pubkey: an authority may be
			// both a builder and the referrer, in which case its User + RevenueShare
			// accounts would otherwise be pushed twice. On-chain `load_revenue_share_map`
			// rejects duplicates, which would silently abort the entire sweep.
			const builderUserAccount = getUserAccountPublicKeySync(
				this.program.programId,
				builder,
				0 // subAccountId 0 for builder user account
			);
			if (!remainingAccounts.find((a) => a.pubkey.equals(builderUserAccount))) {
				remainingAccounts.push({
					pubkey: builderUserAccount,
					isSigner: false,
					isWritable: true,
				});
			}

			const builderAccount = getRevenueShareAccountPublicKey(
				this.program.programId,
				builder
			);
			if (!remainingAccounts.find((a) => a.pubkey.equals(builderAccount))) {
				remainingAccounts.push({
					pubkey: builderAccount,
					isSigner: false,
					isWritable: true,
				});
			}
		}
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
					this.addSpotMarketToRemainingAccountMaps(
						spotPosition.marketIndex,
						false,
						oracleAccountMap,
						spotMarketAccountMap
					);

					if (
						!spotPosition.openAsks.eq(ZERO) ||
						!spotPosition.openBids.eq(ZERO)
					) {
						this.addSpotMarketToRemainingAccountMaps(
							QUOTE_SPOT_MARKET_INDEX,
							false,
							oracleAccountMap,
							spotMarketAccountMap
						);
					}
				}
			}
			for (const position of userAccount.perpPositions) {
				if (!positionIsAvailable(position)) {
					this.addPerpMarketToRemainingAccountMaps(
						position.marketIndex,
						false,
						oracleAccountMap,
						spotMarketAccountMap,
						perpMarketAccountMap
					);
				}
			}
		}

		return {
			oracleAccountMap,
			spotMarketAccountMap,
			perpMarketAccountMap,
		};
	}

	/**
	 * Look up an open order by its program-assigned order ID from the cached user account.
	 *
	 * `orderId` is the monotonically incrementing u32 counter that the program assigns at
	 * placement time — it is not known until the place instruction executes on-chain. Use
	 * {@link getOrderByUserId} when you need to look up an order by the caller-supplied
	 * `userOrderId` instead.
	 *
	 * Returns `undefined` when the order is not found (already filled, cancelled, or the
	 * account cache is stale).
	 */
	public getOrder(
		orderId: number | undefined,
		subAccountId?: number
	): Order | undefined {
		return this.getUserAccount(subAccountId)?.orders.find(
			(order) => order.orderId === orderId
		);
	}

	/**
	 * Look up an open order by the caller-supplied `userOrderId` from the cached user account.
	 *
	 * `userOrderId` is a 1-255 slot chosen by the caller in {@link OrderParams} and is stable
	 * across the life of the order — useful when you need to reference an order before the
	 * program-assigned {@link Order.orderId} is known (e.g. immediately after placing without
	 * waiting for confirmation). Use {@link getOrder} when you have the program-assigned ID.
	 *
	 * Returns `undefined` when the order is not found (already filled, cancelled, or the
	 * account cache is stale).
	 */
	public getOrderByUserId(
		userOrderId: number,
		subAccountId?: number
	): Order | undefined {
		return this.getUserAccount(subAccountId)?.orders.find(
			(order) => order.userOrderId === userOrderId
		);
	}

	/**
	 * Get the associated token address for the given spot market
	 * @param marketIndex
	 * @param useNative
	 * @param tokenProgram
	 */
	public async getAssociatedTokenAccount(
		marketIndex: number,
		useNative = true,
		tokenProgram = TOKEN_PROGRAM_ID,
		authority = this.wallet.publicKey,
		allowOwnerOffCurve = false
	): Promise<PublicKey> {
		const spotMarket = this.getSpotMarketAccountOrThrow(marketIndex);
		if (useNative && spotMarket.mint.equals(WRAPPED_SOL_MINT)) {
			return authority;
		}
		const mint = spotMarket.mint;
		return await getAssociatedTokenAddress(
			mint,
			authority,
			allowOwnerOffCurve,
			tokenProgram
		);
	}

	public createAssociatedTokenAccountIdempotentInstruction(
		account: PublicKey,
		payer: PublicKey,
		owner: PublicKey,
		mint: PublicKey,
		tokenProgram = TOKEN_PROGRAM_ID
	): TransactionInstruction {
		return new TransactionInstruction({
			keys: [
				{ pubkey: payer, isSigner: true, isWritable: true },
				{ pubkey: account, isSigner: false, isWritable: true },
				{ pubkey: owner, isSigner: false, isWritable: false },
				{ pubkey: mint, isSigner: false, isWritable: false },
				{
					pubkey: SystemProgram.programId,
					isSigner: false,
					isWritable: false,
				},
				{ pubkey: tokenProgram, isSigner: false, isWritable: false },
			],
			programId: ASSOCIATED_TOKEN_PROGRAM_ID,
			data: Buffer.from([0x1]),
		});
	}

	public async getDepositTxnIx(
		amount: BN,
		marketIndex: number,
		associatedTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly = false,
		overrides?: {
			authority?: PublicKey;
		}
	): Promise<TransactionInstruction[]> {
		const spotMarketAccount = this.getSpotMarketAccountOrThrow(marketIndex);

		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);

		const signer = overrides?.authority ?? this.wallet.publicKey;

		const createWSOLTokenAccount =
			isSolMarket && associatedTokenAccount.equals(signer);

		const instructions = [];

		if (createWSOLTokenAccount) {
			const { ixs, pubkey } = await this.getWrappedSolAccountCreationIxs(
				amount,
				true,
				overrides
			);

			associatedTokenAccount = pubkey;

			instructions.push(...ixs);
		}

		const depositCollateralIx = await this.getDepositInstruction(
			amount,
			marketIndex,
			associatedTokenAccount,
			subAccountId,
			reduceOnly,
			true,
			overrides
		);

		instructions.push(depositCollateralIx);

		// Close the wrapped sol account at the end of the transaction
		if (createWSOLTokenAccount) {
			instructions.push(
				createCloseAccountInstruction(
					associatedTokenAccount,
					signer,
					signer,
					[]
				)
			);
		}

		return instructions;
	}

	public async buildSwiftDepositTx(
		signedOrderParams: SignedMsgOrderParams,
		takerInfo: {
			taker: PublicKey;
			takerStats: PublicKey;
			takerUserAccount: UserAccount;
			signingAuthority: PublicKey;
		},
		depositAmount: BN,
		depositSpotMarketIndex: number,
		tradePerpMarketIndex: number,
		subAccountId: number,
		takerAssociatedTokenAccount: PublicKey,
		initSwiftAccount = false
	) {
		const instructions = await this.getDepositTxnIx(
			depositAmount,
			depositSpotMarketIndex,
			takerAssociatedTokenAccount,
			subAccountId,
			false
		);

		if (initSwiftAccount) {
			const isSignedMsgUserOrdersAccountInitialized =
				await this.isSignedMsgUserOrdersAccountInitialized(
					this.wallet.publicKey
				);

			if (!isSignedMsgUserOrdersAccountInitialized) {
				const [, initializeSignedMsgUserOrdersAccountIx] =
					await this.getInitializeSignedMsgUserOrdersAccountIx(
						this.wallet.publicKey,
						8
					);

				instructions.push(initializeSignedMsgUserOrdersAccountIx);
			}
		}

		const ixsWithPlace = await this.getPlaceSignedMsgTakerPerpOrderIxs(
			signedOrderParams,
			tradePerpMarketIndex,
			takerInfo,
			instructions
		);

		await this.buildTransaction(ixsWithPlace, {
			computeUnitsPrice: 1_000,
			computeUnits: 100_000,
		});
	}

	public async createDepositTxn(
		amount: BN,
		marketIndex: number,
		associatedTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly = false,
		txParams?: TxParams,
		initSwiftAccount = false,
		overrides?: {
			authority?: PublicKey;
		}
	): Promise<VersionedTransaction | Transaction> {
		const instructions = await this.getDepositTxnIx(
			amount,
			marketIndex,
			associatedTokenAccount,
			subAccountId,
			reduceOnly,
			overrides
		);

		if (initSwiftAccount) {
			const isSignedMsgUserOrdersAccountInitialized =
				await this.isSignedMsgUserOrdersAccountInitialized(
					this.wallet.publicKey
				);

			if (!isSignedMsgUserOrdersAccountInitialized) {
				const [, initializeSignedMsgUserOrdersAccountIx] =
					await this.getInitializeSignedMsgUserOrdersAccountIx(
						this.wallet.publicKey,
						8
					);

				instructions.push(initializeSignedMsgUserOrdersAccountIx);
			}
		}

		txParams = { ...(txParams ?? this.txParams), computeUnits: 800_000 };

		const tx = await this.buildTransaction(instructions, txParams);

		return tx;
	}

	/**
	 * Deposit funds into the given spot market
	 *
	 * @param amount to deposit
	 * @param marketIndex spot market index to deposit into
	 * @param associatedTokenAccount can be the wallet public key if using native sol
	 * @param subAccountId subaccountId to deposit
	 * @param reduceOnly if true, deposit must not increase account risk
	 * @param txParams transaction parameters
	 * @param initSwiftAccount if true, initialize a swift account for the user
	 * @param overrides allows overriding authority for the deposit transaction
	 */
	public async deposit(
		amount: BN,
		marketIndex: number,
		associatedTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly = false,
		txParams?: TxParams,
		initSwiftAccount = false,
		overrides?: {
			authority?: PublicKey;
		}
	): Promise<TransactionSignature> {
		const tx = await this.createDepositTxn(
			amount,
			marketIndex,
			associatedTokenAccount,
			subAccountId,
			reduceOnly,
			txParams,
			initSwiftAccount,
			overrides
		);

		const { txSig, slot } = await this.sendTransaction(tx, [], this.opts);
		this.cacheSpotMarketSlot(slot, marketIndex);
		return txSig;
	}

	async getDepositInstruction(
		amount: BN,
		marketIndex: number,
		userTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly = false,
		userInitialized = true,
		overrides?: {
			authority?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			subAccountId ?? this.activeSubAccountId
		);

		let remainingAccounts = [];
		if (userInitialized) {
			const userAccount = await this.forceGetUserAccount(subAccountId);
			if (!userAccount) {
				throw new Error('User account not loaded after force fetch');
			}
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [userAccount],
				useMarketLastSlotCache: true,
				writableSpotMarketIndexes: [marketIndex],
			});
		} else {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [],
				writableSpotMarketIndexes: [marketIndex],
			});
		}

		const spotMarketAccount = this.getSpotMarketAccountOrThrow(marketIndex);

		this.addTokenMintToRemainingAccounts(spotMarketAccount, remainingAccounts);
		if (this.isTransferHook(spotMarketAccount)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				spotMarketAccount.mint,
				remainingAccounts
			);
		}

		const authority = overrides?.authority ?? this.wallet.publicKey;
		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarketAccount);
		return await VelocityCore.buildDepositInstruction({
			program: this.program,
			marketIndex,
			amount,
			reduceOnly,
			state: await this.getStatePublicKey(),
			spotMarket: spotMarketAccount.pubkey,
			spotMarketVault: spotMarketAccount.vault,
			user: userAccountPublicKey,
			userStats: this.getUserStatsAccountPublicKey(),
			userTokenAccount,
			authority,
			tokenProgram,
			remainingAccounts,
		});
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

	public async getWrappedSolAccountCreationIxs(
		amount: BN,
		includeRent?: boolean,
		overrides?: {
			authority?: PublicKey;
		}
	): Promise<{
		ixs: TransactionInstruction[];
		/** @deprecated - this array is always going to be empty, in the current implementation */
		signers: Signer[];
		pubkey: PublicKey;
	}> {
		const authority = overrides?.authority ?? this.wallet.publicKey;

		// Generate a random seed for wrappedSolAccount.
		const seed = Keypair.generate().publicKey.toBase58().slice(0, 32);

		// Calculate a publicKey that will be controlled by the authority.
		const wrappedSolAccount = await PublicKey.createWithSeed(
			authority,
			seed,
			TOKEN_PROGRAM_ID
		);

		const result: {
			ixs: TransactionInstruction[];
			signers: Signer[];
			pubkey: PublicKey;
		} = {
			ixs: [],
			signers: [],
			pubkey: wrappedSolAccount,
		};

		const rentSpaceLamports = new BN(LAMPORTS_PER_SOL / 100);

		const lamports = includeRent
			? amount.add(rentSpaceLamports)
			: rentSpaceLamports;

		result.ixs.push(
			SystemProgram.createAccountWithSeed({
				fromPubkey: authority,
				basePubkey: authority,
				seed,
				newAccountPubkey: wrappedSolAccount,
				lamports: lamports.toNumber(),
				space: 165,
				programId: TOKEN_PROGRAM_ID,
			})
		);

		result.ixs.push(
			createInitializeAccountInstruction(
				wrappedSolAccount,
				WRAPPED_SOL_MINT,
				authority
			)
		);

		return result;
	}

	public getTokenProgramForSpotMarket(
		spotMarketAccount: SpotMarketAccount
	): PublicKey {
		if (this.isToken2022(spotMarketAccount)) {
			return TOKEN_2022_PROGRAM_ID;
		}
		return TOKEN_PROGRAM_ID;
	}

	public isToken2022(spotMarketAccount: SpotMarketAccount): boolean {
		return (
			(spotMarketAccount.tokenProgramFlag & TokenProgramFlag.Token2022) > 0
		);
	}

	public isTransferHook(spotMarketAccount: SpotMarketAccount): boolean {
		return (
			(spotMarketAccount.tokenProgramFlag & TokenProgramFlag.TransferHook) > 0
		);
	}

	public addTokenMintToRemainingAccounts(
		spotMarketAccount: SpotMarketAccount,
		remainingAccounts: AccountMeta[]
	) {
		if (this.isToken2022(spotMarketAccount)) {
			remainingAccounts.push({
				pubkey: spotMarketAccount.mint,
				isSigner: false,
				isWritable: false,
			});
		}
	}

	public async addExtraAccountMetasToRemainingAccounts(
		mint: PublicKey,
		remainingAccounts: AccountMeta[]
	) {
		const mintAccount = await getMint(
			this.connection,
			mint,
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);
		const hookAccount = getTransferHook(mintAccount)!;
		if (hookAccount.programId.equals(PublicKey.default)) {
			return;
		}
		const extraAccountMetasAddress = getExtraAccountMetaAddress(
			mint,
			hookAccount!.programId
		);
		const extraAccountMetasAccount = await this.connection.getAccountInfo(
			extraAccountMetasAddress
		);
		if (!extraAccountMetasAccount) {
			throw new Error(
				'Extra account metas account not found for transfer hook'
			);
		}
		const extraAccountMetas = getExtraAccountMetas(extraAccountMetasAccount);

		for (const acc of extraAccountMetas) {
			// assuming it's an extra account meta that does not rely on ix data
			const resolvedAcc = await resolveExtraAccountMeta(
				this.connection,
				acc,
				remainingAccounts,
				Buffer.from([]),
				hookAccount.programId
			);
			remainingAccounts.push(resolvedAcc);
		}

		remainingAccounts.push({
			pubkey: hookAccount.programId,
			isSigner: false,
			isWritable: false,
		});
		remainingAccounts.push({
			pubkey: extraAccountMetasAddress,
			isSigner: false,
			isWritable: false,
		});
	}

	public getAssociatedTokenAccountCreationIx(
		tokenMintAddress: PublicKey,
		associatedTokenAddress: PublicKey,
		tokenProgram: PublicKey
	): TransactionInstruction {
		return createAssociatedTokenAccountInstruction(
			this.wallet.publicKey,
			associatedTokenAddress,
			this.wallet.publicKey,
			tokenMintAddress,
			tokenProgram
		);
	}

	public async createInitializeUserAccountAndDepositCollateralIxs(
		amount: BN,
		userTokenAccount: PublicKey,
		marketIndex = 0,
		subAccountId = 0,
		name?: string,
		fromSubAccountId?: number,
		referrerInfo?: ReferrerInfo,
		donateAmount?: BN,
		customMaxMarginRatio?: number,
		poolId?: number,
		overrides?: {
			/**
			 * Optional external wallet to deposit from. If provided, the deposit will be made
			 * from this wallet instead of the user's authority wallet.
			 */
			externalWallet?: PublicKey;
		}
	): Promise<{
		ixs: TransactionInstruction[];
		userAccountPublicKey: PublicKey;
	}> {
		const ixs = [];

		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(
				subAccountId,
				name,
				referrerInfo,
				overrides
			);

		// Check signed message orders account for the actual authority (account owner)
		const isSignedMsgUserOrdersAccountInitialized =
			await this.isSignedMsgUserOrdersAccountInitialized(this.authority);

		if (!isSignedMsgUserOrdersAccountInitialized) {
			const [, initializeSignedMsgUserOrdersAccountIx] =
				await this.getInitializeSignedMsgUserOrdersAccountIx(
					this.authority,
					8,
					overrides
				);
			ixs.push(initializeSignedMsgUserOrdersAccountIx);
		}

		const spotMarket = this.getSpotMarketAccountOrThrow(marketIndex);

		const isSolMarket = spotMarket.mint.equals(WRAPPED_SOL_MINT);

		// Use external wallet for deposit source if provided, otherwise use the wallet
		const depositSource = overrides?.externalWallet ?? this.wallet.publicKey;

		const isFromSubaccount =
			fromSubAccountId !== null &&
			fromSubAccountId !== undefined &&
			!isNaN(fromSubAccountId);

		donateAmount = donateAmount ? donateAmount : ZERO;

		const createWSOLTokenAccount =
			(isSolMarket &&
				userTokenAccount.equals(depositSource) &&
				!isFromSubaccount) ||
			!donateAmount.eq(ZERO);

		const wSolAmount = isSolMarket ? amount.add(donateAmount) : donateAmount;

		let wsolTokenAccount: PublicKey | undefined;
		if (createWSOLTokenAccount) {
			const { ixs: startIxs, pubkey } =
				await this.getWrappedSolAccountCreationIxs(
					wSolAmount,
					true,
					overrides?.externalWallet
						? { authority: overrides.externalWallet }
						: undefined
				);

			wsolTokenAccount = pubkey;

			if (isSolMarket) {
				userTokenAccount = pubkey;
			}

			ixs.push(...startIxs);
		}

		// For Token2022 tokens, check if the user's token account exists and create it if it doesn't
		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarket);
		if (
			!isSolMarket &&
			!isFromSubaccount &&
			!tokenProgram.equals(TOKEN_PROGRAM_ID)
		) {
			const accountExists = await this.checkIfAccountExists(userTokenAccount);

			if (!accountExists) {
				const createAtaIx = this.getAssociatedTokenAccountCreationIx(
					spotMarket.mint,
					userTokenAccount,
					tokenProgram
				);
				ixs.push(createAtaIx);
			}
		}

		const depositCollateralIx = isFromSubaccount
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
					false,
					overrides?.externalWallet
						? { authority: overrides.externalWallet }
						: undefined
			  );

		if (subAccountId === 0) {
			if (
				!(await this.checkIfAccountExists(this.getUserStatsAccountPublicKey()))
			) {
				ixs.push(await this.getInitializeUserStatsIx(overrides));
			}
		}
		ixs.push(initializeUserAccountIx);

		if (poolId) {
			ixs.push(await this.getUpdateUserPoolIdIx(poolId, subAccountId));
		}

		ixs.push(depositCollateralIx);

		if (!donateAmount.eq(ZERO)) {
			if (!wsolTokenAccount) {
				throw new Error('wsolTokenAccount is required to donate to rev pool');
			}
			const donateIx = await this.getDepositIntoSpotMarketRevenuePoolIx(
				1,
				donateAmount,
				wsolTokenAccount
			);

			ixs.push(donateIx);
		}

		// Set the max margin ratio to initialize account with if passed
		if (customMaxMarginRatio) {
			const customMarginRatioIx = await this.getUpdateUserCustomMarginRatioIx(
				customMaxMarginRatio,
				subAccountId
			);
			ixs.push(customMarginRatioIx);
		}

		// Close the wrapped sol account at the end of the transaction
		// Return funds to the deposit source (external wallet if provided)
		if (createWSOLTokenAccount) {
			if (!wsolTokenAccount) {
				throw new Error('wsolTokenAccount was not created');
			}
			ixs.push(
				createCloseAccountInstruction(
					wsolTokenAccount,
					depositSource,
					depositSource,
					[]
				)
			);
		}

		return {
			ixs,
			userAccountPublicKey,
		};
	}
	public async createInitializeUserAccountAndDepositCollateral(
		amount: BN,
		userTokenAccount: PublicKey,
		marketIndex = 0,
		subAccountId = 0,
		name?: string,
		fromSubAccountId?: number,
		referrerInfo?: ReferrerInfo,
		donateAmount?: BN,
		txParams?: TxParams,
		customMaxMarginRatio?: number,
		poolId?: number,
		overrides?: {
			externalWallet?: PublicKey;
		}
	): Promise<[Transaction | VersionedTransaction, PublicKey]> {
		const { ixs, userAccountPublicKey } =
			await this.createInitializeUserAccountAndDepositCollateralIxs(
				amount,
				userTokenAccount,
				marketIndex,
				subAccountId,
				name,
				fromSubAccountId,
				referrerInfo,
				donateAmount,
				customMaxMarginRatio,
				poolId,
				overrides
			);

		const tx = await this.buildTransaction(ixs, txParams);

		return [tx, userAccountPublicKey];
	}

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
	 * @param customMaxMarginRatio
	 * @param poolId
	 * @param overrides - Optional overrides including externalWallet for depositing from a different wallet
	 * @returns
	 */
	public async initializeUserAccountAndDepositCollateral(
		amount: BN,
		userTokenAccount: PublicKey,
		marketIndex = 0,
		subAccountId = 0,
		name?: string,
		fromSubAccountId?: number,
		referrerInfo?: ReferrerInfo,
		donateAmount?: BN,
		txParams?: TxParams,
		customMaxMarginRatio?: number,
		poolId?: number,
		overrides?: {
			externalWallet?: PublicKey;
		}
	): Promise<[TransactionSignature, PublicKey]> {
		const [tx, userAccountPublicKey] =
			await this.createInitializeUserAccountAndDepositCollateral(
				amount,
				userTokenAccount,
				marketIndex,
				subAccountId,
				name,
				fromSubAccountId,
				referrerInfo,
				donateAmount,
				txParams,
				customMaxMarginRatio,
				poolId,
				overrides
			);
		const additionalSigners: Array<Signer> = [];

		const { txSig, slot } = await this.sendTransaction(
			tx,
			additionalSigners,
			this.opts
		);
		this.cacheSpotMarketSlot(slot, marketIndex);

		await this.addUser(subAccountId);

		return [txSig, userAccountPublicKey];
	}

	public async initializeUserAccountForDevnet(
		subAccountId = 0,
		name = DEFAULT_USER_NAME,
		marketIndex: number,
		tokenFaucet: TokenFaucet,
		amount: BN,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<[TransactionSignature, PublicKey]> {
		const ixs = [];

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

		ixs.push(createAssociatedAccountIx, mintToIx);

		if (subAccountId === 0) {
			if (
				!(await this.checkIfAccountExists(this.getUserStatsAccountPublicKey()))
			) {
				ixs.push(await this.getInitializeUserStatsIx());
			}
		}
		ixs.push(initializeUserAccountIx, depositCollateralIx);

		const tx = await this.buildTransaction(ixs, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		await this.addUser(subAccountId);

		return [txSig, userAccountPublicKey];
	}

	public async getWithdrawalIxs(
		amount: BN,
		marketIndex: number,
		associatedTokenAddress: PublicKey,
		reduceOnly = false,
		subAccountId?: number
	): Promise<TransactionInstruction[]> {
		const withdrawIxs: TransactionInstruction[] = [];

		const spotMarketAccount = this.getSpotMarketAccountOrThrow(marketIndex);

		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);

		const authority = this.wallet.publicKey;

		const createWSOLTokenAccount =
			isSolMarket && associatedTokenAddress.equals(authority);

		if (createWSOLTokenAccount) {
			const { ixs, pubkey } = await this.getWrappedSolAccountCreationIxs(
				amount,
				false
			);

			associatedTokenAddress = pubkey;

			withdrawIxs.push(...ixs);
		} else {
			const accountExists = await this.checkIfAccountExists(
				associatedTokenAddress
			);

			if (!accountExists) {
				const createAssociatedTokenAccountIx =
					this.getAssociatedTokenAccountCreationIx(
						spotMarketAccount.mint,
						associatedTokenAddress,
						this.getTokenProgramForSpotMarket(spotMarketAccount)
					);

				withdrawIxs.push(createAssociatedTokenAccountIx);
			}
		}

		const withdrawCollateralIx = await this.getWithdrawIx(
			amount,
			spotMarketAccount.marketIndex,
			associatedTokenAddress,
			reduceOnly,
			subAccountId
		);

		withdrawIxs.push(withdrawCollateralIx);

		// Close the wrapped sol account at the end of the transaction
		if (createWSOLTokenAccount) {
			withdrawIxs.push(
				createCloseAccountInstruction(
					associatedTokenAddress,
					authority,
					authority,
					[]
				)
			);
		}

		return withdrawIxs;
	}

	/**
	 * Withdraws from a user account. If deposit doesn't already exist, creates a borrow
	 * @param amount
	 * @param marketIndex
	 * @param associatedTokenAddress - the token account to withdraw to. can be the wallet public key if using native sol
	 * @param reduceOnly
	 */
	public async withdraw(
		amount: BN,
		marketIndex: number,
		associatedTokenAddress: PublicKey,
		reduceOnly = false,
		subAccountId?: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const additionalSigners: Array<Signer> = [];

		const withdrawIxs = await this.getWithdrawalIxs(
			amount,
			marketIndex,
			associatedTokenAddress,
			reduceOnly,
			subAccountId
		);

		const tx = await this.buildTransaction(
			withdrawIxs,
			txParams ?? this.txParams
		);

		const { txSig, slot } = await this.sendTransaction(
			tx,
			additionalSigners,
			this.opts
		);
		this.cacheSpotMarketSlot(slot, marketIndex);
		return txSig;
	}

	public async withdrawAllDustPositions(
		subAccountId?: number,
		txParams?: TxParams,
		opts?: {
			dustPositionCountCallback?: (count: number) => void;
		}
	): Promise<TransactionSignature | undefined> {
		const user = this.getUser(subAccountId);

		const dustPositionSpotMarketAccounts =
			user.getSpotMarketAccountsWithDustPosition();

		if (
			!dustPositionSpotMarketAccounts ||
			dustPositionSpotMarketAccounts.length === 0
		) {
			opts?.dustPositionCountCallback?.(0);
			return undefined;
		}

		opts?.dustPositionCountCallback?.(dustPositionSpotMarketAccounts.length);

		let allWithdrawIxs: TransactionInstruction[] = [];

		for (const position of dustPositionSpotMarketAccounts) {
			const tokenAccount = await getAssociatedTokenAddress(
				position.mint,
				this.wallet.publicKey
			);

			const tokenAmount = await user.getTokenAmount(position.marketIndex);

			const withdrawIxs = await this.getWithdrawalIxs(
				tokenAmount.muln(2), //  2x to ensure all dust is withdrawn
				position.marketIndex,
				tokenAccount,
				true, // reduce-only true to ensure all dust is withdrawn
				subAccountId
			);

			allWithdrawIxs = allWithdrawIxs.concat(withdrawIxs);
		}

		const tx = await this.buildTransaction(
			allWithdrawIxs,
			txParams ?? this.txParams
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getWithdrawIx(
		amount: BN,
		marketIndex: number,
		userTokenAccount: PublicKey,
		reduceOnly = false,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccountOrThrow(subAccountId)],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [marketIndex],
			readableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		const spotMarketAccount = this.getSpotMarketAccountOrThrow(marketIndex);

		this.addTokenMintToRemainingAccounts(spotMarketAccount, remainingAccounts);
		if (this.isTransferHook(spotMarketAccount)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				spotMarketAccount.mint,
				remainingAccounts
			);
		}

		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarketAccount);

		return await VelocityCore.buildWithdrawInstruction({
			program: this.program,
			marketIndex,
			amount,
			reduceOnly,
			state: await this.getStatePublicKey(),
			spotMarket: spotMarketAccount.pubkey,
			spotMarketVault: spotMarketAccount.vault,
			velocitySigner: this.getSignerPublicKey(),
			user,
			userStats: this.getUserStatsAccountPublicKey(),
			userTokenAccount,
			authority: this.wallet.publicKey,
			tokenProgram,
			remainingAccounts,
		});
	}

	/**
	 * Withdraws from the fromSubAccount and deposits into the toSubAccount
	 * @param amount
	 * @param marketIndex
	 * @param fromSubAccountId
	 * @param toSubAccountId
	 * @param txParams
	 */
	public async transferDeposit(
		amount: BN,
		marketIndex: number,
		fromSubAccountId: number,
		toSubAccountId: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getTransferDepositIx(
					amount,
					marketIndex,
					fromSubAccountId,
					toSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		if (
			fromSubAccountId === this.activeSubAccountId ||
			toSubAccountId === this.activeSubAccountId
		) {
			this.cacheSpotMarketSlot(slot, marketIndex);
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

		const userMapKey = this.getUserMapKey(
			fromSubAccountId,
			this.wallet.publicKey
		);
		const mapUser = this.users.get(userMapKey);
		if (mapUser) {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [mapUser.getUserAccountOrThrow()],
				useMarketLastSlotCache: true,
				writableSpotMarketIndexes: [marketIndex],
			});
		} else {
			const userAccountPublicKey = getUserAccountPublicKeySync(
				this.program.programId,
				this.authority,
				fromSubAccountId
			);

			const fromUserAccount = (await (this.program.account as any).user.fetch(
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
				spotMarketVault: this.getSpotMarketAccountOrThrow(marketIndex).vault,
			},
			remainingAccounts,
		});
	}

	public async transferDepositByDelegate(
		amount: BN,
		marketIndex: number,
		fromSubAccountId: number,
		toSubAccountId: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getTransferDepositByDelegateIx(
					amount,
					marketIndex,
					fromSubAccountId,
					toSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		if (
			fromSubAccountId === this.activeSubAccountId ||
			toSubAccountId === this.activeSubAccountId
		) {
			this.cacheSpotMarketSlot(slot, marketIndex);
		}
		return txSig;
	}

	public async getTransferDepositByDelegateIx(
		amount: BN,
		marketIndex: number,
		fromSubAccountId: number,
		toSubAccountId: number
	): Promise<TransactionInstruction> {
		const fromUser = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			fromSubAccountId
		);
		const toUser = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			toSubAccountId
		);

		let remainingAccounts;

		const userMapKey = this.getUserMapKey(fromSubAccountId, this.authority);
		const mapUser = this.users.get(userMapKey);
		if (mapUser) {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [mapUser.getUserAccountOrThrow()],
				useMarketLastSlotCache: true,
				writableSpotMarketIndexes: [marketIndex],
			});
		} else {
			const fromUserAccount = (await (this.program.account as any).user.fetch(
				fromUser
			)) as UserAccount;
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [fromUserAccount],
				useMarketLastSlotCache: true,
				writableSpotMarketIndexes: [marketIndex],
			});
		}

		return await this.program.instruction.transferDepositByDelegate(
			marketIndex,
			amount,
			{
				accounts: {
					delegate: this.wallet.publicKey,
					fromUser,
					toUser,
					userStats: this.getUserStatsAccountPublicKey(),
					state: await this.getStatePublicKey(),
					spotMarketVault: this.getSpotMarketAccountOrThrow(marketIndex).vault,
				},
				remainingAccounts,
			}
		);
	}

	public async transferPools(
		depositFromMarketIndex: number,
		depositToMarketIndex: number,
		borrowFromMarketIndex: number,
		borrowToMarketIndex: number,
		depositAmount: BN | undefined,
		borrowAmount: BN | undefined,
		fromSubAccountId: number,
		toSubAccountId: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getTransferPoolsIx(
					depositFromMarketIndex,
					depositToMarketIndex,
					borrowFromMarketIndex,
					borrowToMarketIndex,
					depositAmount,
					borrowAmount,
					fromSubAccountId,
					toSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);

		if (
			fromSubAccountId === this.activeSubAccountId ||
			toSubAccountId === this.activeSubAccountId
		) {
			this.cacheSpotMarketSlot(
				slot,
				depositFromMarketIndex,
				depositToMarketIndex,
				borrowFromMarketIndex,
				borrowToMarketIndex
			);
		}
		return txSig;
	}

	public async getTransferPoolsIx(
		depositFromMarketIndex: number,
		depositToMarketIndex: number,
		borrowFromMarketIndex: number,
		borrowToMarketIndex: number,
		depositAmount: BN | undefined,
		borrowAmount: BN | undefined,
		fromSubAccountId: number,
		toSubAccountId: number,
		isToNewSubAccount?: boolean
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

		const userAccounts = [this.getUserAccountOrThrow(fromSubAccountId)];

		if (!isToNewSubAccount) {
			userAccounts.push(this.getUserAccountOrThrow(toSubAccountId));
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [
				depositFromMarketIndex,
				depositToMarketIndex,
				borrowFromMarketIndex,
				borrowToMarketIndex,
			],
		});

		const tokenPrograms = new Set<string>();
		const depositFromSpotMarket = this.getSpotMarketAccountOrThrow(
			depositFromMarketIndex
		);
		const borrowFromSpotMarket = this.getSpotMarketAccountOrThrow(
			borrowFromMarketIndex
		);

		tokenPrograms.add(
			this.getTokenProgramForSpotMarket(depositFromSpotMarket).toBase58()
		);
		tokenPrograms.add(
			this.getTokenProgramForSpotMarket(borrowFromSpotMarket).toBase58()
		);

		for (const tokenProgram of tokenPrograms) {
			remainingAccounts.push({
				isSigner: false,
				isWritable: false,
				pubkey: new PublicKey(tokenProgram),
			});
		}

		return await this.program.instruction.transferPools(
			depositFromMarketIndex,
			depositToMarketIndex,
			borrowFromMarketIndex,
			borrowToMarketIndex,
			depositAmount ?? null,
			borrowAmount ?? null,
			{
				accounts: {
					authority: this.wallet.publicKey,
					fromUser,
					toUser,
					userStats: this.getUserStatsAccountPublicKey(),
					state: await this.getStatePublicKey(),
					depositFromSpotMarketVault: this.getSpotMarketAccountOrThrow(
						depositFromMarketIndex
					).vault,
					depositToSpotMarketVault:
						this.getSpotMarketAccountOrThrow(depositToMarketIndex).vault,
					borrowFromSpotMarketVault: this.getSpotMarketAccountOrThrow(
						borrowFromMarketIndex
					).vault,
					borrowToSpotMarketVault:
						this.getSpotMarketAccountOrThrow(borrowToMarketIndex).vault,
					velocitySigner: this.getSignerPublicKey(),
				},
				remainingAccounts,
			}
		);
	}

	public async transferPerpPosition(
		fromSubAccountId: number,
		toSubAccountId: number,
		marketIndex: number,
		amount: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getTransferPerpPositionIx(
					fromSubAccountId,
					toSubAccountId,
					marketIndex,
					amount
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getTransferPerpPositionIx(
		fromSubAccountId: number,
		toSubAccountId: number,
		marketIndex: number,
		amount: BN
	): Promise<TransactionInstruction> {
		const fromUser = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			fromSubAccountId
		);
		const toUser = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			toSubAccountId
		);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccountOrThrow(fromSubAccountId),
				this.getUserAccountOrThrow(toSubAccountId),
			],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		return await this.program.instruction.transferPerpPosition(
			marketIndex,
			amount ?? null,
			{
				accounts: {
					authority: this.wallet.publicKey,
					fromUser,
					toUser,
					userStats: this.getUserStatsAccountPublicKey(),
					state: await this.getStatePublicKey(),
				},
				remainingAccounts,
			}
		);
	}

	public async specialTransferPerpPositionToVamm(
		userAccountPublicKey: PublicKey,
		marketIndex: number,
		amount?: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getSpecialTransferPerpPositionToVammIx(
			userAccountPublicKey,
			marketIndex,
			amount
		);
		const tx = await this.buildTransaction(ix, txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getSpecialTransferPerpPositionToVammIx(
		userAccountPublicKey: PublicKey,
		marketIndex: number,
		amount?: BN
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			writablePerpMarketIndexes: [marketIndex],
		});

		return this.program.instruction.specialTransferPerpPositionToVamm(
			marketIndex,
			amount ?? null,
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

	async depositIntoIsolatedPerpPosition(
		amount: BN,
		perpMarketIndex: number,
		userTokenAccount: PublicKey,
		subAccountId?: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getDepositIntoIsolatedPerpPositionIx(
					amount,
					perpMarketIndex,
					userTokenAccount,
					subAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	async getDepositIntoIsolatedPerpPositionIx(
		amount: BN,
		perpMarketIndex: number,
		userTokenAccount: PublicKey,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			subAccountId ?? this.activeSubAccountId
		);

		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);
		const spotMarketIndex = perpMarketAccount.quoteSpotMarketIndex;
		const spotMarketAccount = this.getSpotMarketAccountOrThrow(spotMarketIndex);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			writableSpotMarketIndexes: [spotMarketIndex],
			readablePerpMarketIndex: [perpMarketIndex],
		});

		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarketAccount);
		return await this.program.instruction.depositIntoIsolatedPerpPosition(
			spotMarketIndex,
			perpMarketIndex,
			amount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarketVault: spotMarketAccount.vault,
					user: userAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					userTokenAccount: userTokenAccount,
					authority: this.wallet.publicKey,
					tokenProgram,
				},
				remainingAccounts,
			}
		);
	}

	public async transferIsolatedPerpPositionDeposit(
		amount: BN,
		perpMarketIndex: number,
		subAccountId?: number,
		txParams?: TxParams,
		trySettle?: boolean,
		noBuffer?: boolean
	): Promise<TransactionSignature> {
		const ixs = [];
		const tokenAmountDeposited =
			this.getIsolatedPerpPositionTokenAmount(perpMarketIndex);
		const transferIx = await this.getTransferIsolatedPerpPositionDepositIx(
			amount,
			perpMarketIndex,
			subAccountId,
			noBuffer
		);

		const needsToSettle =
			amount.lt(tokenAmountDeposited.neg()) || amount.eq(MIN_I64) || trySettle;
		if (needsToSettle) {
			const settleIx = await this.settleMultiplePNLsIx(
				await getUserAccountPublicKey(
					this.program.programId,
					this.authority,
					subAccountId ?? this.activeSubAccountId
				),
				this.getUserAccountOrThrow(subAccountId),
				[perpMarketIndex],
				SettlePnlMode.TRY_SETTLE
			);
			ixs.push(settleIx);
		}

		ixs.push(transferIx);

		const tx = await this.buildTransaction(ixs, txParams);
		const { txSig } = await this.sendTransaction(tx, [], {
			...this.opts,
			skipPreflight: true,
		});
		return txSig;
	}

	public async getTransferIsolatedPerpPositionDepositIx(
		amount: BN,
		perpMarketIndex: number,
		subAccountId?: number,
		noAmountBuffer?: boolean,
		signingAuthority?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			subAccountId ?? this.activeSubAccountId
		);

		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);
		const spotMarketIndex = perpMarketAccount.quoteSpotMarketIndex;
		const spotMarketAccount = this.getSpotMarketAccountOrThrow(spotMarketIndex);
		const user = await this.getUserAccountOrThrow(subAccountId);
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [user],
			writableSpotMarketIndexes: [spotMarketIndex],
			readablePerpMarketIndex: [perpMarketIndex],
		});

		const amountWithBuffer =
			noAmountBuffer || amount.eq(MIN_I64)
				? amount
				: amount.add(amount.div(new BN(200))); // .5% buffer

		return await this.program.instruction.transferIsolatedPerpPositionDeposit(
			spotMarketIndex,
			perpMarketIndex,
			amountWithBuffer,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarketVault: spotMarketAccount.vault,
					user: userAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: signingAuthority ?? this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async withdrawFromIsolatedPerpPosition(
		amount: BN,
		perpMarketIndex: number,
		userTokenAccount: PublicKey,
		subAccountId?: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const instructions =
			await this.getWithdrawFromIsolatedPerpPositionIxsBundle(
				amount,
				perpMarketIndex,
				subAccountId,
				userTokenAccount
			);
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(instructions, txParams)
		);
		return txSig;
	}

	public async getWithdrawFromIsolatedPerpPositionIxsBundle(
		amount: BN,
		perpMarketIndex: number,
		subAccountId?: number,
		userTokenAccount?: PublicKey
	): Promise<TransactionInstruction[]> {
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			subAccountId ?? this.activeSubAccountId
		);
		const userAccount = this.getUserAccountOrThrow(subAccountId);

		const tokenAmountDeposited =
			this.getIsolatedPerpPositionTokenAmount(perpMarketIndex);
		const isolatedPerpPosition = userAccount.perpPositions.find(
			(p) => p.marketIndex === perpMarketIndex
		);
		if (!isolatedPerpPosition) {
			throw new Error(
				`No perp position found for market index ${perpMarketIndex}`
			);
		}
		const isolatedPositionUnrealizedPnl = calculateClaimablePnl(
			this.getPerpMarketAccountOrThrow(perpMarketIndex),
			this.getSpotMarketAccountOrThrow(
				this.getPerpMarketAccountOrThrow(perpMarketIndex).quoteSpotMarketIndex
			),
			isolatedPerpPosition,
			this.getOracleDataForSpotMarket(
				this.getPerpMarketAccountOrThrow(perpMarketIndex).quoteSpotMarketIndex
			)
		);

		const depositAmountPlusUnrealizedPnl = tokenAmountDeposited.add(
			isolatedPositionUnrealizedPnl
		);

		const amountToWithdraw = amount.gt(depositAmountPlusUnrealizedPnl)
			? MIN_I64 // min i64
			: amount;
		let associatedTokenAccount = userTokenAccount;
		if (!associatedTokenAccount) {
			const perpMarketAccount =
				this.getPerpMarketAccountOrThrow(perpMarketIndex);
			const quoteSpotMarketIndex = perpMarketAccount.quoteSpotMarketIndex;
			associatedTokenAccount = await this.getAssociatedTokenAccount(
				quoteSpotMarketIndex
			);
		}

		const ixs: TransactionInstruction[] = [];
		const needsToSettle =
			amount.gt(tokenAmountDeposited) && isolatedPositionUnrealizedPnl.gt(ZERO);
		if (needsToSettle) {
			const settleIx = await this.settleMultiplePNLsIx(
				userAccountPublicKey,
				userAccount,
				[perpMarketIndex],
				SettlePnlMode.TRY_SETTLE
			);
			ixs.push(settleIx);
		}

		const withdrawIx = await this.getWithdrawFromIsolatedPerpPositionIx(
			amountToWithdraw,
			perpMarketIndex,
			associatedTokenAccount,
			subAccountId
		);
		ixs.push(withdrawIx);
		return ixs;
	}

	public async getWithdrawFromIsolatedPerpPositionIx(
		amount: BN,
		perpMarketIndex: number,
		userTokenAccount: PublicKey,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			subAccountId ?? this.activeSubAccountId
		);
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);
		const spotMarketIndex = perpMarketAccount.quoteSpotMarketIndex;
		const spotMarketAccount = this.getSpotMarketAccountOrThrow(spotMarketIndex);
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccountOrThrow(subAccountId)],
			writableSpotMarketIndexes: [spotMarketIndex],
			readablePerpMarketIndex: [perpMarketIndex],
		});

		return await this.program.instruction.withdrawFromIsolatedPerpPosition(
			spotMarketIndex,
			perpMarketIndex,
			amount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarketVault: spotMarketAccount.vault,
					user: userAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					userTokenAccount: userTokenAccount,
					tokenProgram: this.getTokenProgramForSpotMarket(spotMarketAccount),
					velocitySigner: this.getSignerPublicKey(),
				},
				remainingAccounts,
			}
		);
	}

	public async updateSpotMarketCumulativeInterest(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.updateSpotMarketCumulativeInterestIx(marketIndex),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async updateSpotMarketCumulativeInterestIx(
		marketIndex: number
	): Promise<TransactionInstruction> {
		const spotMarket = this.getSpotMarketAccountOrThrow(marketIndex);
		return await this.program.instruction.updateSpotMarketCumulativeInterest({
			accounts: {
				state: await this.getStatePublicKey(),
				spotMarket: spotMarket.pubkey,
				spotMarketVault: spotMarket.vault,
				oracle: spotMarket.oracle,
			},
		});
	}

	/**
	 * @deprecated use {@link placePerpOrder} or {@link placeAndTakePerpOrder} instead
	 */
	public async openPosition(
		direction: PositionDirection,
		amount: BN,
		marketIndex: number,
		limitPrice?: BN,
		subAccountId?: number
	): Promise<TransactionSignature> {
		return await this.placeAndTakePerpOrder(
			{
				orderType: OrderType.MARKET,
				marketIndex,
				direction,
				baseAssetAmount: amount,
				price: limitPrice,
			},
			undefined,
			undefined,
			undefined,
			undefined,
			subAccountId
		);
	}

	public async sendSignedTx(
		tx: Transaction | VersionedTransaction,
		opts?: ConfirmOptions
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			tx,
			undefined,
			opts ?? this.opts,
			true
		);

		return txSig;
	}

	public async prepareMarketOrderTxs(
		orderParams: OptionalOrderParams,
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		makerInfo?: MakerInfo | MakerInfo[],
		txParams?: TxParams,
		bracketOrdersParams = new Array<OptionalOrderParams>(),
		cancelExistingOrders?: boolean,
		settlePnl?: boolean,
		positionMaxLev?: number,
		isolatedPositionDepositAmount?: BN
	): Promise<{
		cancelExistingOrdersTx?: Transaction | VersionedTransaction;
		settlePnlTx?: Transaction | VersionedTransaction;
		fillTx?: Transaction | VersionedTransaction;
		marketOrderTx: Transaction | VersionedTransaction;
	}> {
		type TxKeys =
			| 'cancelExistingOrdersTx'
			| 'settlePnlTx'
			| 'fillTx'
			| 'marketOrderTx';

		const marketIndex = orderParams.marketIndex;
		const orderId = userAccount.nextOrderId;

		const ixPromisesForTxs: Record<
			TxKeys,
			Promise<TransactionInstruction | TransactionInstruction[]> | undefined
		> = {
			cancelExistingOrdersTx: undefined,
			settlePnlTx: undefined,
			fillTx: undefined,
			marketOrderTx: undefined,
		};

		const txKeys = Object.keys(ixPromisesForTxs);

		const preIxs: TransactionInstruction[] = await this.getPrePlaceOrderIxs(
			orderParams,
			userAccount,
			{
				positionMaxLev,
				isolatedPositionDepositAmount,
			}
		);

		ixPromisesForTxs.marketOrderTx = (async () => {
			const placeOrdersIx = await this.getPlaceOrdersIx(
				[orderParams, ...bracketOrdersParams],
				userAccount.subAccountId
			);
			if (preIxs.length) {
				return [...preIxs, placeOrdersIx] as unknown as TransactionInstruction;
			}
			return placeOrdersIx;
		})();

		/* Cancel open orders in market if requested */
		if (cancelExistingOrders && isVariant(orderParams.marketType, 'perp')) {
			ixPromisesForTxs.cancelExistingOrdersTx = this.getCancelOrdersIx(
				orderParams.marketType,
				orderParams.marketIndex,
				null,
				userAccount.subAccountId
			);
		}

		/* Settle PnL after fill if requested */
		if (settlePnl && isVariant(orderParams.marketType, 'perp')) {
			ixPromisesForTxs.settlePnlTx = this.settlePNLIx(
				userAccountPublicKey,
				userAccount,
				marketIndex
			);
		}

		// use versioned transactions if there is a lookup table account and wallet is compatible
		if (this.txVersion === 0) {
			ixPromisesForTxs.fillTx = this.getFillPerpOrderIx(
				userAccountPublicKey,
				userAccount,
				{
					orderId,
					marketIndex,
				},
				makerInfo,
				userAccount.subAccountId
			);
		}

		const ixs = await Promise.all(Object.values(ixPromisesForTxs));

		const ixsMap = ixs.reduce<
			Record<
				string,
				TransactionInstruction | TransactionInstruction[] | undefined
			>
		>((acc, ix, i) => {
			acc[txKeys[i]] = ix;
			return acc;
		}, {}) as MappedRecord<
			typeof ixPromisesForTxs,
			TransactionInstruction | TransactionInstruction[]
		>;

		const txsMap = (await this.buildTransactionsMap(
			ixsMap,
			txParams
		)) as MappedRecord<typeof ixsMap, Transaction | VersionedTransaction>;

		return txsMap;
	}

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
	public async sendMarketOrderAndGetSignedFillTx(
		orderParams: OptionalOrderParams,
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		makerInfo?: MakerInfo | MakerInfo[],
		txParams?: TxParams,
		bracketOrdersParams = new Array<OptionalOrderParams>(),
		cancelExistingOrders?: boolean,
		settlePnl?: boolean
	): Promise<{
		txSig: TransactionSignature;
		signedFillTx?: Transaction;
		signedCancelExistingOrdersTx?: Transaction;
		signedSettlePnlTx?: Transaction;
	}> {
		const preppedTxs = await this.prepareMarketOrderTxs(
			orderParams,
			userAccountPublicKey,
			userAccount,
			makerInfo,
			txParams,
			bracketOrdersParams,
			cancelExistingOrders,
			settlePnl
		);

		const signedTxs = (
			await this.txHandler.getSignedTransactionMap(preppedTxs, this.wallet)
		).signedTxMap;

		const { txSig, slot } = await this.sendTransaction(
			signedTxs.marketOrderTx,
			[],
			this.opts,
			true
		);

		this.cachePerpMarketSlot(slot, orderParams.marketIndex);

		return {
			txSig,
			signedFillTx: signedTxs.fillTx as Transaction,
			signedCancelExistingOrdersTx:
				signedTxs.cancelExistingOrdersTx as Transaction,
			signedSettlePnlTx: signedTxs.settlePnlTx as Transaction,
		};
	}

	public async placePerpOrder(
		orderParams: OptionalOrderParams,
		txParams?: TxParams,
		subAccountId?: number,
		isolatedPositionDepositAmount?: BN
	): Promise<TransactionSignature> {
		const preIxs: TransactionInstruction[] = [];
		if (
			isolatedPositionDepositAmount?.gt?.(ZERO) &&
			this.isOrderIncreasingPosition(orderParams, subAccountId)
		) {
			preIxs.push(
				await this.getTransferIsolatedPerpPositionDepositIx(
					isolatedPositionDepositAmount as BN,
					orderParams.marketIndex,
					subAccountId
				)
			);
		}

		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getPlacePerpOrderIx(orderParams, subAccountId),
				txParams,
				undefined,
				undefined,
				undefined,
				undefined,
				preIxs
			),
			[],
			this.opts
		);
		this.cachePerpMarketSlot(slot, orderParams.marketIndex);
		return txSig;
	}

	/**
	 * Returns the RevenueShareEscrow account meta for the placing user when `orderParams`
	 * carries a builder code (`builderIdx` + `builderFeeTenthBps`), otherwise `undefined`.
	 * The on-chain handlers peek for this account last in `remaining_accounts`, so callers
	 * must push it after the market/oracle/maker accounts.
	 */
	private getBuilderEscrowAccountMeta(
		orderParams: Pick<OrderParams, 'builderIdx' | 'builderFeeTenthBps'>,
		subAccountId?: number
	): AccountMeta | undefined {
		if (!hasBuilderParams(orderParams)) {
			return undefined;
		}
		const authority =
			this.getUserAccount(subAccountId)?.authority ?? this.authority;
		return {
			pubkey: getRevenueShareEscrowAccountPublicKey(
				this.program.programId,
				authority
			),
			isWritable: true,
			isSigner: false,
		};
	}

	/**
	 * Returns the AccountMeta for the taker's RevenueShareEscrow when a fill of the
	 * taker's order must include it: the order carries a builder code, or the taker
	 * is referred (their escrow was initialized with a referrer). Returns `undefined`
	 * when neither applies so no account meta is added to the transaction. The
	 * on-chain handlers peek for this account last in `remaining_accounts`, so
	 * callers must push it after the market/oracle/maker accounts.
	 *
	 * Throws when `takerEscrow` does not belong to `takerAuthority`.
	 */
	private getTakerEscrowAccountMeta(
		takerAuthority: PublicKey,
		orderHasBuilder: boolean,
		takerEscrow?: RevenueShareEscrowAccount,
		takerIsReferred?: boolean
	): AccountMeta | undefined {
		if (takerEscrow && !takerEscrow.authority.equals(takerAuthority)) {
			throw new Error(
				'takerEscrow.authority does not match the taker user account authority'
			);
		}
		// A taker is "referred" when their RevenueShareEscrow was initialized with a
		// referrer. Callers can signal this directly (`takerIsReferred`, e.g. from
		// the taker's UserStats.referrerStatus BuilderReferral bit — exactly what the
		// on-chain fill gate reads) or implicitly via a decoded escrow with a
		// referrer. The escrow PDA is deterministic, so no escrow data is required.
		const referred =
			!!takerIsReferred || (!!takerEscrow && escrowHasReferrer(takerEscrow));
		if (!orderHasBuilder && !referred) {
			return undefined;
		}
		return {
			pubkey: getRevenueShareEscrowAccountPublicKey(
				this.program.programId,
				takerAuthority
			),
			isWritable: true,
			isSigner: false,
		};
	}

	public async getPlacePerpOrderIx(
		orderParams: OptionalOrderParams,
		subAccountId?: number,
		depositToTradeArgs?: {
			isMakingNewAccount: boolean;
			depositMarketIndex: number;
		}
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.PERP });

		const isDepositToTradeTx = depositToTradeArgs !== undefined;

		const user = isDepositToTradeTx
			? getUserAccountPublicKeySync(
					this.program.programId,
					this.authority,
					subAccountId
			  )
			: await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: depositToTradeArgs?.isMakingNewAccount
				? []
				: [this.getUserAccountOrThrow(subAccountId)],
			useMarketLastSlotCache: false,
			readablePerpMarketIndex: orderParams.marketIndex,
			readableSpotMarketIndexes: isDepositToTradeTx
				? [depositToTradeArgs?.depositMarketIndex]
				: undefined,
		});

		const builderEscrow = this.getBuilderEscrowAccountMeta(
			orderParams,
			subAccountId
		);
		if (builderEscrow) {
			remainingAccounts.push(builderEscrow);
		}

		return await VelocityCore.buildPlacePerpOrderInstruction({
			program: this.program,
			orderParams,
			state: await this.getStatePublicKey(),
			user,
			userStats: this.getUserStatsAccountPublicKey(),
			authority: this.wallet.publicKey,
			remainingAccounts,
		});
	}

	public async updateAMMs(
		marketIndexes: number[],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateAMMsIx(marketIndexes),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateAMMsIx(
		marketIndexes: number[]
	): Promise<TransactionInstruction> {
		const marketAccountInfos = [];
		const oracleAccountInfos = [];
		for (const marketIndex of marketIndexes) {
			const market = this.getPerpMarketAccountOrThrow(marketIndex);
			marketAccountInfos.push({
				pubkey: market.pubkey,
				isWritable: true,
				isSigner: false,
			});
			oracleAccountInfos.push({
				pubkey: market.oracle,
				isWritable: false,
				isSigner: false,
			});
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
			await this.buildTransaction(
				await this.getSettleExpiredMarketIx(marketIndex),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettleExpiredMarketIx(
		marketIndex: number
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			writablePerpMarketIndexes: [marketIndex],
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		return await this.program.instruction.settleExpiredMarket(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.isSubscribed
					? this.getStateAccount().coldAdmin
					: this.wallet.publicKey,
				perpMarket: perpMarketPublicKey,
			},
			remainingAccounts,
		});
	}

	public async settleExpiredMarketPoolsToRevenuePool(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getSettleExpiredMarketPoolsToRevenuePoolIx(marketIndex),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettleExpiredMarketPoolsToRevenuePoolIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		const spotMarketPublicKey = await getSpotMarketPublicKey(
			this.program.programId,
			QUOTE_SPOT_MARKET_INDEX
		);

		return await this.program.instruction.settleExpiredMarketPoolsToRevenuePool(
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.isSubscribed
						? this.getStateAccount().coldAdmin
						: this.wallet.publicKey,
					spotMarket: spotMarketPublicKey,
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

	/**
	 * Cancel an open order and broadcast the transaction.
	 *
	 * When `orderId` is `undefined` (omitted or passed explicitly), the instruction is
	 * sent with a `null` order ID and the program cancels the most recently placed order
	 * on-chain via `get_last_order_id`. This is safe to use in a composed transaction
	 * where a place instruction runs first and the assigned order ID is not yet known.
	 *
	 * Note: when `orderId` is `undefined` and `overrides.withdrawIsolatedDepositAmount`
	 * is also provided, `getOrder` will return `undefined` (the ID is unknown client-side),
	 * causing the withdraw path to throw — supply an explicit `orderId` in that case.
	 *
	 * @see {@link getCancelOrderIx} to obtain the instruction without sending.
	 */
	public async cancelOrder(
		orderId?: number,
		txParams?: TxParams,
		subAccountId?: number,
		overrides?: { withdrawIsolatedDepositAmount?: BN }
	): Promise<TransactionSignature> {
		const cancelIx = await this.getCancelOrderIx(orderId, subAccountId);

		const instructions: TransactionInstruction[] = [cancelIx];

		if (overrides?.withdrawIsolatedDepositAmount !== undefined) {
			const order = this.getOrder(orderId, subAccountId);
			const perpMarketIndex = order?.marketIndex;
			const withdrawAmount = overrides.withdrawIsolatedDepositAmount;

			if (withdrawAmount.gt(ZERO)) {
				if (perpMarketIndex === undefined) {
					throw new Error(
						`Order ${orderId} not found when withdrawing isolated deposit`
					);
				}
				const withdrawIxs =
					await this.getWithdrawFromIsolatedPerpPositionIxsBundle(
						withdrawAmount,
						perpMarketIndex,
						subAccountId
					);
				instructions.push(...withdrawIxs);
			}
		}

		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(instructions, txParams),
			[],
			this.opts
		);
		return txSig;
	}

	/**
	 * Build a `cancelOrder` instruction for the given order.
	 *
	 * When `orderId` is `undefined` (omitted or passed explicitly), the instruction is
	 * built with a `null` order ID (`orderId ?? null`). The program interprets a `null`
	 * ID as "cancel the user's most recently placed order" (via `get_last_order_id`
	 * on-chain). This is useful when composing a multi-instruction transaction where a
	 * place instruction precedes the cancel and the program-assigned order ID is not yet
	 * known at build time.
	 *
	 * When `orderId` is supplied, only that specific order is cancelled.
	 *
	 * @see {@link cancelOrder} to send the transaction directly.
	 * @see {@link getCancelOrderByUserIdIx} to cancel by the caller-supplied `userOrderId`.
	 */
	public async getCancelOrderIx(
		orderId?: number,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccountOrThrow(subAccountId)],
			useMarketLastSlotCache: true,
		});

		return await VelocityCore.buildCancelOrderInstruction({
			program: this.program,
			orderId: orderId ?? null,
			state: await this.getStatePublicKey(),
			user,
			authority: this.wallet.publicKey,
			remainingAccounts,
		});
	}

	public async cancelOrderByUserId(
		userOrderId: number,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getCancelOrderByUserIdIx(userOrderId, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrderByUserIdIx(
		userOrderId: number,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const order = this.getOrderByUserId(userOrderId, subAccountId);
		if (!order) {
			throw new Error(`Order with user order id ${userOrderId} not found`);
		}
		const oracle = this.getPerpMarketAccountOrThrow(order.marketIndex).oracle;

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccountOrThrow(subAccountId)],
			useMarketLastSlotCache: true,
		});

		return await VelocityCore.buildCancelOrderByUserIdInstruction({
			program: this.program,
			userOrderId,
			state: await this.getStatePublicKey(),
			user,
			authority: this.wallet.publicKey,
			oracle,
			remainingAccounts,
		});
	}

	/**
	 * Sends a transaction to cancel the provided order ids.
	 *
	 * @param orderIds - The order ids to cancel.
	 * @param txParams - The transaction parameters.
	 * @param subAccountId - The sub account id to cancel the orders for.
	 * @param user - The user to cancel the orders for. If provided, it will be prioritized over the subAccountId.
	 * @returns The transaction signature.
	 */
	public async cancelOrdersByIds(
		orderIds?: number[],
		txParams?: TxParams,
		subAccountId?: number,
		user?: User,
		overrides?: {
			authority?: PublicKey;
		}
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getCancelOrdersByIdsIx(
					orderIds,
					subAccountId,
					user,
					overrides
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	/**
	 * Returns the transaction instruction to cancel the provided order ids.
	 *
	 * @param orderIds - The order ids to cancel.
	 * @param subAccountId - The sub account id to cancel the orders for.
	 * @param user - The user to cancel the orders for. If provided, it will be prioritized over the subAccountId.
	 * @returns The transaction instruction to cancel the orders.
	 */
	public async getCancelOrdersByIdsIx(
		orderIds?: number[],
		subAccountId?: number,
		user?: User,
		overrides?: {
			authority?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		const userAccountPubKey =
			user?.userAccountPublicKey ??
			(await this.getUserAccountPublicKey(subAccountId));
		const userAccount =
			user?.getUserAccount() ?? this.getUserAccountOrThrow(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
			useMarketLastSlotCache: true,
		});

		const authority = overrides?.authority ?? this.wallet.publicKey;

		return await VelocityCore.buildCancelOrdersByIdsInstruction({
			program: this.program,
			orderIds,
			state: await this.getStatePublicKey(),
			user: userAccountPubKey,
			authority,
			remainingAccounts,
		});
	}

	public async cancelOrders(
		marketType?: MarketType,
		marketIndex?: number,
		direction?: PositionDirection,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getCancelOrdersIx(
					marketType,
					marketIndex,
					direction,
					subAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrdersIx(
		marketType: MarketType | null | undefined,
		marketIndex: number | null | undefined,
		direction: PositionDirection | null | undefined,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		let readablePerpMarketIndex = undefined;
		let readableSpotMarketIndexes = undefined;

		if (typeof marketIndex === 'number') {
			if (marketType && isVariant(marketType, 'perp')) {
				readablePerpMarketIndex = marketIndex;
			} else if (marketType && isVariant(marketType, 'spot')) {
				readableSpotMarketIndexes = [marketIndex];
			}
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccountOrThrow(subAccountId)],
			readablePerpMarketIndex,
			readableSpotMarketIndexes,
			useMarketLastSlotCache: true,
		});

		return await VelocityCore.buildCancelOrdersInstruction({
			program: this.program,
			marketType: marketType ?? null,
			marketIndex: marketIndex ?? null,
			direction: direction ?? null,
			user,
			state: await this.getStatePublicKey(),
			userStats: this.getUserStatsAccountPublicKey(),
			authority: this.wallet.publicKey,
			remainingAccounts,
		});
	}

	public async cancelAndPlaceOrders(
		cancelOrderParams: {
			marketType?: MarketType;
			marketIndex?: number;
			direction?: PositionDirection;
		},
		placeOrderParams: OrderParams[],
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const ixs = [
			await this.getCancelOrdersIx(
				cancelOrderParams.marketType,
				cancelOrderParams.marketIndex,
				cancelOrderParams.direction,
				subAccountId
			),
			await this.getPlaceOrdersIx(placeOrderParams, subAccountId),
		];
		const tx = await this.buildTransaction(ixs, txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async placeOrders(
		params: OrderParams[],
		txParams?: TxParams,
		subAccountId?: number,
		optionalIxs?: TransactionInstruction[],
		isolatedPositionDepositAmount?: BN
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			(
				await this.preparePlaceOrdersTx(
					params,
					txParams,
					subAccountId,
					optionalIxs,
					isolatedPositionDepositAmount
				)
			).placeOrdersTx,
			[],
			this.opts,
			false
		);
		return txSig;
	}

	public async preparePlaceOrdersTx(
		params: OrderParams[],
		txParams?: TxParams,
		subAccountId?: number,
		optionalIxs?: TransactionInstruction[],
		isolatedPositionDepositAmount?: BN
	) {
		const lookupTableAccounts = await this.fetchAllLookupTableAccounts();

		const preIxs: TransactionInstruction[] = [];
		if (params?.length === 1) {
			const p = params[0];
			if (
				isVariant(p.marketType, 'perp') &&
				isolatedPositionDepositAmount?.gt?.(ZERO) &&
				this.isOrderIncreasingPosition(p, subAccountId)
			) {
				preIxs.push(
					await this.getTransferIsolatedPerpPositionDepositIx(
						isolatedPositionDepositAmount as BN,
						p.marketIndex,
						subAccountId
					)
				);
			}
		}

		const tx = await this.buildTransaction(
			await this.getPlaceOrdersIx(params, subAccountId),
			txParams,
			undefined,
			lookupTableAccounts,
			undefined,
			undefined,
			[...preIxs, ...(optionalIxs ?? [])]
		);

		return {
			placeOrdersTx: tx,
		};
	}
	public async getPlaceOrdersIx(
		params: OptionalOrderParams[],
		subAccountId?: number,
		overrides?: {
			authority?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const readablePerpMarketIndex: number[] = [];
		const readableSpotMarketIndexes: number[] = [];
		for (const param of params) {
			if (!param.marketType) {
				throw new Error('must set param.marketType');
			}
			if (isVariant(param.marketType, 'perp')) {
				readablePerpMarketIndex.push(param.marketIndex);
			} else {
				readableSpotMarketIndexes.push(param.marketIndex);
			}
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccountOrThrow(subAccountId)],
			readablePerpMarketIndex,
			readableSpotMarketIndexes,
			useMarketLastSlotCache: true,
		});

		const formattedParams = params.map((item) => getOrderParams(item));
		const authority = overrides?.authority ?? this.wallet.publicKey;

		// The handler loads a single RevenueShareEscrow for the placing user, so push it once
		// if any order in the batch carries a builder code.
		const builderParam = formattedParams.find((p) => hasBuilderParams(p));
		if (builderParam) {
			const builderEscrow = this.getBuilderEscrowAccountMeta(
				builderParam,
				subAccountId
			);
			if (builderEscrow) {
				remainingAccounts.push(builderEscrow);
			}
		}

		return await VelocityCore.buildPlaceOrdersInstruction({
			program: this.program,
			formattedParams,
			state: await this.getStatePublicKey(),
			user,
			userStats: this.getUserStatsAccountPublicKey(),
			authority,
			remainingAccounts,
		});
	}

	public async getPlaceOrdersAndSetPositionMaxLevIx(
		params: OptionalOrderParams[],
		positionMaxLev: number,
		subAccountId?: number
	): Promise<TransactionInstruction[]> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const readablePerpMarketIndex: number[] = [];
		const readableSpotMarketIndexes: number[] = [];
		for (const param of params) {
			if (!param.marketType) {
				throw new Error('must set param.marketType');
			}
			if (isVariant(param.marketType, 'perp')) {
				readablePerpMarketIndex.push(param.marketIndex);
			} else {
				readableSpotMarketIndexes.push(param.marketIndex);
			}
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccountOrThrow(subAccountId)],
			readablePerpMarketIndex,
			readableSpotMarketIndexes,
			useMarketLastSlotCache: true,
		});

		const formattedParams = params.map((item) => getOrderParams(item));

		const placeOrdersIxs = await (this.program.instruction as any).placeOrders(
			formattedParams,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);

		const marginRatio = Math.floor(
			(1 / positionMaxLev) * MARGIN_PRECISION.toNumber()
		);
		// Keep existing behavior but note: prefer using getPostPlaceOrderIxs path
		const setPositionMaxLevIxs =
			await this.getUpdateUserPerpPositionCustomMarginRatioIx(
				readablePerpMarketIndex[0],
				marginRatio,
				subAccountId
			);

		return [placeOrdersIxs, setPositionMaxLevIxs];
	}

	/**
	 * Place scale orders: multiple limit orders distributed across a price range
	 * @param params Scale order parameters
	 * @param txParams Optional transaction parameters
	 * @param subAccountId Optional sub account ID
	 * @returns Transaction signature
	 */
	public async placeScaleOrders(
		params: ScaleOrderParams,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			(await this.preparePlaceScaleOrdersTx(params, txParams, subAccountId))
				.placeScaleOrdersTx,
			[],
			this.opts,
			false
		);
		return txSig;
	}

	public async preparePlaceScaleOrdersTx(
		params: ScaleOrderParams,
		txParams?: TxParams,
		subAccountId?: number
	) {
		const lookupTableAccounts = await this.fetchAllLookupTableAccounts();

		const tx = await this.buildTransaction(
			await this.getPlaceScaleOrdersIx(params, subAccountId),
			txParams,
			undefined,
			lookupTableAccounts
		);

		return {
			placeScaleOrdersTx: tx,
		};
	}

	public async getPlaceScaleOrdersIx(
		params: ScaleOrderParams,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const isPerp = isVariant(params.marketType, 'perp');

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccountOrThrow(subAccountId)],
			readablePerpMarketIndex: isPerp ? [params.marketIndex] : [],
			readableSpotMarketIndexes: isPerp ? [] : [params.marketIndex],
			useMarketLastSlotCache: true,
		});

		const formattedParams = {
			marketType: params.marketType,
			direction: params.direction,
			marketIndex: params.marketIndex,
			totalBaseAssetAmount: params.totalBaseAssetAmount,
			startPrice: params.startPrice,
			endPrice: params.endPrice,
			orderCount: params.orderCount,
			sizeDistribution: params.sizeDistribution,
			reduceOnly: params.reduceOnly,
			postOnly: params.postOnly,
			bitFlags: params.bitFlags,
			maxTs: params.maxTs,
		};

		return await (this.program.instruction as any).placeScaleOrders(
			formattedParams,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user,
					userStats: this.getUserStatsAccountPublicKey(),
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
		makerInfo?: MakerInfo | MakerInfo[],
		txParams?: TxParams,
		fillerSubAccountId?: number,
		fillerAuthority?: PublicKey,
		hasBuilderFee?: boolean,
		takerEscrow?: RevenueShareEscrowAccount
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getFillPerpOrderIx(
					userAccountPublicKey,
					user,
					order,
					makerInfo,
					fillerSubAccountId,
					undefined,
					fillerAuthority,
					hasBuilderFee,
					takerEscrow
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getFillPerpOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order?: Pick<Order, 'marketIndex' | 'orderId'>,
		makerInfo?: MakerInfo | MakerInfo[],
		fillerSubAccountId?: number,
		isSignedMsg?: boolean,
		fillerAuthority?: PublicKey,
		hasBuilderFee?: boolean,
		// The program rejects fills that omit the taker's RevenueShareEscrow when the
		// order has a builder OR the taker is referred. The builder case is detected
		// from the order bitflags. For the referred case, prefer `takerIsReferred`
		// (below) — passing a decoded `takerEscrow` still works but is not required.
		takerEscrow?: RevenueShareEscrowAccount,
		// Set when the taker is referred (their escrow was initialized with a
		// referrer). This mirrors the on-chain gate, which reads the taker's
		// UserStats.referrerStatus BuilderReferral bit — e.g. pass
		// `isBuilderReferral(takerUserStats)`. No escrow account data is needed.
		takerIsReferred?: boolean
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		let filler;

		if (fillerAuthority) {
			filler = getUserAccountPublicKeySync(
				this.program.programId,
				fillerAuthority,
				fillerSubAccountId
			);
		} else {
			filler = await this.getUserAccountPublicKey(fillerSubAccountId);
		}

		let fillerStatsPublicKey;

		if (fillerAuthority) {
			fillerStatsPublicKey = getUserStatsAccountPublicKey(
				this.program.programId,
				fillerAuthority
			);
		} else {
			fillerStatsPublicKey = this.getUserStatsAccountPublicKey();
		}

		const marketIndex = order
			? order.marketIndex
			: userAccount.orders.find(
					(order) => order.orderId === userAccount.nextOrderId - 1
			  )?.marketIndex;
		if (marketIndex === undefined) {
			throw new Error('No order found to fill');
		}

		makerInfo = Array.isArray(makerInfo)
			? makerInfo
			: makerInfo
			? [makerInfo]
			: [];

		const userAccounts = [userAccount];
		for (const maker of makerInfo) {
			userAccounts.push(maker.makerUserAccount);
		}
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			writablePerpMarketIndexes: [marketIndex],
		});

		for (const maker of makerInfo) {
			remainingAccounts.push({
				pubkey: maker.maker,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: maker.makerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		let withBuilder = false;
		if (hasBuilderFee) {
			withBuilder = true;
		} else {
			// figure out if we need builder account or not
			if (order && !isSignedMsg) {
				const userOrder = userAccount.orders.find(
					(o) => o.orderId === order.orderId
				);
				if (userOrder) {
					withBuilder = hasBuilder(userOrder);
				}
			} else if (isSignedMsg) {
				// Order hasn't been placed yet, we can't tell if it has a builder or not.
				// Include it optimistically
				withBuilder = true;
			}
		}

		const takerEscrowMeta = this.getTakerEscrowAccountMeta(
			userAccount.authority,
			withBuilder,
			takerEscrow,
			takerIsReferred
		);
		if (takerEscrowMeta) {
			remainingAccounts.push(takerEscrowMeta);
		}

		let orderId: number | null = null;
		if (!isSignedMsg) {
			if (!order) {
				throw new Error('order is required to fill a non-signedMsg order');
			}
			orderId = order.orderId;
		}
		return await VelocityCore.buildFillPerpOrderInstruction({
			program: this.program,
			orderId,
			state: await this.getStatePublicKey(),
			filler,
			fillerStats: fillerStatsPublicKey,
			user: userAccountPublicKey,
			userStats: userStatsPublicKey,
			authority: this.wallet.publicKey,
			remainingAccounts,
		});
	}

	public async getRevertFillIx(
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const filler = fillerPublicKey ?? (await this.getUserAccountPublicKey());
		const fillerStatsPublicKey = this.getUserStatsAccountPublicKey();

		return this.program.instruction.revertFill({
			accounts: {
				state: await this.getStatePublicKey(),
				filler,
				fillerStats: fillerStatsPublicKey,
				authority: this.wallet.publicKey,
			},
		});
	}

	public async placeSpotOrder(
		_orderParams: OptionalOrderParams,
		_txParams?: TxParams,
		_subAccountId?: number
	): Promise<TransactionSignature> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	public async preparePlaceSpotOrderTx(
		_orderParams: OptionalOrderParams,
		_txParams?: TxParams,
		_subAccountId?: number
	) {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	public async getPlaceSpotOrderIx(
		_orderParams: OptionalOrderParams,
		_subAccountId?: number,
		_overrides?: {
			authority?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	public async fillSpotOrder(
		_userAccountPublicKey: PublicKey,
		_user: UserAccount,
		_order?: Pick<Order, 'marketIndex' | 'orderId'>,
		_fulfillmentConfig?: unknown,
		_makerInfo?: MakerInfo | MakerInfo[],
		_txParams?: TxParams
	): Promise<TransactionSignature> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	public async getFillSpotOrderIx(
		_userAccountPublicKey: PublicKey,
		_userAccount: UserAccount,
		_order?: Pick<Order, 'marketIndex' | 'orderId'>,
		_fulfillmentConfig?: unknown,
		_makerInfo?: MakerInfo | MakerInfo[],
		_fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	/**
	 * Swap tokens in velocity account using titan or jupiter
	 * @param swapClient swap client to find routes and instructions (Titan or Jupiter)
	 * @param jupiterClient @deprecated Use swapClient instead. Legacy parameter for backward compatibility
	 * @param outMarketIndex the market index of the token you're buying
	 * @param inMarketIndex the market index of the token you're selling
	 * @param outAssociatedTokenAccount the token account to receive the token being sold on the swap provider
	 * @param inAssociatedTokenAccount the token account to
	 * @param amount the amount of TokenIn, regardless of swapMode
	 * @param slippageBps the max slippage passed to the swap provider api
	 * @param swapMode swap provider swapMode (ExactIn or ExactOut), default is ExactIn
	 * @param route the swap provider route to use for the swap
	 * @param reduceOnly specify if In or Out token on the velocity account must reduceOnly, checked at end of swap
	 * @param v6 pass in the quote response from swap provider quote's API (deprecated, use quote instead)
	 * @param quote pass in the quote response from swap provider quote's API
	 * @param txParams
	 */
	public async swap({
		swapClient,
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
		onlyDirectRoutes = false,
	}: {
		swapClient?: UnifiedSwapClient | SwapClient;
		/** @deprecated Use swapClient instead. Legacy parameter for backward compatibility */
		jupiterClient?: JupiterClient;
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
		quote?: UnifiedQuoteResponse;
	}): Promise<TransactionSignature> {
		// Handle backward compatibility: use jupiterClient if swapClient is not provided
		const clientToUse = swapClient || jupiterClient;

		if (!clientToUse) {
			throw new Error('Either swapClient or jupiterClient must be provided');
		}

		let res: {
			ixs: TransactionInstruction[];
			lookupTables: AddressLookupTableAccount[];
		};

		// Use unified SwapClient if available
		if (clientToUse instanceof UnifiedSwapClient) {
			res = await this.getSwapIxV2({
				swapClient: clientToUse,
				outMarketIndex,
				inMarketIndex,
				outAssociatedTokenAccount,
				inAssociatedTokenAccount,
				amount,
				slippageBps,
				swapMode,
				onlyDirectRoutes,
				reduceOnly,
				quote,
				v6,
			});
		} else if (clientToUse instanceof TitanClient) {
			res = await this.getTitanSwapIx({
				titanClient: clientToUse,
				outMarketIndex,
				inMarketIndex,
				outAssociatedTokenAccount,
				inAssociatedTokenAccount,
				amount,
				slippageBps,
				swapMode,
				onlyDirectRoutes,
				reduceOnly,
			});
		} else if (clientToUse instanceof JupiterClient) {
			const quoteToUse = quote ?? v6?.quote;
			res = await this.getJupiterSwapIxV6({
				jupiterClient: clientToUse,
				outMarketIndex,
				inMarketIndex,
				outAssociatedTokenAccount,
				inAssociatedTokenAccount,
				amount,
				slippageBps,
				swapMode,
				quote: quoteToUse as QuoteResponse,
				reduceOnly,
				onlyDirectRoutes,
			});
		} else {
			throw new Error(
				'Invalid swap client type. Must be SwapClient, TitanClient, or JupiterClient.'
			);
		}

		const ixs = res.ixs;
		const lookupTables = res.lookupTables;

		const tx = (await this.buildTransaction(
			ixs,
			txParams,
			0,
			lookupTables
		)) as VersionedTransaction;

		const { txSig, slot } = await this.sendTransaction(tx);
		this.cacheSpotMarketSlot(slot, outMarketIndex, inMarketIndex);

		return txSig;
	}

	public async getTitanSwapIx({
		titanClient,
		outMarketIndex,
		inMarketIndex,
		outAssociatedTokenAccount,
		inAssociatedTokenAccount,
		amount,
		slippageBps,
		swapMode,
		onlyDirectRoutes,
		reduceOnly,
		userAccountPublicKey,
	}: {
		titanClient: TitanClient;
		outMarketIndex: number;
		inMarketIndex: number;
		outAssociatedTokenAccount?: PublicKey;
		inAssociatedTokenAccount?: PublicKey;
		amount: BN;
		slippageBps?: number;
		swapMode?: string;
		onlyDirectRoutes?: boolean;
		reduceOnly?: SwapReduceOnly;
		userAccountPublicKey?: PublicKey;
	}): Promise<{
		ixs: TransactionInstruction[];
		lookupTables: AddressLookupTableAccount[];
	}> {
		const outMarket = this.getSpotMarketAccountOrThrow(outMarketIndex);
		const inMarket = this.getSpotMarketAccountOrThrow(inMarketIndex);

		const isExactOut = swapMode === 'ExactOut';
		const exactOutBufferedAmountIn = amount.muln(1001).divn(1000); // Add 10bp buffer

		const preInstructions = [];
		if (!outAssociatedTokenAccount) {
			const tokenProgram = this.getTokenProgramForSpotMarket(outMarket);
			outAssociatedTokenAccount = await this.getAssociatedTokenAccount(
				outMarket.marketIndex,
				false,
				tokenProgram
			);

			const accountInfo = await this.connection.getAccountInfo(
				outAssociatedTokenAccount
			);
			if (!accountInfo) {
				preInstructions.push(
					this.createAssociatedTokenAccountIdempotentInstruction(
						outAssociatedTokenAccount,
						this.provider.wallet.publicKey,
						this.provider.wallet.publicKey,
						outMarket.mint,
						tokenProgram
					)
				);
			}
		}

		if (!inAssociatedTokenAccount) {
			const tokenProgram = this.getTokenProgramForSpotMarket(inMarket);
			inAssociatedTokenAccount = await this.getAssociatedTokenAccount(
				inMarket.marketIndex,
				false,
				tokenProgram
			);

			const accountInfo = await this.connection.getAccountInfo(
				inAssociatedTokenAccount
			);
			if (!accountInfo) {
				preInstructions.push(
					this.createAssociatedTokenAccountIdempotentInstruction(
						inAssociatedTokenAccount,
						this.provider.wallet.publicKey,
						this.provider.wallet.publicKey,
						inMarket.mint,
						tokenProgram
					)
				);
			}
		}

		const { beginSwapIx, endSwapIx } = await this.getSwapIx({
			outMarketIndex,
			inMarketIndex,
			amountIn: isExactOut ? exactOutBufferedAmountIn : amount,
			inTokenAccount: inAssociatedTokenAccount,
			outTokenAccount: outAssociatedTokenAccount,
			reduceOnly,
			userAccountPublicKey,
		});

		const { transactionMessage, lookupTables } = await titanClient.getSwap({
			inputMint: inMarket.mint,
			outputMint: outMarket.mint,
			amount,
			userPublicKey: this.provider.wallet.publicKey,
			slippageBps,
			swapMode: isExactOut ? TitanSwapMode.ExactOut : TitanSwapMode.ExactIn,
			onlyDirectRoutes,
			sizeConstraint: MAX_TX_BYTE_SIZE - 375, // buffer for velocity instructions
		});

		const titanInstructions = titanClient.getTitanInstructions({
			transactionMessage,
			inputMint: inMarket.mint,
			outputMint: outMarket.mint,
		});

		const ixs = [
			...preInstructions,
			beginSwapIx,
			...titanInstructions,
			endSwapIx,
		];

		return { ixs, lookupTables };
	}

	public async getJupiterSwapIxV6({
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
	}> {
		const outMarket = this.getSpotMarketAccountOrThrow(outMarketIndex);
		const inMarket = this.getSpotMarketAccountOrThrow(inMarketIndex);

		if (!quote) {
			const fetchedQuote = await jupiterClient.getQuote({
				inputMint: inMarket.mint,
				outputMint: outMarket.mint,
				amount,
				slippageBps,
				swapMode,
				onlyDirectRoutes,
			});

			quote = fetchedQuote;
		}

		if (!quote) {
			throw new Error('Could not fetch swap quote. Please try again.');
		}

		const isExactOut = swapMode === 'ExactOut' || quote.swapMode === 'ExactOut';
		const amountIn = new BN(quote.inAmount);
		const exactOutBufferedAmountIn = amountIn.muln(1001).divn(1000); // Add 10bp buffer

		const transaction = await jupiterClient.getSwap({
			quote,
			userPublicKey: this.provider.wallet.publicKey,
			slippageBps,
		});

		const { transactionMessage, lookupTables } =
			await jupiterClient.getTransactionMessageAndLookupTables({
				transaction,
			});

		const jupiterInstructions = jupiterClient.getJupiterInstructions({
			transactionMessage,
			inputMint: inMarket.mint,
			outputMint: outMarket.mint,
		});

		const preInstructions = [];
		if (!outAssociatedTokenAccount) {
			const tokenProgram = this.getTokenProgramForSpotMarket(outMarket);
			outAssociatedTokenAccount = await this.getAssociatedTokenAccount(
				outMarket.marketIndex,
				false,
				tokenProgram
			);

			const accountInfo = await this.connection.getAccountInfo(
				outAssociatedTokenAccount
			);
			if (!accountInfo) {
				preInstructions.push(
					this.createAssociatedTokenAccountIdempotentInstruction(
						outAssociatedTokenAccount,
						this.provider.wallet.publicKey,
						this.provider.wallet.publicKey,
						outMarket.mint,
						tokenProgram
					)
				);
			}
		}

		if (!inAssociatedTokenAccount) {
			const tokenProgram = this.getTokenProgramForSpotMarket(inMarket);
			inAssociatedTokenAccount = await this.getAssociatedTokenAccount(
				inMarket.marketIndex,
				false,
				tokenProgram
			);

			const accountInfo = await this.connection.getAccountInfo(
				inAssociatedTokenAccount
			);
			if (!accountInfo) {
				preInstructions.push(
					this.createAssociatedTokenAccountIdempotentInstruction(
						inAssociatedTokenAccount,
						this.provider.wallet.publicKey,
						this.provider.wallet.publicKey,
						inMarket.mint,
						tokenProgram
					)
				);
			}
		}

		const { beginSwapIx, endSwapIx } = await this.getSwapIx({
			outMarketIndex,
			inMarketIndex,
			amountIn: isExactOut ? exactOutBufferedAmountIn : amountIn,
			inTokenAccount: inAssociatedTokenAccount,
			outTokenAccount: outAssociatedTokenAccount,
			reduceOnly,
			userAccountPublicKey,
		});

		const ixs = [
			...preInstructions,
			beginSwapIx,
			...jupiterInstructions,
			endSwapIx,
		];

		return { ixs, lookupTables };
	}

	/**
	 * Get the velocity begin_swap and end_swap instructions
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
	public async getSwapIx({
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
	}> {
		const userAccountPublicKeyToUse =
			userAccountPublicKey || (await this.getUserAccountPublicKey());

		const userAccounts = [];
		try {
			const userAccount = this.hasUser()
				? this.getUser().getUserAccount()
				: undefined;
			if (userAccount) {
				userAccounts.push(userAccount);
			}
		} catch (err) {
			// ignore
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			writableSpotMarketIndexes: [outMarketIndex, inMarketIndex],
			readableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		const outSpotMarket = this.getSpotMarketAccountOrThrow(outMarketIndex);
		const inSpotMarket = this.getSpotMarketAccountOrThrow(inMarketIndex);

		const outTokenProgram = this.getTokenProgramForSpotMarket(outSpotMarket);
		const inTokenProgram = this.getTokenProgramForSpotMarket(inSpotMarket);

		if (!outTokenProgram.equals(inTokenProgram)) {
			remainingAccounts.push({
				pubkey: outTokenProgram,
				isWritable: false,
				isSigner: false,
			});
		}

		if (this.isToken2022(outSpotMarket) || this.isToken2022(inSpotMarket)) {
			remainingAccounts.push({
				pubkey: inSpotMarket.mint,
				isWritable: false,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: outSpotMarket.mint,
				isWritable: false,
				isSigner: false,
			});
			if (this.isTransferHook(outSpotMarket)) {
				this.addExtraAccountMetasToRemainingAccounts(
					outSpotMarket.mint,
					remainingAccounts
				);
			}
			if (this.isTransferHook(inSpotMarket)) {
				this.addExtraAccountMetasToRemainingAccounts(
					inSpotMarket.mint,
					remainingAccounts
				);
			}
		}

		const beginSwapIx = await this.program.instruction.beginSwap(
			inMarketIndex,
			outMarketIndex,
			amountIn,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKeyToUse,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					outSpotMarketVault: outSpotMarket.vault,
					inSpotMarketVault: inSpotMarket.vault,
					inTokenAccount,
					outTokenAccount,
					tokenProgram: inTokenProgram,
					velocitySigner: this.getStateAccount().signer,
					instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
				},
				remainingAccounts,
			}
		);

		const endSwapIx = await this.program.instruction.endSwap(
			inMarketIndex,
			outMarketIndex,
			limitPrice ?? null,
			reduceOnly ?? null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKeyToUse,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					outSpotMarketVault: outSpotMarket.vault,
					inSpotMarketVault: inSpotMarket.vault,
					inTokenAccount,
					outTokenAccount,
					tokenProgram: inTokenProgram,
					velocitySigner: this.getStateAccount().signer,
					instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
				},
				remainingAccounts,
			}
		);

		return { beginSwapIx, endSwapIx };
	}

	public async getSwapIxV2({
		swapClient,
		outMarketIndex,
		inMarketIndex,
		outAssociatedTokenAccount,
		inAssociatedTokenAccount,
		amount,
		slippageBps,
		swapMode,
		onlyDirectRoutes,
		reduceOnly,
		quote,
		v6,
		userAccountPublicKey,
	}: {
		swapClient: UnifiedSwapClient;
		outMarketIndex: number;
		inMarketIndex: number;
		outAssociatedTokenAccount?: PublicKey;
		inAssociatedTokenAccount?: PublicKey;
		amount: BN;
		slippageBps?: number;
		swapMode?: SwapMode;
		onlyDirectRoutes?: boolean;
		reduceOnly?: SwapReduceOnly;
		quote?: UnifiedQuoteResponse;
		v6?: {
			quote?: QuoteResponse;
		};
		userAccountPublicKey?: PublicKey;
	}): Promise<{
		ixs: TransactionInstruction[];
		lookupTables: AddressLookupTableAccount[];
	}> {
		// Get market accounts to determine mints
		const outMarket = this.getSpotMarketAccountOrThrow(outMarketIndex);
		const inMarket = this.getSpotMarketAccountOrThrow(inMarketIndex);

		const isExactOut = swapMode === 'ExactOut';

		const preInstructions: TransactionInstruction[] = [];

		// Handle token accounts if not provided
		let finalOutAssociatedTokenAccount = outAssociatedTokenAccount;
		let finalInAssociatedTokenAccount = inAssociatedTokenAccount;

		if (!finalOutAssociatedTokenAccount) {
			const tokenProgram = this.getTokenProgramForSpotMarket(outMarket);
			finalOutAssociatedTokenAccount = await this.getAssociatedTokenAccount(
				outMarket.marketIndex,
				false,
				tokenProgram
			);

			const accountInfo = await this.connection.getAccountInfo(
				finalOutAssociatedTokenAccount
			);
			if (!accountInfo) {
				preInstructions.push(
					this.createAssociatedTokenAccountIdempotentInstruction(
						finalOutAssociatedTokenAccount,
						this.provider.wallet.publicKey,
						this.provider.wallet.publicKey,
						outMarket.mint,
						tokenProgram
					)
				);
			}
		}

		if (!finalInAssociatedTokenAccount) {
			const tokenProgram = this.getTokenProgramForSpotMarket(inMarket);
			finalInAssociatedTokenAccount = await this.getAssociatedTokenAccount(
				inMarket.marketIndex,
				false,
				tokenProgram
			);

			const accountInfo = await this.connection.getAccountInfo(
				finalInAssociatedTokenAccount
			);
			if (!accountInfo) {
				preInstructions.push(
					this.createAssociatedTokenAccountIdempotentInstruction(
						finalInAssociatedTokenAccount,
						this.provider.wallet.publicKey,
						this.provider.wallet.publicKey,
						inMarket.mint,
						tokenProgram
					)
				);
			}
		}

		let amountInForBeginSwap: BN;
		if (isExactOut) {
			if (quote || v6?.quote) {
				amountInForBeginSwap = v6?.quote
					? new BN(v6.quote.inAmount)
					: new BN(quote!.inAmount);
			} else {
				amountInForBeginSwap = amount.muln(1001).divn(1000);
			}
		} else {
			amountInForBeginSwap = amount;
		}

		// Get velocity swap instructions for begin and end
		const { beginSwapIx, endSwapIx } = await this.getSwapIx({
			outMarketIndex,
			inMarketIndex,
			amountIn: amountInForBeginSwap,
			inTokenAccount: finalInAssociatedTokenAccount,
			outTokenAccount: finalOutAssociatedTokenAccount,
			reduceOnly,
			userAccountPublicKey,
		});

		// Get core swap instructions from SwapClient
		const swapResult = await swapClient.getSwapInstructions({
			inputMint: inMarket.mint,
			outputMint: outMarket.mint,
			amount,
			userPublicKey: this.provider.wallet.publicKey,
			slippageBps,
			swapMode,
			onlyDirectRoutes,
			quote: quote ?? v6?.quote,
		});

		const allInstructions = [
			...preInstructions,
			beginSwapIx,
			...swapResult.instructions,
			endSwapIx,
		];

		return {
			ixs: allInstructions,
			lookupTables: swapResult.lookupTables,
		};
	}

	public async stakeForMSOL({ amount }: { amount: BN }): Promise<TxSigAndSlot> {
		const ixs = await this.getStakeForMSOLIx({ amount });
		const tx = await this.buildTransaction(ixs);
		return this.sendTransaction(tx);
	}

	public async getStakeForMSOLIx({
		amount,
		userAccountPublicKey,
	}: {
		amount: BN;
		userAccountPublicKey?: PublicKey;
	}): Promise<TransactionInstruction[]> {
		const wSOLMint = this.getSpotMarketAccountOrThrow(1).mint;
		const mSOLAccount = await this.getAssociatedTokenAccount(2);
		const wSOLAccount = await this.getAssociatedTokenAccount(1, false);

		const wSOLAccountExists = await this.checkIfAccountExists(wSOLAccount);

		const closeWSOLIx = createCloseAccountInstruction(
			wSOLAccount,
			this.wallet.publicKey,
			this.wallet.publicKey
		);

		const createWSOLIx =
			await this.createAssociatedTokenAccountIdempotentInstruction(
				wSOLAccount,
				this.wallet.publicKey,
				this.wallet.publicKey,
				wSOLMint
			);

		const { beginSwapIx, endSwapIx } = await this.getSwapIx({
			inMarketIndex: 1,
			outMarketIndex: 2,
			amountIn: amount,
			inTokenAccount: wSOLAccount,
			outTokenAccount: mSOLAccount,
			userAccountPublicKey,
		});

		const program = getMarinadeFinanceProgram(this.provider);
		const depositIx = await getMarinadeDepositIx({
			program,
			mSOLAccount: mSOLAccount,
			transferFrom: this.wallet.publicKey,
			amount,
		});

		const ixs = [];

		if (!wSOLAccountExists) {
			ixs.push(createWSOLIx);
		}
		ixs.push(beginSwapIx, closeWSOLIx, depositIx, createWSOLIx, endSwapIx);

		return ixs;
	}

	public async triggerOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order: Order,
		txParams?: TxParams,
		fillerPublicKey?: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getTriggerOrderIx(
					userAccountPublicKey,
					user,
					order,
					fillerPublicKey
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getTriggerOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order: Order,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const filler = fillerPublicKey ?? (await this.getUserAccountPublicKey());

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
		return await VelocityCore.buildTriggerOrderInstruction({
			program: this.program,
			orderId,
			state: await this.getStatePublicKey(),
			filler,
			user: userAccountPublicKey,
			authority: this.wallet.publicKey,
			remainingAccounts,
		});
	}

	public async forceCancelOrders(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		txParams?: TxParams,
		fillerPublicKey?: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getForceCancelOrdersIx(
					userAccountPublicKey,
					user,
					fillerPublicKey
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getForceCancelOrdersIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const filler = fillerPublicKey ?? (await this.getUserAccountPublicKey());

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		return await this.program.instruction.forceCancelOrders({
			accounts: {
				state: await this.getStatePublicKey(),
				filler,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async updateUserIdle(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		txParams?: TxParams,
		fillerPublicKey?: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateUserIdleIx(
					userAccountPublicKey,
					user,
					fillerPublicKey
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateUserIdleIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const filler = fillerPublicKey ?? (await this.getUserAccountPublicKey());

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
		});

		return await this.program.instruction.updateUserIdle({
			accounts: {
				state: await this.getStatePublicKey(),
				filler,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async logUserBalances(
		userAccountPublicKey: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLogUserBalancesIx(userAccountPublicKey),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getLogUserBalancesIx(
		userAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const userAccount = (await (this.program.account as any).user.fetch(
			userAccountPublicKey
		)) as UserAccount;
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
		});

		return await this.program.instruction.logUserBalances({
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async updateUserStatsReferrerStatus(
		userAuthority: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateUserStatsReferrerStatusIx(userAuthority),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateUserStatsReferrerStatusIx(
		userAuthority: PublicKey
	): Promise<TransactionInstruction> {
		const userStatsAccountPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAuthority
		);

		return await this.program.instruction.updateUserStatsReferrerStatus({
			accounts: {
				state: await this.getStatePublicKey(),
				userStats: userStatsAccountPublicKey,
				authority: this.wallet.publicKey,
			},
		});
	}

	public async updateUserOpenOrdersCount(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		txParams?: TxParams,
		fillerPublicKey?: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateUserOpenOrdersCountIx(
					userAccountPublicKey,
					user,
					fillerPublicKey
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateUserOpenOrdersCountIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const filler = fillerPublicKey ?? (await this.getUserAccountPublicKey());

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
		});

		return await (this.program.instruction as any).updateUserOpenOrdersCount({
			accounts: {
				state: await this.getStatePublicKey(),
				filler,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async placeAndTakePerpOrder(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		successCondition?: PlaceAndTakeOrderSuccessCondition,
		auctionDurationPercentage?: number,
		txParams?: TxParams,
		subAccountId?: number,
		takerEscrow?: RevenueShareEscrowAccount
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getPlaceAndTakePerpOrderIx(
					orderParams,
					makerInfo,
					successCondition,
					auctionDurationPercentage,
					subAccountId,
					undefined,
					takerEscrow
				),
				txParams
			),
			[],
			this.opts
		);
		this.cachePerpMarketSlot(slot, orderParams.marketIndex);
		return txSig;
	}
	public async preparePlaceAndTakePerpOrderWithAdditionalOrders(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		bracketOrdersParams = new Array<OptionalOrderParams>(),
		txParams?: TxParams,
		subAccountId?: number,
		cancelExistingOrders?: boolean,
		settlePnl?: boolean,
		exitEarlyIfSimFails?: boolean,
		auctionDurationPercentage?: number,
		optionalIxs?: TransactionInstruction[],
		isolatedPositionDepositAmount?: BN
	): Promise<{
		placeAndTakeTx: Transaction | VersionedTransaction | undefined;
		cancelExistingOrdersTx: Transaction | VersionedTransaction | undefined;
		settlePnlTx: Transaction | VersionedTransaction | undefined;
	} | null> {
		const placeAndTakeIxs: TransactionInstruction[] = [];

		type TxKeys = 'placeAndTakeTx' | 'cancelExistingOrdersTx' | 'settlePnlTx';

		const txsToSign: Record<
			TxKeys,
			Transaction | VersionedTransaction | undefined
		> = {
			placeAndTakeTx: undefined,
			cancelExistingOrdersTx: undefined,
			settlePnlTx: undefined,
		};

		// Get recent block hash so that we can re-use it for all transactions. Makes this logic run faster with fewer RPC requests
		const recentBlockHash =
			await this.txHandler.getLatestBlockhashForTransaction();

		const lookupTableAccounts = await this.fetchAllLookupTableAccounts();

		let earlyExitFailedPlaceAndTakeSim = false;

		const prepPlaceAndTakeTx = async () => {
			const placeAndTakeIx = await this.getPlaceAndTakePerpOrderIx(
				orderParams,
				makerInfo,
				undefined,
				auctionDurationPercentage,
				subAccountId
			);

			if (
				isVariant(orderParams.marketType, 'perp') &&
				isolatedPositionDepositAmount?.gt?.(ZERO) &&
				this.isOrderIncreasingPosition(orderParams, subAccountId)
			) {
				placeAndTakeIxs.push(
					await this.getTransferIsolatedPerpPositionDepositIx(
						isolatedPositionDepositAmount as BN,
						orderParams.marketIndex,
						subAccountId
					)
				);
			}

			placeAndTakeIxs.push(placeAndTakeIx);

			if (bracketOrdersParams.length > 0) {
				const bracketOrdersIx = await this.getPlaceOrdersIx(
					bracketOrdersParams,
					subAccountId
				);
				placeAndTakeIxs.push(bracketOrdersIx);
			}

			// Optional extra ixs can be appended at the front
			if (optionalIxs?.length) {
				placeAndTakeIxs.unshift(...optionalIxs);
			}

			const shouldUseSimulationComputeUnits =
				txParams?.useSimulatedComputeUnits;
			const shouldExitIfSimulationFails = exitEarlyIfSimFails;

			const txParamsWithoutImplicitSimulation: TxParams = {
				...txParams,
				useSimulatedComputeUnits: false,
			};

			if (shouldUseSimulationComputeUnits || shouldExitIfSimulationFails) {
				if (!txParams) {
					throw new Error(
						'txParams is required when simulating compute units or exiting early on failed simulation'
					);
				}
				const placeAndTakeTxToSim = (await this.buildTransaction(
					placeAndTakeIxs,
					txParams,
					undefined,
					lookupTableAccounts,
					true,
					recentBlockHash,
					optionalIxs
				)) as VersionedTransaction;

				const simulationResult =
					await TransactionParamProcessor.getTxSimComputeUnits(
						placeAndTakeTxToSim,
						this.connection,
						txParams.computeUnitsBufferMultiplier ?? 1.2,
						txParams.lowerBoundCu
					);

				if (shouldExitIfSimulationFails && !simulationResult.success) {
					earlyExitFailedPlaceAndTakeSim = true;
					return;
				}

				txsToSign.placeAndTakeTx = await this.buildTransaction(
					placeAndTakeIxs,
					{
						...txParamsWithoutImplicitSimulation,
						computeUnits: simulationResult.computeUnits,
					},
					undefined,
					lookupTableAccounts,
					undefined,
					recentBlockHash,
					optionalIxs
				);
			} else {
				txsToSign.placeAndTakeTx = await this.buildTransaction(
					placeAndTakeIxs,
					txParams,
					undefined,
					lookupTableAccounts,
					undefined,
					recentBlockHash,
					optionalIxs
				);
			}

			return;
		};

		const prepCancelOrderTx = async () => {
			if (cancelExistingOrders && isVariant(orderParams.marketType, 'perp')) {
				const cancelOrdersIx = await this.getCancelOrdersIx(
					orderParams.marketType,
					orderParams.marketIndex,
					null,
					subAccountId
				);

				txsToSign.cancelExistingOrdersTx = await this.buildTransaction(
					[cancelOrdersIx],
					txParams,
					this.txVersion,
					lookupTableAccounts,
					undefined,
					recentBlockHash,
					optionalIxs
				);
			}

			return;
		};

		const prepSettlePnlTx = async () => {
			if (settlePnl && isVariant(orderParams.marketType, 'perp')) {
				const userAccountPublicKey = await this.getUserAccountPublicKey(
					subAccountId
				);

				const settlePnlIx = await this.settlePNLIx(
					userAccountPublicKey,
					this.getUserAccountOrThrow(subAccountId),
					orderParams.marketIndex
				);

				txsToSign.settlePnlTx = await this.buildTransaction(
					[settlePnlIx],
					txParams,
					this.txVersion,
					lookupTableAccounts,
					undefined,
					recentBlockHash,
					optionalIxs
				);
			}
			return;
		};

		await Promise.all([
			prepPlaceAndTakeTx(),
			prepCancelOrderTx(),
			prepSettlePnlTx(),
		]);

		if (earlyExitFailedPlaceAndTakeSim) {
			return null;
		}

		return txsToSign;
	}

	public async placeAndTakePerpWithAdditionalOrders(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		bracketOrdersParams = new Array<OptionalOrderParams>(),
		txParams?: TxParams,
		subAccountId?: number,
		cancelExistingOrders?: boolean,
		settlePnl?: boolean,
		exitEarlyIfSimFails?: boolean
	): Promise<{
		txSig: TransactionSignature;
		signedCancelExistingOrdersTx?: Transaction;
		signedSettlePnlTx?: Transaction;
	} | null> {
		const txsToSign =
			await this.preparePlaceAndTakePerpOrderWithAdditionalOrders(
				orderParams,
				makerInfo,
				bracketOrdersParams,
				txParams,
				subAccountId,
				cancelExistingOrders,
				settlePnl,
				exitEarlyIfSimFails
			);

		if (!txsToSign) {
			return null;
		}

		const signedTxs = (
			await this.txHandler.getSignedTransactionMap(
				txsToSign,
				// @ts-ignore
				this.provider.wallet
			)
		).signedTxMap;

		if (!signedTxs.placeAndTakeTx) {
			throw new Error('placeAndTakeTx was not built');
		}

		const { txSig, slot } = await this.sendTransaction(
			signedTxs.placeAndTakeTx,
			[],
			this.opts,
			true
		);

		this.cachePerpMarketSlot(slot, orderParams.marketIndex);

		return {
			txSig,
			signedCancelExistingOrdersTx:
				signedTxs.cancelExistingOrdersTx as Transaction,
			signedSettlePnlTx: signedTxs.settlePnlTx as Transaction,
		};
	}

	public async getPlaceAndTakePerpOrderIx(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		successCondition?: PlaceAndTakeOrderSuccessCondition,
		auctionDurationPercentage?: number,
		subAccountId?: number,
		overrides?: {
			authority?: PublicKey;
		},
		// place_and_take fills the placing user's (the taker's) order in-instruction, so
		// their RevenueShareEscrow must be attached for BOTH builder fees and referrer
		// revenue share. The builder case is detected from orderParams; pass the user's
		// decoded escrow (e.g. from a RevenueShareEscrowMap) to cover the referred case.
		takerEscrow?: RevenueShareEscrowAccount
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.PERP });
		const userStatsPublicKey = await this.getUserStatsAccountPublicKey();
		const user = await this.getUserAccountPublicKey(subAccountId);

		makerInfo = Array.isArray(makerInfo)
			? makerInfo
			: makerInfo
			? [makerInfo]
			: [];

		const userAccounts = [this.getUserAccountOrThrow(subAccountId)];
		for (const maker of makerInfo) {
			userAccounts.push(maker.makerUserAccount);
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [orderParams.marketIndex],
		});

		for (const maker of makerInfo) {
			remainingAccounts.push({
				pubkey: maker.maker,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: maker.makerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		const takerEscrowMeta = this.getTakerEscrowAccountMeta(
			this.getUserAccount(subAccountId)?.authority ?? this.authority,
			hasBuilderParams(orderParams),
			takerEscrow
		);
		if (takerEscrowMeta) {
			remainingAccounts.push(takerEscrowMeta);
		}

		let optionalParams = null;
		if (auctionDurationPercentage || successCondition) {
			optionalParams =
				((auctionDurationPercentage ?? 100) << 8) | (successCondition ?? 0);
		}

		const authority = overrides?.authority ?? this.wallet.publicKey;

		return await VelocityCore.buildPlaceAndTakePerpOrderInstruction({
			program: this.program,
			orderParams,
			optionalParams,
			state: await this.getStatePublicKey(),
			user,
			userStats: userStatsPublicKey,
			authority,
			remainingAccounts,
		});
	}

	public async placeAndMakePerpOrder(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		txParams?: TxParams,
		subAccountId?: number,
		takerEscrow?: RevenueShareEscrowAccount
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getPlaceAndMakePerpOrderIx(
					orderParams,
					takerInfo,
					subAccountId,
					takerEscrow
				),
				txParams
			),
			[],
			this.opts
		);

		this.cachePerpMarketSlot(slot, orderParams.marketIndex);

		return txSig;
	}

	public async getPlaceAndMakePerpOrderIx(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		subAccountId?: number,
		// place_and_make fills the taker's order in-instruction, so the TAKER's
		// RevenueShareEscrow must be attached when their order has a builder or they
		// are referred with an escrow. The builder case is detected from the taker
		// order bitflags; pass the taker's decoded escrow to cover the referred case.
		takerEscrow?: RevenueShareEscrowAccount
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.PERP });
		const userStatsPublicKey = this.getUserStatsAccountPublicKey();
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccountOrThrow(subAccountId),
				takerInfo.takerUserAccount,
			],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [orderParams.marketIndex],
		});

		const takerOrderId = takerInfo.order.orderId;
		const takerEscrowMeta = this.getTakerEscrowAccountMeta(
			takerInfo.takerUserAccount.authority,
			hasBuilder(takerInfo.order),
			takerEscrow
		);
		if (takerEscrowMeta) {
			remainingAccounts.push(takerEscrowMeta);
		}
		return await VelocityCore.buildPlaceAndMakePerpOrderInstruction({
			program: this.program,
			orderParams,
			takerOrderId,
			state: await this.getStatePublicKey(),
			user,
			userStats: userStatsPublicKey,
			taker: takerInfo.taker,
			takerStats: takerInfo.takerStats,
			authority: this.wallet.publicKey,
			remainingAccounts,
		});
	}

	public signSignedMsgOrderParamsMessage(
		orderParamsMessage:
			| SignedMsgOrderParamsMessage
			| SignedMsgOrderParamsDelegateMessage,
		delegateSigner?: boolean
	): SignedMsgOrderParams {
		const borshBuf = this.encodeSignedMsgOrderParamsMessage(
			orderParamsMessage,
			delegateSigner
		);
		const orderParams = Buffer.from(borshBuf.toString('hex'));
		return {
			orderParams,
			signature: this.signMessage(Buffer.from(borshBuf.toString('hex'))),
		};
	}

	/**
	 * Builds a deposit and place request for Swift service
	 *
	 * @param depositTx - The signed tx containing a velocity deposit (e.g. see `buildSwiftDepositTx`)
	 * @param orderParamsMessage - The order parameters message to sign
	 * @param delegateSigner - Whether this is a delegate signer
	 *
	 * @returns request object for Swift service
	 */
	public buildDepositAndPlaceSignedMsgOrderRequest(
		depositTx: VersionedTransaction,
		orderParamsMessage:
			| SignedMsgOrderParamsMessage
			| SignedMsgOrderParamsDelegateMessage,
		delegateSigner?: boolean
	): {
		deposit_tx: Buffer;
		swift_order: SignedMsgOrderParams;
	} {
		// Serialize the deposit transaction
		const serializedDepositTx = Buffer.from(depositTx.serialize());

		// Get the signed swift order using the existing method
		const swiftOrder = this.signSignedMsgOrderParamsMessage(
			orderParamsMessage,
			delegateSigner
		);

		return {
			deposit_tx: serializedDepositTx,
			swift_order: swiftOrder,
		};
	}

	/*
	 * Borsh encode signedMsg taker order params
	 */
	public encodeSignedMsgOrderParamsMessage(
		orderParamsMessage:
			| SignedMsgOrderParamsMessage
			| SignedMsgOrderParamsDelegateMessage,
		delegateSigner?: boolean
	): Buffer {
		return VelocityCore.signedMsg.encodeSignedMsgOrderParamsMessage({
			coderTypes: this.program.coder.types as any,
			orderParamsMessage,
			delegateSigner,
		});
	}

	/*
	 * Decode signedMsg taker order params from borsh buffer. Zero pads the message in case the
	 * received message was encoded by an outdated IDL (size will be too small and decode will throw).
	 * Note: the 128 will be problematic if the type we are expecting to deserializze into is 128 bytes
	 * larger than the message we are receiving (unlikely, especially if all new fields are Options).
	 */
	public decodeSignedMsgOrderParamsMessage(
		encodedMessage: Buffer,
		delegateSigner?: boolean
	): SignedMsgOrderParamsMessage | SignedMsgOrderParamsDelegateMessage {
		return VelocityCore.signedMsg.decodeSignedMsgOrderParamsMessage({
			coderTypes: this.program.coder.types as any,
			encodedMessage,
			delegateSigner,
		});
	}

	public signMessage(
		message: Uint8Array,
		keypair: Keypair | undefined = this.wallet.payer
	): Buffer {
		if (!keypair) {
			throw new Error('No keypair available to sign message');
		}
		return Buffer.from(nacl.sign.detached(message, keypair.secretKey));
	}

	public async placeSignedMsgTakerOrder(
		signedSignedMsgOrderParams: SignedMsgOrderParams,
		marketIndex: number,
		takerInfo: {
			taker: PublicKey;
			takerStats: PublicKey;
			takerUserAccount: UserAccount;
			signingAuthority: PublicKey;
		},
		precedingIxs: TransactionInstruction[] = [],
		overrideCustomIxIndex?: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await this.getPlaceSignedMsgTakerPerpOrderIxs(
			signedSignedMsgOrderParams,
			marketIndex,
			takerInfo,
			precedingIxs,
			overrideCustomIxIndex
		);
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(ixs, txParams),
			[],
			this.opts
		);
		return txSig;
	}

	public async getPlaceSignedMsgTakerPerpOrderIxs(
		signedSignedMsgOrderParams: SignedMsgOrderParams,
		marketIndex: number,
		takerInfo: {
			taker: PublicKey;
			takerStats: PublicKey;
			takerUserAccount: UserAccount;
			signingAuthority: PublicKey;
		},
		precedingIxs: TransactionInstruction[] = [],
		overrideCustomIxIndex?: number
	): Promise<TransactionInstruction[]> {
		const isDelegateSigner = takerInfo.signingAuthority.equals(
			takerInfo.takerUserAccount.delegate
		);

		const borshBuf = Buffer.from(
			signedSignedMsgOrderParams.orderParams.toString(),
			'hex'
		);

		const signedMessage = this.decodeSignedMsgOrderParamsMessage(
			borshBuf,
			isDelegateSigner
		);

		const writableSpotMarketIndexes = signedMessage.isolatedPositionDeposit?.gt(
			ZERO
		)
			? [QUOTE_SPOT_MARKET_INDEX]
			: undefined;

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [takerInfo.takerUserAccount],
			useMarketLastSlotCache: false,
			readablePerpMarketIndex: marketIndex,
			writableSpotMarketIndexes,
		});

		if (hasBuilderParams(signedMessage)) {
			remainingAccounts.push({
				pubkey: getRevenueShareEscrowAccountPublicKey(
					this.program.programId,
					takerInfo.takerUserAccount.authority
				),
				isWritable: true,
				isSigner: false,
			});
		}

		const messageLengthBuffer = Buffer.alloc(2);
		messageLengthBuffer.writeUInt16LE(
			signedSignedMsgOrderParams.orderParams.length
		);

		const signedMsgIxData = Buffer.concat([
			signedSignedMsgOrderParams.signature,
			takerInfo.signingAuthority.toBytes(),
			messageLengthBuffer,
			signedSignedMsgOrderParams.orderParams,
		]);

		const signedMsgOrderParamsSignatureIx = createMinimalEd25519VerifyIx(
			overrideCustomIxIndex || precedingIxs.length + 1,
			12,
			signedMsgIxData,
			0
		);

		const placeTakerSignedMsgPerpOrderIx =
			this.program.instruction.placeSignedMsgTakerOrder(
				signedMsgIxData,
				isDelegateSigner,
				{
					accounts: {
						state: await this.getStatePublicKey(),
						user: takerInfo.taker,
						userStats: takerInfo.takerStats,
						signedMsgUserOrders: getSignedMsgUserAccountPublicKey(
							this.program.programId,
							takerInfo.takerUserAccount.authority
						),
						authority: this.wallet.publicKey,
						ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
					},
					remainingAccounts,
				}
			);

		return [signedMsgOrderParamsSignatureIx, placeTakerSignedMsgPerpOrderIx];
	}

	public async placeAndMakeSignedMsgPerpOrder(
		signedSignedMsgOrderParams: SignedMsgOrderParams,
		signedMsgOrderUuid: Uint8Array,
		takerInfo: {
			taker: PublicKey;
			takerStats: PublicKey;
			takerUserAccount: UserAccount;
			signingAuthority: PublicKey;
		},
		orderParams: OptionalOrderParams,
		txParams?: TxParams,
		subAccountId?: number,
		precedingIxs: TransactionInstruction[] = [],
		overrideCustomIxIndex?: number,
		takerEscrow?: RevenueShareEscrowAccount
	): Promise<TransactionSignature> {
		const ixs = await this.getPlaceAndMakeSignedMsgPerpOrderIxs(
			signedSignedMsgOrderParams,
			signedMsgOrderUuid,
			takerInfo,
			orderParams,
			subAccountId,
			precedingIxs,
			overrideCustomIxIndex,
			takerEscrow
		);
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(ixs, txParams),
			[],
			this.opts
		);

		this.cachePerpMarketSlot(slot, orderParams.marketIndex);
		return txSig;
	}

	public async getPlaceAndMakeSignedMsgPerpOrderIxs(
		signedSignedMsgOrderParams: SignedMsgOrderParams,
		signedMsgOrderUuid: Uint8Array,
		takerInfo: {
			taker: PublicKey;
			takerStats: PublicKey;
			takerUserAccount: UserAccount;
			signingAuthority: PublicKey;
		},
		orderParams: OptionalOrderParams,
		subAccountId?: number,
		precedingIxs: TransactionInstruction[] = [],
		overrideCustomIxIndex?: number,
		// fills the taker's order in-instruction; pass the taker's decoded escrow so a
		// referred taker's escrow is attached even when the signed order carries no
		// builder fee
		takerEscrow?: RevenueShareEscrowAccount
	): Promise<TransactionInstruction[]> {
		const [signedMsgOrderSignatureIx, placeTakerSignedMsgPerpOrderIx] =
			await this.getPlaceSignedMsgTakerPerpOrderIxs(
				signedSignedMsgOrderParams,
				orderParams.marketIndex,
				takerInfo,
				precedingIxs,
				overrideCustomIxIndex
			);

		orderParams = getOrderParams(orderParams, { marketType: MarketType.PERP });
		const userStatsPublicKey = this.getUserStatsAccountPublicKey();
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccountOrThrow(subAccountId),
				takerInfo.takerUserAccount,
			],
			useMarketLastSlotCache: false,
			writablePerpMarketIndexes: [orderParams.marketIndex],
		});

		const isDelegateSigner = takerInfo.signingAuthority.equals(
			takerInfo.takerUserAccount.delegate
		);
		const borshBuf = Buffer.from(
			signedSignedMsgOrderParams.orderParams.toString(),
			'hex'
		);

		const signedMessage = this.decodeSignedMsgOrderParamsMessage(
			borshBuf,
			isDelegateSigner
		);
		const takerEscrowMeta = this.getTakerEscrowAccountMeta(
			takerInfo.takerUserAccount.authority,
			hasBuilderParams(signedMessage),
			takerEscrow
		);
		if (takerEscrowMeta) {
			remainingAccounts.push(takerEscrowMeta);
		}

		const placeAndMakeIx =
			await this.program.instruction.placeAndMakeSignedMsgPerpOrder(
				orderParams,
				signedMsgOrderUuid,
				{
					accounts: {
						state: await this.getStatePublicKey(),
						user,
						userStats: userStatsPublicKey,
						taker: takerInfo.taker,
						takerStats: takerInfo.takerStats,
						authority: this.wallet.publicKey,
						takerSignedMsgUserOrders: getSignedMsgUserAccountPublicKey(
							this.program.programId,
							takerInfo.takerUserAccount.authority
						),
					},
					remainingAccounts,
				}
			);

		return [
			signedMsgOrderSignatureIx,
			placeTakerSignedMsgPerpOrderIx,
			placeAndMakeIx,
		];
	}

	public async preparePlaceAndTakeSpotOrder(
		_orderParams: OptionalOrderParams,
		_fulfillmentConfig?: unknown,
		_makerInfo?: MakerInfo,
		_txParams?: TxParams,
		_subAccountId?: number
	) {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	public async placeAndTakeSpotOrder(
		_orderParams: OptionalOrderParams,
		_fulfillmentConfig?: unknown,
		_makerInfo?: MakerInfo,
		_txParams?: TxParams,
		_subAccountId?: number
	): Promise<TransactionSignature> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}
	public async getPlaceAndTakeSpotOrderIx(
		_orderParams: OptionalOrderParams,
		_fulfillmentConfig?: unknown,
		_makerInfo?: MakerInfo,
		_subAccountId?: number
	): Promise<TransactionInstruction> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	public async placeAndMakeSpotOrder(
		_orderParams: OptionalOrderParams,
		_takerInfo: TakerInfo,
		_fulfillmentConfig?: unknown,
		_txParams?: TxParams,
		_subAccountId?: number
	): Promise<TransactionSignature> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	public async getPlaceAndMakeSpotOrderIx(
		_orderParams: OptionalOrderParams,
		_takerInfo: TakerInfo,
		_fulfillmentConfig?: unknown,
		_subAccountId?: number
	): Promise<TransactionInstruction> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	/**
	 * @deprecated use {@link placePerpOrder} or {@link placeAndTakePerpOrder} instead
	 */
	public async closePosition(
		marketIndex: number,
		limitPrice?: BN,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const userPosition =
			this.getUser(subAccountId).getPerpPosition(marketIndex);
		if (!userPosition) {
			throw Error(`No position in market ${marketIndex.toString()}`);
		}

		return await this.placeAndTakePerpOrder(
			{
				orderType: OrderType.MARKET,
				marketIndex,
				direction: findDirectionToClose(userPosition),
				baseAssetAmount: userPosition.baseAssetAmount.abs(),
				reduceOnly: true,
				price: limitPrice,
			},
			undefined,
			undefined,
			undefined,
			undefined,
			subAccountId
		);
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
		newOraclePriceOffset?: BN
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
		newOraclePriceOffset?: BN
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
	public async modifyOrder(
		orderParams: {
			orderId: number;
			newDirection?: PositionDirection;
			newBaseAmount?: BN;
			newLimitPrice?: BN;
			newOraclePriceOffset?: BN;
			newTriggerPrice?: BN;
			newTriggerCondition?: OrderTriggerCondition;
			auctionDuration?: number;
			auctionStartPrice?: BN;
			auctionEndPrice?: BN;
			reduceOnly?: boolean;
			postOnly?: PostOnlyParams;
			bitFlags?: number;
			maxTs?: BN;
			policy?: number;
		},
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getModifyOrderIx(orderParams, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	/**
	 * @param orderParams: The parameters for the order to modify.
	 * @param subAccountId: Optional - The subaccount ID of the user to modify the order for.
	 * @param userPublicKey: Optional - The public key of the user to modify the order for. This takes precedence over subAccountId.
	 * @returns
	 */
	public async getModifyOrderIx(
		{
			orderId,
			newDirection,
			newBaseAmount,
			newLimitPrice,
			newOraclePriceOffset,
			newTriggerPrice,
			newTriggerCondition,
			auctionDuration,
			auctionStartPrice,
			auctionEndPrice,
			reduceOnly,
			postOnly,
			bitFlags,
			maxTs,
			policy,
		}: {
			orderId: number;
			newDirection?: PositionDirection;
			newBaseAmount?: BN;
			newLimitPrice?: BN;
			newOraclePriceOffset?: BN;
			newTriggerPrice?: BN;
			newTriggerCondition?: OrderTriggerCondition;
			auctionDuration?: number;
			auctionStartPrice?: BN;
			auctionEndPrice?: BN;
			reduceOnly?: boolean;
			postOnly?: PostOnlyParams;
			bitFlags?: number;
			maxTs?: BN;
			policy?: number;
		},
		subAccountId?: number,
		overrides?: {
			user?: User;
			authority?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		const userPubKey =
			overrides?.user?.getUserAccountPublicKey() ??
			(await this.getUserAccountPublicKey(subAccountId));
		const overrideUserAccount = overrides?.user?.getUserAccount();
		if (overrides?.user && !overrideUserAccount) {
			throw new Error('modifyOrder: override user account is not loaded');
		}
		const userAccount =
			overrideUserAccount ?? this.getUserAccountOrThrow(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
			useMarketLastSlotCache: true,
		});

		const orderParams: ModifyOrderParams = {
			baseAssetAmount: newBaseAmount || null,
			direction: newDirection || null,
			price: newLimitPrice || null,
			oraclePriceOffset: newOraclePriceOffset || null,
			triggerPrice: newTriggerPrice || null,
			triggerCondition: newTriggerCondition || null,
			auctionDuration: auctionDuration || null,
			auctionStartPrice: auctionStartPrice || null,
			auctionEndPrice: auctionEndPrice || null,
			reduceOnly: reduceOnly != undefined ? reduceOnly : null,
			postOnly: postOnly != undefined ? postOnly : null,
			bitFlags: bitFlags != undefined ? bitFlags : null,
			policy: policy || null,
			maxTs: maxTs || null,
		};

		const authority =
			overrides?.authority ??
			overrideUserAccount?.authority ??
			this.wallet.publicKey;
		return await VelocityCore.buildModifyOrderInstruction({
			program: this.program,
			orderId,
			modifyParams: orderParams,
			state: await this.getStatePublicKey(),
			user: userPubKey,
			userStats: this.getUserStatsAccountPublicKey(),
			authority,
			remainingAccounts,
		});
	}

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
	public async modifyOrderByUserOrderId(
		orderParams: {
			userOrderId: number;
			newDirection?: PositionDirection;
			newBaseAmount?: BN;
			newLimitPrice?: BN;
			newOraclePriceOffset?: BN;
			newTriggerPrice?: BN;
			newTriggerCondition?: OrderTriggerCondition;
			auctionDuration?: number;
			auctionStartPrice?: BN;
			auctionEndPrice?: BN;
			reduceOnly?: boolean;
			postOnly?: PostOnlyParams;
			bitFlags?: number;
			policy?: ModifyOrderPolicy;
			maxTs?: BN;
		},
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getModifyOrderByUserIdIx(orderParams, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getModifyOrderByUserIdIx(
		{
			userOrderId,
			newDirection,
			newBaseAmount,
			newLimitPrice,
			newOraclePriceOffset,
			newTriggerPrice,
			newTriggerCondition,
			auctionDuration,
			auctionStartPrice,
			auctionEndPrice,
			reduceOnly,
			postOnly,
			bitFlags,
			maxTs,
			policy,
		}: {
			userOrderId: number;
			newDirection?: PositionDirection;
			newBaseAmount?: BN;
			newLimitPrice?: BN;
			newOraclePriceOffset?: BN;
			newTriggerPrice?: BN;
			newTriggerCondition?: OrderTriggerCondition;
			auctionDuration?: number;
			auctionStartPrice?: BN;
			auctionEndPrice?: BN;
			reduceOnly?: boolean;
			postOnly?: PostOnlyParams;
			bitFlags?: number;
			policy?: ModifyOrderPolicy;
			maxTs?: BN;
		},
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccountOrThrow(subAccountId)],
			useMarketLastSlotCache: true,
		});

		const orderParams: ModifyOrderParams = {
			baseAssetAmount: newBaseAmount || null,
			direction: newDirection || null,
			price: newLimitPrice || null,
			oraclePriceOffset: newOraclePriceOffset || null,
			triggerPrice: newTriggerPrice || null,
			triggerCondition: newTriggerCondition || null,
			auctionDuration: auctionDuration || null,
			auctionStartPrice: auctionStartPrice || null,
			auctionEndPrice: auctionEndPrice || null,
			reduceOnly: reduceOnly || false,
			postOnly: postOnly || null,
			bitFlags: bitFlags || null,
			policy: policy || null,
			maxTs: maxTs || null,
		};

		return await VelocityCore.buildModifyOrderByUserIdInstruction({
			program: this.program,
			userOrderId,
			modifyParams: orderParams,
			state: await this.getStatePublicKey(),
			user,
			userStats: this.getUserStatsAccountPublicKey(),
			authority: this.wallet.publicKey,
			remainingAccounts,
		});
	}

	public async settlePNLs(
		users: {
			settleeUserAccountPublicKey: PublicKey;
			settleeUserAccount: UserAccount;
		}[],
		marketIndexes: number[],
		opts?: {
			filterInvalidMarkets?: boolean;
		},
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const filterInvalidMarkets = opts?.filterInvalidMarkets;

		// # Filter market indexes by markets with valid oracle
		const marketIndexToSettle: number[] = filterInvalidMarkets
			? []
			: marketIndexes;

		if (filterInvalidMarkets) {
			for (const marketIndex of marketIndexes) {
				const perpMarketAccount = this.getPerpMarketAccountOrThrow(marketIndex);
				const oraclePriceData = this.getOracleDataForPerpMarket(marketIndex);
				const stateAccountAndSlot =
					this.accountSubscriber.getStateAccountAndSlot();
				const oracleGuardRails = stateAccountAndSlot.data.oracleGuardRails;

				const isValid = isOracleValid(
					perpMarketAccount,
					oraclePriceData,
					oracleGuardRails,
					stateAccountAndSlot.slot
				);

				if (isValid) {
					marketIndexToSettle.push(marketIndex);
				}
			}
		}

		// # Settle filtered market indexes
		const ixs = await this.getSettlePNLsIxs(users, marketIndexToSettle);

		const tx = await this.buildTransaction(
			ixs,
			txParams ?? {
				computeUnits: 1_400_000,
			}
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getSettlePNLsIxs(
		users: {
			settleeUserAccountPublicKey: PublicKey;
			settleeUserAccount: UserAccount;
		}[],
		marketIndexes: number[],
		revenueShareEscrowMap?: RevenueShareEscrowMap
	): Promise<Array<TransactionInstruction>> {
		const ixs = [];
		for (const { settleeUserAccountPublicKey, settleeUserAccount } of users) {
			for (const marketIndex of marketIndexes) {
				ixs.push(
					await this.settlePNLIx(
						settleeUserAccountPublicKey,
						settleeUserAccount,
						marketIndex,
						revenueShareEscrowMap
					)
				);
			}
		}

		return ixs;
	}

	public async settlePNL(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: number,
		txParams?: TxParams,
		optionalIxs?: TransactionInstruction[],
		revenueShareEscrowMap?: RevenueShareEscrowMap
	): Promise<TransactionSignature> {
		const lookupTableAccounts = await this.fetchAllLookupTableAccounts();

		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.settlePNLIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketIndex,
					revenueShareEscrowMap
				),
				txParams,
				undefined,
				lookupTableAccounts,
				undefined,
				undefined,
				optionalIxs
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async settlePNLIx(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: number,
		revenueShareEscrowMap?: RevenueShareEscrowMap
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [settleeUserAccount],
			writablePerpMarketIndexes: [marketIndex],
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		if (revenueShareEscrowMap) {
			const escrow = revenueShareEscrowMap.get(
				settleeUserAccount.authority.toBase58()
			);
			if (escrow) {
				const escrowPk = getRevenueShareEscrowAccountPublicKey(
					this.program.programId,
					settleeUserAccount.authority
				);

				const builders = new Map<number, PublicKey>();
				for (const order of escrow.orders) {
					const eligibleBuilder =
						isBuilderOrderCompleted(order) &&
						!isBuilderOrderReferral(order) &&
						order.feesAccrued.gt(ZERO) &&
						order.marketIndex === marketIndex;
					if (eligibleBuilder && !builders.has(order.builderIdx)) {
						builders.set(
							order.builderIdx,
							escrow.approvedBuilders[order.builderIdx].authority
						);
					}
				}
				if (builders.size > 0) {
					if (!remainingAccounts.find((a) => a.pubkey.equals(escrowPk))) {
						remainingAccounts.push({
							pubkey: escrowPk,
							isSigner: false,
							isWritable: true,
						});
					}
					this.addBuilderToRemainingAccounts(
						Array.from(builders.values()),
						remainingAccounts
					);
				}

				// Include escrow and referrer accounts if referral rewards exist for this market
				const hasReferralForMarket = escrow.orders.some(
					(o) =>
						isBuilderOrderReferral(o) &&
						o.feesAccrued.gt(ZERO) &&
						o.marketIndex === marketIndex
				);

				if (hasReferralForMarket) {
					if (!remainingAccounts.find((a) => a.pubkey.equals(escrowPk))) {
						remainingAccounts.push({
							pubkey: escrowPk,
							isSigner: false,
							isWritable: true,
						});
					}
					if (escrowHasReferrer(escrow)) {
						this.addBuilderToRemainingAccounts(
							[escrow.referrer],
							remainingAccounts
						);
					}
				}
			} else {
				// Stale-cache fallback: if the user has any builder orders, include escrow PDA. This allows
				// the program to lazily clean up any completed builder orders.
				for (const order of settleeUserAccount.orders) {
					if (hasBuilder(order)) {
						const escrowPk = getRevenueShareEscrowAccountPublicKey(
							this.program.programId,
							settleeUserAccount.authority
						);
						if (!remainingAccounts.find((a) => a.pubkey.equals(escrowPk))) {
							remainingAccounts.push({
								pubkey: escrowPk,
								isSigner: false,
								isWritable: true,
							});
						}
						break;
					}
				}
			}
		}

		return await VelocityCore.buildSettlePnlInstruction({
			program: this.program,
			marketIndex,
			state: await this.getStatePublicKey(),
			authority: this.wallet.publicKey,
			user: settleeUserAccountPublicKey,
			spotMarketVault: this.getQuoteSpotMarketAccount().vault,
			remainingAccounts,
		});
	}

	public async settleMultiplePNLs(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndexes: number[],
		mode: SettlePnlMode,
		revenueShareEscrowMap?: RevenueShareEscrowMap,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.settleMultiplePNLsIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketIndexes,
					mode,
					undefined,
					revenueShareEscrowMap
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async settleMultiplePNLsMultipleTxs(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndexes: number[],
		mode: SettlePnlMode,
		txParams?: TxParams,
		optionalIxs?: TransactionInstruction[],
		revenueShareEscrowMap?: RevenueShareEscrowMap
	): Promise<TransactionSignature[]> {
		// need multiple TXs because settling more than 4 markets won't fit in a single TX
		const txsToSign: (Transaction | VersionedTransaction)[] = [];
		const marketIndexesInFourGroups: number[][] = [];
		for (let i = 0; i < marketIndexes.length; i += 4) {
			marketIndexesInFourGroups.push(marketIndexes.slice(i, i + 4));
		}

		for (const marketIndexes of marketIndexesInFourGroups) {
			const ix = await this.settleMultiplePNLsIx(
				settleeUserAccountPublicKey,
				settleeUserAccount,
				marketIndexes,
				mode,
				undefined,
				revenueShareEscrowMap
			);
			const computeUnits = Math.min(300_000 * marketIndexes.length, 1_400_000);
			const tx = await this.buildTransaction(
				ix,
				{
					...txParams,
					computeUnits,
				},
				undefined,
				undefined,
				undefined,
				undefined,
				optionalIxs
			);
			txsToSign.push(tx);
		}

		const txsMap: Record<string, Transaction | VersionedTransaction> = {};
		let i = 1;
		for (const tx of txsToSign) {
			txsMap[`tx-${i}`] = tx;
			i++;
		}
		const signedTxs = (
			await this.txHandler.getSignedTransactionMap(txsMap, this.provider.wallet)
		).signedTxMap;

		const txSigs: TransactionSignature[] = [];
		for (const key in signedTxs) {
			const tx = signedTxs[key];
			const { txSig } = await this.sendTransaction(tx, [], this.opts, true);
			txSigs.push(txSig);
		}

		return txSigs;
	}

	public async settleMultiplePNLsIx(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndexes: number[],
		mode: SettlePnlMode,
		overrides?: {
			authority?: PublicKey;
		},
		revenueShareEscrowMap?: RevenueShareEscrowMap
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [settleeUserAccount],
			writablePerpMarketIndexes: marketIndexes,
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		if (revenueShareEscrowMap) {
			const escrow = revenueShareEscrowMap.get(
				settleeUserAccount.authority.toBase58()
			);
			const builders = new Map<number, PublicKey>();
			if (escrow) {
				for (const order of escrow.orders) {
					const eligibleBuilder =
						isBuilderOrderCompleted(order) &&
						!isBuilderOrderReferral(order) &&
						order.feesAccrued.gt(ZERO) &&
						marketIndexes.includes(order.marketIndex);
					if (eligibleBuilder && !builders.has(order.builderIdx)) {
						builders.set(
							order.builderIdx,
							escrow.approvedBuilders[order.builderIdx].authority
						);
					}
				}
				if (builders.size > 0) {
					const escrowPk = getRevenueShareEscrowAccountPublicKey(
						this.program.programId,
						settleeUserAccount.authority
					);
					if (!remainingAccounts.find((a) => a.pubkey.equals(escrowPk))) {
						remainingAccounts.push({
							pubkey: escrowPk,
							isSigner: false,
							isWritable: true,
						});
					}
					this.addBuilderToRemainingAccounts(
						Array.from(builders.values()),
						remainingAccounts
					);
				}

				// Include escrow and referrer accounts when there are referral rewards
				// for any of the markets we are settling, so on-chain sweep can find them.
				const hasReferralForRequestedMarkets = escrow.orders.some(
					(o) =>
						isBuilderOrderReferral(o) &&
						o.feesAccrued.gt(ZERO) &&
						marketIndexes.includes(o.marketIndex)
				);

				if (hasReferralForRequestedMarkets) {
					const escrowPk = getRevenueShareEscrowAccountPublicKey(
						this.program.programId,
						settleeUserAccount.authority
					);
					if (!remainingAccounts.find((a) => a.pubkey.equals(escrowPk))) {
						remainingAccounts.push({
							pubkey: escrowPk,
							isSigner: false,
							isWritable: true,
						});
					}

					// Add referrer's User and RevenueShare accounts
					if (escrowHasReferrer(escrow)) {
						this.addBuilderToRemainingAccounts(
							[escrow.referrer],
							remainingAccounts
						);
					}
				}
			} else {
				// Stale-cache fallback: if the user has any builder orders, include escrow PDA. This allows
				// the program to lazily clean up any completed builder orders.
				for (const order of settleeUserAccount.orders) {
					if (hasBuilder(order)) {
						const escrowPk = getRevenueShareEscrowAccountPublicKey(
							this.program.programId,
							settleeUserAccount.authority
						);
						if (!remainingAccounts.find((a) => a.pubkey.equals(escrowPk))) {
							remainingAccounts.push({
								pubkey: escrowPk,
								isSigner: false,
								isWritable: true,
							});
						}
						break;
					}
				}
			}
		}

		return await this.program.instruction.settleMultiplePnls(
			marketIndexes,
			mode,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: overrides?.authority ?? this.wallet.publicKey,
					user: settleeUserAccountPublicKey,
					spotMarketVault: this.getQuoteSpotMarketAccount().vault,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async getSetUserStatusToBeingLiquidatedIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
		});
		return await this.program.instruction.setUserStatusToBeingLiquidated({
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async setUserStatusToBeingLiquidated(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getSetUserStatusToBeingLiquidatedIx(
					userAccountPublicKey,
					userAccount
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async liquidatePerp(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		maxBaseAssetAmount: BN,
		limitPrice?: BN,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLiquidatePerpIx(
					userAccountPublicKey,
					userAccount,
					marketIndex,
					maxBaseAssetAmount,
					limitPrice,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.cachePerpMarketSlot(slot, marketIndex);
		return txSig;
	}
	public async getLiquidatePerpIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		maxBaseAssetAmount: BN,
		limitPrice?: BN,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccountOrThrow(liquidatorSubAccountId),
				userAccount,
			],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		return await VelocityCore.buildLiquidatePerpInstruction({
			program: this.program,
			marketIndex,
			maxBaseAssetAmount,
			limitPrice: limitPrice ?? null,
			state: await this.getStatePublicKey(),
			authority: this.wallet.publicKey,
			user: userAccountPublicKey,
			userStats: userStatsPublicKey,
			liquidator,
			liquidatorStats: liquidatorStatsPublicKey,
			remainingAccounts,
		});
	}

	public async liquidatePerpWithFill(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		makerInfos: MakerInfo[],
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLiquidatePerpWithFillIx(
					userAccountPublicKey,
					userAccount,
					marketIndex,
					makerInfos,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.cachePerpMarketSlot(slot, marketIndex);
		return txSig;
	}

	public async getLiquidatePerpWithFillIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		makerInfos: MakerInfo[],
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				userAccount,
				...makerInfos.map((makerInfo) => makerInfo.makerUserAccount),
			],
			writablePerpMarketIndexes: [marketIndex],
		});

		for (const makerInfo of makerInfos) {
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

		return await this.program.instruction.liquidatePerpWithFill(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: userAccountPublicKey,
				userStats: userStatsPublicKey,
				liquidator,
				liquidatorStats: liquidatorStatsPublicKey,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async liquidateSpot(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		assetMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLiquidateSpotIx(
					userAccountPublicKey,
					userAccount,
					assetMarketIndex,
					liabilityMarketIndex,
					maxLiabilityTransfer,
					limitPrice,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.cacheSpotMarketSlot(slot, assetMarketIndex, liabilityMarketIndex);
		return txSig;
	}

	public async getLiquidateSpotIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		assetMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccountOrThrow(liquidatorSubAccountId),
				userAccount,
			],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [liabilityMarketIndex, assetMarketIndex],
		});

		return await (this.program.instruction as any).liquidateSpot(
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
					liquidator,
					liquidatorStats: liquidatorStatsPublicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async getJupiterLiquidateSpotWithSwapIxV6({
		jupiterClient,
		liabilityMarketIndex,
		assetMarketIndex,
		swapAmount,
		assetTokenAccount,
		liabilityTokenAccount,
		slippageBps,
		swapMode,
		onlyDirectRoutes,
		quote,
		userAccount,
		userAccountPublicKey,
		liquidatorSubAccountId,
		maxAccounts,
	}: {
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
		liquidatorSubAccountId?: number;
		maxAccounts?: number;
	}): Promise<{
		ixs: TransactionInstruction[];
		lookupTables: AddressLookupTableAccount[];
	}> {
		const liabilityMarket =
			this.getSpotMarketAccountOrThrow(liabilityMarketIndex);
		const assetMarket = this.getSpotMarketAccountOrThrow(assetMarketIndex);

		if (!quote) {
			const fetchedQuote = await jupiterClient.getQuote({
				inputMint: assetMarket.mint,
				outputMint: liabilityMarket.mint,
				amount: swapAmount,
				slippageBps,
				swapMode,
				onlyDirectRoutes,
				maxAccounts,
			});

			quote = fetchedQuote;
		}

		if (!quote) {
			throw new Error('Could not fetch swap quote. Please try again.');
		}

		const amountIn = new BN(quote.inAmount);

		const transaction = await jupiterClient.getSwap({
			quote,
			userPublicKey: this.provider.wallet.publicKey,
			slippageBps,
		});

		const { transactionMessage, lookupTables } =
			await jupiterClient.getTransactionMessageAndLookupTables({
				transaction,
			});

		const jupiterInstructions = jupiterClient.getJupiterInstructions({
			transactionMessage,
			inputMint: assetMarket.mint,
			outputMint: liabilityMarket.mint,
		});

		const preInstructions = [];
		if (!liabilityTokenAccount) {
			const tokenProgram = this.getTokenProgramForSpotMarket(liabilityMarket);
			liabilityTokenAccount = await this.getAssociatedTokenAccount(
				liabilityMarket.marketIndex,
				false,
				tokenProgram
			);

			preInstructions.push(
				this.createAssociatedTokenAccountIdempotentInstruction(
					liabilityTokenAccount,
					this.provider.wallet.publicKey,
					this.provider.wallet.publicKey,
					liabilityMarket.mint,
					tokenProgram
				)
			);
		}

		if (!assetTokenAccount) {
			const tokenProgram = this.getTokenProgramForSpotMarket(assetMarket);
			assetTokenAccount = await this.getAssociatedTokenAccount(
				assetMarket.marketIndex,
				false,
				tokenProgram
			);

			preInstructions.push(
				this.createAssociatedTokenAccountIdempotentInstruction(
					assetTokenAccount,
					this.provider.wallet.publicKey,
					this.provider.wallet.publicKey,
					assetMarket.mint,
					tokenProgram
				)
			);
		}

		const { beginSwapIx, endSwapIx } = await this.getLiquidateSpotWithSwapIx({
			liabilityMarketIndex,
			assetMarketIndex,
			swapAmount: amountIn,
			assetTokenAccount,
			liabilityTokenAccount,
			userAccount,
			userAccountPublicKey,
			liquidatorSubAccountId,
		});

		const ixs = [
			...preInstructions,
			beginSwapIx,
			...jupiterInstructions,
			endSwapIx,
		];

		return { ixs, lookupTables };
	}

	/**
	 * Get the velocity liquidate_spot_with_swap instructions
	 *
	 * @param liabilityMarketIndex the market index of the token you're buying
	 * @param assetMarketIndex the market index of the token you're selling
	 * @param amountIn the amount of the token to sell
	 * @param assetTokenAccount the token account to move the tokens being sold
	 * @param liabilityTokenAccount the token account to receive the tokens being bought
	 * @param userAccount
	 * @param userAccountPublicKey
	 */
	public async getLiquidateSpotWithSwapIx({
		liabilityMarketIndex,
		assetMarketIndex,
		swapAmount: swapAmount,
		assetTokenAccount,
		liabilityTokenAccount,
		userAccount,
		userAccountPublicKey,
		liquidatorSubAccountId,
	}: {
		liabilityMarketIndex: number;
		assetMarketIndex: number;
		swapAmount: BN;
		assetTokenAccount: PublicKey;
		liabilityTokenAccount: PublicKey;
		userAccount: UserAccount;
		userAccountPublicKey: PublicKey;
		liquidatorSubAccountId?: number;
	}): Promise<{
		beginSwapIx: TransactionInstruction;
		endSwapIx: TransactionInstruction;
	}> {
		const liquidatorAccountPublicKey = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);

		const userAccounts = [userAccount];
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			writableSpotMarketIndexes: [liabilityMarketIndex, assetMarketIndex],
			readableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		const liabilitySpotMarket =
			this.getSpotMarketAccountOrThrow(liabilityMarketIndex);
		const assetSpotMarket = this.getSpotMarketAccountOrThrow(assetMarketIndex);

		const liabilityTokenProgram =
			this.getTokenProgramForSpotMarket(liabilitySpotMarket);
		const assetTokenProgram =
			this.getTokenProgramForSpotMarket(assetSpotMarket);

		if (!liabilityTokenProgram.equals(assetTokenProgram)) {
			remainingAccounts.push({
				pubkey: liabilityTokenProgram,
				isWritable: false,
				isSigner: false,
			});
		}

		if (
			this.isToken2022(liabilitySpotMarket) ||
			this.isToken2022(assetSpotMarket)
		) {
			remainingAccounts.push({
				pubkey: assetSpotMarket.mint,
				isWritable: false,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: liabilitySpotMarket.mint,
				isWritable: false,
				isSigner: false,
			});
			if (this.isTransferHook(assetSpotMarket)) {
				this.addExtraAccountMetasToRemainingAccounts(
					assetSpotMarket.mint,
					remainingAccounts
				);
			}
			if (this.isTransferHook(liabilitySpotMarket)) {
				this.addExtraAccountMetasToRemainingAccounts(
					liabilitySpotMarket.mint,
					remainingAccounts
				);
			}
		}

		const beginSwapIx =
			await this.program.instruction.liquidateSpotWithSwapBegin(
				assetMarketIndex,
				liabilityMarketIndex,
				swapAmount,
				{
					accounts: {
						state: await this.getStatePublicKey(),
						user: userAccountPublicKey,
						liquidator: liquidatorAccountPublicKey,
						authority: this.wallet.publicKey,
						liabilitySpotMarketVault: liabilitySpotMarket.vault,
						assetSpotMarketVault: assetSpotMarket.vault,
						assetTokenAccount: assetTokenAccount,
						liabilityTokenAccount: liabilityTokenAccount,
						tokenProgram: assetTokenProgram,
						velocitySigner: this.getStateAccount().signer,
						instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
					},
					remainingAccounts,
				}
			);

		const endSwapIx = await this.program.instruction.liquidateSpotWithSwapEnd(
			assetMarketIndex,
			liabilityMarketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					liquidator: liquidatorAccountPublicKey,
					authority: this.wallet.publicKey,
					liabilitySpotMarketVault: liabilitySpotMarket.vault,
					assetSpotMarketVault: assetSpotMarket.vault,
					assetTokenAccount: assetTokenAccount,
					liabilityTokenAccount: liabilityTokenAccount,
					tokenProgram: assetTokenProgram,
					velocitySigner: this.getStateAccount().signer,
					instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
				},
				remainingAccounts,
			}
		);

		return { beginSwapIx, endSwapIx };
	}

	public async liquidateBorrowForPerpPnl(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLiquidateBorrowForPerpPnlIx(
					userAccountPublicKey,
					userAccount,
					perpMarketIndex,
					liabilityMarketIndex,
					maxLiabilityTransfer,
					limitPrice,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.cachePerpMarketSlot(slot, perpMarketIndex);
		this.cacheSpotMarketSlot(slot, liabilityMarketIndex);
		return txSig;
	}

	public async getLiquidateBorrowForPerpPnlIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccountOrThrow(liquidatorSubAccountId),
				userAccount,
			],
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
					liquidator,
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
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLiquidatePerpPnlForDepositIx(
					userAccountPublicKey,
					userAccount,
					perpMarketIndex,
					assetMarketIndex,
					maxPnlTransfer,
					limitPrice,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.cachePerpMarketSlot(slot, perpMarketIndex);
		this.cacheSpotMarketSlot(slot, assetMarketIndex);
		return txSig;
	}

	public async getLiquidatePerpPnlForDepositIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		assetMarketIndex: number,
		maxPnlTransfer: BN,
		limitPrice?: BN,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccountOrThrow(liquidatorSubAccountId),
				userAccount,
			],
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
					liquidator,
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
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getResolvePerpBankruptcyIx(
					userAccountPublicKey,
					userAccount,
					marketIndex,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getResolvePerpBankruptcyIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccountOrThrow(liquidatorSubAccountId),
				userAccount,
			],
			writablePerpMarketIndexes: [marketIndex],
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		const spotMarket = this.getQuoteSpotMarketAccount();

		return await this.program.instruction.resolvePerpBankruptcy(
			QUOTE_SPOT_MARKET_INDEX,
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					liquidator,
					liquidatorStats: liquidatorStatsPublicKey,
					spotMarketVault: spotMarket.vault,
					insuranceFundVault: spotMarket.insuranceFund.vault,
					velocitySigner: this.getSignerPublicKey(),
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
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getResolveSpotBankruptcyIx(
					userAccountPublicKey,
					userAccount,
					marketIndex,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getResolveSpotBankruptcyIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccountOrThrow(liquidatorSubAccountId),
				userAccount,
			],
			writableSpotMarketIndexes: [marketIndex],
		});

		const spotMarket = this.getSpotMarketAccountOrThrow(marketIndex);
		const tokenProgramId = this.getTokenProgramForSpotMarket(spotMarket);

		this.addTokenMintToRemainingAccounts(spotMarket, remainingAccounts);
		if (this.isTransferHook(spotMarket)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				spotMarket.mint,
				remainingAccounts
			);
		}

		return await this.program.instruction.resolveSpotBankruptcy(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: userAccountPublicKey,
				userStats: userStatsPublicKey,
				liquidatorStats: liquidatorStatsPublicKey,
				liquidator,
				spotMarketVault: spotMarket.vault,
				insuranceFundVault: spotMarket.insuranceFund.vault,
				velocitySigner: this.getSignerPublicKey(),
				tokenProgram: tokenProgramId,
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
			await this.buildTransaction(
				await this.getUpdateFundingRateIx(perpMarketIndex, oracle),
				txParams
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
		return await VelocityCore.buildUpdateFundingRateInstruction({
			program: this.program,
			perpMarketIndex,
			state: await this.getStatePublicKey(),
			perpMarket: perpMarketPublicKey,
			oracle,
		});
	}

	public async updatePrelaunchOracle(
		perpMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdatePrelaunchOracleIx(perpMarketIndex),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdatePrelaunchOracleIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const perpMarket = this.getPerpMarketAccountOrThrow(perpMarketIndex);

		if (!isVariant(perpMarket.oracleSource, 'prelaunch')) {
			throw new Error(`Wrong oracle source ${perpMarket.oracleSource}`);
		}

		return await this.program.instruction.updatePrelaunchOracle({
			accounts: {
				state: await this.getStatePublicKey(),
				perpMarket: perpMarket.pubkey,
				oracle: perpMarket.oracle,
			},
		});
	}

	public async updatePerpBidAskTwap(
		perpMarketIndex: number,
		makers: [PublicKey, PublicKey][],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdatePerpBidAskTwapIx(perpMarketIndex, makers),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdatePerpBidAskTwapIx(
		perpMarketIndex: number,
		makers: [PublicKey, PublicKey][]
	): Promise<TransactionInstruction> {
		const perpMarket = this.getPerpMarketAccountOrThrow(perpMarketIndex);

		const remainingAccounts = [];
		for (const [maker, makerStats] of makers) {
			remainingAccounts.push({
				pubkey: maker,
				isWritable: false,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: makerStats,
				isWritable: false,
				isSigner: false,
			});
		}

		return await this.program.instruction.updatePerpBidAskTwap({
			accounts: {
				state: await this.getStatePublicKey(),
				perpMarket: perpMarket.pubkey,
				oracle: perpMarket.oracle,
				authority: this.wallet.publicKey,
				keeperStats: this.getUserStatsAccountPublicKey(),
			},
			remainingAccounts,
		});
	}

	public async settleFundingPayment(
		userAccountPublicKey: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getSettleFundingPaymentIx(userAccountPublicKey),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettleFundingPaymentIx(
		userAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const userAccount = (await (this.program.account as any).user.fetch(
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

	public triggerEvent(
		eventName: keyof VelocityClientAccountEvents,
		data?: any
	) {
		this.eventEmitter.emit(eventName, data);
	}

	public getOracleDataForPerpMarket(marketIndex: number): OraclePriceData {
		const oraclePriceDataAndSlot =
			this.accountSubscriber.getOraclePriceDataAndSlotForPerpMarket(
				marketIndex
			);
		if (!oraclePriceDataAndSlot) {
			throw new Error(`No oracle price data for perp market ${marketIndex}`);
		}
		return oraclePriceDataAndSlot.data;
	}

	public getMMOracleDataForPerpMarket(marketIndex: number): MMOraclePriceData {
		const perpMarket = this.getPerpMarketAccountOrThrow(marketIndex);
		const oracleData = this.getOracleDataForPerpMarket(marketIndex);
		const stateAccountAndSlot = this.accountSubscriber.getStateAccountAndSlot();
		const isMMOracleActive = !perpMarket.marketStats.mmOracleSlot.eq(ZERO);
		const pctDiff = perpMarket.marketStats.mmOraclePrice
			.sub(oracleData.price)
			.abs()
			.mul(PERCENTAGE_PRECISION)
			.div(BN.max(oracleData.price, ONE));

		const mmOracleSequenceId = perpMarket.marketStats.mmOracleSequenceId;

		// Do slot check for recency if sequence ids are zero or they're too divergent
		const doSlotCheckForRecency =
			oracleData.sequenceId == null ||
			oracleData.sequenceId.eq(ZERO) ||
			mmOracleSequenceId.eq(ZERO) ||
			oracleData.sequenceId
				.sub(perpMarket.marketStats.mmOracleSequenceId)
				.abs()
				.gt(oracleData.sequenceId.div(new BN(10_000)));

		let isExchangeOracleMoreRecent = true;
		if (
			doSlotCheckForRecency &&
			oracleData.slot.lte(perpMarket.marketStats.mmOracleSlot)
		) {
			isExchangeOracleMoreRecent = false;
		} else if (
			!doSlotCheckForRecency &&
			oracleData.sequenceId != null &&
			oracleData.sequenceId.lt(mmOracleSequenceId)
		) {
			isExchangeOracleMoreRecent = false;
		}

		const conf = getOracleConfidenceFromMMOracleData(
			perpMarket.marketStats.mmOraclePrice,
			oracleData
		);

		if (
			isOracleTooDivergent(
				perpMarket.marketStats,
				{
					price: perpMarket.marketStats.mmOraclePrice,
					slot: perpMarket.marketStats.mmOracleSlot,
					confidence: conf,
					hasSufficientNumberOfDataPoints: true,
				},
				stateAccountAndSlot.data.oracleGuardRails
			) ||
			perpMarket.marketStats.mmOraclePrice.eq(ZERO) ||
			isExchangeOracleMoreRecent ||
			pctDiff.gt(PERCENTAGE_PRECISION.divn(100)) // 1% threshold
		) {
			return { ...oracleData, isMMOracleActive };
		} else {
			return {
				price: perpMarket.marketStats.mmOraclePrice,
				slot: perpMarket.marketStats.mmOracleSlot,
				confidence: conf,
				hasSufficientNumberOfDataPoints: true,
				isMMOracleActive,
			};
		}
	}

	public getOracleDataForSpotMarket(marketIndex: number): OraclePriceData {
		const oraclePriceDataAndSlot =
			this.accountSubscriber.getOraclePriceDataAndSlotForSpotMarket(
				marketIndex
			);
		if (!oraclePriceDataAndSlot) {
			throw new Error(`No oracle price data for spot market ${marketIndex}`);
		}
		return oraclePriceDataAndSlot.data;
	}

	public async initializeInsuranceFundStake(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getInitializeInsuranceFundStakeIx(marketIndex),
				txParams
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

		const accounts = {
			insuranceFundStake: ifStakeAccountPublicKey,
			spotMarket: this.getSpotMarketAccountOrThrow(marketIndex).pubkey,
			userStats: getUserStatsAccountPublicKey(
				this.program.programId,
				this.wallet.publicKey // only allow payer to initialize own insurance fund stake account
			),
			authority: this.wallet.publicKey,
			payer: this.wallet.publicKey,
			rent: SYSVAR_RENT_PUBKEY,
			systemProgram: SystemProgram.programId,
			state: await this.getStatePublicKey(),
		};

		return await this.program.instruction.initializeInsuranceFundStake(
			marketIndex,
			{
				accounts,
			}
		);
	}

	public async getAddInsuranceFundStakeIx(
		marketIndex: number,
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const spotMarket = this.getSpotMarketAccountOrThrow(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const remainingAccounts: AccountMeta[] = [];
		this.addTokenMintToRemainingAccounts(spotMarket, remainingAccounts);
		if (this.isTransferHook(spotMarket)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				spotMarket.mint,
				remainingAccounts
			);
		}

		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarket);
		const ix = this.program.instruction.addInsuranceFundStake(
			marketIndex,
			amount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarket.pubkey,
					insuranceFundStake: ifStakeAccountPublicKey,
					userStats: getUserStatsAccountPublicKey(
						this.program.programId,
						this.wallet.publicKey // only allow payer to add to own insurance fund stake account
					),
					authority: this.wallet.publicKey,
					spotMarketVault: spotMarket.vault,
					insuranceFundVault: spotMarket.insuranceFund.vault,
					velocitySigner: this.getSignerPublicKey(),
					userTokenAccount: collateralAccountPublicKey,
					tokenProgram,
				},
				remainingAccounts,
			}
		);

		return ix;
	}

	/**
	 * Add to an insurance fund stake and optionally initialize the account
	 */
	public async addInsuranceFundStake({
		marketIndex,
		amount,
		collateralAccountPublicKey,
		initializeStakeAccount,
		fromSubaccount,
		txParams,
	}: {
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
	}): Promise<TransactionSignature> {
		const addIfStakeIxs = await this.getAddInsuranceFundStakeIxs({
			marketIndex,
			amount,
			collateralAccountPublicKey,
			initializeStakeAccount,
			fromSubaccount,
		});

		const additionalSigners: Array<Signer> = [];
		const tx = await this.buildTransaction(addIfStakeIxs, txParams);

		const { txSig } = await this.sendTransaction(
			tx,
			additionalSigners,
			this.opts
		);

		return txSig;
	}

	/**
	 * Get instructions to add to an insurance fund stake and optionally initialize the account
	 */
	public async getAddInsuranceFundStakeIxs({
		marketIndex,
		amount,
		collateralAccountPublicKey,
		initializeStakeAccount,
		fromSubaccount,
	}: {
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
	}): Promise<TransactionInstruction[]> {
		const addIfStakeIxs = [];

		const spotMarketAccount = this.getSpotMarketAccountOrThrow(marketIndex);
		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);
		const createWSOLTokenAccount =
			isSolMarket && collateralAccountPublicKey.equals(this.wallet.publicKey);
		const tokenProgramId = this.getTokenProgramForSpotMarket(spotMarketAccount);

		// create associated token account because it may not exist
		const associatedTokenAccountPublicKey = getAssociatedTokenAddressSync(
			spotMarketAccount.mint,
			this.wallet.publicKey,
			true,
			tokenProgramId
		);

		addIfStakeIxs.push(
			await createAssociatedTokenAccountIdempotentInstruction(
				this.wallet.publicKey,
				associatedTokenAccountPublicKey,
				this.wallet.publicKey,
				spotMarketAccount.mint,
				tokenProgramId
			)
		);

		let tokenAccount;

		if (
			!(await this.checkIfAccountExists(
				getUserStatsAccountPublicKey(
					this.program.programId,
					this.wallet.publicKey // only allow payer to initialize own user stats account
				)
			))
		) {
			addIfStakeIxs.push(await this.getInitializeUserStatsIx());
		}

		if (createWSOLTokenAccount) {
			const { ixs, pubkey } = await this.getWrappedSolAccountCreationIxs(
				amount,
				true
			);
			tokenAccount = pubkey;
			ixs.forEach((ix) => {
				addIfStakeIxs.push(ix);
			});
		} else {
			tokenAccount = collateralAccountPublicKey;
		}

		if (fromSubaccount) {
			const withdrawIx = await this.getWithdrawIx(
				amount,
				marketIndex,
				tokenAccount
			);
			addIfStakeIxs.push(withdrawIx);
		}

		if (initializeStakeAccount) {
			const initializeIx = await this.getInitializeInsuranceFundStakeIx(
				marketIndex
			);
			addIfStakeIxs.push(initializeIx);
		}

		const addFundsIx = await this.getAddInsuranceFundStakeIx(
			marketIndex,
			amount,
			tokenAccount
		);

		addIfStakeIxs.push(addFundsIx);

		if (createWSOLTokenAccount) {
			addIfStakeIxs.push(
				createCloseAccountInstruction(
					tokenAccount,
					this.wallet.publicKey,
					this.wallet.publicKey,
					[]
				)
			);
		}

		return addIfStakeIxs;
	}

	public async requestRemoveInsuranceFundStake(
		marketIndex: number,
		amount: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccountOrThrow(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const ix = await (
			this.program.instruction as any
		).requestRemoveInsuranceFundStake(marketIndex, amount, {
			accounts: {
				state: await this.getStatePublicKey(),
				spotMarket: spotMarketAccount.pubkey,
				insuranceFundStake: ifStakeAccountPublicKey,
				userStats: getUserStatsAccountPublicKey(
					this.program.programId,
					this.wallet.publicKey // only allow payer to request remove own insurance fund stake account
				),
				authority: this.wallet.publicKey,
				insuranceFundVault: spotMarketAccount.insuranceFund.vault,
			},
		});

		const tx = await this.buildTransaction(ix, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async cancelRequestRemoveInsuranceFundStake(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccountOrThrow(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const ix = await (
			this.program.instruction as any
		).cancelRequestRemoveInsuranceFundStake(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				spotMarket: spotMarketAccount.pubkey,
				insuranceFundStake: ifStakeAccountPublicKey,
				userStats: getUserStatsAccountPublicKey(
					this.program.programId,
					this.wallet.publicKey // only allow payer to request remove own insurance fund stake account
				),
				authority: this.wallet.publicKey,
				insuranceFundVault: spotMarketAccount.insuranceFund.vault,
			},
		});

		const tx = await this.buildTransaction(ix, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async removeInsuranceFundStake(
		marketIndex: number,
		collateralAccountPublicKey: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const removeIfStakeIxs = [];
		const spotMarketAccount = this.getSpotMarketAccountOrThrow(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const additionalSigners: Array<Signer> = [];
		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);
		const createWSOLTokenAccount =
			isSolMarket && collateralAccountPublicKey.equals(this.wallet.publicKey);
		const tokenProgramId = this.getTokenProgramForSpotMarket(spotMarketAccount);

		let tokenAccount;

		if (createWSOLTokenAccount) {
			const { ixs, pubkey } = await this.getWrappedSolAccountCreationIxs(
				ZERO,
				true
			);
			tokenAccount = pubkey;
			ixs.forEach((ix) => {
				removeIfStakeIxs.push(ix);
			});
		} else {
			tokenAccount = collateralAccountPublicKey;
			const tokenAccountExists = await this.checkIfAccountExists(tokenAccount);
			if (!tokenAccountExists) {
				const createTokenAccountIx =
					await this.createAssociatedTokenAccountIdempotentInstruction(
						tokenAccount,
						this.wallet.publicKey,
						this.wallet.publicKey,
						spotMarketAccount.mint,
						tokenProgramId
					);
				removeIfStakeIxs.push(createTokenAccountIx);
			}
		}

		const remainingAccounts: AccountMeta[] = [];
		this.addTokenMintToRemainingAccounts(spotMarketAccount, remainingAccounts);
		if (this.isTransferHook(spotMarketAccount)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				spotMarketAccount.mint,
				remainingAccounts
			);
		}

		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarketAccount);
		const removeStakeIx =
			await this.program.instruction.removeInsuranceFundStake(marketIndex, {
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					insuranceFundStake: ifStakeAccountPublicKey,
					userStats: getUserStatsAccountPublicKey(
						this.program.programId,
						this.wallet.publicKey // only allow payer to request remove own insurance fund stake account
					),
					authority: this.wallet.publicKey,
					insuranceFundVault: spotMarketAccount.insuranceFund.vault,
					velocitySigner: this.getSignerPublicKey(),
					userTokenAccount: tokenAccount,
					tokenProgram,
				},
				remainingAccounts,
			});

		removeIfStakeIxs.push(removeStakeIx);

		// Close the wrapped sol account at the end of the transaction
		if (createWSOLTokenAccount) {
			removeIfStakeIxs.push(
				createCloseAccountInstruction(
					tokenAccount,
					this.wallet.publicKey,
					this.wallet.publicKey,
					[]
				)
			);
		}

		const tx = await this.buildTransaction(removeIfStakeIxs, txParams);

		const { txSig } = await this.sendTransaction(
			tx,
			additionalSigners,
			this.opts
		);
		return txSig;
	}

	public async updateUserQuoteAssetInsuranceStake(
		authority: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const tx = await this.buildTransaction(
			await this.getUpdateUserQuoteAssetInsuranceStakeIx(authority),
			txParams
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUpdateUserQuoteAssetInsuranceStakeIx(
		authority: PublicKey
	): Promise<TransactionInstruction> {
		const marketIndex = QUOTE_SPOT_MARKET_INDEX;
		const spotMarket = this.getSpotMarketAccountOrThrow(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			authority,
			marketIndex
		);
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			authority
		);

		const ix = this.program.instruction.updateUserQuoteAssetInsuranceStake({
			accounts: {
				state: await this.getStatePublicKey(),
				spotMarket: spotMarket.pubkey,
				insuranceFundStake: ifStakeAccountPublicKey,
				userStats: userStatsPublicKey,
				signer: this.wallet.publicKey,
				insuranceFundVault: spotMarket.insuranceFund.vault,
			},
		});

		return ix;
	}

	public async settleRevenueToInsuranceFund(
		spotMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const tx = await this.buildTransaction(
			await this.getSettleRevenueToInsuranceFundIx(spotMarketIndex),
			txParams
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}
	public async getSettleRevenueToInsuranceFundIx(
		spotMarketIndex: number
	): Promise<TransactionInstruction> {
		const spotMarketAccount = this.getSpotMarketAccountOrThrow(spotMarketIndex);
		const tokenProgramId = this.getTokenProgramForSpotMarket(spotMarketAccount);

		const remainingAccounts: AccountMeta[] = [];
		this.addTokenMintToRemainingAccounts(spotMarketAccount, remainingAccounts);
		if (this.isTransferHook(spotMarketAccount)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				spotMarketAccount.mint,
				remainingAccounts
			);
		}

		const ix = await this.program.instruction.settleRevenueToInsuranceFund(
			spotMarketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					spotMarketVault: spotMarketAccount.vault,
					velocitySigner: this.getSignerPublicKey(),
					insuranceFundVault: spotMarketAccount.insuranceFund.vault,
					tokenProgram: tokenProgramId,
				},
				remainingAccounts,
			}
		);
		return ix;
	}

	public async sweepPerpMarketFees(
		perpMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const tx = await this.buildTransaction(
			await this.getSweepPerpMarketFeesIx(perpMarketIndex),
			txParams
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getSweepPerpMarketFeesIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const perpMarketAccount = this.getPerpMarketAccountOrThrow(perpMarketIndex);
		const spotMarketAccount = this.getSpotMarketAccountOrThrow(
			perpMarketAccount.quoteSpotMarketIndex
		);

		const ix = await this.program.instruction.sweepPerpMarketFees(
			perpMarketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					perpMarket: perpMarketAccount.pubkey,
					spotMarket: spotMarketAccount.pubkey,
					oracle: perpMarketAccount.oracle,
				},
			}
		);
		return ix;
	}

	public async resolvePerpPnlDeficit(
		spotMarketIndex: number,
		perpMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getResolvePerpPnlDeficitIx(spotMarketIndex, perpMarketIndex),
				txParams
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
			userAccounts: [],
			writablePerpMarketIndexes: [perpMarketIndex],
			writableSpotMarketIndexes: [spotMarketIndex],
		});

		const spotMarket = this.getSpotMarketAccountOrThrow(spotMarketIndex);
		const tokenProgramId = this.getTokenProgramForSpotMarket(spotMarket);

		return await this.program.instruction.resolvePerpPnlDeficit(
			spotMarketIndex,
			perpMarketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					spotMarketVault: spotMarket.vault,
					insuranceFundVault: spotMarket.insuranceFund.vault,
					velocitySigner: this.getSignerPublicKey(),
					tokenProgram: tokenProgramId,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async getDepositIntoSpotMarketRevenuePoolIx(
		marketIndex: number,
		amount: BN,
		userTokenAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const spotMarket = await this.getSpotMarketAccountOrThrow(marketIndex);

		const remainingAccounts: AccountMeta[] = [];
		this.addTokenMintToRemainingAccounts(spotMarket, remainingAccounts);
		if (this.isTransferHook(spotMarket)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				spotMarket.mint,
				remainingAccounts
			);
		}

		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarket);
		const ix = await this.program.instruction.depositIntoSpotMarketRevenuePool(
			amount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarket.pubkey,
					authority: this.wallet.publicKey,
					spotMarketVault: spotMarket.vault,
					userTokenAccount: userTokenAccountPublicKey,
					tokenProgram,
				},
			}
		);

		return ix;
	}

	/**
	 * This ix will donate your funds to velocity revenue pool. It does not deposit into your user account
	 * @param marketIndex
	 * @param amount
	 * @param userTokenAccountPublicKey
	 * @returns
	 */
	public async depositIntoSpotMarketRevenuePool(
		marketIndex: number,
		amount: BN,
		userTokenAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		const ix = await this.getDepositIntoSpotMarketRevenuePoolIx(
			marketIndex,
			amount,
			userTokenAccountPublicKey
		);
		const tx = await this.buildTransaction([ix]);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public getPerpMarketExtendedInfo(
		marketIndex: number
	): PerpMarketExtendedInfo {
		const marketAccount = this.getPerpMarketAccountOrThrow(marketIndex);
		const quoteAccount = this.getSpotMarketAccountOrThrow(
			QUOTE_SPOT_MARKET_INDEX
		);

		const extendedInfo: PerpMarketExtendedInfo = {
			marketIndex,
			minOrderSize: marketAccount.marketStats?.minOrderSize,
			marginMaintenance: marketAccount.marginRatioMaintenance,
			pnlPoolValue: getTokenAmount(
				marketAccount.pnlPool?.scaledBalance,
				quoteAccount,
				SpotBalanceType.DEPOSIT
			),
			contractTier: marketAccount.contractTier,
			availableInsurance: calculateMarketMaxAvailableInsurance(
				marketAccount,
				quoteAccount
			),
		};

		return extendedInfo;
	}

	/**
	 * Calculates taker / maker fee (as a percentage, e.g. .001 = 10 basis points) for particular marketType
	 * @param marketType
	 * @param positionMarketIndex
	 * @returns : {takerFee: number, makerFee: number} Precision None
	 */
	public getMarketFees(
		marketType: MarketType,
		marketIndex?: number,
		user?: User
	) {
		let feeTier;
		if (user) {
			feeTier = user.getUserFeeTier(marketType);
		} else {
			const state = this.getStateAccount();
			feeTier = isVariant(marketType, 'perp')
				? state.perpFeeStructure.feeTiers[0]
				: state.spotFeeStructure.feeTiers[0];
		}

		let takerFee = feeTier.feeNumerator / feeTier.feeDenominator;
		let makerFee =
			feeTier.makerRebateNumerator / feeTier.makerRebateDenominator;

		if (marketIndex !== undefined) {
			let marketAccount: PerpMarketAccount | SpotMarketAccount;
			if (isVariant(marketType, 'perp')) {
				marketAccount = this.getPerpMarketAccountOrThrow(marketIndex);
			} else {
				marketAccount = this.getSpotMarketAccountOrThrow(marketIndex);
			}

			takerFee += (takerFee * marketAccount.feeAdjustment) / 100;
			makerFee += (makerFee * marketAccount.feeAdjustment) / 100;
		}

		return {
			takerFee,
			makerFee,
		};
	}

	/**
	 * Returns the market index and type for a given market name
	 * E.g. "SOL-PERP" -> { marketIndex: 0, marketType: MarketType.PERP }
	 *
	 * @param name
	 */
	getMarketIndexAndType(
		name: string
	): { marketIndex: number; marketType: MarketType } | undefined {
		name = name.toUpperCase();
		for (const perpMarketAccount of this.getPerpMarketAccounts()) {
			if (decodeName(perpMarketAccount.name).toUpperCase() === name) {
				return {
					marketIndex: perpMarketAccount.marketIndex,
					marketType: MarketType.PERP,
				};
			}
		}

		for (const spotMarketAccount of this.getSpotMarketAccounts()) {
			if (decodeName(spotMarketAccount.name).toUpperCase() === name) {
				return {
					marketIndex: spotMarketAccount.marketIndex,
					marketType: MarketType.SPOT,
				};
			}
		}

		return undefined;
	}

	public async postPythLazerOracleUpdate(
		feedIds: number[],
		pythMessageHex: string
	): Promise<string> {
		const postIxs = await this.getPostPythLazerOracleUpdateIxs(
			feedIds,
			pythMessageHex,
			undefined,
			2
		);
		const tx = await this.buildTransaction(postIxs);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getPostPythLazerOracleUpdateIxs(
		feedIds: number[],
		pythMessageHex: string,
		precedingIxs: TransactionInstruction[] = [],
		overrideCustomIxIndex?: number
	): Promise<TransactionInstruction[]> {
		const pythMessageBytes = Buffer.from(pythMessageHex, 'hex');

		const verifyIx = createMinimalEd25519VerifyIx(
			overrideCustomIxIndex || precedingIxs.length + 1,
			12,
			pythMessageBytes
		);

		const remainingAccountsMeta = feedIds.map((feedId) => {
			return {
				pubkey: getPythLazerOraclePublicKey(this.program.programId, feedId),
				isSigner: false,
				isWritable: true,
			};
		});

		const ix = this.program.instruction.postPythLazerOracleUpdate(
			pythMessageBytes,
			{
				accounts: {
					keeper: this.wallet.publicKey,
					pythLazerStorage: PYTH_LAZER_STORAGE_ACCOUNT_KEY,
					ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
				},
				remainingAccounts: remainingAccountsMeta,
			}
		);
		return [verifyIx, ix];
	}

	public async getPauseSpotMarketDepositWithdrawIx(
		spotMarketIndex: number
	): Promise<TransactionInstruction> {
		const spotMarket = await this.getSpotMarketAccountOrThrow(spotMarketIndex);
		return this.program.instruction.pauseSpotMarketDepositWithdraw({
			accounts: {
				state: await this.getStatePublicKey(),
				keeper: this.wallet.publicKey,
				spotMarket: spotMarket.pubkey,
				spotMarketVault: spotMarket.vault,
			},
		});
	}

	public async pauseSpotMarketDepositWithdraw(
		spotMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getPauseSpotMarketDepositWithdrawIx(spotMarketIndex),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async updateMmOracleNative(
		marketIndex: number,
		oraclePrice: BN,
		oracleSequenceId: BN
	): Promise<TransactionSignature> {
		const updateMmOracleIx = await this.getUpdateMmOracleNativeIx(
			marketIndex,
			oraclePrice,
			oracleSequenceId
		);

		const tx = await this.buildTransaction(updateMmOracleIx, {
			computeUnits: 5000,
			computeUnitsPrice: 0,
		});
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateMmOracleNativeIx(
		marketIndex: number,
		oraclePrice: BN,
		oracleSequenceId: BN
	): Promise<TransactionInstruction> {
		const discriminatorBuffer = createNativeInstructionDiscriminatorBuffer(0);
		const data = Buffer.alloc(discriminatorBuffer.length + 16);
		data.set(discriminatorBuffer, 0);
		data.set(oraclePrice.toArrayLike(Buffer, 'le', 8), 5); // next 8 bytes
		data.set(oracleSequenceId.toArrayLike(Buffer, 'le', 8), 13); // next 8 bytes

		// Build the instruction manually
		return new TransactionInstruction({
			programId: this.program.programId,
			keys: [
				{
					pubkey: this.getPerpMarketAccountOrThrow(marketIndex).pubkey,
					isWritable: true,
					isSigner: false,
				},
				{
					pubkey: this.wallet.publicKey,
					isWritable: false,
					isSigner: true,
				},
				{
					pubkey: SYSVAR_CLOCK_PUBKEY,
					isWritable: false,
					isSigner: false,
				},
				{
					pubkey: await this.getStatePublicKey(),
					isWritable: false,
					isSigner: false,
				},
			],
			data,
		});
	}

	public async updateAmmSpreadAdjustmentNative(
		marketIndex: number,
		ammSpreadAdjustment: number
	): Promise<TransactionSignature> {
		const updateMmOracleIx = await this.getUpdateAmmSpreadAdjustmentNativeIx(
			marketIndex,
			ammSpreadAdjustment
		);

		const tx = await this.buildTransaction(updateMmOracleIx, {
			// Headroom for the native handler's owner + discriminator validation
			// of the state + perp-market accounts (was 1000 when it bytemuck-cast
			// the market without any checks). Measured ~1.3k CU; 2000 leaves
			// margin for the production-only signer check.
			computeUnits: 2000,
			computeUnitsPrice: 0,
		});
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getUpdateAmmSpreadAdjustmentNativeIx(
		marketIndex: number,
		ammSpreadAdjustment: number // i8
	): Promise<TransactionInstruction> {
		const discriminatorBuffer = createNativeInstructionDiscriminatorBuffer(1);
		const data = Buffer.alloc(discriminatorBuffer.length + 4);
		data.set(discriminatorBuffer, 0);
		data.writeInt8(ammSpreadAdjustment, 5); // next byte

		// Build the instruction manually. The native handler re-establishes the
		// account guarantees Anchor would normally provide: it loads `state` as
		// the program-owned State account and authenticates the signer against
		// `state.hotAmmSpreadAdjust`, so the state account is required at index 2.
		return new TransactionInstruction({
			programId: this.program.programId,
			keys: [
				{
					pubkey: this.getPerpMarketAccountOrThrow(marketIndex).pubkey,
					isWritable: true,
					isSigner: false,
				},
				{
					pubkey: this.wallet.publicKey,
					isWritable: false,
					isSigner: true,
				},
				{
					pubkey: await this.getStatePublicKey(),
					isWritable: false,
					isSigner: false,
				},
			],
			data,
		});
	}

	public async getLpPoolAccount(lpPoolId: number): Promise<LPPoolAccount> {
		return (await (this.program.account as any).lpPool.fetch(
			getLpPoolPublicKey(this.program.programId, lpPoolId)
		)) as unknown as LPPoolAccount;
	}

	public async getConstituentTargetBaseAccount(
		lpPoolId: number
	): Promise<ConstituentTargetBaseAccount> {
		return (await (this.program.account as any).constituentTargetBase.fetch(
			getConstituentTargetBasePublicKey(
				this.program.programId,
				getLpPoolPublicKey(this.program.programId, lpPoolId)
			)
		)) as ConstituentTargetBaseAccount;
	}

	public async getAmmCache(): Promise<AmmCache> {
		return (await (this.program.account as any).ammCache.fetch(
			getAmmCachePublicKey(this.program.programId)
		)) as AmmCache;
	}

	public async updateLpConstituentTargetBase(
		lpPoolId: number,
		constituents: PublicKey[],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateLpConstituentTargetBaseIx(lpPoolId, constituents),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateLpConstituentTargetBaseIx(
		lpPoolId: number,
		constituents: PublicKey[]
	): Promise<TransactionInstruction> {
		const lpPool = getLpPoolPublicKey(this.program.programId, lpPoolId);
		const ammConstituentMappingPublicKey = getAmmConstituentMappingPublicKey(
			this.program.programId,
			lpPool
		);
		const constituentTargetBase = getConstituentTargetBasePublicKey(
			this.program.programId,
			lpPool
		);

		const ammCache = getAmmCachePublicKey(this.program.programId);

		const remainingAccounts = constituents.map((constituent) => {
			return {
				isWritable: false,
				isSigner: false,
				pubkey: constituent,
			};
		});

		return this.program.instruction.updateLpConstituentTargetBase({
			accounts: {
				keeper: this.wallet.publicKey,
				lpPool,
				ammConstituentMapping: ammConstituentMappingPublicKey,
				constituentTargetBase,
				state: await this.getStatePublicKey(),
				ammCache,
			},
			remainingAccounts,
		});
	}

	public async updateLpPoolAum(
		lpPool: LPPoolAccount,
		spotMarketIndexOfConstituents: number[],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateLpPoolAumIxs(lpPool, spotMarketIndexOfConstituents),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateLpPoolAumIxs(
		lpPool: LPPoolAccount,
		spotMarketIndexOfConstituents: number[]
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			readableSpotMarketIndexes: spotMarketIndexOfConstituents,
		});
		remainingAccounts.push(
			...spotMarketIndexOfConstituents.map((index) => {
				return {
					pubkey: getConstituentPublicKey(
						this.program.programId,
						lpPool.pubkey,
						index
					),
					isSigner: false,
					isWritable: true,
				};
			})
		);
		return this.program.instruction.updateLpPoolAum({
			accounts: {
				keeper: this.wallet.publicKey,
				lpPool: lpPool.pubkey,
				state: await this.getStatePublicKey(),
				constituentTargetBase: getConstituentTargetBasePublicKey(
					this.program.programId,
					lpPool.pubkey
				),
				ammCache: getAmmCachePublicKey(this.program.programId),
			},
			remainingAccounts,
		});
	}

	public async updateAmmCache(
		perpMarketIndexes: number[],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateAmmCacheIx(perpMarketIndexes),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateAmmCacheIx(
		perpMarketIndexes: number[]
	): Promise<TransactionInstruction> {
		if (perpMarketIndexes.length > 50) {
			throw new Error('Cant update more than 50 markets at once');
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			readablePerpMarketIndex: perpMarketIndexes,
		});

		return this.program.instruction.updateAmmCache({
			accounts: {
				state: await this.getStatePublicKey(),
				keeper: this.wallet.publicKey,
				ammCache: getAmmCachePublicKey(this.program.programId),
				quoteMarket: this.getSpotMarketAccountOrThrow(0).pubkey,
			},
			remainingAccounts,
		});
	}

	public async updateConstituentOracleInfo(
		constituent: ConstituentAccount
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateConstituentOracleInfoIx(constituent),
				undefined
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateConstituentOracleInfoIx(
		constituent: ConstituentAccount
	): Promise<TransactionInstruction> {
		const spotMarket = this.getSpotMarketAccountOrThrow(
			constituent.spotMarketIndex
		);
		return this.program.instruction.updateConstituentOracleInfo({
			accounts: {
				keeper: this.wallet.publicKey,
				constituent: constituent.pubkey,
				state: await this.getStatePublicKey(),
				oracle: spotMarket.oracle,
				spotMarket: spotMarket.pubkey,
			},
		});
	}

	public async lpPoolSwap(
		inMarketIndex: number,
		outMarketIndex: number,
		inAmount: BN,
		minOutAmount: BN,
		lpPool: PublicKey,
		userAuthority: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLpPoolSwapIx(
					inMarketIndex,
					outMarketIndex,
					inAmount,
					minOutAmount,
					lpPool,
					userAuthority
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getLpPoolSwapIx(
		inMarketIndex: number,
		outMarketIndex: number,
		inAmount: BN,
		minOutAmount: BN,
		lpPool: PublicKey,
		userAuthority: PublicKey
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			readableSpotMarketIndexes: [inMarketIndex, outMarketIndex],
		});

		const constituentInTokenAccount = getConstituentVaultPublicKey(
			this.program.programId,
			lpPool,
			inMarketIndex
		);
		const constituentOutTokenAccount = getConstituentVaultPublicKey(
			this.program.programId,
			lpPool,
			outMarketIndex
		);
		const userInTokenAccount = await getAssociatedTokenAddress(
			this.getSpotMarketAccountOrThrow(inMarketIndex).mint,
			userAuthority
		);
		const userOutTokenAccount = await getAssociatedTokenAddress(
			this.getSpotMarketAccountOrThrow(outMarketIndex).mint,
			userAuthority
		);
		const inConstituent = getConstituentPublicKey(
			this.program.programId,
			lpPool,
			inMarketIndex
		);
		const outConstituent = getConstituentPublicKey(
			this.program.programId,
			lpPool,
			outMarketIndex
		);
		const inMarketMint = this.getSpotMarketAccountOrThrow(inMarketIndex).mint;
		const outMarketMint = this.getSpotMarketAccountOrThrow(outMarketIndex).mint;

		const constituentTargetBase = getConstituentTargetBasePublicKey(
			this.program.programId,
			lpPool
		);

		return this.program.instruction.lpPoolSwap(
			inMarketIndex,
			outMarketIndex,
			inAmount,
			minOutAmount,
			{
				remainingAccounts,
				accounts: {
					state: await this.getStatePublicKey(),
					lpPool,
					constituentTargetBase,
					constituentInTokenAccount,
					constituentOutTokenAccount,
					constituentCorrelations: getConstituentCorrelationsPublicKey(
						this.program.programId,
						lpPool
					),
					userInTokenAccount,
					userOutTokenAccount,
					inConstituent,
					outConstituent,
					inMarketMint,
					outMarketMint,
					authority: this.wallet.publicKey,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
			}
		);
	}

	public async viewLpPoolSwapFees(
		inMarketIndex: number,
		outMarketIndex: number,
		inAmount: BN,
		inTargetWeight: BN,
		outTargetWeight: BN,
		lpPool: PublicKey,
		constituentTargetBase: PublicKey,
		constituentInTokenAccount: PublicKey,
		constituentOutTokenAccount: PublicKey,
		inConstituent: PublicKey,
		outConstituent: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getViewLpPoolSwapFeesIx(
					inMarketIndex,
					outMarketIndex,
					inAmount,
					inTargetWeight,
					outTargetWeight,
					lpPool,
					constituentTargetBase,
					constituentInTokenAccount,
					constituentOutTokenAccount,
					inConstituent,
					outConstituent
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getViewLpPoolSwapFeesIx(
		inMarketIndex: number,
		outMarketIndex: number,
		inAmount: BN,
		inTargetWeight: BN,
		outTargetWeight: BN,
		lpPool: PublicKey,
		constituentTargetBase: PublicKey,
		constituentInTokenAccount: PublicKey,
		constituentOutTokenAccount: PublicKey,
		inConstituent: PublicKey,
		outConstituent: PublicKey
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			readableSpotMarketIndexes: [inMarketIndex, outMarketIndex],
		});

		return this.program.instruction.viewLpPoolSwapFees(
			inMarketIndex,
			outMarketIndex,
			inAmount,
			inTargetWeight,
			outTargetWeight,
			{
				remainingAccounts,
				accounts: {
					velocitySigner: this.getSignerPublicKey(),
					state: await this.getStatePublicKey(),
					lpPool,
					constituentTargetBase,
					constituentInTokenAccount,
					constituentOutTokenAccount,
					constituentCorrelations: getConstituentCorrelationsPublicKey(
						this.program.programId,
						lpPool
					),
					inConstituent,
					outConstituent,
					authority: this.wallet.publicKey,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
			}
		);
	}

	public async getCreateLpPoolTokenAccountIx(
		lpPool: LPPoolAccount
	): Promise<TransactionInstruction> {
		const lpMint = lpPool.mint;
		const userLpTokenAccount = await getLpPoolTokenTokenAccountPublicKey(
			lpMint,
			this.wallet.publicKey
		);

		return this.createAssociatedTokenAccountIdempotentInstruction(
			userLpTokenAccount,
			this.wallet.publicKey,
			this.wallet.publicKey,
			lpMint
		);
	}

	public async createLpPoolTokenAccount(
		lpPool: LPPoolAccount,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getCreateLpPoolTokenAccountIx(lpPool),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async lpPoolAddLiquidity({
		inMarketIndex,
		inAmount,
		minMintAmount,
		lpPool,
		txParams,
	}: {
		inMarketIndex: number;
		inAmount: BN;
		minMintAmount: BN;
		lpPool: LPPoolAccount;
		txParams?: TxParams;
	}): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLpPoolAddLiquidityIx({
					inMarketIndex,
					inAmount,
					minMintAmount,
					lpPool,
				}),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getLpPoolAddLiquidityIx({
		inMarketIndex,
		inAmount,
		minMintAmount,
		lpPool,
	}: {
		inMarketIndex: number;
		inAmount: BN;
		minMintAmount: BN;
		lpPool: LPPoolAccount;
	}): Promise<TransactionInstruction[]> {
		const ixs: TransactionInstruction[] = [];
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			writableSpotMarketIndexes: [inMarketIndex],
		});

		const spotMarket = this.getSpotMarketAccountOrThrow(inMarketIndex);
		const inMarketMint = spotMarket.mint;
		const isSolMarket = inMarketMint.equals(WRAPPED_SOL_MINT);

		let wSolTokenAccount: PublicKey | undefined;
		if (isSolMarket) {
			const { ixs: wSolIxs, pubkey } =
				await this.getWrappedSolAccountCreationIxs(inAmount, true);
			wSolTokenAccount = pubkey;
			ixs.push(...wSolIxs);
		}

		const inConstituent = getConstituentPublicKey(
			this.program.programId,
			lpPool.pubkey,
			inMarketIndex
		);
		const userInTokenAccount =
			wSolTokenAccount ??
			(await this.getAssociatedTokenAccount(inMarketIndex, false));
		const constituentInTokenAccount = getConstituentVaultPublicKey(
			this.program.programId,
			lpPool.pubkey,
			inMarketIndex
		);
		const lpMint = lpPool.mint;
		const userLpTokenAccount = await getLpPoolTokenTokenAccountPublicKey(
			lpMint,
			this.wallet.publicKey
		);
		if (!(await this.checkIfAccountExists(userLpTokenAccount))) {
			ixs.push(
				this.createAssociatedTokenAccountIdempotentInstruction(
					userLpTokenAccount,
					this.wallet.publicKey,
					this.wallet.publicKey,
					lpMint
				)
			);
		}

		const constituentTargetBase = getConstituentTargetBasePublicKey(
			this.program.programId,
			lpPool.pubkey
		);

		if (!lpPool.whitelistMint.equals(PublicKey.default)) {
			const associatedTokenPublicKey = await getAssociatedTokenAddress(
				lpPool.whitelistMint,
				this.wallet.publicKey
			);
			remainingAccounts.push({
				pubkey: associatedTokenPublicKey,
				isWritable: false,
				isSigner: false,
			});
		}

		const lpPoolAddLiquidityIx = this.program.instruction.lpPoolAddLiquidity(
			inMarketIndex,
			inAmount,
			minMintAmount,
			{
				remainingAccounts,
				accounts: {
					state: await this.getStatePublicKey(),
					lpPool: lpPool.pubkey,
					authority: this.wallet.publicKey,
					inMarketMint,
					inConstituent,
					userInTokenAccount,
					constituentInTokenAccount,
					userLpTokenAccount,
					lpMint,
					lpPoolTokenVault: getLpPoolTokenVaultPublicKey(
						this.program.programId,
						lpPool.pubkey
					),
					constituentTargetBase,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
			}
		);
		ixs.push(lpPoolAddLiquidityIx);

		if (isSolMarket && wSolTokenAccount) {
			ixs.push(
				createCloseAccountInstruction(
					wSolTokenAccount,
					this.wallet.publicKey,
					this.wallet.publicKey
				)
			);
		}
		return [...ixs];
	}

	public async viewLpPoolAddLiquidityFees({
		inMarketIndex,
		inAmount,
		lpPool,
		txParams,
	}: {
		inMarketIndex: number;
		inAmount: BN;
		lpPool: LPPoolAccount;
		txParams?: TxParams;
	}): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getViewLpPoolAddLiquidityFeesIx({
					inMarketIndex,
					inAmount,
					lpPool,
				}),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getViewLpPoolAddLiquidityFeesIx({
		inMarketIndex,
		inAmount,
		lpPool,
	}: {
		inMarketIndex: number;
		inAmount: BN;
		lpPool: LPPoolAccount;
	}): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			readableSpotMarketIndexes: [inMarketIndex],
		});

		const spotMarket = this.getSpotMarketAccountOrThrow(inMarketIndex);
		const inMarketMint = spotMarket.mint;
		const inConstituent = getConstituentPublicKey(
			this.program.programId,
			lpPool.pubkey,
			inMarketIndex
		);
		const lpMint = lpPool.mint;

		const constituentTargetBase = getConstituentTargetBasePublicKey(
			this.program.programId,
			lpPool.pubkey
		);

		return this.program.instruction.viewLpPoolAddLiquidityFees(
			inMarketIndex,
			inAmount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					lpPool: lpPool.pubkey,
					authority: this.wallet.publicKey,
					inMarketMint,
					inConstituent,
					lpMint,
					constituentTargetBase,
				},
				remainingAccounts,
			}
		);
	}

	public async lpPoolRemoveLiquidity({
		outMarketIndex,
		lpToBurn,
		minAmountOut,
		lpPool,
		txParams,
	}: {
		outMarketIndex: number;
		lpToBurn: BN;
		minAmountOut: BN;
		lpPool: LPPoolAccount;
		txParams?: TxParams;
	}): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLpPoolRemoveLiquidityIx({
					outMarketIndex,
					lpToBurn,
					minAmountOut,
					lpPool,
				}),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getLpPoolRemoveLiquidityIx({
		outMarketIndex,
		lpToBurn,
		minAmountOut,
		lpPool,
	}: {
		outMarketIndex: number;
		lpToBurn: BN;
		minAmountOut: BN;
		lpPool: LPPoolAccount;
	}): Promise<TransactionInstruction[]> {
		const ixs: TransactionInstruction[] = [];
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			writableSpotMarketIndexes: [outMarketIndex],
		});

		const spotMarket = this.getSpotMarketAccountOrThrow(outMarketIndex);
		const outMarketMint = spotMarket.mint;
		const outConstituent = getConstituentPublicKey(
			this.program.programId,
			lpPool.pubkey,
			outMarketIndex
		);
		if (outMarketMint.equals(WRAPPED_SOL_MINT)) {
			ixs.push(
				createAssociatedTokenAccountIdempotentInstruction(
					this.wallet.publicKey,
					await this.getAssociatedTokenAccount(outMarketIndex, false),
					this.wallet.publicKey,
					WRAPPED_SOL_MINT
				)
			);
		}
		const userOutTokenAccount = await this.getAssociatedTokenAccount(
			outMarketIndex,
			false
		);
		const constituentOutTokenAccount = getConstituentVaultPublicKey(
			this.program.programId,
			lpPool.pubkey,
			outMarketIndex
		);
		const lpMint = lpPool.mint;
		const userLpTokenAccount = await getAssociatedTokenAddress(
			lpMint,
			this.wallet.publicKey,
			true
		);

		const constituentTargetBase = getConstituentTargetBasePublicKey(
			this.program.programId,
			lpPool.pubkey
		);

		ixs.push(
			this.program.instruction.lpPoolRemoveLiquidity(
				outMarketIndex,
				lpToBurn,
				minAmountOut,
				{
					remainingAccounts,
					accounts: {
						velocitySigner: this.getSignerPublicKey(),
						state: await this.getStatePublicKey(),
						lpPool: lpPool.pubkey,
						authority: this.wallet.publicKey,
						outMarketMint,
						outConstituent,
						userOutTokenAccount,
						constituentOutTokenAccount,
						userLpTokenAccount,
						spotMarketTokenAccount: spotMarket.vault,
						lpMint,
						lpPoolTokenVault: getLpPoolTokenVaultPublicKey(
							this.program.programId,
							lpPool.pubkey
						),
						constituentTargetBase,
						tokenProgram: TOKEN_PROGRAM_ID,
						ammCache: getAmmCachePublicKey(this.program.programId),
					},
				}
			)
		);
		return ixs;
	}

	public async viewLpPoolRemoveLiquidityFees({
		outMarketIndex,
		lpToBurn,
		lpPool,
		txParams,
	}: {
		outMarketIndex: number;
		lpToBurn: BN;
		lpPool: LPPoolAccount;
		txParams?: TxParams;
	}): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getViewLpPoolRemoveLiquidityFeesIx({
					outMarketIndex,
					lpToBurn,
					lpPool,
				}),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getViewLpPoolRemoveLiquidityFeesIx({
		outMarketIndex,
		lpToBurn,
		lpPool,
	}: {
		outMarketIndex: number;
		lpToBurn: BN;
		lpPool: LPPoolAccount;
	}): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			writableSpotMarketIndexes: [outMarketIndex],
		});

		const spotMarket = this.getSpotMarketAccountOrThrow(outMarketIndex);
		const outMarketMint = spotMarket.mint;
		const outConstituent = getConstituentPublicKey(
			this.program.programId,
			lpPool.pubkey,
			outMarketIndex
		);
		const lpMint = lpPool.mint;
		const constituentTargetBase = getConstituentTargetBasePublicKey(
			this.program.programId,
			lpPool.pubkey
		);

		return this.program.instruction.viewLpPoolRemoveLiquidityFees(
			outMarketIndex,
			lpToBurn,
			{
				remainingAccounts,
				accounts: {
					state: await this.getStatePublicKey(),
					lpPool: lpPool.pubkey,
					authority: this.wallet.publicKey,
					outMarketMint,
					outConstituent,
					lpMint,
					constituentTargetBase,
				},
			}
		);
	}

	public async getAllLpPoolAddLiquidityIxs(
		{
			inMarketIndex,
			inAmount,
			minMintAmount,
			lpPool,
		}: {
			inMarketIndex: number;
			inAmount: BN;
			minMintAmount: BN;
			lpPool: LPPoolAccount;
		},
		constituentMap: ConstituentMap,
		includeUpdateConstituentOracleInfo = true,
		view = false
	): Promise<TransactionInstruction[]> {
		const ixs: TransactionInstruction[] = [];

		ixs.push(
			...(await this.getAllUpdateLpPoolAumIxs(
				lpPool,
				constituentMap,
				includeUpdateConstituentOracleInfo
			))
		);

		if (view) {
			ixs.push(
				await this.getViewLpPoolAddLiquidityFeesIx({
					inMarketIndex,
					inAmount,
					lpPool,
				})
			);
		} else {
			ixs.push(
				...(await this.getLpPoolAddLiquidityIx({
					inMarketIndex,
					inAmount,
					minMintAmount,
					lpPool,
				}))
			);
		}

		return ixs;
	}

	public async getAllLpPoolRemoveLiquidityIxs(
		{
			outMarketIndex,
			lpToBurn,
			minAmountOut,
			lpPool,
		}: {
			outMarketIndex: number;
			lpToBurn: BN;
			minAmountOut: BN;
			lpPool: LPPoolAccount;
		},
		constituentMap: ConstituentMap,
		includeUpdateConstituentOracleInfo = true,
		view = false
	): Promise<TransactionInstruction[]> {
		const ixs: TransactionInstruction[] = [];
		ixs.push(
			...(await this.getAllSettlePerpToLpPoolIxs(
				lpPool.lpPoolId,
				this.getPerpMarketAccounts()
					.filter((marketAccount) => marketAccount.hedgeConfig.status > 0)
					.map((marketAccount) => marketAccount.marketIndex)
			))
		);
		ixs.push(
			...(await this.getAllUpdateLpPoolAumIxs(
				lpPool,
				constituentMap,
				includeUpdateConstituentOracleInfo
			))
		);
		if (view) {
			ixs.push(
				await this.getViewLpPoolRemoveLiquidityFeesIx({
					outMarketIndex,
					lpToBurn,
					lpPool,
				})
			);
		} else {
			ixs.push(
				...(await this.getLpPoolRemoveLiquidityIx({
					outMarketIndex,
					lpToBurn,
					minAmountOut,
					lpPool,
				}))
			);
		}

		return ixs;
	}

	public async getAllUpdateLpPoolAumIxs(
		lpPool: LPPoolAccount,
		constituentMap: ConstituentMap,
		includeUpdateConstituentOracleInfo = true
	): Promise<TransactionInstruction[]> {
		const ixs: TransactionInstruction[] = [];
		const constituents: ConstituentAccount[] = Array.from(
			constituentMap.values()
		);

		if (includeUpdateConstituentOracleInfo) {
			for (const constituent of constituents) {
				ixs.push(await this.getUpdateConstituentOracleInfoIx(constituent));
			}
		}

		const spotMarketIndexes = constituents.map(
			(constituent) => constituent.spotMarketIndex
		);
		ixs.push(await this.getUpdateLpPoolAumIxs(lpPool, spotMarketIndexes));
		return ixs;
	}

	public async getAllUpdateConstituentTargetBaseIxs(
		perpMarketIndexes: number[],
		lpPool: LPPoolAccount,
		constituentMap: ConstituentMap,
		includeUpdateConstituentOracleInfo = true
	): Promise<TransactionInstruction[]> {
		const ixs: TransactionInstruction[] = [];

		ixs.push(await this.getUpdateAmmCacheIx(perpMarketIndexes));

		const constituents: ConstituentAccount[] = Array.from(
			constituentMap.values()
		);

		if (includeUpdateConstituentOracleInfo) {
			for (const constituent of constituents) {
				ixs.push(await this.getUpdateConstituentOracleInfoIx(constituent));
			}
		}

		ixs.push(
			await this.getUpdateLpConstituentTargetBaseIx(
				lpPool.lpPoolId,
				Array.from(constituentMap.values()).map(
					(constituent) => constituent.pubkey
				)
			)
		);

		ixs.push(
			...(await this.getAllUpdateLpPoolAumIxs(lpPool, constituentMap, false))
		);

		return ixs;
	}

	async getAllLpPoolSwapIxs(
		lpPool: LPPoolAccount,
		constituentMap: ConstituentMap,
		inMarketIndex: number,
		outMarketIndex: number,
		inAmount: BN,
		minOutAmount: BN,
		userAuthority: PublicKey
	): Promise<TransactionInstruction[]> {
		const ixs: TransactionInstruction[] = [];
		ixs.push(...(await this.getAllUpdateLpPoolAumIxs(lpPool, constituentMap)));
		ixs.push(
			await this.getLpPoolSwapIx(
				inMarketIndex,
				outMarketIndex,
				inAmount,
				minOutAmount,
				lpPool.pubkey,
				userAuthority
			)
		);
		return ixs;
	}

	async settlePerpToLpPool(
		lpPoolId: number,
		perpMarketIndexes: number[]
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getSettlePerpToLpPoolIx(lpPoolId, perpMarketIndexes),
				undefined
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettlePerpToLpPoolIx(
		lpPoolId: number,
		perpMarketIndexes: number[]
	): Promise<TransactionInstruction> {
		const remainingAccounts = [];
		remainingAccounts.push(
			...perpMarketIndexes.map((index) => {
				return {
					pubkey: this.getPerpMarketAccountOrThrow(index).pubkey,
					isSigner: false,
					isWritable: true,
				};
			})
		);
		const quoteSpotMarketAccount = this.getQuoteSpotMarketAccount();
		const lpPool = getLpPoolPublicKey(this.program.programId, lpPoolId);
		return this.program.instruction.settlePerpToLpPool({
			accounts: {
				velocitySigner: this.getSignerPublicKey(),
				state: await this.getStatePublicKey(),
				keeper: this.wallet.publicKey,
				ammCache: getAmmCachePublicKey(this.program.programId),
				quoteMarket: quoteSpotMarketAccount.pubkey,
				constituent: getConstituentPublicKey(this.program.programId, lpPool, 0),
				constituentQuoteTokenAccount: getConstituentVaultPublicKey(
					this.program.programId,
					lpPool,
					0
				),
				lpPool,
				quoteTokenVault: quoteSpotMarketAccount.vault,
				tokenProgram: this.getTokenProgramForSpotMarket(quoteSpotMarketAccount),
			},
			remainingAccounts,
		});
	}

	public async getAllSettlePerpToLpPoolIxs(
		lpPoolId: number,
		marketIndexes: number[]
	): Promise<TransactionInstruction[]> {
		const ixs: TransactionInstruction[] = [];
		ixs.push(await this.getUpdateAmmCacheIx(marketIndexes));
		ixs.push(await this.getSettlePerpToLpPoolIx(lpPoolId, marketIndexes));
		return ixs;
	}

	/**
	 * Below here are the transaction sending functions
	 */

	private handleSignedTransaction(signedTxs: SignedTxData[]) {
		if (this.enableMetricsEvents && this.metricsEventEmitter) {
			this.metricsEventEmitter.emit('txSigned', signedTxs);
		}
	}

	private handlePreSignedTransaction() {
		if (this.enableMetricsEvents && this.metricsEventEmitter) {
			this.metricsEventEmitter.emit('preTxSigned');
		}
	}

	private isVersionedTransaction(
		tx: Transaction | VersionedTransaction
	): boolean {
		return isVersionedTransaction(tx);
	}

	/**
	 * Send a transaction.
	 *
	 * @param tx
	 * @param additionalSigners
	 * @param opts :: Will fallback to VelocityClient's opts if not provided
	 * @param preSigned
	 * @returns
	 */
	sendTransaction(
		tx: Transaction | VersionedTransaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot> {
		const isVersionedTx = this.isVersionedTransaction(tx);
		if (isVersionedTx) {
			return this.txSender.sendVersionedTransaction(
				tx as VersionedTransaction,
				additionalSigners,
				opts ?? this.opts,
				preSigned
			);
		} else {
			return this.txSender.send(
				tx as Transaction,
				additionalSigners,
				opts ?? this.opts,
				preSigned
			);
		}
	}

	async buildTransaction(
		instructions: TransactionInstruction | TransactionInstruction[],
		txParams?: TxParams,
		txVersion?: TransactionVersion,
		lookupTables?: AddressLookupTableAccount[],
		forceVersionedTransaction?: boolean,
		recentBlockhash?: BlockhashWithExpiryBlockHeight,
		optionalIxs?: TransactionInstruction[]
	): Promise<Transaction | VersionedTransaction> {
		return this.txHandler.buildTransaction({
			instructions,
			txVersion: txVersion ?? this.txVersion,
			txParams: txParams ?? this.txParams,
			connection: this.connection,
			preFlightCommitment: this.opts.preflightCommitment,
			fetchAllMarketLookupTableAccounts:
				this.fetchAllLookupTableAccounts.bind(this),
			lookupTables,
			forceVersionedTransaction,
			recentBlockhash,
			optionalIxs,
		});
	}

	async buildBulkTransactions(
		instructions: (TransactionInstruction | TransactionInstruction[])[],
		txParams?: TxParams,
		txVersion?: TransactionVersion,
		lookupTables?: AddressLookupTableAccount[],
		forceVersionedTransaction?: boolean
	): Promise<(Transaction | VersionedTransaction | undefined)[]> {
		return this.txHandler.buildBulkTransactions({
			instructions,
			txVersion: txVersion ?? this.txVersion,
			txParams: txParams ?? this.txParams,
			connection: this.connection,
			preFlightCommitment: this.opts.preflightCommitment,
			fetchAllMarketLookupTableAccounts:
				this.fetchAllLookupTableAccounts.bind(this),
			lookupTables,
			forceVersionedTransaction,
		});
	}

	async buildTransactionsMap(
		instructionsMap: Record<
			string,
			TransactionInstruction | TransactionInstruction[]
		>,
		txParams?: TxParams,
		txVersion?: TransactionVersion,
		lookupTables?: AddressLookupTableAccount[],
		forceVersionedTransaction?: boolean
	) {
		return this.txHandler.buildTransactionsMap({
			instructionsMap,
			txVersion: txVersion ?? this.txVersion,
			txParams: txParams ?? this.txParams,
			connection: this.connection,
			preFlightCommitment: this.opts.preflightCommitment,
			fetchAllMarketLookupTableAccounts:
				this.fetchAllLookupTableAccounts.bind(this),
			lookupTables,
			forceVersionedTransaction,
		});
	}

	async buildAndSignTransactionsMap(
		instructionsMap: Record<
			string,
			TransactionInstruction | TransactionInstruction[]
		>,
		txParams?: TxParams,
		txVersion?: TransactionVersion,
		lookupTables?: AddressLookupTableAccount[],
		forceVersionedTransaction?: boolean
	) {
		return this.txHandler.buildAndSignTransactionMap({
			instructionsMap,
			txVersion: txVersion ?? this.txVersion,
			txParams: txParams ?? this.txParams,
			connection: this.connection,
			preFlightCommitment: this.opts.preflightCommitment,
			fetchAllMarketLookupTableAccounts:
				this.fetchAllLookupTableAccounts.bind(this),
			lookupTables,
			forceVersionedTransaction,
		});
	}

	isOrderIncreasingPosition(
		orderParams: OptionalOrderParams,
		subAccountId?: number
	): boolean {
		const userAccount = this.getUserAccountOrThrow(subAccountId);
		const perpPosition = userAccount.perpPositions.find(
			(p) => p.marketIndex === orderParams.marketIndex
		);
		if (!perpPosition) return true;

		const currentBase = perpPosition.baseAssetAmount;
		if (currentBase.eq(ZERO)) return true;

		const orderBaseAmount = isVariant(orderParams.direction, 'long')
			? orderParams.baseAssetAmount
			: orderParams.baseAssetAmount.neg();

		return currentBase.add(orderBaseAmount).abs().gt(currentBase.abs());
	}
}
