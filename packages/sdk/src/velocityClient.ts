/**
 * VelocityClient — main SDK entry point for all trading and keeper operations.
 *
 * Responsibilities:
 *   - Builds and sends all on-chain instructions (place/cancel/fill orders, deposits, withdrawals,
 *     settle PnL, update funding rate, liquidations).
 *   - Manages the program account subscription lifecycle (markets, oracles, user accounts).
 *   - Provides oracle price reads, market config lookups, and PDA derivation helpers.
 *
 * Admin operations (market init, fee updates, oracle config) live in `AdminClient` (adminClient.ts).
 * Read-only user account queries (margin, positions, PnL) live in `User` (user.ts).
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
	OracleValidity,
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
	ReferrerStatus,
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
import { isOracleValid, getOracleValidity } from './math/oracles';
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
 * Main entry point for interacting with Velocity Exchange from TypeScript. A single instance wraps
 * one `authority` wallet (optionally trading on behalf of multiple sub-accounts via
 * `authoritySubAccountMap`, or as a delegate via `includeDelegates`) and owns:
 *   - the Anchor `program` handle and RPC `connection`/`provider`,
 *   - the account subscription (`accountSubscriber`) that streams State, PerpMarket, SpotMarket,
 *     and oracle accounts (websocket, polling, or grpc — selected via `VelocityClientConfig.accountSubscription`),
 *   - the set of loaded `User` / `UserStats` objects for this authority's sub-accounts,
 *   - the `txSender` / `txHandler` used to build, sign, and send every instruction the class exposes.
 *
 * Most instruction-building methods come in pairs: `doThing(...)` builds the instruction(s), wraps
 * them in a transaction, signs, sends, and confirms; `getDoThingIx(...)` (or `getDoThingIxs(...)`)
 * only builds and returns the raw `TransactionInstruction`(s) for callers composing their own
 * transaction (e.g. bundling several instructions, or using a custom `txParams`/lookup-table setup).
 *
 * Almost every account-touching method requires `subscribe()` to have resolved and the target
 * sub-account's `User` to be loaded first — see `subscribe`, `addUser`, `switchActiveUser`.
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

	/**
	 * Whether this client has completed `subscribe()` and its underlying `accountSubscriber` is
	 * still actively streaming account updates. Most account-reading and instruction-building
	 * methods assume this is `true`; call `subscribe()` first if it is `false`.
	 */
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

	/**
	 * Overrides the internal subscribed flag directly, without touching `accountSubscriber`. Intended
	 * for advanced/test callers managing subscription state manually; regular callers should use
	 * `subscribe()` / `unsubscribe()` instead.
	 * @param val - New value for the internal subscribed flag.
	 */
	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	/**
	 * Constructs a `VelocityClient` from a `VelocityClientConfig`. Does not perform any network I/O —
	 * it wires up the Anchor `program`/`provider`, resolves the account-subscription strategy
	 * (websocket/polling/grpc), and constructs the `txSender`/`txHandler` used by every instruction
	 * method, but does not fetch or subscribe to any accounts. Call `subscribe()` afterwards before
	 * using the client.
	 *
	 * Config interplay of note:
	 *   - `authority` defaults to `config.wallet.publicKey`; `activeSubAccountId` defaults to `0`.
	 *   - Exactly one of `includeDelegates`, `subAccountIds`, or `authoritySubAccountMap` may be set —
	 *     passing more than one throws. `subAccountIds` is shorthand for
	 *     `authoritySubAccountMap = { [authority]: subAccountIds }`.
	 *   - `txVersion` defaults based on whether `config.wallet` supports versioned transactions.
	 *   - `txParams.computeUnits` defaults to `600_000` and `computeUnitsPrice` to `0` (no priority fee)
	 *     when not provided.
	 *   - `config.accountSubscription.type` selects `PollingVelocityClientAccountSubscriber`,
	 *     a grpc subscriber, or (default) `WebSocketVelocityClientAccountSubscriber`.
	 *   - `config.userStats` (default falsy) additionally constructs a `UserStats` instance for the
	 *     authority.
	 *   - `config.marketLookupTables` defaults to the lookup tables from `configs[env]` for the
	 *     resolved `env` (default `'mainnet-beta'`).
	 * @param config - Client configuration; see `VelocityClientConfig` (velocityClientConfig.ts).
	 * @throws if more than one of `includeDelegates`/`subAccountIds`/`authoritySubAccountMap` is set.
	 */
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

	/**
	 * Builds the internal `Map` key used to index `this.users` for a given sub-account/authority pair.
	 * @param subAccountId - Sub-account id.
	 * @param authority - Owning (or delegated) authority public key for the sub-account.
	 * @returns A string key of the form `"<subAccountId>_<authority>"`.
	 */
	public getUserMapKey(subAccountId: number, authority: PublicKey): string {
		return `${subAccountId}_${authority.toString()}`;
	}

	/**
	 * Constructs (but does not subscribe) a `User` for the given sub-account/authority.
	 * @param subAccountId - Sub-account id to derive the user account PDA for.
	 * @param accountSubscriptionConfig - Subscription strategy to use for the new `User`.
	 * @param authority - Authority owning the sub-account; defaults to `this.authority`.
	 * @returns An unsubscribed `User` instance.
	 */
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

	/**
	 * Subscribes the client to on-chain state: loads and subscribes to the sub-account(s) implied by
	 * the constructor/`updateWallet` config (`addAndSubscribeToUsers`), subscribes the `accountSubscriber`
	 * (State, PerpMarket, SpotMarket, oracle accounts), and, if `userStats` was configured, subscribes
	 * it too. Must be called (and resolve `true`) before using most other methods on this class.
	 * @returns `true` if every subscription succeeded; `false` if any failed. Also updates `isSubscribed`.
	 */
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

	/**
	 * Subscribes every currently-loaded `User` in `this.users`. Does not add new users or subscribe
	 * `accountSubscriber`/`userStats` — see `subscribe()` for full client subscription.
	 * @returns One subscribe promise per loaded user, resolving to that user's subscribe success.
	 */
	subscribeUsers(): Promise<boolean>[] {
		return [...this.users.values()].map((user) => user.subscribe());
	}

	/**
	 * Forces every loaded `User`, the `accountSubscriber`, and (if present) `userStats` to fetch fresh
	 * account data from RPC immediately, bypassing the normal websocket/polling cadence. Useful in
	 * tests (e.g. local validator) where a just-landed transaction's effects need to be visible
	 * without waiting for the next update.
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

	/**
	 * Unsubscribes all loaded users, the `accountSubscriber`, and (if present) `userStats`, and sets
	 * `isSubscribed` to `false`. Does not clear `this.users` — the `User` objects remain but stop
	 * receiving updates until re-subscribed.
	 */
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

	/**
	 * Unsubscribes every currently-loaded `User` in `this.users` without clearing the map or touching
	 * `accountSubscriber`/`userStats`.
	 * @returns One unsubscribe promise per loaded user.
	 */
	unsubscribeUsers(): Promise<void>[] {
		return [...this.users.values()].map((user) => user.unsubscribe());
	}

	statePublicKey?: PublicKey;
	/**
	 * Returns the `State` account PDA for this program, computing and caching it on first call.
	 * @returns The `State` account public key.
	 */
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
	/**
	 * Returns the program's PDA signer (used as the authority for vault CPIs), computing and caching
	 * it on first call. Synchronous — the signer PDA has no seeds that require an on-chain lookup.
	 * @returns The velocity signer public key.
	 */
	public getSignerPublicKey(): PublicKey {
		if (this.signerPublicKey) {
			return this.signerPublicKey;
		}
		this.signerPublicKey = getVelocitySignerPublicKey(this.program.programId);
		return this.signerPublicKey;
	}

	/**
	 * Returns the last account-subscriber-cached `State` account. Does not hit RPC.
	 * @returns The current `StateAccount` snapshot.
	 * @throws if `subscribe()` has not been called (or the state account has never loaded).
	 */
	public getStateAccount(): StateAccount {
		return this.accountSubscriber.getStateAccountAndSlot().data;
	}

	/**
	 * Like `getStateAccount` but forces a fresh RPC fetch first. Useful for anchor tests where an
	 * update needs to be observed immediately rather than waiting for the next subscription push.
	 * @returns The freshly-fetched `StateAccount`.
	 */
	public async forceGetStateAccount(): Promise<StateAccount> {
		await this.accountSubscriber.fetch();
		return this.accountSubscriber.getStateAccountAndSlot().data;
	}

	/**
	 * Returns the last account-subscriber-cached `PerpMarketAccount` for a market index. Does not hit
	 * RPC. The market must be one of the indexes/lookup-tables this client subscribed to.
	 * @param marketIndex - Perp market index.
	 * @returns The cached `PerpMarketAccount`, or `undefined` if not loaded/subscribed.
	 */
	public getPerpMarketAccount(
		marketIndex: number
	): PerpMarketAccount | undefined {
		return this.accountSubscriber.getMarketAccountAndSlot(marketIndex)?.data;
	}

	/**
	 * Like `getPerpMarketAccount` but throws if the market is not loaded,
	 * for call sites that require a guaranteed account.
	 * @param marketIndex - Perp market index.
	 * @returns The cached `PerpMarketAccount`.
	 * @throws if the market is not loaded.
	 */
	public getPerpMarketAccountOrThrow(marketIndex: number): PerpMarketAccount {
		const perpMarketAccount = this.getPerpMarketAccount(marketIndex);
		if (!perpMarketAccount) {
			throw new Error(`Perp market ${marketIndex} not found`);
		}
		return perpMarketAccount;
	}

	/**
	 * Like `getPerpMarketAccount` but forces a fresh RPC fetch, retrying up to 10 times (one fetch per
	 * attempt) until the market account appears. Useful in anchor tests right after
	 * `initializePerpMarket` where the market may not yet be visible to the subscriber.
	 * @param marketIndex - Perp market index.
	 * @returns The `PerpMarketAccount`, or `undefined` if still not found after 10 attempts.
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

	/**
	 * Returns all currently-loaded `PerpMarketAccount`s (does not hit RPC).
	 * @returns Array of loaded perp market accounts, in subscriber order.
	 */
	public getPerpMarketAccounts(): PerpMarketAccount[] {
		return this.accountSubscriber
			.getMarketAccountsAndSlots()
			.filter((value) => value !== undefined)
			.map((value) => value.data);
	}

	/**
	 * Returns the last account-subscriber-cached `SpotMarketAccount` for a market index. Does not hit
	 * RPC.
	 * @param marketIndex - Spot market index.
	 * @returns The cached `SpotMarketAccount`, or `undefined` if not loaded/subscribed.
	 */
	public getSpotMarketAccount(
		marketIndex: number
	): SpotMarketAccount | undefined {
		return this.accountSubscriber.getSpotMarketAccountAndSlot(marketIndex)
			?.data;
	}

	/**
	 * Like `getSpotMarketAccount` but throws if the market is not loaded,
	 * for call sites that require a guaranteed account.
	 * @param marketIndex - Spot market index.
	 * @returns The cached `SpotMarketAccount`.
	 * @throws if the market is not loaded.
	 */
	public getSpotMarketAccountOrThrow(marketIndex: number): SpotMarketAccount {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		if (!spotMarketAccount) {
			throw new Error(`Spot market ${marketIndex} not found`);
		}
		return spotMarketAccount;
	}

	/**
	 * Like `getSpotMarketAccount` but forces a fresh RPC fetch first. Useful for anchor tests where an
	 * update needs to be observed immediately.
	 * @param marketIndex - Spot market index.
	 * @returns The freshly-fetched `SpotMarketAccount`, or `undefined` if not found.
	 */
	public async forceGetSpotMarketAccount(
		marketIndex: number
	): Promise<SpotMarketAccount | undefined> {
		await this.accountSubscriber.fetch();
		return this.accountSubscriber.getSpotMarketAccountAndSlot(marketIndex)
			?.data;
	}

	/**
	 * Returns all currently-loaded `SpotMarketAccount`s (does not hit RPC).
	 * @returns Array of loaded spot market accounts, in subscriber order.
	 */
	public getSpotMarketAccounts(): SpotMarketAccount[] {
		return this.accountSubscriber
			.getSpotMarketAccountsAndSlots()
			.filter((value) => value !== undefined)
			.map((value) => value.data);
	}

	/**
	 * Convenience accessor for the quote spot market (`QUOTE_SPOT_MARKET_INDEX`, always index 0), i.e.
	 * the USDC market used to denominate collateral/PnL across the protocol.
	 * @returns The quote `SpotMarketAccount`.
	 * @throws if the quote spot market is not loaded.
	 */
	public getQuoteSpotMarketAccount(): SpotMarketAccount {
		return this.getSpotMarketAccountOrThrow(QUOTE_SPOT_MARKET_INDEX);
	}

	/**
	 * Returns the last subscriber-cached oracle price data for a given oracle account/source. Does not
	 * hit RPC.
	 * @param oraclePublicKey - Oracle account public key.
	 * @param oracleSource - Oracle protocol/feed variant (Pyth, Pyth Lazer, Switchboard, etc.) that
	 * determines how the account is decoded.
	 * @returns The cached oracle price data and the slot it was observed at, or `undefined` if this
	 * oracle isn't subscribed.
	 */
	public getOraclePriceDataAndSlot(
		oraclePublicKey: PublicKey,
		oracleSource: OracleSource
	): DataAndSlot<OraclePriceData> | undefined {
		return this.accountSubscriber.getOraclePriceDataAndSlot(
			getOracleId(oraclePublicKey, oracleSource)
		);
	}

	/**
	 * Fetches and caches the `AddressLookupTableAccount`s for `this.marketLookupTables`, so
	 * transaction builders can include them to shrink versioned-transaction size. Subsequent calls
	 * return the cached result.
	 * @returns The resolved lookup table accounts (entries that don't exist on-chain are filtered out).
	 */
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
	 * Swaps the wallet/authority this client transacts and subscribes as, rebuilding the Anchor
	 * `provider`/`program`, `txSender`, `txHandler`, `userStats`, and (if already subscribed) every
	 * loaded `User` for the new authority. Use this instead of constructing a new `VelocityClient` when
	 * a UI wallet-adapter connection changes.
	 *
	 * At most one of `includeDelegates`, `subAccountIds`, or `authoritySubaccountMap` may be passed
	 * (mirrors the constructor's mutual-exclusion rule); `subAccountIds` is shorthand for
	 * `authoritySubaccountMap = { [newWallet.publicKey]: subAccountIds }`.
	 * @param newWallet - Wallet to switch to; becomes the new `authority`.
	 * @param subAccountIds - Sub-account ids to load for `newWallet`'s authority. Mutually exclusive
	 * with `includeDelegates` and `authoritySubaccountMap`.
	 * @param activeSubAccountId - Sub-account id to make active after the switch.
	 * @param includeDelegates - If `true`, load every sub-account this wallet is a delegate for, in
	 * addition to sub-accounts it owns directly. Mutually exclusive with `subAccountIds` and
	 * `authoritySubaccountMap`.
	 * @param authoritySubaccountMap - Explicit map of authority (as string) to sub-account ids to load,
	 * for managing multiple authorities from one wallet. Mutually exclusive with `subAccountIds` and
	 * `includeDelegates`.
	 * @returns `true` if re-subscribing users (when previously subscribed) succeeded; otherwise `false`.
	 * @throws if more than one of `includeDelegates`/`subAccountIds`/`authoritySubaccountMap` is set.
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
	 *
	 * `authority` is repointed to `emulateAuthority` and `includeDelegates` is forced to `true`, but the
	 * connected `wallet` (and thus its signing key) is unchanged — instructions that require the
	 * emulated authority's own signature (e.g. deposits from its wallet) will still fail; only actions
	 * the connected wallet is independently authorized for (e.g. as a delegate, or read-only views)
	 * will succeed.
	 * @param emulateAuthority - Authority public key to view/act as.
	 * @returns `true` if re-subscribing users (when previously subscribed) succeeded; otherwise `false`.
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

	/**
	 * Sets the client's `activeSubAccountId`/`authority` (the sub-account used by default when a
	 * method's `subAccountId` param is omitted). If `authority` changes, re-derives and re-subscribes
	 * `userStats` for the new authority (assumed unnecessary when only the sub-account id changes for
	 * the same authority). Does not load or subscribe the target `User` itself — call `addUser` first
	 * if it isn't already loaded.
	 * @param subAccountId - Sub-account id to make active.
	 * @param authority - Authority to switch to; defaults to the current `this.authority` (no change).
	 */
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

	/**
	 * Loads and subscribes a `User` for a sub-account, adding it to `this.users`. If a subscribed
	 * `User` for this sub-account/authority is already loaded, returns `true` immediately without
	 * re-subscribing.
	 * @param subAccountId - Sub-account id to load.
	 * @param authority - Authority owning the sub-account; defaults to `this.authority`.
	 * @param userAccount - Optional pre-fetched `UserAccount` data to seed the subscription with,
	 * avoiding an extra RPC round-trip (e.g. when the caller already has it from a prior fetch).
	 * @returns `true` if the user was already loaded or subscribed successfully; `false` if
	 * subscription failed (e.g. the on-chain user account doesn't exist).
	 */
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
	 *
	 * If `authoritySubAccountMap` is non-empty, loads exactly the (authority, subAccountId) pairs it
	 * lists. Otherwise fetches every on-chain `UserAccount` owned by `authority` (defaulting to
	 * `this.wallet.publicKey`), plus (when `includeDelegates` is `true`) every account this authority
	 * is a delegate for, and loads all of them. If `activeSubAccountId` is not already set, the first
	 * loaded account becomes active. A no-op returning `true` if `skipLoadUsers` is set (e.g. no real
	 * wallet configured).
	 * @param authority - Authority to load accounts for; defaults to `this.wallet.publicKey`. Ignored
	 * when `authoritySubAccountMap` is set (its keys are used instead).
	 * @returns `true` if every implied user loaded/subscribed successfully.
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
	 * Builds the instructions to initialize a user (sub-account) for `this.authority`, without sending
	 * a transaction. For `subAccountId === 0`, also prepends `initializeUserStats` if the authority's
	 * `UserStats` account doesn't already exist on-chain (every authority needs exactly one, created
	 * alongside its first sub-account).
	 * @param subAccountId - Sub-account id to create; defaults to `0`. Must not already exist.
	 * @param name - Display name (max 32 bytes, UTF-8), stored on-chain. Defaults to `DEFAULT_USER_NAME`
	 * for sub-account 0, or `"Subaccount {subAccountId + 1}"` otherwise.
	 * @param referrerInfo - Referrer's `referrer`/`referrerStats` public keys to attribute this account
	 * to a referrer at creation time (fee-share eligibility); omit if there is no referrer.
	 * @param poolId - If provided, appends an instruction to set the sub-account's isolated pool id
	 * after creation.
	 * @returns A tuple of `[instructions, userAccountPublicKey]` — the caller is responsible for
	 * building/sending the transaction.
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
	 * Initializes a new user (sub-account) for `this.authority` on-chain, then loads and subscribes it
	 * into `this.users` via `addUser`. See `getInitializeUserAccountIxs` for parameter semantics and
	 * the implicit `UserStats` creation for `subAccountId === 0`.
	 * @param subAccountId - Sub-account id to create; defaults to `0`.
	 * @param name - Display name (max 32 bytes); see `getInitializeUserAccountIxs` for the default.
	 * @param referrerInfo - Referrer's `referrer`/`referrerStats` public keys, if attributing this
	 * account to a referrer.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns A tuple of `[transactionSignature, userAccountPublicKey]`.
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

	/**
	 * Builds the `initializeUserStats` instruction for `this.authority`. Every authority needs exactly
	 * one `UserStats` account (created automatically by `getInitializeUserAccountIxs`/
	 * `initializeUserAccount` alongside sub-account 0 if missing); call this directly only when
	 * building a custom initialization flow.
	 * @param overrides.externalWallet - Pays for account creation instead of `this.wallet`, if set.
	 * @returns The `initializeUserStats` instruction.
	 */
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

	/**
	 * Initializes the `SignedMsgUserOrders` account for `authority`, which caches recently-submitted
	 * off-chain signed (SignedMsg / "swift") order messages so keepers can look them up and verify
	 * duplicates on-chain. Required once per authority before that authority's signed-message orders
	 * can be placed.
	 * @param authority - Authority the account is created for.
	 * @param numOrders - Number of order-message slots to allocate; determines account rent/size.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns A tuple of `[transactionSignature, signedMsgUserAccountPublicKey]`.
	 */
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

	/**
	 * Builds the `initializeSignedMsgUserOrders` instruction. See `initializeSignedMsgUserOrders` for
	 * semantics.
	 * @param authority - Authority the account is created for.
	 * @param numOrders - Number of order-message slots to allocate.
	 * @param overrides.externalWallet - Pays for account creation instead of `this.wallet`, if set.
	 * @returns A tuple of `[signedMsgUserAccountPublicKey, instruction]`.
	 */
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

	/**
	 * Grows an existing `SignedMsgUserOrders` account to hold more order-message slots. The program
	 * only allows growing, never shrinking.
	 * @param authority - Authority whose account is resized.
	 * @param numOrders - New (larger) number of order-message slots.
	 * @param userSubaccountId - Sub-account id used to derive the `user` account passed to the
	 * instruction; defaults to `0`.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `resizeSignedMsgUserOrders` instruction. See `resizeSignedMsgUserOrders` for
	 * semantics.
	 * @param authority - Authority whose account is resized.
	 * @param numOrders - New (larger) number of order-message slots.
	 * @param userSubaccountId - Sub-account id used to derive the `user` account; defaults to `0`.
	 * @returns The resize instruction.
	 */
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

	/**
	 * Initializes `authority`'s `SignedMsgWsDelegates` account, which lists wallets authorized to
	 * co-sign/relay that authority's signed-message ("swift") orders over a websocket connection
	 * without holding general trading authority.
	 * @param authority - Authority the delegates account is created for.
	 * @param delegates - Initial set of delegate public keys; defaults to an empty list.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `initializeSignedMsgWsDelegates` instruction. See
	 * `initializeSignedMsgWsDelegatesAccount` for semantics.
	 * @param authority - Authority the delegates account is created for.
	 * @param delegates - Initial set of delegate public keys; defaults to an empty list.
	 * @returns The initialize instruction.
	 */
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

	/**
	 * Initializes the per-authority `RevenueShare` account, which accumulates that authority's
	 * lifetime referrer and builder fee-share rewards. One per authority (not per sub-account); an
	 * authority must have this before it can earn referrer or builder revenue share.
	 * @param authority - Authority the account is created for.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 */
	public async initializeRevenueShare(
		authority: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ix = await this.getInitializeRevenueShareIx(authority);
		const tx = await this.buildTransaction([ix], txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	/**
	 * Builds the `initializeRevenueShare` instruction. See `initializeRevenueShare` for semantics.
	 * @param authority - Authority the account is created for.
	 * @param overrides.payer - Pays for account creation instead of `this.wallet`, if set.
	 * @returns The initialize instruction.
	 */
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

	/**
	 * Initializes `authority`'s `RevenueShareEscrow` account — the per-user account that tracks
	 * pending builder-fee orders and the list of builders this user has approved (`approvedBuilders`),
	 * required to place orders carrying a builder fee. On creation, `escrow.referrer` is copied from
	 * the authority's existing `UserStats.referrer`, if any.
	 * @param authority - Authority the escrow is created for.
	 * @param numOrders - Number of pending-order slots to allocate; determines account rent/size. Can
	 * be grown later with `resizeRevenueShareEscrowOrders` (never shrunk).
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `initializeRevenueShareEscrow` instruction. See `initializeRevenueShareEscrow` for
	 * semantics.
	 * @param authority - Authority the escrow is created for.
	 * @param numOrders - Number of pending-order slots to allocate.
	 * @param overrides.payer - Pays for account creation instead of `this.wallet`, if set.
	 * @returns The initialize instruction.
	 */
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

	/**
	 * Grows `authority`'s `RevenueShareEscrow` order slots. On-chain rejects `numOrders` smaller than
	 * the current slot count (shrinking is not supported).
	 * @param authority - Authority whose escrow is resized.
	 * @param numOrders - New (larger or equal) number of pending-order slots.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 * @throws (on-chain `InvalidRevenueShareResize`) if `numOrders` is less than the current slot count.
	 */
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

	/**
	 * Builds the `resizeRevenueShareEscrowOrders` instruction. See `resizeRevenueShareEscrowOrders` for
	 * semantics.
	 * @param authority - Authority whose escrow is resized.
	 * @param numOrders - New (larger or equal) number of pending-order slots.
	 * @returns The resize instruction.
	 */
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
	 * Adds, updates, or revokes an approved builder in the caller's own `RevenueShareEscrow`
	 * (`this.wallet.publicKey` unless `overrides.authority` is set on the underlying ix). This is the
	 * *user's* opt-in that lets `builder` attach a builder fee (capped at `maxFeeTenthBps`) to orders
	 * this user places — it does not itself submit any order. `maxFeeTenthBps` is in tenths of a basis
	 * point (1 unit = 0.001%, i.e. `10_000` tenth-bps = 1%).
	 * @param builder - The public key of the builder to add or update. Must differ from the escrow's
	 * own authority.
	 * @param maxFeeTenthBps - The maximum fee, in tenths of a basis point, the builder may charge.
	 * @param add - Whether to add or update the builder. If the builder already exists, `add = true` will update the `maxFeeTenthBps`, otherwise it will add the builder. If `add = false`, the builder's `maxFeeTenthBps` will be set to 0.
	 * @param txParams - The transaction parameters to use for the transaction.
	 * @returns The transaction to add or update an approved builder.
	 * @throws (on-chain `CannotRevokeBuilderWithOpenOrders`) if `add` is `false` and the builder has
	 * open (unsettled) orders outstanding — those must be cancelled/settled first.
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
	 * Builds the `changeApprovedBuilder` instruction. See `changeApprovedBuilder` for semantics; unlike
	 * the wrapper, `overrides.authority` lets you target an escrow other than the connected wallet's.
	 * @param builder - The public key of the builder to add or update.
	 * @param maxFeeTenthBps - The maximum fee, in tenths of a basis point (1 unit = 0.001%).
	 * @param add - Whether to add or update the builder. If the builder already exists, `add = true` will update the `maxFeeTenthBps`, otherwise it will add the builder. If `add = false`, the builder's `maxFeeTenthBps` will be set to 0.
	 * @param overrides.authority - Escrow authority to target; defaults to `this.wallet.publicKey`.
	 * @param overrides.payer - Pays for any account resize instead of `this.wallet`, if set.
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

	/**
	 * Authorizes `delegate` on `authority`'s existing `SignedMsgWsDelegates` account (must already be
	 * initialized via `initializeSignedMsgWsDelegatesAccount`). Signed by `this.wallet.publicKey`,
	 * which must be `authority`.
	 * @param authority - Authority whose delegates list is updated.
	 * @param delegate - Delegate public key to authorize.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `changeSignedMsgWsDelegateStatus` instruction with `add = true`. See
	 * `addSignedMsgWsDelegate` for semantics.
	 * @param authority - Authority whose delegates list is updated.
	 * @param delegate - Delegate public key to authorize.
	 * @returns The instruction.
	 */
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

	/**
	 * Revokes `delegate`'s authorization on `authority`'s `SignedMsgWsDelegates` account. Signed by
	 * `this.wallet.publicKey`, which must be `authority`.
	 * @param authority - Authority whose delegates list is updated.
	 * @param delegate - Delegate public key to revoke.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `changeSignedMsgWsDelegateStatus` instruction with `add = false`. See
	 * `removeSignedMsgWsDelegate` for semantics.
	 * @param authority - Authority whose delegates list is updated.
	 * @param delegate - Delegate public key to revoke.
	 * @returns The instruction.
	 */
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

	/**
	 * Returns the sub-account id that would be assigned to the next sub-account created for
	 * `this.wallet.publicKey` (i.e. `UserStats.numberOfSubAccountsCreated`, which increments on every
	 * `initializeUser` and never reuses ids after `deleteUser`). Prefers the already-loaded `userStats`
	 * subscription; falls back to an RPC fetch if it isn't loaded or has no cached account yet.
	 * @returns The next sub-account id to be created.
	 * @throws if no `UserStats` account exists on-chain for `this.wallet.publicKey` (i.e. sub-account 0
	 * has never been initialized).
	 */
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

	/**
	 * Registers `this.wallet`'s sub-account 0 as a referrer under a human-readable `name`, creating a
	 * `ReferrerNameAccount` PDA keyed by that name. Other users can then look up this authority's
	 * `referrer`/`referrerStats` public keys by name (see `getReferrerNameAccountsForAuthority`) when
	 * passing `referrerInfo` to `initializeUserAccount`. Fails if the name is already taken (PDA
	 * already initialized).
	 * @param name - Referrer name to register (encoded/truncated the same way as user names).
	 * @returns The transaction signature.
	 */
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

	/**
	 * Updates the display name stored on a sub-account. Signed by `this.wallet.publicKey`, which must
	 * be the sub-account's authority.
	 * @param name - New display name (max 32 bytes, UTF-8).
	 * @param subAccountId - Sub-account id to rename; defaults to `0`.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Sets a per-sub-account custom (higher) minimum margin ratio for one or more sub-accounts in a
	 * single transaction, self-imposing a lower max leverage than the market default. Signed by
	 * `this.wallet.publicKey` for each sub-account's authority.
	 * @param updates - List of `{ marginRatio, subAccountId }` updates to apply.
	 * `marginRatio` is in `MARGIN_PRECISION` (1e4 = 100%), e.g. `2000` = 20% margin ratio = 5x max
	 * leverage.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 */
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
	/**
	 * Builds the `updateUserCustomMarginRatio` instruction for a single sub-account. As a side effect,
	 * ensures the target sub-account is loaded via `addUser` before building the instruction. See
	 * `updateUserCustomMarginRatio` for unit/semantics.
	 * @param marginRatio - Minimum margin ratio, in `MARGIN_PRECISION` (1e4 = 100%).
	 * @param subAccountId - Sub-account id to update; defaults to `0`.
	 * @returns The instruction.
	 */
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

	/**
	 * Builds the instruction to set a custom minimum margin ratio for a single open perp position
	 * (rather than the whole sub-account), letting a position use different effective max leverage than
	 * the sub-account default. Used internally by `getPrePlaceOrderIxs` to implement per-order
	 * `positionMaxLev`.
	 * @param perpMarketIndex - Perp market index of the position to constrain.
	 * @param marginRatio - Minimum margin ratio for this position, in `MARGIN_PRECISION` (1e4 = 100%).
	 * @param subAccountId - Sub-account id owning the position; defaults to `0`.
	 * @param overrides.userAccountPublicKey - Explicit user account PDA, skipping derivation.
	 * @param overrides.authority - Authority to derive the user account PDA for if
	 * `userAccountPublicKey` isn't given; defaults to `this.authority`.
	 * @param overrides.signingAuthority - Signer passed to the instruction; defaults to
	 * `this.wallet.publicKey`.
	 * @returns The instruction.
	 */
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

	/**
	 * Sends the instruction built by `getUpdateUserPerpPositionCustomMarginRatioIx`. See that method
	 * for semantics/units.
	 * @param perpMarketIndex - Perp market index of the position to constrain.
	 * @param marginRatio - Minimum margin ratio for this position, in `MARGIN_PRECISION` (1e4 = 100%).
	 * @param subAccountId - Sub-account id owning the position; defaults to `0`.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the instruction to toggle a sub-account's "margin trading enabled" flag, which permits
	 * borrowing against spot collateral (multiple simultaneous spot borrows / cross-margined spot). It
	 * is incompatible with holding a position in an `Isolated`-tier perp market — enabling it while
	 * such a position is open, or opening one while it's enabled, is rejected on-chain. As a side
	 * effect, ensures the target sub-account is loaded via `addUser`.
	 * @param marginTradingEnabled - New value for the flag.
	 * @param subAccountId - Sub-account id to update; defaults to `0`.
	 * @param userAccountPublicKey - Explicit user account PDA, skipping derivation from
	 * `this.wallet.publicKey`/`subAccountId`.
	 * @returns The instruction.
	 */
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

	/**
	 * Sends instructions built by `getUpdateUserMarginTradingEnabledIx` for one or more sub-accounts in
	 * a single transaction. See that method for semantics.
	 * @param updates - List of `{ marginTradingEnabled, subAccountId }` updates to apply.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the instruction to set (or clear, with `PublicKey.default`) the delegate authority on a
	 * sub-account. The delegate can sign most trading instructions (place/cancel orders, etc.) on the
	 * sub-account's behalf, but `withdraw` always requires the true owning `authority`'s own signature
	 * (delegates can never withdraw). A delegate-initiated internal transfer of the sub-account's
	 * collateral to another of the owner's sub-accounts is possible only via `transferDepositByDelegate`,
	 * and only once the owner has separately opted in via `updateUserAllowDelegateTransfer`.
	 * @param delegate - New delegate public key; pass `PublicKey.default` to remove the delegate.
	 * @param overrides.subAccountId - Sub-account id to update; defaults to `this.activeSubAccountId`.
	 * @param overrides.userAccountPublicKey - Explicit user account PDA, skipping derivation.
	 * @param overrides.authority - Signer for the instruction; defaults to `this.wallet.publicKey`.
	 * @returns The instruction.
	 */
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

	/**
	 * Sends the `updateUserDelegate` instruction for `this.wallet.publicKey`'s sub-account. See
	 * `getUpdateUserDelegateIx` for full semantics.
	 * @param delegate - New delegate public key; pass `PublicKey.default` to remove the delegate.
	 * @param subAccountId - Sub-account id to update; defaults to `0`.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the instruction to set the `allowDelegateTransfer` opt-in flag on `this.wallet.publicKey`'s
	 * `UserStats` account. This flag gates `transferDepositByDelegate` across *all* of this authority's
	 * sub-accounts — if it is `false` (the default), any delegate-initiated internal transfer attempt
	 * is rejected on-chain regardless of that sub-account's delegate. It does not affect direct
	 * deposits/withdrawals, which are unaffected by delegate status.
	 * @param allowDelegateTransfer - New value for the flag.
	 * @returns The instruction.
	 */
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

	/**
	 * Sends the instruction built by `getUpdateUserAllowDelegateTransferIx`. See that method for
	 * semantics.
	 * @param allowDelegateTransfer - New value for the flag.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Sends instructions built by `getUpdateAdvancedDlpIx` for one or more sub-accounts.
	 *
	 * **Currently non-functional**: the on-chain `update_user_advanced_lp` instruction handler is
	 * commented out of the program's Anchor `#[program]` module (see `programs/velocity/src/lib.rs`)
	 * and is absent from the generated IDL, so `program.instruction.updateUserAdvancedLp` does not
	 * exist and this call will throw at runtime until the instruction is re-enabled on-chain.
	 * @param updates - List of `{ advancedLp, subAccountId }` updates to apply.
	 * @returns The transaction signature.
	 * @throws always, until `update_user_advanced_lp` is re-enabled on-chain and regenerated into the IDL.
	 */
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

	/**
	 * Builds the (currently unavailable — see `updateUserAdvancedLp`) `updateUserAdvancedLp`
	 * instruction, which would flag a sub-account as an "advanced LP" participant.
	 * @param advancedLp - New value for the flag.
	 * @param subAccountId - Sub-account id to update.
	 * @returns The instruction, if the on-chain ix existed.
	 * @throws always, since `program.instruction.updateUserAdvancedLp` is not defined in the current IDL.
	 */
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

	/**
	 * Sends instructions built by `getUpdateUserReduceOnlyIx` for one or more sub-accounts in a single
	 * transaction. See that method for semantics.
	 * @param updates - List of `{ reduceOnly, subAccountId }` updates to apply.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the instruction to toggle a sub-account's reduce-only status. When reduce-only, orders on
	 * the sub-account may only decrease existing positions, never open or increase one.
	 * @param reduceOnly - New value for the flag.
	 * @param subAccountId - Sub-account id to update.
	 * @returns The instruction.
	 * @throws (on-chain `LiquidationsOngoing`) if the sub-account is currently being liquidated.
	 */
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

	/**
	 * Sends instructions built by `getUpdateUserPoolIdIx` for one or more sub-accounts in a single
	 * transaction. See that method for semantics.
	 * @param updates - List of `{ poolId, subAccountId }` updates to apply.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the instruction to move a sub-account into a different isolated pool. On-chain,
	 * re-validates the sub-account still meets its initial margin requirement after the switch using
	 * only markets/oracles passed via `remaining_accounts` — the caller (this method doesn't add any)
	 * must supply those if the sub-account has open deposits/positions, or the ix will fail.
	 * @param poolId - New pool id for the sub-account.
	 * @param subAccountId - Sub-account id to update.
	 * @returns The instruction.
	 * @throws (on-chain) if the sub-account has deposits/positions in markets outside the new pool, or
	 * otherwise fails the initial margin check after the switch.
	 */
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

	/**
	 * Fetches every `User` account that exists on-chain for this program via `getProgramAccounts` (with
	 * a `memcmp` filter, not restricted to this client's authority). Expensive — intended for indexers/
	 * admin tooling, not per-trade calls.
	 * @param includeIdle - If `false`, filters out idle (inactive) user accounts server-side; defaults
	 * to `true` (return all).
	 * @returns All matching `User` program accounts with their addresses.
	 */
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

	/**
	 * Fetches (via RPC `memcmp` filter, not the account subscriber) every on-chain `User` account whose
	 * `delegate` field equals `delegate`, i.e. every sub-account this wallet can trade on behalf of as a
	 * delegate.
	 * @param delegate - Delegate public key to search for.
	 * @returns Matching `UserAccount`s, sorted by `subAccountId` ascending.
	 */
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

	/**
	 * Fetches (via RPC, not the account subscriber) every on-chain `User` account owned by `authority`,
	 * with each account's PDA address included.
	 * @param authority - Authority to search for.
	 * @returns Matching `UserAccount`s and their addresses, in RPC-returned order (not sorted).
	 */
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

	/**
	 * Fetches (via RPC, not the account subscriber) every on-chain `User` account owned by `authority`.
	 * Used internally by `addAndSubscribeToUsers` to discover an authority's sub-accounts.
	 * @param authority - Authority to search for.
	 * @returns Matching `UserAccount`s, sorted by `subAccountId` ascending.
	 */
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

	/**
	 * Fetches (via RPC `memcmp` filter) every `UserStats` account whose `referrer` field equals
	 * `referrer`, i.e. every authority that was referred by this referrer.
	 * @param referrer - Referrer authority public key to search for.
	 * @returns Matching `UserStatsAccount`s, in RPC-returned order.
	 */
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

	/**
	 * Fetches (via RPC `memcmp` filter) every `ReferrerNameAccount` registered by `authority` via
	 * `initializeReferrerName`.
	 * @param authority - Authority to search for.
	 * @returns Matching `ReferrerNameAccount`s, in RPC-returned order.
	 */
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

	/**
	 * Deletes a sub-account owned by `this.wallet.publicKey` and unsubscribes/removes it from
	 * `this.users`. On-chain requires the sub-account to be fully closed out: no open perp/spot
	 * positions, no open orders, not bankrupt, not being liquidated, and (unless idle) sub-account 0 of
	 * a referrer cannot be deleted at all. If the protocol charges a `maxInitializeUserFee` and the
	 * account's `UserStats` is younger than ~13 days, the sub-account must also be marked `idle`.
	 * @param subAccountId - Sub-account id to delete; defaults to `0`.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 * @throws (on-chain `UserCantBeDeleted`) if any of the above preconditions aren't met.
	 */
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

	/**
	 * Builds the `deleteUser` instruction. See `deleteUser` for on-chain preconditions.
	 * @param userAccountPublicKey - User account PDA to delete.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper-only instruction: force-cancels all open orders and deletes/closes an inactive, near-zero
	 * equity user account, refunding remaining rent to `userAccount.authority`. Requires the signer
	 * (`this.wallet.publicKey`) to hold the `UserFlag` hot-role. On-chain, requires the account's
	 * total equity to be under `QUOTE_PRECISION / 20` (0.05 USDC, QUOTE_PRECISION = 1e6) and (outside
	 * `anchor-test` builds) at least ~3 months of inactivity since `lastActiveSlot`. Not for
	 * self-service account deletion — see `deleteUser` for that.
	 * @param userAccountPublicKey - PDA of the user account to force-delete.
	 * @param userAccount - The account's current on-chain data, used to build `remaining_accounts` for
	 * the markets it holds positions in.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 * @throws (on-chain) if the signer lacks the `UserFlag` hot-role, if equity exceeds the dust
	 * threshold, or if the account has been active too recently.
	 */
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

	/**
	 * Builds the keeper-only `forceDeleteUser` instruction, assembling `remaining_accounts` for the
	 * account's non-empty spot positions, its revenue-share escrow (if any order carries a builder
	 * fee), and every mint/token-program needed for its open spot balances. See `forceDeleteUser` for
	 * on-chain preconditions.
	 * @param userAccountPublicKey - PDA of the user account to force-delete.
	 * @param userAccount - The account's current on-chain data.
	 * @returns The instruction.
	 */
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

	/**
	 * Closes `this.wallet.publicKey`'s `SignedMsgUserOrders` account, refunding its rent to the
	 * authority. Requires the account to exist (see `isSignedMsgUserOrdersAccountInitialized`).
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `deleteSignedMsgUserOrders` instruction, signed by `this.wallet.publicKey`. See
	 * `deleteSignedMsgUserOrders` for semantics.
	 * @param authority - Authority whose `SignedMsgUserOrders` PDA is derived and closed.
	 * @returns The instruction.
	 */
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

	/**
	 * Reclaims any lamports on a sub-account's `User` PDA in excess of the rent-exempt minimum for its
	 * current size (e.g. left over after the account was resized smaller), transferring them to
	 * `this.wallet.publicKey`.
	 * @param subAccountId - Sub-account id to reclaim rent from; defaults to `0`.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 * @throws (on-chain `CantReclaimRent`) if there are no excess lamports, or if the account's
	 * `UserStats` is younger than ~13 days while the protocol enforces a max sub-account count.
	 */
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

	/**
	 * Builds the `reclaimRent` instruction. See `reclaimRent` for semantics/preconditions.
	 * @param userAccountPublicKey - User account PDA to reclaim excess rent from.
	 * @returns The instruction.
	 */
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

	/**
	 * Looks up an already-loaded `User` from `this.users` (does not fetch or subscribe).
	 * @param subAccountId - Sub-account id; defaults to `this.activeSubAccountId`.
	 * @param authority - Authority owning the sub-account; defaults to `this.authority`.
	 * @returns The loaded `User`.
	 * @throws if `subAccountId`/`authority` can't be resolved, or no matching user is loaded (call
	 * `addUser` first).
	 */
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

	/**
	 * Checks whether a `User` for the given sub-account/authority is currently loaded in `this.users`,
	 * without throwing. Safe to call with unresolvable `subAccountId`/`authority` (returns `false`).
	 * @param subAccountId - Sub-account id; defaults to `this.activeSubAccountId`.
	 * @param authority - Authority owning the sub-account; defaults to `this.authority`.
	 * @returns `true` if a matching `User` is loaded.
	 */
	public hasUser(subAccountId?: number, authority?: PublicKey): boolean {
		subAccountId = subAccountId ?? this.activeSubAccountId;
		authority = authority ?? this.authority;
		if (subAccountId === undefined || authority === undefined) {
			return false;
		}
		const userMapKey = this.getUserMapKey(subAccountId, authority);

		return this.users.has(userMapKey);
	}

	/**
	 * Returns every currently-loaded `User`, with sub-accounts owned directly by `this.wallet.publicKey`
	 * first, followed by delegated sub-accounts (owned by other authorities this wallet delegates for).
	 * @returns All loaded `User`s in that order.
	 */
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

	/**
	 * Returns the `UserStats` instance for `this.authority`, if one was constructed (via
	 * `config.userStats`, `updateWallet`, `emulateAccount`, or `switchActiveUser`).
	 * @returns The `UserStats` instance, or `undefined` if none exists.
	 */
	public getUserStats(): UserStats | undefined {
		return this.userStats;
	}

	/**
	 * Like `getUserStats` but throws if there is no UserStats
	 * subscription, for call sites that require a guaranteed account.
	 */
	public getUserStatsOrThrow(): UserStats {
		if (!this.userStats) {
			throw new Error('VelocityClient has no UserStats subscription');
		}
		return this.userStats;
	}

	/**
	 * Fetches (via RPC, not the account subscriber) the `ReferrerNameAccount` registered for a given
	 * name via `initializeReferrerName`.
	 * @param name - Referrer name to look up.
	 * @returns The `ReferrerNameAccount`.
	 * @throws if no `ReferrerNameAccount` is registered under `name`.
	 */
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

	/**
	 * Returns the `UserStats` account PDA for `this.authority`, computing and caching it on first call
	 * (or after `this.authority` changes, since callers like `updateWallet`/`switchActiveUser` reset the
	 * cache).
	 * @returns The `UserStats` account public key.
	 */
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

	/**
	 * Returns the user account PDA for an already-loaded sub-account (does not derive/compute a PDA
	 * for a sub-account that hasn't been loaded).
	 * @param subAccountId - Sub-account id; defaults to `this.activeSubAccountId`.
	 * @param authority - Authority owning the sub-account; defaults to `this.authority`.
	 * @returns The user account public key.
	 * @throws if no matching user is loaded — see `getUser`.
	 */
	public async getUserAccountPublicKey(
		subAccountId?: number,
		authority?: PublicKey
	): Promise<PublicKey> {
		return this.getUser(subAccountId, authority).userAccountPublicKey;
	}

	/**
	 * Returns the last subscriber-cached `UserAccount` data for a loaded sub-account. Does not hit RPC.
	 * @param subAccountId - Sub-account id; defaults to `this.activeSubAccountId`.
	 * @param authority - Authority owning the sub-account; defaults to `this.authority`.
	 * @returns The cached `UserAccount`, or `undefined` if not yet loaded.
	 * @throws if no matching `User` is loaded — see `getUser`.
	 */
	public getUserAccount(
		subAccountId?: number,
		authority?: PublicKey
	): UserAccount | undefined {
		return this.getUser(subAccountId, authority).getUserAccount();
	}

	/**
	 * Like `getUserAccount` but throws a named error instead of returning
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
	 * Like `getUserAccount` but forces a fresh RPC fetch first. Useful for anchor tests where an
	 * update needs to be observed immediately.
	 * @param subAccountId - Sub-account id; defaults to `this.activeSubAccountId`.
	 * @param authority - Authority owning the sub-account; defaults to `this.authority`.
	 * @returns The freshly-fetched `UserAccount`, or `undefined` if not found.
	 * @throws if no matching `User` is loaded — see `getUser`.
	 */
	public async forceGetUserAccount(
		subAccountId?: number,
		authority?: PublicKey
	): Promise<UserAccount | undefined> {
		await this.getUser(subAccountId, authority).fetchAccounts();
		return this.getUser(subAccountId, authority).getUserAccount();
	}

	/**
	 * Like `getUserAccount` but also returns the slot the data was last observed at.
	 * @param subAccountId - Sub-account id; defaults to `this.activeSubAccountId`.
	 * @param authority - Authority owning the sub-account; defaults to `this.authority`.
	 * @returns The cached `UserAccount` and its slot, or `undefined` if not yet loaded.
	 * @throws if no matching `User` is loaded — see `getUser`.
	 */
	public getUserAccountAndSlot(
		subAccountId?: number,
		authority?: PublicKey
	): DataAndSlot<UserAccount> | undefined {
		return this.getUser(subAccountId, authority).getUserAccountAndSlot();
	}

	/**
	 * Returns a sub-account's spot balance entry for a market, if it holds one.
	 * @param marketIndex - Spot market index.
	 * @param subAccountId - Sub-account id; defaults to `this.activeSubAccountId`.
	 * @returns The `SpotPosition`, or `undefined` if the sub-account has no balance in this market.
	 * @throws if the sub-account is not loaded — see `getUserAccountOrThrow`.
	 */
	public getSpotPosition(
		marketIndex: number,
		subAccountId?: number
	): SpotPosition | undefined {
		return this.getUserAccountOrThrow(subAccountId).spotPositions.find(
			(spotPosition) => spotPosition.marketIndex === marketIndex
		);
	}

	/**
	 * Convenience accessor for the active sub-account's quote (USDC) token amount.
	 * @returns Signed token amount, in the quote spot market's token precision (positive if a deposit,
	 * negative if a borrow). See `getTokenAmount`.
	 */
	public getQuoteAssetTokenAmount(): BN {
		return this.getTokenAmount(QUOTE_SPOT_MARKET_INDEX);
	}

	/**
	 * Returns the isolated deposit token amount backing a sub-account's isolated perp position in a
	 * given market (the collateral segregated into that position via
	 * `transferIsolatedPerpPositionDeposit`, distinct from the sub-account's general/cross balances).
	 * @param perpMarketIndex - Perp market index of the isolated position.
	 * @param subAccountId - Sub-account id; defaults to `this.activeSubAccountId`.
	 * @returns Token amount in the quote spot market's token precision.
	 */
	public getIsolatedPerpPositionTokenAmount(
		perpMarketIndex: number,
		subAccountId?: number
	): BN {
		return this.getUser(subAccountId).getIsolatePerpPositionTokenAmount(
			perpMarketIndex
		);
	}

	/**
	 * Returns the active sub-account's balance in a spot market, converted from the internal scaled
	 * balance representation to actual token units.
	 * @param marketIndex - Spot market index.
	 * @returns Token amount in the spot market's own token precision (`10^mint.decimals`, e.g.
	 * QUOTE_PRECISION (1e6) for USDC). Positive if a deposit, negative if a borrow. `ZERO` if the
	 * sub-account has no balance in this market.
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
	 * Converts a human-readable (UI) amount to a market's on-chain spot precision (`10^mint.decimals`).
	 * A plain `number` is scaled up via `castNumberToSpotPrecision`; a `BN` is assumed to already be a
	 * whole-token count and is scaled by the same factor.
	 * @param marketIndex - Spot market index whose token decimals determine the scale factor.
	 * @param amount - UI amount to convert.
	 * @returns The amount in the spot market's token precision.
	 */
	public convertToSpotPrecision(marketIndex: number, amount: BN | number): BN {
		const spotMarket = this.getSpotMarketAccountOrThrow(marketIndex);
		return castNumberToSpotPrecision(amount, spotMarket);
	}

	/**
	 * Converts a human-readable (UI) base-asset amount to `BASE_PRECISION` (1e9), the precision used for
	 * perp/spot order base amounts.
	 * @param amount - UI base amount to convert. A `number` is scaled via a precision-safe helper; a
	 * `BN` is assumed to already be a whole-unit count and is multiplied directly by `BASE_PRECISION`.
	 * @returns The amount in `BASE_PRECISION` (1e9).
	 */
	public convertToPerpPrecision(amount: BN | number): BN {
		if (typeof amount === 'number') {
			return numberToSafeBN(amount, BASE_PRECISION);
		} else {
			return amount.mul(BASE_PRECISION);
		}
	}

	/**
	 * Converts a human-readable (UI) price to `PRICE_PRECISION` (1e6).
	 * @param amount - UI price to convert.
	 * @returns The amount in `PRICE_PRECISION` (1e6) when `amount` is a `number` (uses
	 * `numberToSafeBN(amount, PRICE_PRECISION)`).
	 * **Note:** when `amount` is a `BN`, this multiplies by `BASE_PRECISION` (1e9), not
	 * `PRICE_PRECISION` (1e6) — that is very likely a bug (1000x too large) rather than intended
	 * behavior; pass a `number` for correct scaling until this is fixed.
	 */
	public convertToPricePrecision(amount: BN | number): BN {
		if (typeof amount === 'number') {
			return numberToSafeBN(amount, PRICE_PRECISION);
		} else {
			return amount.mul(BASE_PRECISION);
		}
	}

	/**
	 * Each velocity instruction must include perp and spot market accounts in the ix remaining accounts.
	 * Use this function to force a subset of markets to be included in the remaining accounts for every ix
	 * built by this client going forward (accumulates into `mustIncludePerpMarketIndexes` /
	 * `mustIncludeSpotMarketIndexes`; there is no corresponding "unset" — construct a new client to
	 * reset). Useful when an instruction's own logic can't infer every market/oracle it needs (e.g. a
	 * cross-margin health check spanning markets the user has no position in yet).
	 * @param perpMarketIndexes - Perp market indexes to always include.
	 * @param spotMarketIndexes - Spot market indexes to always include.
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

	/**
	 * Builds the `remaining_accounts` list (perp/spot market + oracle accounts, plus any accounts
	 * derived from the given `userAccounts`) that most instructions need appended so the on-chain
	 * handler can load the markets/oracles it touches. Always includes markets registered via
	 * `mustIncludeMarketsInIx`, in addition to whatever `params` (e.g. `userAccounts`,
	 * `writableSpotMarketIndexes`) implies. Used internally by nearly every instruction-building method
	 * on this class; exposed publicly for callers assembling custom instructions.
	 * @param params - Describes which markets/users to derive remaining accounts for; see
	 * `RemainingAccountParams` (core/remainingAccounts.ts).
	 * @returns The `AccountMeta[]` to append to an instruction's accounts.
	 */
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

	/**
	 * Adds a perp market's account meta (and its oracle and quote spot market) into the shared maps used
	 * to de-duplicate remaining accounts across multiple markets in one instruction. The oracle is
	 * marked writable only for `prelaunch`-sourced oracles being written to.
	 * @param marketIndex - Perp market index to include.
	 * @param writable - Whether the perp market account meta should be writable.
	 * @param oracleAccountMap - Shared map (keyed by oracle pubkey string) mutated in place.
	 * @param spotMarketAccountMap - Shared map (keyed by spot market index) mutated in place.
	 * @param perpMarketAccountMap - Shared map (keyed by perp market index) mutated in place.
	 */
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

	/**
	 * Adds a spot market's account meta (and its oracle, if any) into the shared maps used to
	 * de-duplicate remaining accounts across multiple markets in one instruction.
	 * @param marketIndex - Spot market index to include.
	 * @param writable - Whether the spot market account meta should be writable.
	 * @param oracleAccountMap - Shared map (keyed by oracle pubkey string) mutated in place.
	 * @param spotMarketAccountMap - Shared map (keyed by spot market index) mutated in place.
	 */
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

	/**
	 * Appends each builder's `User` (sub-account 0) and `RevenueShare` account metas to
	 * `remainingAccounts` (writable), deduping by pubkey so an authority that is both a builder and a
	 * referrer isn't pushed twice — the on-chain revenue-share account loader rejects duplicates and
	 * would abort the whole instruction.
	 * @param builders - Builder authority public keys to include.
	 * @param remainingAccounts - Array mutated in place by appending the builder account metas.
	 */
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

	/**
	 * Builds the deduplicated oracle/spot-market/perp-market account-meta maps needed to cover every
	 * non-empty position across a set of user accounts (e.g. taker + makers in a fill), including the
	 * quote spot market whenever a spot position has open orders. All accounts are added read-only.
	 * @param userAccounts - User accounts whose open positions determine which markets to include.
	 * @returns The three account-meta maps, keyed by oracle pubkey string / spot market index / perp
	 * market index respectively.
	 */
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
	 * `getOrderByUserId` when you need to look up an order by the caller-supplied
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
	 * `userOrderId` is a 1-255 slot chosen by the caller in `OrderParams` and is stable
	 * across the life of the order — useful when you need to reference an order before the
	 * program-assigned `Order.orderId` is known (e.g. immediately after placing without
	 * waiting for confirmation). Use `getOrder` when you have the program-assigned ID.
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
	 * Resolves the token account to use for a spot market's mint. For the wrapped-SOL market with
	 * `useNative = true` (the default), returns `authority` itself (native SOL, no wrapping) rather
	 * than an SPL associated token account; for every other market (or `useNative = false`), returns
	 * the derived associated token account address (not guaranteed to exist on-chain — see
	 * `getAssociatedTokenAccountCreationIx`).
	 * @param marketIndex - Spot market index whose mint the token account is for.
	 * @param useNative - If `true` (default) and the market is wrapped SOL, return `authority` directly
	 * instead of an ATA.
	 * @param tokenProgram - Token program the mint belongs to; defaults to the classic SPL Token program.
	 * @param authority - Wallet the token account belongs to; defaults to `this.wallet.publicKey`.
	 * @param allowOwnerOffCurve - Passed through to `getAssociatedTokenAddress`; set `true` for PDA owners.
	 * @returns The resolved token account address (or `authority`, for native SOL).
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

	/**
	 * Builds an `CreateIdempotent` associated-token-account instruction (creates `account` if it
	 * doesn't already exist; no-ops without failing if it does), constructed manually rather than via
	 * `@solana/spl-token`'s helper.
	 * @param account - Associated token account address to create.
	 * @param payer - Pays for the account creation; must sign the transaction.
	 * @param owner - Token account owner.
	 * @param mint - Mint the token account is for.
	 * @param tokenProgram - Token program the mint belongs to; defaults to the classic SPL Token program.
	 * @returns The `CreateIdempotent` instruction.
	 */
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

	/**
	 * Builds the full instruction sequence for a deposit, without sending a transaction. If
	 * `associatedTokenAccount` equals the signer and the market is wrapped SOL, transparently wraps
	 * native SOL first (creates a temporary wrapped-SOL account funded with `amount`, deposits from it,
	 * then closes it at the end of the same transaction, refunding rent to the signer) — otherwise
	 * deposits directly from `associatedTokenAccount`.
	 * @param amount - Amount to deposit, in the spot market's own token precision (`10^mint.decimals`).
	 * @param marketIndex - Spot market index to deposit into.
	 * @param associatedTokenAccount - Source token account (or the signer's own pubkey, for native SOL).
	 * @param subAccountId - Sub-account id to credit; defaults to `this.activeSubAccountId`.
	 * @param reduceOnly - If `true`, the deposit is capped so it cannot flip/increase a net borrow
	 * position beyond what's needed to reach zero (used to repay a borrow without over-depositing).
	 * @param overrides.authority - Signer/depositor authority; defaults to `this.wallet.publicKey`.
	 * @returns The ordered list of instructions (wrap SOL, deposit, unwrap SOL as applicable).
	 */
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

	/**
	 * Builds (but does not send) a single transaction that deposits collateral and then places a
	 * pre-signed SignedMsg ("swift") taker perp order in one atomic bundle — useful for funding a new
	 * or under-collateralized account immediately before submitting an off-chain-signed order.
	 * Optionally also initializes the taker's `SignedMsgUserOrders` account (with 8 order slots) first,
	 * if it doesn't already exist.
	 * @param signedOrderParams - The pre-signed SignedMsg order message/params to place.
	 * @param takerInfo - Taker's user/user-stats accounts, loaded `UserAccount` data, and the signing
	 * authority for the order message.
	 * @param depositAmount - Amount to deposit, in `depositSpotMarketIndex`'s token precision.
	 * @param depositSpotMarketIndex - Spot market index to deposit into.
	 * @param tradePerpMarketIndex - Perp market index the signed order trades.
	 * @param subAccountId - Sub-account id to deposit into and place the order for.
	 * @param takerAssociatedTokenAccount - Source token account for the deposit.
	 * @param initSwiftAccount - If `true`, initializes the taker's `SignedMsgUserOrders` account first
	 * when it doesn't already exist; defaults to `false`.
	 * @returns Nothing — currently discards the built transaction rather than returning or sending it
	 * (likely a bug: the built `VersionedTransaction`/`Transaction` from `buildTransaction` is neither
	 * returned nor passed to `sendTransaction`).
	 */
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

	/**
	 * Builds (via `getDepositTxnIx`) and wraps a full deposit transaction, without sending it.
	 * Optionally also initializes the depositor's `SignedMsgUserOrders` account first, if it doesn't
	 * already exist. Forces `computeUnits` to `800_000` regardless of `txParams`/`this.txParams`.
	 * @param amount - Amount to deposit, in the spot market's own token precision.
	 * @param marketIndex - Spot market index to deposit into.
	 * @param associatedTokenAccount - Source token account (or the signer's own pubkey, for native SOL).
	 * @param subAccountId - Sub-account id to credit; defaults to `this.activeSubAccountId`.
	 * @param reduceOnly - If `true`, caps the deposit so it cannot exceed what's needed to zero out an
	 * existing borrow.
	 * @param txParams - Optional compute-unit-price/other overrides; `computeUnits` is always
	 * overridden to `800_000`.
	 * @param initSwiftAccount - If `true`, initializes the signer's `SignedMsgUserOrders` account first
	 * when it doesn't already exist; defaults to `false`.
	 * @param overrides.authority - Signer/depositor authority; defaults to `this.wallet.publicKey`.
	 * @returns The built (unsigned/unsent) transaction.
	 */
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
	 * Deposits collateral into a spot market for a sub-account: builds (`createDepositTxn`), signs, and
	 * sends the transaction, then caches the confirming slot for this market so subsequent instructions
	 * built by this client can use the freshest oracle/market data.
	 * @param amount - Amount to deposit, in the spot market's own token precision (`10^mint.decimals`,
	 * e.g. QUOTE_PRECISION (1e6) for USDC).
	 * @param marketIndex - Spot market index to deposit into.
	 * @param associatedTokenAccount - Source token account; can be the wallet's own public key when
	 * depositing native SOL into the wrapped-SOL market (see `getAssociatedTokenAccount`).
	 * @param subAccountId - Sub-account id to credit; defaults to `this.activeSubAccountId`.
	 * @param reduceOnly - If `true`, caps the deposit so it cannot exceed what's needed to fully repay
	 * an existing borrow (never opens/increases a deposit position); defaults to `false`.
	 * @param txParams - Optional transaction parameters; `computeUnits` is always forced to `800_000`.
	 * @param initSwiftAccount - If `true`, also initializes the signer's `SignedMsgUserOrders` account
	 * first if it doesn't exist; defaults to `false`.
	 * @param overrides.authority - Signer/depositor authority; defaults to `this.wallet.publicKey`.
	 * @returns The transaction signature.
	 * @throws (on-chain) if the sub-account's `poolId` doesn't match the spot market's pool, the market
	 * is uninitialized/paused for deposits, or `amount` is `0`.
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

	/**
	 * Builds the raw `deposit` instruction (no SOL-wrapping helpers — see `getDepositTxnIx` for the
	 * full sequence). Assembles `remaining_accounts` from the target sub-account's current positions
	 * (forcing a fresh fetch when `userInitialized` is `true`) plus the market's mint and, if the mint
	 * uses a transfer hook, its extra account metas.
	 * @param amount - Amount to deposit, in the spot market's own token precision.
	 * @param marketIndex - Spot market index to deposit into.
	 * @param userTokenAccount - Source token account for the deposit.
	 * @param subAccountId - Sub-account id to credit; defaults to `this.activeSubAccountId`.
	 * @param reduceOnly - If `true`, caps the deposit at what's needed to repay an existing borrow.
	 * @param userInitialized - Set `false` only when depositing as part of creating a brand-new user
	 * account in the same transaction (skips fetching/using existing position data).
	 * @param overrides.authority - Signer/depositor authority; defaults to `this.wallet.publicKey`.
	 * @returns The `deposit` instruction.
	 * @throws if `userInitialized` is `true` but the user account fails to load after a forced fetch.
	 */
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

	/**
	 * Builds the instructions to create and fund a temporary wrapped-SOL token account (via
	 * `createAccountWithSeed` + `initializeAccount`, no keypair required — derived deterministically
	 * from `authority` and a random seed). The caller is responsible for closing it after use (see the
	 * `createCloseAccountInstruction` pattern in `getDepositTxnIx`).
	 * @param amount - Lamport amount to wrap (native SOL to make available as wrapped SOL).
	 * @param includeRent - If `true`, funds the account with `amount` plus an extra
	 * `LAMPORTS_PER_SOL / 100` (0.01 SOL) rent buffer; if falsy, funds with only the rent buffer (no
	 * `amount`).
	 * @param overrides.authority - Owner/payer of the wrapped-SOL account; defaults to
	 * `this.wallet.publicKey`.
	 * @returns `ixs` (create + initialize instructions), `pubkey` (the new wrapped-SOL account
	 * address), and `signers` (always empty — no keypair signature is needed for a seed-derived
	 * account).
	 */
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

	/**
	 * Returns the correct SPL token program (classic or Token-2022) for a spot market's mint, based on
	 * its `tokenProgramFlag`.
	 * @param spotMarketAccount - Spot market whose mint's token program is needed.
	 * @returns `TOKEN_2022_PROGRAM_ID` or `TOKEN_PROGRAM_ID`.
	 */
	public getTokenProgramForSpotMarket(
		spotMarketAccount: SpotMarketAccount
	): PublicKey {
		if (this.isToken2022(spotMarketAccount)) {
			return TOKEN_2022_PROGRAM_ID;
		}
		return TOKEN_PROGRAM_ID;
	}

	/**
	 * Checks whether a spot market's mint belongs to the Token-2022 program.
	 * @param spotMarketAccount - Spot market to check.
	 * @returns `true` if the market's `tokenProgramFlag` has the `Token2022` bit set.
	 */
	public isToken2022(spotMarketAccount: SpotMarketAccount): boolean {
		return (
			(spotMarketAccount.tokenProgramFlag & TokenProgramFlag.Token2022) > 0
		);
	}

	/**
	 * Checks whether a spot market's mint has a Token-2022 transfer hook, requiring extra account
	 * metas to be appended on any instruction that moves its tokens.
	 * @param spotMarketAccount - Spot market to check.
	 * @returns `true` if the market's `tokenProgramFlag` has the `TransferHook` bit set.
	 */
	public isTransferHook(spotMarketAccount: SpotMarketAccount): boolean {
		return (
			(spotMarketAccount.tokenProgramFlag & TokenProgramFlag.TransferHook) > 0
		);
	}

	/**
	 * Appends a spot market's mint as a read-only remaining account, but only when the mint is
	 * Token-2022 (the classic SPL Token program doesn't need the mint passed for transfers). No-op for
	 * classic SPL Token mints.
	 * @param spotMarketAccount - Spot market whose mint may need to be included.
	 * @param remainingAccounts - Array mutated in place by appending the mint account meta, if needed.
	 */
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

	/**
	 * Resolves and appends the Token-2022 transfer-hook program's extra required account metas for a
	 * mint. Required on any instruction transferring tokens for a mint where `isTransferHook` is `true`
	 * (e.g. deposits/withdrawals/transfers involving that market).
	 * @param mint - Transfer-hook mint to resolve extra accounts for.
	 * @param remainingAccounts - Array mutated in place by appending the resolved extra account metas.
	 */
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

	/**
	 * Builds a (non-idempotent) instruction to create an associated token account owned by
	 * `this.wallet.publicKey`, paid for by `this.wallet.publicKey`.
	 * @param tokenMintAddress - Mint the associated token account is for.
	 * @param associatedTokenAddress - Associated token account address to create.
	 * @param tokenProgram - Token program the mint belongs to.
	 * @returns The create-associated-token-account instruction.
	 */
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

	/**
	 * Builds the full instruction sequence to create a new sub-account and fund it with an initial
	 * deposit in one transaction, without sending it. Handles: initializing `UserStats` (for
	 * `subAccountId === 0`) and the `SignedMsgUserOrders` account if missing, wrapping native SOL when
	 * depositing/donating SOL, creating the depositor's associated token account for Token-2022 mints
	 * if it doesn't exist, sourcing the deposit either from a token account or (if `fromSubAccountId` is
	 * given) via an internal transfer from another of the authority's sub-accounts, an optional donation
	 * to the market's revenue pool, an optional custom margin ratio, and unwrapping any temporary SOL
	 * account at the end.
	 * @param amount - Amount to deposit, in `marketIndex`'s token precision.
	 * @param userTokenAccount - Source token account for the deposit (ignored if `fromSubAccountId` is
	 * set, or replaced with a temporary wrapped-SOL account for a SOL deposit from the depositor).
	 * @param marketIndex - Spot market index to deposit into; defaults to `0` (quote/USDC).
	 * @param subAccountId - New sub-account id to create; defaults to `0`.
	 * @param name - Display name for the new sub-account; see `getInitializeUserAccountIxs` for the
	 * default.
	 * @param fromSubAccountId - If set, sources the deposit via an internal transfer from this other
	 * sub-account of the same authority instead of from `userTokenAccount`.
	 * @param referrerInfo - Referrer's `referrer`/`referrerStats` public keys, if attributing this
	 * account to a referrer.
	 * @param donateAmount - Additional lamport amount to donate to spot market index `1`'s (SOL's, in
	 * the default market configs) revenue pool in the same transaction, funded via a temporary
	 * wrapped-SOL account regardless of `marketIndex`; defaults to none. Note the destination market for
	 * the donation is hardcoded to index `1`, not derived from `marketIndex`.
	 * @param customMaxMarginRatio - If set, also sets this sub-account's custom margin ratio (in
	 * `MARGIN_PRECISION`, 1e4 = 100%) at creation time.
	 * @param poolId - If set, also assigns the sub-account to this isolated pool at creation time.
	 * @param overrides.externalWallet - Optional external wallet to deposit/pay from instead of
	 * `this.wallet.publicKey` (the sub-account's owning `authority` is unaffected).
	 * @returns The ordered instructions and the new user account's public key.
	 * @throws if a SOL/donation amount requires a temporary wrapped-SOL account but it fails to be
	 * created.
	 */
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
	/**
	 * Builds (via `createInitializeUserAccountAndDepositCollateralIxs`) and wraps the full
	 * initialize-and-deposit transaction, without sending it. See that method for parameter semantics.
	 * @returns The built (unsigned/unsent) transaction and the new user account's public key.
	 */
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
	 * Creates a new sub-account and deposits initial collateral into it in a single transaction, then
	 * loads and subscribes the new sub-account via `addUser`. See
	 * `createInitializeUserAccountAndDepositCollateralIxs` for full parameter semantics.
	 * @param amount - Amount to deposit, in `marketIndex`'s token precision.
	 * @param userTokenAccount - Source token account for the deposit.
	 * @param marketIndex - Spot market index to deposit into; defaults to `0` (quote/USDC).
	 * @param subAccountId - New sub-account id to create; defaults to `0`.
	 * @param name - Display name for the new sub-account.
	 * @param fromSubAccountId - If set, sources the deposit via internal transfer from this sub-account
	 * instead of `userTokenAccount`.
	 * @param referrerInfo - Referrer's `referrer`/`referrerStats` public keys, if applicable.
	 * @param donateAmount - Additional amount to donate to the (hardcoded index `1`) revenue pool.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @param customMaxMarginRatio - If set, custom margin ratio in `MARGIN_PRECISION` (1e4 = 100%).
	 * @param poolId - If set, isolated pool id to assign the sub-account to at creation time.
	 * @param overrides - Optional overrides including externalWallet for depositing from a different wallet
	 * @returns A tuple of `[transactionSignature, userAccountPublicKey]`.
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

	/**
	 * Devnet/test-only convenience: mints test tokens from a `TokenFaucet` into a fresh associated
	 * token account, then creates a new sub-account and deposits the minted amount, all in one
	 * transaction. Not usable on mainnet (no faucet exists there).
	 * @param subAccountId - New sub-account id to create; defaults to `0`.
	 * @param name - Display name for the new sub-account; defaults to `DEFAULT_USER_NAME`.
	 * @param marketIndex - Spot market index to deposit the minted tokens into.
	 * @param tokenFaucet - Faucet client used to mint test tokens.
	 * @param amount - Amount to mint and deposit, in `marketIndex`'s token precision.
	 * @param referrerInfo - Referrer's `referrer`/`referrerStats` public keys, if applicable.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns A tuple of `[transactionSignature, userAccountPublicKey]`.
	 */
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

	/**
	 * Builds the full instruction sequence for a withdrawal, without sending a transaction. If
	 * `associatedTokenAddress` equals the signer and the market is wrapped SOL, creates a temporary
	 * wrapped-SOL account to receive the withdrawal and closes it (unwrapping to native SOL) at the end
	 * of the same transaction; otherwise, creates the destination associated token account first if it
	 * doesn't already exist.
	 * @param amount - Amount to withdraw, in the spot market's own token precision.
	 * @param marketIndex - Spot market index to withdraw from.
	 * @param associatedTokenAddress - Destination token account (or the signer's own pubkey, for native
	 * SOL).
	 * @param reduceOnly - If `true`, caps the withdrawal at the sub-account's existing deposit (and the
	 * max amount withdrawable while remaining within margin requirements) so it can never flip the
	 * position into a borrow; defaults to `false`.
	 * @param subAccountId - Sub-account id to withdraw from; defaults to `this.activeSubAccountId`.
	 * @returns The ordered list of instructions (create ATA / wrap SOL, withdraw, unwrap SOL as
	 * applicable).
	 */
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
	 * Withdraws from a user account. If deposit doesn't already exist, creates a borrow (or increases an
	 * existing one) — unless `reduceOnly` is set. Always requires the sub-account's true owning
	 * authority to sign (`this.wallet.publicKey`); a delegate cannot withdraw at all, even with
	 * `allowDelegateTransfer` enabled.
	 * @param amount - Amount to withdraw, in the spot market's own token precision (`10^mint.decimals`,
	 * e.g. QUOTE_PRECISION (1e6) for USDC).
	 * @param marketIndex - Spot market index to withdraw from.
	 * @param associatedTokenAddress - the token account to withdraw to. can be the wallet public key if using native sol
	 * @param reduceOnly - If `true`, caps the withdrawal so it can never open/increase a borrow; the
	 * on-chain amount is clamped to `min(requested, max withdrawable within margin, existing deposit)`.
	 * @param subAccountId - Sub-account id to withdraw from; defaults to `this.activeSubAccountId`.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 * @throws (on-chain `ReduceOnlyWithdrawIncreasedRisk`) if `reduceOnly` is set but the sub-account's
	 * position in this market is already a borrow (nothing to reduce).
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

	/**
	 * Fully withdraws every spot market position on a sub-account too small to be worth carrying
	 * ("dust", as determined by `User.getSpotMarketAccountsWithDustPosition`), in one transaction. Each
	 * withdrawal requests 2x the current token amount with `reduceOnly = true` so the on-chain clamp
	 * (see `withdraw`) withdraws exactly the full balance without risking a borrow, regardless of
	 * balance drift between calculation and execution.
	 * @param subAccountId - Sub-account id to sweep; defaults to `this.activeSubAccountId`.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @param opts.dustPositionCountCallback - Called once with the number of dust positions found
	 * (`0` if none), before building/sending the transaction.
	 * @returns The transaction signature, or `undefined` if there were no dust positions to withdraw.
	 */
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

	/**
	 * Builds the raw `withdraw` instruction (no SOL-wrapping/ATA-creation helpers — see
	 * `getWithdrawalIxs` for the full sequence). Signed by `this.wallet.publicKey`, which must be the
	 * sub-account's true owning authority (delegates cannot withdraw).
	 * @param amount - Amount to withdraw, in the spot market's own token precision.
	 * @param marketIndex - Spot market index to withdraw from.
	 * @param userTokenAccount - Destination token account for the withdrawal.
	 * @param reduceOnly - If `true`, caps the withdrawal so it can never open/increase a borrow.
	 * @param subAccountId - Sub-account id to withdraw from; defaults to `this.activeSubAccountId`.
	 * @returns The `withdraw` instruction.
	 */
	public async getWithdrawIx(
		amount: BN,
		marketIndex: number,
		userTokenAccount: PublicKey,
		reduceOnly = false,
		subAccountId?: number,
		overrides?: {
			authority?: PublicKey;
		}
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
			authority: overrides?.authority ?? this.wallet.publicKey,
			tokenProgram,
			remainingAccounts,
		});
	}

	/**
	 * Transfers a spot balance directly between two sub-accounts owned by `this.wallet.publicKey`
	 * (withdraws from `fromSubAccountId`, deposits into `toSubAccountId`) without leaving the program —
	 * no token account round-trip. Signed by `this.wallet.publicKey`, which must literally be the
	 * `authority` on *both* sub-accounts (this is the owner-to-owner path; a delegate must use
	 * `transferDepositByDelegate` instead).
	 * @param amount - Amount to transfer, in the spot market's own token precision.
	 * @param marketIndex - Spot market index of the balance to transfer.
	 * @param fromSubAccountId - Sub-account id to debit.
	 * @param toSubAccountId - Sub-account id to credit.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 * @throws (on-chain `UserBankrupt`) if either sub-account is bankrupt, or
	 * (`CantTransferBetweenSameUserAccount`) if `fromSubAccountId === toSubAccountId`.
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

	/**
	 * Builds the `transferDeposit` instruction. See `transferDeposit` for semantics/preconditions.
	 * Uses an already-loaded `from` sub-account's cached data if available (to build
	 * `remaining_accounts` from its current positions); otherwise fetches it directly via RPC.
	 * @param amount - Amount to transfer, in the spot market's own token precision.
	 * @param marketIndex - Spot market index of the balance to transfer.
	 * @param fromSubAccountId - Sub-account id to debit.
	 * @param toSubAccountId - Sub-account id to credit.
	 * @returns The instruction.
	 */
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

	/**
	 * Like `transferDeposit`, but signed by a *delegate* (`this.wallet.publicKey`) rather than the
	 * sub-accounts' owning authority. On-chain requires all of:
	 *   - the owner has opted in via `updateUserAllowDelegateTransfer(true)` on their `UserStats` — the
	 *     transfer is rejected outright otherwise, regardless of delegate status on the sub-accounts;
	 *   - `this.wallet.publicKey` is set as the `delegate` on **both** `fromSubAccountId` and
	 *     `toSubAccountId` (see `updateUserDelegate`) — a delegate for only one side is not sufficient;
	 *   - both sub-accounts share the same owning `authority` (this only moves funds within one owner's
	 *     sub-accounts, never across different owners);
	 *   - neither sub-account is bankrupt, and `fromSubAccountId !== toSubAccountId`.
	 * @param amount - Amount to transfer, in the spot market's own token precision.
	 * @param marketIndex - Spot market index of the balance to transfer.
	 * @param fromSubAccountId - Sub-account id to debit.
	 * @param toSubAccountId - Sub-account id to credit.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 * @throws (on-chain) if `allowDelegateTransfer` is not enabled, if the signer is not the delegate on
	 * both sub-accounts, if the sub-accounts have different owners, if either is bankrupt, or if
	 * `fromSubAccountId === toSubAccountId`.
	 */
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

	/**
	 * Builds the `transferDepositByDelegate` instruction. See `transferDepositByDelegate` for the full
	 * set of on-chain preconditions. Uses an already-loaded `from` sub-account's cached data if
	 * available; otherwise fetches it directly via RPC. Sub-accounts are derived under `this.authority`
	 * (the sub-accounts' owner), not `this.wallet.publicKey` (the delegate signer).
	 * @param amount - Amount to transfer, in the spot market's own token precision.
	 * @param marketIndex - Spot market index of the balance to transfer.
	 * @param fromSubAccountId - Sub-account id to debit.
	 * @param toSubAccountId - Sub-account id to credit.
	 * @returns The instruction.
	 */
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

	/**
	 * Moves a deposit balance and/or a borrow balance for the same underlying mint between two
	 * sub-accounts owned by `this.wallet.publicKey` that sit in *different* isolated pools, in one
	 * on-chain instruction (`transferPools`). Unlike `transferDeposit` (which only moves a single spot
	 * balance and requires same-pool markets), this requires: `depositFromMarketIndex`/
	 * `depositToMarketIndex` to share a mint but different `poolId`s, `borrowFromMarketIndex`/
	 * `borrowToMarketIndex` to likewise share a mint but different pool ids, and the deposit-from/
	 * borrow-from markets to share `fromSubAccountId`'s pool while the deposit-to/borrow-to markets
	 * share `toSubAccountId`'s pool. Both sub-accounts must be re-validated against their initial
	 * margin requirement after the move.
	 * @param depositFromMarketIndex - Spot market to debit the deposit leg from.
	 * @param depositToMarketIndex - Spot market to credit the deposit leg to (same mint, different pool).
	 * @param borrowFromMarketIndex - Spot market to credit (repay) the borrow leg from.
	 * @param borrowToMarketIndex - Spot market to debit (re-open) the borrow leg on.
	 * @param depositAmount - Deposit amount to move, in the deposit market's token precision;
	 * `undefined`/omitted moves the entire existing deposit token amount; `0` skips the deposit leg
	 * entirely.
	 * @param borrowAmount - Borrow amount to move, in the borrow market's token precision; `undefined`
	 * moves the entire existing borrow token amount; `0` skips the borrow leg entirely.
	 * @param fromSubAccountId - Sub-account id to debit.
	 * @param toSubAccountId - Sub-account id to credit.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 * @throws (on-chain `InvalidPoolId`) if the mint/pool relationships above don't hold, or
	 * (`UserBankrupt`/`CantTransferBetweenSameUserAccount`) for the same preconditions as `transferDeposit`.
	 */
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

	/**
	 * Builds the `transferPools` instruction. See `transferPools` for full semantics/preconditions.
	 * @param depositFromMarketIndex - Spot market to debit the deposit leg from.
	 * @param depositToMarketIndex - Spot market to credit the deposit leg to.
	 * @param borrowFromMarketIndex - Spot market to credit (repay) the borrow leg from.
	 * @param borrowToMarketIndex - Spot market to debit (re-open) the borrow leg on.
	 * @param depositAmount - Deposit amount to move, in the deposit market's token precision;
	 * `undefined` moves the entire deposit, `0` skips the deposit leg.
	 * @param borrowAmount - Borrow amount to move, in the borrow market's token precision; `undefined`
	 * moves the entire borrow, `0` skips the borrow leg.
	 * @param fromSubAccountId - Sub-account id to debit.
	 * @param toSubAccountId - Sub-account id to credit.
	 * @param isToNewSubAccount - If `true`, skips including `toSubAccountId`'s current `UserAccount` data
	 * when building `remaining_accounts` (use when `toSubAccountId` is being created in the same
	 * transaction and has no on-chain data yet).
	 * @returns The instruction.
	 */
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

	/**
	 * Moves all or part of an open perp position from one sub-account to another via the
	 * `transferPerpPosition` instruction, settling funding on both sides first. The signer
	 * (`this.wallet.publicKey`) must independently satisfy `can_sign_for_user` (be the owning
	 * `authority` or the sub-account's `delegate`) on *both* `fromSubAccountId` and `toSubAccountId` —
	 * unlike `transferDepositByDelegate`, there is no separate `allowDelegateTransfer` opt-in gate, and
	 * the two sub-accounts are not required to share the same owning authority.
	 * @param fromSubAccountId - Sub-account id to debit the position from.
	 * @param toSubAccountId - Sub-account id to credit the position to.
	 * @param marketIndex - Perp market index of the position to transfer.
	 * @param amount - Signed base amount to transfer, in `BASE_PRECISION` (1e9). Must have the same sign
	 * as `fromSubAccountId`'s existing position (i.e. it only reduces/closes that position, never
	 * flips it) and a magnitude at most the position's size and a multiple of the market's step size;
	 * pass `undefined` to transfer the entire position.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 * @throws (on-chain `UserBankrupt`/`CantTransferBetweenSameUserAccount`) for the standard transfer
	 * preconditions, or `InvalidTransferPerpPosition` if the oracle is invalid, fills are paused for
	 * `marketIndex`, `amount`'s sign/magnitude/step-size don't satisfy the constraints above, or
	 * `fromSubAccountId` has no position in `marketIndex`.
	 */
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

	/**
	 * Builds the `transferPerpPosition` instruction. See `transferPerpPosition` for full semantics.
	 * @param fromSubAccountId - Sub-account id to debit the position from.
	 * @param toSubAccountId - Sub-account id to credit the position to.
	 * @param marketIndex - Perp market index of the position to transfer.
	 * @param amount - Signed base amount to transfer, in `BASE_PRECISION` (1e9); `undefined`/`null`
	 * transfers the entire position. See `transferPerpPosition` for sign/magnitude constraints.
	 * @returns The instruction.
	 */
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

	/**
	 * Special-account-only: transfers all or part of a position on the protocol's designated "vAMM
	 * hedger" account directly into the AMM's own inventory, offsetting the vAMM's synthetic position.
	 * On-chain requires `userAccountPublicKey`'s `specialUserStatus` to be `VammHedger`, the position's
	 * direction to already be opposite the AMM's net inventory (`amm.baseAssetAmountWithAmm`), and the
	 * transferred amount to fit within the AMM's available capacity for that direction. Not usable on a
	 * regular trading sub-account.
	 * @param userAccountPublicKey - The vAMM-hedger `User` PDA to transfer from; must already be loaded
	 * in `this.users` (see `getUsers`).
	 * @param marketIndex - Perp market index of the position to transfer.
	 * @param amount - Signed base amount to transfer, in `BASE_PRECISION` (1e9), matching the position's
	 * sign and capped at its size and a multiple of the market's step size; omit to transfer the entire
	 * position.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 * @throws (on-chain) if the account isn't a `VammHedger`, has no (or a same-direction-as-AMM)
	 * position in `marketIndex`, or `amount` fails the sign/magnitude/step-size/AMM-capacity checks.
	 */
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

	/**
	 * Builds the `specialTransferPerpPositionToVamm` instruction. See
	 * `specialTransferPerpPositionToVamm` for full semantics/preconditions.
	 * @param userAccountPublicKey - The vAMM-hedger `User` PDA to transfer from.
	 * @param marketIndex - Perp market index of the position to transfer.
	 * @param amount - Signed base amount to transfer, in `BASE_PRECISION` (1e9); omit to transfer the
	 * entire position.
	 * @returns The instruction.
	 * @throws if `userAccountPublicKey` isn't among `this.getUsers()`.
	 */
	public async getSpecialTransferPerpPositionToVammIx(
		userAccountPublicKey: PublicKey,
		marketIndex: number,
		amount?: BN
	): Promise<TransactionInstruction> {
		const user = this.getUsers().find((u) =>
			u.getUserAccountPublicKey().equals(userAccountPublicKey)
		);
		if (!user) {
			throw new Error(
				`VelocityClient has no user for user account ${userAccountPublicKey.toString()}`
			);
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [user.getUserAccountOrThrow()],
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

	/**
	 * Deposits collateral from a token account directly into an isolated perp position's own segregated
	 * balance (as opposed to `deposit`, which credits the sub-account's general/cross balance). The
	 * position's quote spot market is derived from `perpMarketIndex`'s `quoteSpotMarketIndex`.
	 * @param amount - Amount to deposit, in the position's quote spot market's token precision.
	 * @param perpMarketIndex - Perp market index of the isolated position to fund.
	 * @param userTokenAccount - Source token account for the deposit.
	 * @param subAccountId - Sub-account id owning the position; defaults to `this.activeSubAccountId`.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 * @throws (on-chain `InvalidPoolId`) if the sub-account's pool doesn't match the spot/perp markets'.
	 */
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

	/**
	 * Builds the `depositIntoIsolatedPerpPosition` instruction. See `depositIntoIsolatedPerpPosition` for
	 * semantics.
	 * @param amount - Amount to deposit, in the position's quote spot market's token precision.
	 * @param perpMarketIndex - Perp market index of the isolated position to fund.
	 * @param userTokenAccount - Source token account for the deposit.
	 * @param subAccountId - Sub-account id owning the position; defaults to `this.activeSubAccountId`.
	 * @returns The instruction.
	 */
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

	/**
	 * Moves collateral between an isolated perp position's segregated balance and the sub-account's
	 * general/cross balance, in the same underlying quote spot market (derived from `perpMarketIndex`).
	 * Positive `amount` moves collateral **from general into the isolated position**; negative moves it
	 * **from the isolated position back to general**. If the requested outflow from the isolated
	 * position would exceed its current deposit (i.e. it needs unrealized PnL to be realized first, or
	 * the caller wants to withdraw everything), prepends a `TRY_SETTLE` settle-PnL instruction for
	 * `perpMarketIndex` before the transfer.
	 * @param amount - Signed amount to move, in the quote spot market's token precision (e.g.
	 * QUOTE_PRECISION (1e6) for USDC); positive = into the isolated position, negative = out of it. Pass
	 * `MIN_I64` to move the entire isolated deposit back to general.
	 * @param perpMarketIndex - Perp market index of the isolated position.
	 * @param subAccountId - Sub-account id owning the position; defaults to `this.activeSubAccountId`.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @param trySettle - If `true`, always prepends the `TRY_SETTLE` instruction even if not otherwise
	 * inferred as necessary.
	 * @param noBuffer - If `true`, sends `amount` unmodified; otherwise (default) adds a 0.5% buffer to
	 * the requested amount to absorb price movement between build and execution. Has no effect when
	 * `amount` is `MIN_I64`.
	 * @returns The transaction signature. Sent with `skipPreflight: true`.
	 */
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

	/**
	 * Builds the `transferIsolatedPerpPositionDeposit` instruction (without the `TRY_SETTLE` prepend —
	 * see `transferIsolatedPerpPositionDeposit` for the full sequence). See that method for the
	 * sign/precision convention of `amount`.
	 * @param amount - Signed amount to move, in the quote spot market's token precision; positive = into
	 * the isolated position, negative = out. Pass `MIN_I64` to move the entire isolated deposit out.
	 * @param perpMarketIndex - Perp market index of the isolated position.
	 * @param subAccountId - Sub-account id owning the position; defaults to `this.activeSubAccountId`.
	 * @param noAmountBuffer - If `true`, sends `amount` unmodified; otherwise adds a 0.5% buffer
	 * (ignored when `amount` is `MIN_I64`).
	 * @param signingAuthority - Signer for the instruction; defaults to `this.wallet.publicKey`.
	 * @returns The instruction.
	 */
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

	/**
	 * Withdraws collateral out of the protocol directly from an isolated perp position's segregated
	 * balance to a token account (as opposed to `withdraw`, which draws from the sub-account's
	 * general/cross balance). See `getWithdrawFromIsolatedPerpPositionIxsBundle` for the settle-PnL and
	 * amount-clamping logic applied first.
	 * @param amount - Amount to withdraw, in the position's quote spot market's token precision.
	 * @param perpMarketIndex - Perp market index of the isolated position to withdraw from.
	 * @param userTokenAccount - Destination token account for the withdrawal.
	 * @param subAccountId - Sub-account id owning the position; defaults to `this.activeSubAccountId`.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the full instruction sequence for `withdrawFromIsolatedPerpPosition`: computes the position's
	 * claimable unrealized PnL, and clamps `amount` to the isolated deposit plus that claimable PnL —
	 * the on-chain `amount` is `u64` with no "withdraw all" sentinel (unlike the sibling
	 * `transferIsolatedPerpPositionDeposit`, whose `i64` `amount` treats `i64::MIN` as one), so passing
	 * `BN` values larger than the withdrawable balance is how a caller requests "withdraw everything".
	 * Also prepends a `TRY_SETTLE` settle-PnL instruction for `perpMarketIndex` whenever the request
	 * draws into unrealized (unsettled) PnL. Note the clamp is a build-time estimate: if the settle
	 * realizes less than the claimable PnL (e.g. the market's PnL pool is short), the withdraw can still
	 * fail on-chain with `InsufficientCollateral`.
	 * @param amount - Amount to withdraw, in the position's quote spot market's token precision. Values
	 * exceeding the withdrawable balance are clamped to it (i.e. pass a huge value to withdraw all).
	 * @param perpMarketIndex - Perp market index of the isolated position to withdraw from.
	 * @param subAccountId - Sub-account id owning the position; defaults to `this.activeSubAccountId`.
	 * @param userTokenAccount - Destination token account; defaults to the signer's own associated token
	 * account for the position's quote spot market.
	 * @returns The ordered instructions (optional settle-PnL, then withdraw).
	 * @throws if `subAccountId` has no perp position in `perpMarketIndex`, or if the position has no
	 * withdrawable collateral (deposit plus claimable PnL is zero or negative).
	 */
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

		// On-chain amount is u64 with no "withdraw all" sentinel — clamp to the
		// withdrawable estimate instead of overshooting into InsufficientCollateral
		const amountToWithdraw = BN.min(amount, depositAmountPlusUnrealizedPnl);
		if (amountToWithdraw.lte(ZERO)) {
			throw new Error(
				`Isolated perp position in market ${perpMarketIndex} has no withdrawable collateral (deposit + claimable PnL = ${depositAmountPlusUnrealizedPnl.toString()})`
			);
		}
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

	/**
	 * Builds the raw `withdrawFromIsolatedPerpPosition` instruction (no settle-PnL/clamping — see
	 * `getWithdrawFromIsolatedPerpPositionIxsBundle` for the full sequence).
	 * @param amount - Amount to withdraw, in the position's quote spot market's token precision.
	 * The on-chain `amount` arg is `u64` (unsigned) with no "withdraw all" sentinel — the exact amount
	 * is withdrawn, and it must not exceed the isolated position's token balance. Use
	 * `getWithdrawFromIsolatedPerpPositionIxsBundle` for withdraw-all/clamping behavior.
	 * @param perpMarketIndex - Perp market index of the isolated position to withdraw from.
	 * @param userTokenAccount - Destination token account for the withdrawal.
	 * @param subAccountId - Sub-account id owning the position; defaults to `this.activeSubAccountId`.
	 * @returns The instruction.
	 */
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

	/**
	 * Permissionless crank: forces a spot market to accrue interest (updating
	 * `cumulativeDepositInterest`/`cumulativeBorrowInterest` and TWAP stats) up to the current slot. The
	 * instruction's accounts impose no authority/hot-role check beyond the transaction fee payer —
	 * anyone can call this to keep a market's interest current between organic deposit/withdraw/borrow
	 * activity.
	 * @param marketIndex - Spot market index to update.
	 * @param txParams - Optional compute-unit/priority-fee overrides for the transaction.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updateSpotMarketCumulativeInterest` instruction. See
	 * `updateSpotMarketCumulativeInterest` for semantics.
	 * @param marketIndex - Spot market index to update.
	 * @returns The instruction.
	 */
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
	 * Opens/increases a perp position with a market order (or a limit order if `limitPrice` is
	 * given), filled immediately against the AMM/makers via `placeAndTakePerpOrder`.
	 * @deprecated use `placePerpOrder` or `placeAndTakePerpOrder` instead.
	 * @param direction - `LONG` or `SHORT`.
	 * @param amount - Base asset amount to trade, BASE_PRECISION (1e9).
	 * @param marketIndex - Perp market index.
	 * @param limitPrice - Optional limit price, PRICE_PRECISION (1e6); omit for a pure market order.
	 * @param subAccountId - Sub-account to trade from; defaults to the active sub-account.
	 * @returns The transaction signature.
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

	/**
	 * Submits and confirms a transaction that has already been fully signed elsewhere (e.g. by an
	 * external/hardware wallet flow), skipping this client's normal build-and-sign step entirely. Not
	 * order/instruction-specific — works for any pre-signed `Transaction`/`VersionedTransaction`.
	 * @param tx - The already-signed transaction to send.
	 * @param opts - Confirmation options; defaults to `this.opts`.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds (without sending) the set of transactions needed to place a market order and,
	 * for legacy (non-versioned) transactions, a companion transaction that fills it against
	 * the AMM. Also builds optional companion transactions to cancel the market's existing
	 * orders first and/or settle PnL after the fill. Used by `sendMarketOrderAndGetSignedFillTx`.
	 * @param orderParams - Order to place; `orderParams.baseAssetAmount` is BASE_PRECISION (1e9)
	 * for perp (token-mint precision for spot), `orderParams.price` is PRICE_PRECISION (1e6).
	 * @param userAccountPublicKey - Public key of the placing user account (used for the
	 * post-fill settle-PnL instruction).
	 * @param userAccount - Decoded user account; supplies `subAccountId` and `nextOrderId`.
	 * @param makerInfo - Maker account(s) to include as fill counterparties, if any.
	 * @param txParams - Optional compute-unit/priority-fee overrides applied to all built transactions.
	 * @param bracketOrdersParams - Additional orders (e.g. TP/SL) placed in the same transaction as the market order.
	 * @param cancelExistingOrders - If `true` and `orderParams.marketType` is perp, also builds a
	 * transaction cancelling all existing open orders in that market — intended for auto-cancelling
	 * TP/SL orders when closing a position. Ignored for spot.
	 * @param settlePnl - If `true` and `orderParams.marketType` is perp, also builds a
	 * settle-PnL transaction for `orderParams.marketIndex`.
	 * @param positionMaxLev - If set, prepends an instruction to set a custom max-leverage margin
	 * ratio (`MARGIN_PRECISION`, 1e4, derived as `1 / positionMaxLev`) for the position before placing.
	 * @param isolatedPositionDepositAmount - If set and the order increases the position, prepends a
	 * transfer-into-isolated-position deposit instruction (token-mint precision) before placing.
	 * @returns An object with `marketOrderTx` (always present) and optional `cancelExistingOrdersTx`,
	 * `settlePnlTx`, `fillTx` (only built when `this.txVersion === 0`, i.e. legacy transactions).
	 */
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
	 * Sends a market order transaction and, for legacy (non-versioned) transactions, also returns
	 * a co-signed fill transaction the caller can broadcast themselves to fill the order against
	 * the AMM (useful when the caller wants to control fill timing/submission rather than relying
	 * on a keeper). Internally builds transactions via `prepareMarketOrderTxs`, signs them all, then
	 * sends only `marketOrderTx`.
	 * @param orderParams - Order to place; `baseAssetAmount` is BASE_PRECISION (1e9) for perp
	 * (token-mint precision for spot), `price` is PRICE_PRECISION (1e6).
	 * @param userAccountPublicKey - Public key of the placing user account.
	 * @param userAccount - Decoded user account; supplies `subAccountId` and `nextOrderId`.
	 * @param makerInfo - Maker account(s) to include as fill counterparties, if any.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param bracketOrdersParams - Additional orders (e.g. TP/SL) placed alongside the market order.
	 * @param cancelExistingOrders - Builds and returns an extra transaction to cancel the existing orders in the same perp market. Intended use is to auto-cancel TP/SL orders when closing a position. Ignored if orderParams.marketType is not MarketType.PERP.
	 * @param settlePnl - If `true` and the order is a perp order, also builds and returns a signed settle-PnL transaction for the order's market.
	 * @returns `txSig` for the sent market-order transaction, plus `signedFillTx` (only when
	 * `this.txVersion === 0`), `signedCancelExistingOrdersTx`, and `signedSettlePnlTx` — each
	 * `undefined` when not applicable/requested. None of the returned side transactions are sent;
	 * the caller must broadcast them.
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

	/**
	 * Places a single perp order without attempting to fill it in the same instruction — the
	 * order rests until a keeper (or a `placeAndTake*`/signed-msg fill) matches it. Use
	 * `placeAndTakePerpOrder` instead if the caller wants an immediate attempt to fill against
	 * the AMM/makers.
	 * @param orderParams - Order to place; `baseAssetAmount` is BASE_PRECISION (1e9), `price` /
	 * `triggerPrice` / `oraclePriceOffset` (signed) / `auctionStartPrice` / `auctionEndPrice` are
	 * PRICE_PRECISION (1e6).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account to place the order for; defaults to the active sub-account.
	 * @param isolatedPositionDepositAmount - If set and the order increases the position, a transfer
	 * into an isolated-margin position (token-mint precision) is prepended in the same transaction.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `placePerpOrder` instruction. See `placePerpOrder` for semantics. Automatically
	 * attaches the placing user's `RevenueShareEscrow` account when `orderParams` carries a
	 * builder code (`builderIdx`/`builderFeeTenthBps`).
	 * @param orderParams - Order to place; see `placePerpOrder` for field precisions.
	 * @param subAccountId - Sub-account to place the order for; defaults to the active sub-account.
	 * @param depositToTradeArgs - Pass when composing this instruction ahead of the user account
	 * actually existing on-chain yet (e.g. deposit-to-trade in the same transaction as account
	 * creation): `isMakingNewAccount` skips loading the (not-yet-existing) user account for
	 * `remainingAccounts`, and `depositMarketIndex` marks the deposit's spot market as readable.
	 * @returns The instruction.
	 */
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

	/**
	 * Admin instruction: finalizes settlement pricing for a perp market that has already been put
	 * into `Settlement` status (`market.status === MarketStatus.SETTLEMENT`), snapping the market's
	 * settlement price/oracle-twap so every position can subsequently be closed at that fixed price
	 * via `settlePNL`. Requires a warm- or cold-tier admin signer (`check_warm`).
	 * @param marketIndex - Perp market index to settle.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `settleExpiredMarket` instruction. See `settleExpiredMarket` for semantics. Signs
	 * with `this.wallet.publicKey` when not subscribed, or the state's `coldAdmin` when subscribed —
	 * the on-chain constraint accepts either a warm- or cold-tier admin, so passing `coldAdmin`
	 * always satisfies it regardless of which tier the actual signer holds.
	 * @param marketIndex - Perp market index to settle.
	 * @returns The instruction.
	 */
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

	/**
	 * Admin instruction: sweeps a settled (`MarketStatus.SETTLEMENT`) perp market's remaining fee
	 * pool and PnL pool balances into the quote spot market's revenue pool, once all user positions
	 * in the market have been settled out. Requires a warm- or cold-tier admin signer.
	 * @param marketIndex - Perp market index to sweep.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `settleExpiredMarketPoolsToRevenuePool` instruction. See
	 * `settleExpiredMarketPoolsToRevenuePool` for semantics.
	 * @param perpMarketIndex - Perp market index to sweep.
	 * @returns The instruction.
	 */
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
	 * @param orderId - Program-assigned order ID to cancel; omit to cancel the most recently
	 * placed order (resolved on-chain via `get_last_order_id`).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account the order belongs to; defaults to the active sub-account.
	 * @param overrides.withdrawIsolatedDepositAmount - If set and > 0, appends an isolated-margin
	 * withdrawal (token-mint precision) for the cancelled order's market in the same transaction;
	 * requires an explicit `orderId` (see note above).
	 * @returns The transaction signature.
	 * @see `getCancelOrderIx` to obtain the instruction without sending.
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
	 * @param orderId - Program-assigned order ID to cancel; omit (or `undefined`) to cancel the
	 * most recently placed order.
	 * @param subAccountId - Sub-account the order belongs to; defaults to the active sub-account.
	 * @returns The instruction.
	 * @see `cancelOrder` to send the transaction directly.
	 * @see `getCancelOrderByUserIdIx` to cancel by the caller-supplied `userOrderId`.
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

	/**
	 * Cancel an open order identified by its caller-supplied `userOrderId` and broadcast the
	 * transaction.
	 * @param userOrderId - Caller-chosen order slot (set via `OrderParams.userOrderId` at placement).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account the order belongs to; defaults to the active sub-account.
	 * @returns The transaction signature.
	 * @see `getCancelOrderByUserIdIx` to obtain the instruction without sending.
	 */
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

	/**
	 * Builds the `cancelOrderByUserId` instruction. See `cancelOrderByUserId` for semantics.
	 * @param userOrderId - Caller-chosen order slot (set via `OrderParams.userOrderId` at placement).
	 * @param subAccountId - Sub-account the order belongs to; defaults to the active sub-account.
	 * @throws If no open order with `userOrderId` is found in the cached user account (looked up
	 * client-side to resolve the order's market/oracle for `remainingAccounts`).
	 * @returns The instruction.
	 * @see `getCancelOrderIx` to cancel by the program-assigned order ID instead.
	 */
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
	 * @param orderIds - Program-assigned order IDs to cancel; an order ID that no longer exists is
	 * silently skipped. `undefined` sends an empty list on-chain, i.e. cancels nothing.
	 * @param txParams - The transaction parameters.
	 * @param subAccountId - The sub account id to cancel the orders for.
	 * @param user - The user to cancel the orders for. If provided, it will be prioritized over the subAccountId.
	 * @param overrides.authority - Signing authority to use instead of `this.wallet.publicKey`.
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
	 * @param orderIds - Program-assigned order IDs to cancel; an order ID that no longer exists is
	 * silently skipped. `undefined` sends an empty list on-chain, i.e. cancels nothing.
	 * @param subAccountId - The sub account id to cancel the orders for.
	 * @param user - The user to cancel the orders for. If provided, it will be prioritized over the subAccountId.
	 * @param overrides.authority - Signing authority to use instead of `this.wallet.publicKey`.
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

	/**
	 * Cancel all of a user's open orders matching the given (optional) filters, and broadcast the
	 * transaction. Any filter left `undefined` is not applied — calling with no filters cancels
	 * every open order on the sub-account.
	 * @param marketType - Only cancel orders of this market type (`PERP`/`SPOT`); combined with
	 * `marketIndex` to scope to one perp or spot market.
	 * @param marketIndex - Only cancel orders in this market index.
	 * @param direction - Only cancel orders on this side (`LONG`/`SHORT`).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account to cancel orders for; defaults to the active sub-account.
	 * @returns The transaction signature.
	 * @see `getCancelOrdersIx` to obtain the instruction without sending.
	 */
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

	/**
	 * Builds the `cancelOrders` instruction. See `cancelOrders` for filter semantics (`null`/`undefined`
	 * on any of `marketType`/`marketIndex`/`direction` means "don't filter on that field").
	 * @param marketType - Only cancel orders of this market type.
	 * @param marketIndex - Only cancel orders in this market index.
	 * @param direction - Only cancel orders on this side.
	 * @param subAccountId - Sub-account to cancel orders for; defaults to the active sub-account.
	 * @returns The instruction.
	 */
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

	/**
	 * Atomically cancels orders matching the given filters and places new orders in a single
	 * transaction (cancel instruction first, then place). Useful for order replacement flows
	 * (e.g. re-quoting) where the old orders must not be fillable in the gap before the new
	 * ones land.
	 * @param cancelOrderParams - Filters for which open orders to cancel; see `cancelOrders` for
	 * semantics (`undefined` fields are not filtered on).
	 * @param placeOrderParams - Orders to place after the cancel; `baseAssetAmount` is BASE_PRECISION
	 * (1e9), `price`/`triggerPrice`/`oraclePriceOffset` are PRICE_PRECISION (1e6).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account to operate on; defaults to the active sub-account.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Places a batch of orders (perp and/or spot) in a single instruction. None are filled
	 * in-instruction — each rests until matched by a keeper or a subsequent fill/place-and-take.
	 * @param params - Orders to place; `baseAssetAmount` is BASE_PRECISION (1e9) for perp
	 * (token-mint precision for spot), `price`/`triggerPrice`/`oraclePriceOffset` are
	 * PRICE_PRECISION (1e6).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account to place the orders for; defaults to the active sub-account.
	 * @param optionalIxs - Extra instructions to prepend to the transaction.
	 * @param isolatedPositionDepositAmount - If set and `params` has exactly one perp order that
	 * increases the position, a transfer into an isolated-margin position (token-mint precision)
	 * is prepended before placing. Ignored for batches of more than one order.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds (without sending) the `placeOrders` transaction. See `placeOrders` for semantics.
	 * @param params - Orders to place; see `placeOrders` for field precisions.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account to place the orders for; defaults to the active sub-account.
	 * @param optionalIxs - Extra instructions to prepend to the transaction.
	 * @param isolatedPositionDepositAmount - See `placeOrders`; only applied when `params.length === 1`.
	 * @returns An object with `placeOrdersTx`, the built (unsigned) transaction.
	 */
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
	/**
	 * Builds the `placeOrders` instruction. See `placeOrders` for semantics. Attaches the placing
	 * user's `RevenueShareEscrow` once (not per-order) when any order in the batch carries a
	 * builder code — the on-chain handler expects a single escrow account for the whole batch.
	 * @param params - Orders to place; every entry must set `marketType`. See `placeOrders` for
	 * field precisions.
	 * @param subAccountId - Sub-account to place the orders for; defaults to the active sub-account.
	 * @param overrides - `authority` overrides the signing authority (defaults to `this.wallet.publicKey`).
	 * @throws If any order in `params` omits `marketType`.
	 * @returns The instruction.
	 */
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

	/**
	 * Builds a `placeOrders` instruction followed by an instruction that sets a custom max-leverage
	 * margin ratio on the position for `params[0]`'s market. Unlike `placeOrders`, this bypasses the
	 * `RevenueShareEscrow` attachment for builder-coded orders (uses the raw `program.instruction`
	 * call directly) — don't use it for batches containing a builder-coded order.
	 * @param params - Orders to place; `baseAssetAmount` is BASE_PRECISION (1e9) for perp
	 * (token-mint precision for spot), `price`/`triggerPrice`/`oraclePriceOffset` are PRICE_PRECISION (1e6).
	 * @param positionMaxLev - Max leverage to apply to the position in `params[0].marketIndex`; converted
	 * to a MARGIN_PRECISION (1e4) margin ratio as `1 / positionMaxLev`.
	 * @param subAccountId - Sub-account to place the orders for; defaults to the active sub-account.
	 * @returns A two-element array: `[placeOrdersIx, setPositionMaxLevIx]`.
	 */
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
	 * Places multiple limit orders (`params.orderCount`, 2-32) distributed across a price range
	 * in a single instruction, none filled in-instruction — each rests until matched.
	 * @param params - Scale order parameters: `totalBaseAssetAmount` is BASE_PRECISION (1e9),
	 * `startPrice`/`endPrice` are PRICE_PRECISION (1e6); see `ScaleOrderParams` for the rest.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account to place the orders for; defaults to the active sub-account.
	 * @returns The transaction signature.
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

	/**
	 * Builds (without sending) the `placeScaleOrders` transaction. See `placeScaleOrders` for semantics.
	 * @param params - Scale order parameters; see `placeScaleOrders` for field precisions.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account to place the orders for; defaults to the active sub-account.
	 * @returns An object with `placeScaleOrdersTx`, the built (unsigned) transaction.
	 */
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

	/**
	 * Builds the `placeScaleOrders` instruction. See `placeScaleOrders` for semantics.
	 * @param params - Scale order parameters; see `placeScaleOrders` for field precisions.
	 * @param subAccountId - Sub-account to place the orders for; defaults to the active sub-account.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction that fills a resting DLOB perp order against one or more makers (or the
	 * AMM/vAMM when no maker matches). Permissionless — any signer can act as filler and earns the
	 * filler reward. Does not place or cancel orders itself; it only matches an order that is
	 * already on the book.
	 * @param userAccountPublicKey - Public key of the order owner's user account.
	 * @param user - Decoded user account of the order owner.
	 * @param order - The order to fill (`marketIndex`/`orderId`); defaults to the owner's most
	 * recently placed order (`nextOrderId - 1`) when omitted.
	 * @param makerInfo - Maker(s) to attempt to cross against; a single `MakerInfo` or an array.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param fillerSubAccountId - Filler's sub-account to credit; defaults to the active sub-account.
	 * @param fillerAuthority - Filler's authority, if different from this client's wallet (e.g.
	 * filling on behalf of a delegated sub-account); the filler user/user-stats PDAs are derived
	 * from this authority instead of `this.wallet.publicKey`.
	 * @param hasBuilderFee - Force-attach the taker's `RevenueShareEscrow` account, bypassing the
	 * automatic builder-code detection performed by `getFillPerpOrderIx`.
	 * @param takerEscrow - The taker's decoded `RevenueShareEscrow`. Required whenever the order
	 * carries a builder code or the taker is referred — the program rejects the fill if the escrow
	 * is owed but not attached.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `fillPerpOrder` instruction. See `fillPerpOrder` for semantics. Assembles maker
	 * accounts and the taker's `RevenueShareEscrow` (when owed) into `remainingAccounts` in the
	 * order the on-chain handler expects: user/maker market+oracle accounts first, then each
	 * maker's `(maker, makerStats)` pair, then the taker escrow meta last.
	 * @param userAccountPublicKey - Public key of the order owner's user account.
	 * @param userAccount - Decoded user account of the order owner.
	 * @param order - The order to fill (`marketIndex`/`orderId`); defaults to the owner's most
	 * recently placed order when omitted and `isSignedMsg` is false.
	 * @param makerInfo - Maker(s) to attempt to cross against.
	 * @param fillerSubAccountId - Filler's sub-account to credit; defaults to the active sub-account.
	 * @param isSignedMsg - Whether this fills a signed-msg (swift) order that has not yet been
	 * placed on-chain; when true, `order` is not required and the builder-escrow attachment is
	 * done optimistically (the order's builder flag cannot be inspected before it lands).
	 * @param fillerAuthority - Filler's authority if different from this client's wallet; the
	 * filler user/user-stats PDAs are derived from this authority.
	 * @param hasBuilderFee - Force-attach the taker escrow regardless of the detected builder flag.
	 * @param takerEscrow - The taker's decoded `RevenueShareEscrow`. Required to attach the escrow
	 * when the order has a builder code or the taker is referred with an initialized escrow — the
	 * on-chain handler rejects the fill if an owed escrow is missing from `remainingAccounts`.
	 * @throws If no order can be resolved to fill, or (for a non-signed-msg fill) `order` is omitted.
	 * @returns The instruction.
	 */
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

	/**
	 * Builds the `revertFill` instruction. Used by keepers as a same-transaction fallback after a
	 * simulated fill fails downstream (e.g. a subsequent instruction errors): it only asserts the
	 * filler's `lastActiveSlot` equals the current slot and otherwise is a no-op, letting the
	 * keeper's earlier fill CPI effects be discarded by the transaction failing cleanly rather than
	 * with a confusing downstream error.
	 * @param fillerPublicKey - Filler's user account public key; defaults to this client's own
	 * user account.
	 * @returns The instruction.
	 */
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

	/**
	 * Disabled. Spot DLOB trading (order placement/matching) is turned off in this deployment —
	 * spot balances, deposits, withdrawals, and swaps remain available.
	 * @throws Always throws with the spot-DLOB-disabled message.
	 */
	public async placeSpotOrder(
		_orderParams: OptionalOrderParams,
		_txParams?: TxParams,
		_subAccountId?: number
	): Promise<TransactionSignature> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	/**
	 * Disabled. See `placeSpotOrder`.
	 * @throws Always throws with the spot-DLOB-disabled message.
	 */
	public async preparePlaceSpotOrderTx(
		_orderParams: OptionalOrderParams,
		_txParams?: TxParams,
		_subAccountId?: number
	) {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	/**
	 * Disabled. See `placeSpotOrder`.
	 * @throws Always throws with the spot-DLOB-disabled message.
	 */
	public async getPlaceSpotOrderIx(
		_orderParams: OptionalOrderParams,
		_subAccountId?: number,
		_overrides?: {
			authority?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	/**
	 * Disabled. See `placeSpotOrder`.
	 * @throws Always throws with the spot-DLOB-disabled message.
	 */
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

	/**
	 * Disabled. See `placeSpotOrder`.
	 * @throws Always throws with the spot-DLOB-disabled message.
	 */
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
	 * Swaps one spot-market token for another inside the user's velocity account: brackets the
	 * external swap provider's instructions between the program's `beginSwap`/`endSwap`
	 * instructions in a single transaction, so the swap is settled directly against the user's
	 * deposits/vault balances rather than the wallet's own token accounts. Sends and confirms the
	 * transaction.
	 * @param swapClient - Swap client used to fetch routes/instructions (`UnifiedSwapClient` or a
	 * `TitanClient`); dispatches to `getSwapIxV2` or `getTitanSwapIx` respectively.
	 * @param jupiterClient - @deprecated Use `swapClient` instead. When passed (and `swapClient` is
	 * not), dispatches to `getJupiterSwapIxV6`.
	 * @param outMarketIndex - Spot market index of the token being bought.
	 * @param inMarketIndex - Spot market index of the token being sold.
	 * @param outAssociatedTokenAccount - Token account to receive the bought token; created
	 * idempotently if omitted.
	 * @param inAssociatedTokenAccount - Token account to source the sold token from; created
	 * idempotently if omitted.
	 * @param amount - Amount of the "in" token (or "out" token when `swapMode` is `ExactOut`, in
	 * which case this is the desired output amount), in the token's own mint decimals — not a
	 * fixed protocol precision.
	 * @param slippageBps - Max slippage in basis points passed to the swap provider's routing API.
	 * @param swapMode - `ExactIn` (default) or `ExactOut`.
	 * @param reduceOnly - Whether the in/out token's position on the velocity account must reduce
	 * (not flip sign); enforced by `endSwap` after the swap completes.
	 * @param v6 - @deprecated Use `quote` instead. Pre-fetched Jupiter v6 quote response.
	 * @param quote - Pre-fetched quote response (skips an extra round-trip to the swap provider).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @throws If neither `swapClient` nor `jupiterClient` is provided, or if `swapClient` is not a
	 * recognized client type.
	 * @returns The transaction signature.
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

	/**
	 * Builds the instruction list for a Titan-routed swap: creates any missing associated token
	 * accounts, wraps Titan's routing instructions between `beginSwap`/`endSwap`. See `swap` for
	 * parameter semantics; `amount` is in the "in" token's mint decimals.
	 * @param userAccountPublicKey - Optional user account override (e.g. when the account is being
	 * created in the same transaction and not yet resolvable via `getUserAccountPublicKey`).
	 * @returns `ixs` — instruction list (ATA creation, `beginSwap`, Titan swap instructions,
	 * `endSwap`, in order) and `lookupTables` needed to fit it in a versioned transaction.
	 */
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

	/**
	 * Builds the instruction list for a Jupiter v6-routed swap: fetches a quote if none is passed,
	 * creates any missing associated token accounts, and wraps Jupiter's routing instructions
	 * between `beginSwap`/`endSwap`. See `swap` for parameter semantics; `amount` is in the "in"
	 * token's mint decimals.
	 * @param userAccountPublicKey - Optional user account override (e.g. when the account is being
	 * created in the same transaction).
	 * @throws If no quote is passed and Jupiter's quote API returns none.
	 * @returns `ixs` — instruction list (ATA creation, `beginSwap`, Jupiter swap instructions,
	 * `endSwap`, in order) and `lookupTables` needed to fit it in a versioned transaction.
	 */
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
	 * Builds the `beginSwap`/`endSwap` instruction pair that must bracket an external swap
	 * provider's routing instructions in the same transaction. `beginSwap` snapshots the token
	 * account balances and moves `amountIn` out of the in-market vault; `endSwap` reconciles the
	 * post-swap token balances back into the user's velocity deposits, enforces `limitPrice` and
	 * `reduceOnly`, and validates both spot markets' oracles are fresh/valid.
	 * @param outMarketIndex - Spot market index of the token being bought.
	 * @param inMarketIndex - Spot market index of the token being sold.
	 * @param amountIn - Amount of the in-token released from the vault to the swap provider, in
	 * the in-token's own mint decimals (not a fixed protocol precision).
	 * @param inTokenAccount - Token account the sold tokens are moved through.
	 * @param outTokenAccount - Token account the bought tokens are moved through.
	 * @param limitPrice - Minimum acceptable `out/in` swap price, PRICE_PRECISION (1e6); `endSwap`
	 * throws `SwapLimitPriceBreached` if the realized price is lower. Omit for no price check.
	 * @param reduceOnly - Which side (`In`/`Out`) must not increase in magnitude after the swap;
	 * enforced by `endSwap`.
	 * @param userAccountPublicKey - Optional user account override; useful when the account is
	 * being created within the same transaction and not yet resolvable via
	 * `getUserAccountPublicKey`.
	 * @returns `{ beginSwapIx, endSwapIx }` — insert the swap provider's instructions between them.
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

	/**
	 * Builds the instruction list for a swap routed through a `UnifiedSwapClient` (the current
	 * preferred swap path). Creates any missing associated token accounts and wraps the client's
	 * routing instructions between `beginSwap`/`endSwap`. See `swap` for parameter semantics;
	 * `amount` is in the "in" token's mint decimals (or "out" token's decimals when `swapMode` is
	 * `ExactOut`).
	 * @param userAccountPublicKey - Optional user account override (e.g. when the account is being
	 * created in the same transaction).
	 * @returns `ixs` — instruction list (ATA creation, `beginSwap`, routed swap instructions,
	 * `endSwap`, in order) and `lookupTables` needed to fit it in a versioned transaction.
	 */
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

	/**
	 * Converts a portion of the user's deposited wSOL (spot market index 1) into mSOL (spot market
	 * index 2) by staking it with Marinade Finance, then swapping the resulting mSOL back into the
	 * velocity deposit via `beginSwap`/`endSwap`. Sends and confirms the transaction.
	 * @param amount - Amount of wSOL to stake, in lamports (wSOL mint decimals, 1e9).
	 * @returns The transaction signature and confirmation slot.
	 */
	public async stakeForMSOL({ amount }: { amount: BN }): Promise<TxSigAndSlot> {
		const ixs = await this.getStakeForMSOLIx({ amount });
		const tx = await this.buildTransaction(ixs);
		return this.sendTransaction(tx);
	}

	/**
	 * Builds the instruction list for `stakeForMSOL`: wraps a Marinade `deposit` (wSOL to mSOL)
	 * between the velocity `beginSwap`/`endSwap` pair so the mSOL lands back in the user's velocity
	 * deposit for spot market index 2. Hardcodes wSOL as market index 1 and mSOL as market index 2.
	 * @param amount - Amount of wSOL to stake, in lamports (wSOL mint decimals, 1e9).
	 * @param userAccountPublicKey - Optional user account override; useful when the account is
	 * being created within the same transaction.
	 * @returns The ordered instruction list (WSOL ATA setup, `beginSwap`, close/recreate wSOL
	 * account around the Marinade deposit, `endSwap`).
	 */
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

	/**
	 * Keeper instruction: activates a resting trigger order (stop/take-profit, perp or spot) once
	 * its `triggerPrice`/`triggerCondition` has been met, turning it into a fillable market/limit
	 * order. Permissionless — any signer can act as filler and earns a small keeper fee. Does not
	 * fill the order itself; a separate fill instruction (or place-and-take) is still required.
	 * @param userAccountPublicKey - Public key of the order owner's user account.
	 * @param user - Decoded user account for the order owner.
	 * @param order - The trigger order to activate (`order.orderId`, `order.marketType`, `order.marketIndex`).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param fillerPublicKey - Filler's user account public key; defaults to this client's own user account.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `triggerOrder` instruction. See `triggerOrder` for semantics.
	 * @param userAccountPublicKey - Public key of the order owner's user account.
	 * @param userAccount - Decoded user account for the order owner.
	 * @param order - The trigger order to activate.
	 * @param fillerPublicKey - Filler's user account public key; defaults to this client's own user account.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: cancels a user's open, non-position-reducing orders when the user fails
	 * their initial margin requirement (reverts with `SufficientCollateral` if the user still
	 * meets it, or with `UserIsBeingLiquidated`/`UserBankrupt` if either is set). Charges the user a
	 * per-cancelled-order fee paid to the filler. Permissionless — any signer can act as filler.
	 * @param userAccountPublicKey - Public key of the target user's user account.
	 * @param user - Decoded user account of the target user.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param fillerPublicKey - Filler's user account public key; defaults to this client's own user account.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `forceCancelOrders` instruction. See `forceCancelOrders` for semantics.
	 * @param userAccountPublicKey - Public key of the target user's user account.
	 * @param userAccount - Decoded user account of the target user.
	 * @param fillerPublicKey - Filler's user account public key; defaults to this client's own user account.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: marks a user account idle after confirming (via `validate_user_is_idle`)
	 * it has been inactive long enough — the inactivity window is shorter (accelerated) when the
	 * user's equity is below 1000 USDC (QUOTE_PRECISION, 1e6). Idle users are excluded from some
	 * keeper crank workloads. Permissionless — any signer can act as filler.
	 * @param userAccountPublicKey - Public key of the target user's user account.
	 * @param user - Decoded user account of the target user.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param fillerPublicKey - Filler's user account public key; defaults to this client's own user account.
	 * @throws If the user does not yet qualify as idle.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updateUserIdle` instruction. See `updateUserIdle` for semantics.
	 * @param userAccountPublicKey - Public key of the target user's user account.
	 * @param userAccount - Decoded user account of the target user.
	 * @param fillerPublicKey - Filler's user account public key; defaults to this client's own user account.
	 * @returns The instruction.
	 */
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

	/**
	 * Debug/monitoring instruction: emits the user's equity, each non-zero spot position's signed
	 * token amount (native mint decimals), and each open perp position's unrealized PnL
	 * (QUOTE_PRECISION, 1e6) as program logs. Has no on-chain state effect. Exchange must not be
	 * paused.
	 * @param userAccountPublicKey - Public key of the user account to log.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `logUserBalances` instruction. See `logUserBalances` for semantics. Fetches the
	 * user account fresh from the RPC (rather than relying on a cached/passed-in account) to build
	 * `remainingAccounts`.
	 * @param userAccountPublicKey - Public key of the user account to log.
	 * @returns The instruction.
	 */
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

	/**
	 * Recomputes and updates the `isReferrer` flag on a `UserStats` account from its current
	 * referrer-related fields. Permissionless — anyone can trigger the refresh for any authority.
	 * @param userAuthority - Wallet authority whose `UserStats` PDA should be refreshed.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updateUserStatsReferrerStatus` instruction. See `updateUserStatsReferrerStatus`
	 * for semantics.
	 * @param userAuthority - Wallet authority whose `UserStats` PDA should be refreshed.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: recounts `user.orders` and rewrites `openOrders`/`hasOpenOrder`/
	 * `openAuctions`/`hasOpenAuction` to match the account's actual order state — a repair
	 * instruction for when these cached counters have drifted. Permissionless — any signer can act
	 * as filler.
	 * @param userAccountPublicKey - Public key of the target user's user account.
	 * @param user - Decoded user account of the target user.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param fillerPublicKey - Filler's user account public key; defaults to this client's own user account.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updateUserOpenOrdersCount` instruction. See `updateUserOpenOrdersCount` for
	 * semantics.
	 * @param userAccountPublicKey - Public key of the target user's user account.
	 * @param userAccount - Decoded user account of the target user.
	 * @param fillerPublicKey - Filler's user account public key; defaults to this client's own user account.
	 * @returns The instruction.
	 */
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

	/**
	 * Places a perp order and immediately attempts to fill it in the same instruction against the
	 * AMM and/or the supplied `makerInfo`. `orderParams.postOnly` must be `PostOnlyParams.NONE` —
	 * the on-chain handler rejects post-only orders here (use `placeAndMakePerpOrder` instead for a
	 * post-only maker order). If the order is immediate-or-cancel (or `successCondition`/
	 * `auctionDurationPercentage` is set) and still open after the fill attempt, it is cancelled
	 * in the same instruction.
	 * @param orderParams - Order to place; `baseAssetAmount` is BASE_PRECISION (1e9), `price`/
	 * `triggerPrice`/`oraclePriceOffset` (signed) are PRICE_PRECISION (1e6).
	 * @param makerInfo - Maker account(s) to include as fill counterparties, if any.
	 * @param successCondition - Require the fill to be a `PartialFill` or `FullFill`; the
	 * instruction reverts with `PlaceAndTakeOrderSuccessConditionFailed` if not met. Omit for no check.
	 * @param auctionDurationPercentage - Percent (0-100, default 100) of the order's auction that
	 * must have elapsed before this fill attempt is allowed to cross the AMM/makers at the current
	 * auction price; packed on-chain into the same `u32` as `successCondition`.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account to place the order for; defaults to the active sub-account.
	 * @param takerEscrow - The placing user's (taker's) decoded `RevenueShareEscrow`. Required to
	 * attach the escrow account when the taker is referred but the order itself carries no builder
	 * code — the builder case is detected automatically from `orderParams`.
	 * @returns The transaction signature.
	 */
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
	/**
	 * Builds (without sending) a `placeAndTakePerpOrder` transaction bundled with optional bracket
	 * orders (e.g. TP/SL) in the same transaction, plus optional companion transactions to cancel
	 * the market's existing orders first and/or settle PnL after. Reuses a single recent blockhash
	 * across all built transactions to save RPC round trips.
	 * @param orderParams - Order to place; see `placeAndTakePerpOrder` for field precisions.
	 * @param makerInfo - Maker account(s) to include as fill counterparties, if any.
	 * @param bracketOrdersParams - Additional orders placed in the same transaction as the place-and-take.
	 * @param txParams - Compute-unit/priority-fee overrides. Required (throws otherwise) if
	 * `txParams.useSimulatedComputeUnits` is set or `exitEarlyIfSimFails` is `true`.
	 * @param subAccountId - Sub-account to place the order for; defaults to the active sub-account.
	 * @param cancelExistingOrders - If `true` and the order is perp, also builds a transaction
	 * cancelling all existing open orders in that market.
	 * @param settlePnl - If `true` and the order is perp, also builds a settle-PnL transaction for the market.
	 * @param exitEarlyIfSimFails - If `true`, simulates the place-and-take transaction first and
	 * returns `null` without building the real transactions if the simulation fails.
	 * @param auctionDurationPercentage - See `placeAndTakePerpOrder`.
	 * @param optionalIxs - Extra instructions prepended to the place-and-take transaction (and to
	 * the cancel/settle-PnL transactions).
	 * @param isolatedPositionDepositAmount - If set and the order increases the position, a
	 * transfer into an isolated-margin position (token-mint precision) is prepended before placing.
	 * @returns `null` if `exitEarlyIfSimFails` triggered an early exit; otherwise an object with
	 * `placeAndTakeTx` and optional `cancelExistingOrdersTx`/`settlePnlTx` (each `undefined` when
	 * not applicable).
	 */
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

	/**
	 * Builds, signs, and sends a `placeAndTakePerpOrder` transaction bundled with bracket orders via
	 * `preparePlaceAndTakePerpOrderWithAdditionalOrders`, and returns the signed (but unsent)
	 * companion cancel/settle-PnL transactions for the caller to broadcast separately.
	 * @param orderParams - Order to place; see `placeAndTakePerpOrder` for field precisions.
	 * @param makerInfo - Maker account(s) to include as fill counterparties, if any.
	 * @param bracketOrdersParams - Additional orders placed in the same transaction as the place-and-take.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account to place the order for; defaults to the active sub-account.
	 * @param cancelExistingOrders - See `preparePlaceAndTakePerpOrderWithAdditionalOrders`.
	 * @param settlePnl - See `preparePlaceAndTakePerpOrderWithAdditionalOrders`.
	 * @param exitEarlyIfSimFails - If `true`, returns `null` without sending when the pre-flight
	 * simulation of the place-and-take transaction fails.
	 * @returns `null` if the simulation failed and `exitEarlyIfSimFails` was set; otherwise `txSig`
	 * for the sent place-and-take transaction plus the signed (unsent) `signedCancelExistingOrdersTx`
	 * / `signedSettlePnlTx`, each `undefined` when not applicable.
	 * @throws If `placeAndTakeTx` was not built (should not happen unless simulation-related options are misused).
	 */
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

	/**
	 * Builds the `placeAndTakePerpOrder` instruction. See `placeAndTakePerpOrder` for semantics.
	 * @param orderParams - Order to place; see `placeAndTakePerpOrder` for field precisions.
	 * @param makerInfo - Maker account(s) to include as fill counterparties, if any.
	 * @param successCondition - See `placeAndTakePerpOrder`.
	 * @param auctionDurationPercentage - See `placeAndTakePerpOrder`.
	 * @param subAccountId - Sub-account to place the order for; defaults to the active sub-account.
	 * @param overrides - `authority` overrides the signing authority (defaults to `this.wallet.publicKey`).
	 * @param takerEscrow - See `placeAndTakePerpOrder`.
	 * @returns The instruction.
	 */
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

	/**
	 * Places a resting maker order and, in the same instruction, fills a specific counterparty
	 * taker order (`takerInfo.order`) against it. `orderParams` must be an immediate-or-cancel,
	 * post-only (not `PostOnlyParams.NONE`) limit order — the on-chain handler rejects any other
	 * shape with `InvalidOrderIOCPostOnly`.
	 * @param orderParams - Maker order to place; `baseAssetAmount` is BASE_PRECISION (1e9), `price`
	 * is PRICE_PRECISION (1e6). Must have `orderType: LIMIT`, `postOnly` set, and be IOC.
	 * @param takerInfo - The taker account/order to fill against (`takerInfo.order.orderId` must be open).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account placing the maker order; defaults to the active sub-account.
	 * @param takerEscrow - The taker's decoded `RevenueShareEscrow`. Required to attach the escrow
	 * when the taker is referred but their order carries no builder code — the builder case is
	 * detected automatically from `takerInfo.order`.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `placeAndMakePerpOrder` instruction. See `placeAndMakePerpOrder` for semantics.
	 * @param orderParams - Maker order to place; see `placeAndMakePerpOrder` for field precisions
	 * and required order shape.
	 * @param takerInfo - The taker account/order to fill against.
	 * @param subAccountId - Sub-account placing the maker order; defaults to the active sub-account.
	 * @param takerEscrow - See `placeAndMakePerpOrder`.
	 * @returns The instruction.
	 */
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

	/**
	 * Borsh-encodes a swift/signed-msg order message and signs the resulting hex-encoded buffer
	 * with `signMessage` (this client's wallet keypair by default). The returned payload is what a
	 * swift/signed-msg service or a taker-facing `placeSignedMsgTakerOrder` expects.
	 * @param orderParamsMessage - The order message to sign; use `SignedMsgOrderParamsDelegateMessage`
	 * when signing on behalf of a delegated authority (`delegateSigner: true`), otherwise
	 * `SignedMsgOrderParamsMessage`.
	 * @param delegateSigner - Whether `orderParamsMessage` is the delegate-signer variant; must match
	 * the message's actual shape or encoding/decoding elsewhere will misinterpret the buffer.
	 * @returns `{ orderParams, signature }` — `orderParams` is the hex-encoded borsh buffer as a
	 * `Buffer`, `signature` is the detached ed25519 signature over it.
	 */
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
	 * Bundles a pre-signed deposit transaction with a signed swift/signed-msg order message into
	 * the request shape the Swift service expects for a "deposit and place" flow (e.g. depositing
	 * new collateral and placing an order off-chain in one round trip before either lands on-chain).
	 * @param depositTx - The signed tx containing a velocity deposit (e.g. see `buildSwiftDepositTx`).
	 * @param orderParamsMessage - The order parameters message to sign.
	 * @param delegateSigner - Whether `orderParamsMessage` is signed by a delegate; see `signSignedMsgOrderParamsMessage`.
	 * @returns `{ deposit_tx, swift_order }` — the serialized deposit transaction and the signed order payload.
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

	/**
	 * Borsh-encodes a swift/signed-msg order message using the program's IDL type coder. Used
	 * internally by `signSignedMsgOrderParamsMessage`; call directly if you need the raw encoded
	 * bytes without also signing them.
	 * @param orderParamsMessage - The order message to encode.
	 * @param delegateSigner - Whether `orderParamsMessage` is the delegate-signer variant
	 * (`SignedMsgOrderParamsDelegateMessage`) rather than the regular one — selects which on-chain
	 * type is used to encode.
	 * @returns The borsh-encoded message bytes.
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

	/**
	 * Decodes a borsh-encoded swift/signed-msg order message. Zero-pads the input by 128 bytes
	 * before decoding so messages encoded by an older IDL (missing newer, all-`Option` fields)
	 * still decode instead of throwing on a too-short buffer. Note: this padding assumes any
	 * newer fields added to the message type are `Option`s — a 128+ byte non-optional field
	 * addition could still fail to decode older messages correctly.
	 * @param encodedMessage - The borsh-encoded message bytes (as produced by `encodeSignedMsgOrderParamsMessage`).
	 * @param delegateSigner - Whether to decode as the delegate-signer variant
	 * (`SignedMsgOrderParamsDelegateMessage`) rather than the regular one.
	 * @returns The decoded order message.
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

	/**
	 * Signs arbitrary bytes with a raw ed25519 detached signature (not a Solana transaction
	 * signature) — the primitive used to sign swift/signed-msg order messages.
	 * @param message - Bytes to sign.
	 * @param keypair - Keypair to sign with; defaults to `this.wallet.payer`.
	 * @throws If no keypair is available (e.g. the configured wallet has no local `payer`, such as
	 * a browser-extension wallet — that case must sign the message externally instead).
	 * @returns The detached ed25519 signature.
	 */
	public signMessage(
		message: Uint8Array,
		keypair: Keypair | undefined = this.wallet.payer
	): Buffer {
		if (!keypair) {
			throw new Error('No keypair available to sign message');
		}
		return Buffer.from(nacl.sign.detached(message, keypair.secretKey));
	}

	/**
	 * Submits a previously off-chain-signed swift/signed-msg taker order on-chain: verifies the
	 * ed25519 signature via the sysvar-instructions program and records the order in the taker's
	 * `SignedMsgUserOrders` account (see `initializeSignedMsgUserOrders`, required beforehand).
	 * This only registers the order — it does not place or fill it against the market; a keeper
	 * (or `placeAndMakeSignedMsgPerpOrder`) still performs the actual place/fill.
	 * @param signedSignedMsgOrderParams - The signed order payload from `signSignedMsgOrderParamsMessage`.
	 * @param marketIndex - Perp market index the signed order targets.
	 * @param takerInfo - Taker's account/authority info; `signingAuthority` is the delegate or
	 * direct authority that produced the signature (compared against `takerUserAccount.delegate`
	 * to determine whether the message decodes as the delegate-signer variant).
	 * @param precedingIxs - Instructions that will precede the returned ones in the final
	 * transaction; used only to compute the correct sysvar-instructions index for signature
	 * verification (has no other effect — the caller is still responsible for including them).
	 * @param overrideCustomIxIndex - Explicit index of the ed25519-verify instruction within the
	 * final transaction; overrides the value derived from `precedingIxs.length`.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the two instructions for `placeSignedMsgTakerOrder`: an ed25519-signature-verify
	 * instruction (must be placed at the sysvar-instructions index this function assumes — see
	 * `precedingIxs`/`overrideCustomIxIndex`) followed by the `placeSignedMsgTakerOrder` program
	 * instruction. See `placeSignedMsgTakerOrder` for semantics.
	 * @param signedSignedMsgOrderParams - The signed order payload.
	 * @param marketIndex - Perp market index the signed order targets.
	 * @param takerInfo - Taker's account/authority info; see `placeSignedMsgTakerOrder`.
	 * @param precedingIxs - Instructions preceding these two in the final transaction (used only
	 * to compute the ed25519-verify instruction's sysvar index).
	 * @param overrideCustomIxIndex - Explicit sysvar-instructions index override.
	 * @returns `[ed25519VerifyIx, placeSignedMsgTakerOrderIx]`.
	 */
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

	/**
	 * Verifies and registers a taker's off-chain signed swift/signed-msg order (same as
	 * `placeSignedMsgTakerOrder`) and, in the same transaction, places a maker order and fills the
	 * taker order against it in one shot — the signed-msg analog of `placeAndMakePerpOrder`.
	 * `orderParams` (the maker order) is subject to the same IOC/post-only/limit requirement as
	 * `placeAndMakePerpOrder`.
	 * @param signedSignedMsgOrderParams - The taker's signed order payload.
	 * @param signedMsgOrderUuid - UUID identifying the signed-msg order, used by the program to
	 * dedupe/match it against the recorded `SignedMsgUserOrders` entry.
	 * @param takerInfo - Taker's account/authority info; see `placeSignedMsgTakerOrder`.
	 * @param orderParams - Maker order to place; `baseAssetAmount` is BASE_PRECISION (1e9), `price`
	 * is PRICE_PRECISION (1e6). Must have `orderType: LIMIT`, `postOnly` set, and be IOC.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account placing the maker order; defaults to the active sub-account.
	 * @param precedingIxs - Instructions preceding these in the final transaction (used only to
	 * compute the ed25519-verify instruction's sysvar index).
	 * @param overrideCustomIxIndex - Explicit sysvar-instructions index override.
	 * @param takerEscrow - The taker's decoded `RevenueShareEscrow`. Required to attach the escrow
	 * when the taker is referred but the signed order carries no builder code.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the instructions for `placeAndMakeSignedMsgPerpOrder`: the taker signature-verify +
	 * registration instructions from `getPlaceSignedMsgTakerPerpOrderIxs`, followed by the
	 * `placeAndMakeSignedMsgPerpOrder` program instruction. See `placeAndMakeSignedMsgPerpOrder`
	 * for semantics.
	 * @param signedSignedMsgOrderParams - The taker's signed order payload.
	 * @param signedMsgOrderUuid - UUID identifying the signed-msg order.
	 * @param takerInfo - Taker's account/authority info.
	 * @param orderParams - Maker order to place; see `placeAndMakeSignedMsgPerpOrder` for field
	 * precisions and required order shape.
	 * @param subAccountId - Sub-account placing the maker order; defaults to the active sub-account.
	 * @param precedingIxs - Instructions preceding these in the final transaction (used only to
	 * compute the ed25519-verify instruction's sysvar index).
	 * @param overrideCustomIxIndex - Explicit sysvar-instructions index override.
	 * @param takerEscrow - See `placeAndMakeSignedMsgPerpOrder`.
	 * @returns `[ed25519VerifyIx, placeSignedMsgTakerOrderIx, placeAndMakeSignedMsgPerpOrderIx]`.
	 */
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

	/**
	 * Disabled. See `placeSpotOrder`.
	 * @throws Always throws with the spot-DLOB-disabled message.
	 */
	public async preparePlaceAndTakeSpotOrder(
		_orderParams: OptionalOrderParams,
		_fulfillmentConfig?: unknown,
		_makerInfo?: MakerInfo,
		_txParams?: TxParams,
		_subAccountId?: number
	) {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	/**
	 * Disabled. See `placeSpotOrder`.
	 * @throws Always throws with the spot-DLOB-disabled message.
	 */
	public async placeAndTakeSpotOrder(
		_orderParams: OptionalOrderParams,
		_fulfillmentConfig?: unknown,
		_makerInfo?: MakerInfo,
		_txParams?: TxParams,
		_subAccountId?: number
	): Promise<TransactionSignature> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	/**
	 * Disabled. See `placeSpotOrder`.
	 * @throws Always throws with the spot-DLOB-disabled message.
	 */
	public async getPlaceAndTakeSpotOrderIx(
		_orderParams: OptionalOrderParams,
		_fulfillmentConfig?: unknown,
		_makerInfo?: MakerInfo,
		_subAccountId?: number
	): Promise<TransactionInstruction> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	/**
	 * Disabled. See `placeSpotOrder`.
	 * @throws Always throws with the spot-DLOB-disabled message.
	 */
	public async placeAndMakeSpotOrder(
		_orderParams: OptionalOrderParams,
		_takerInfo: TakerInfo,
		_fulfillmentConfig?: unknown,
		_txParams?: TxParams,
		_subAccountId?: number
	): Promise<TransactionSignature> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	/**
	 * Disabled. See `placeSpotOrder`.
	 * @throws Always throws with the spot-DLOB-disabled message.
	 */
	public async getPlaceAndMakeSpotOrderIx(
		_orderParams: OptionalOrderParams,
		_takerInfo: TakerInfo,
		_fulfillmentConfig?: unknown,
		_subAccountId?: number
	): Promise<TransactionInstruction> {
		throw new Error(SPOT_DLOB_TRADING_DISABLED_MSG);
	}

	/**
	 * Closes (or reduces to zero) the caller's entire perp position in `marketIndex` with a
	 * reduce-only market order (or limit order if `limitPrice` is given), filled immediately via
	 * `placeAndTakePerpOrder`.
	 * @deprecated use `placePerpOrder` or `placeAndTakePerpOrder` instead.
	 * @param marketIndex - Perp market index of the position to close.
	 * @param limitPrice - Optional limit price, PRICE_PRECISION (1e6); omit for a pure market order.
	 * @param subAccountId - Sub-account holding the position; defaults to the active sub-account.
	 * @throws If there is no open position in `marketIndex` for the sub-account.
	 * @returns The transaction signature.
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
	 * @deprecated use `modifyOrder` instead.
	 * @param orderId - The open order to modify (program-assigned order ID).
	 * @param newBaseAmount - The new base amount for the order, BASE_PRECISION (1e9). One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newLimitPrice - The new limit price for the order, PRICE_PRECISION (1e6). One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newOraclePriceOffset - The new oracle price offset for the order, PRICE_PRECISION (1e6), signed. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @returns The transaction signature.
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
	 * @deprecated use `modifyOrderByUserOrderId` instead.
	 * @param userOrderId - The open order to modify (caller-supplied `userOrderId`).
	 * @param newBaseAmount - The new base amount for the order, BASE_PRECISION (1e9). One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newLimitPrice - The new limit price for the order, PRICE_PRECISION (1e6). One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newOraclePriceOffset - The new oracle price offset for the order, PRICE_PRECISION (1e6), signed. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @returns The transaction signature.
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
	 * Modifies an open order (spot or perp) by closing it and replacing it with a new order in one
	 * instruction. Only fields present (non-`undefined`) in `orderParams` are changed; the rest of
	 * the order is left as-is.
	 * @param orderParams.orderId - The open order to modify (program-assigned order ID).
	 * @param orderParams.newDirection - The new direction for the order.
	 * @param orderParams.newBaseAmount - The new base amount for the order, BASE_PRECISION (1e9).
	 * @param orderParams.newLimitPrice - The new limit price for the order, PRICE_PRECISION (1e6).
	 * @param orderParams.newOraclePriceOffset - The new oracle price offset for the order, PRICE_PRECISION (1e6), signed.
	 * @param orderParams.newTriggerPrice - Optional - the new trigger price for the order, PRICE_PRECISION (1e6).
	 * @param orderParams.auctionDuration - Slots the auction lasts; only relevant for market/oracle orders.
	 * @param orderParams.auctionStartPrice - PRICE_PRECISION (1e6), signed; only relevant for market/oracle orders.
	 * @param orderParams.auctionEndPrice - PRICE_PRECISION (1e6), signed; only relevant for market/oracle orders.
	 * @param orderParams.reduceOnly - Whether the modified order must only reduce the position.
	 * @param orderParams.postOnly - Post-only behavior for the modified order.
	 * @param orderParams.bitFlags - Bitmask, see `OrderParamsBitFlag`.
	 * @param orderParams.policy - Bitmask of `ModifyOrderPolicy` (e.g. `MustModify`, `ExcludePreviousFill`).
	 * @param orderParams.maxTs - Unix timestamp after which the order expires.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account the order belongs to; defaults to the active sub-account.
	 * @returns The transaction signature.
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
	 * Builds the `modifyOrder` instruction. See `modifyOrder` for field semantics/precisions.
	 * @param orderParams - The parameters for the order to modify.
	 * @param subAccountId - Optional - the sub-account ID of the user to modify the order for; ignored if `overrides.user` is set.
	 * @param overrides - `user` supplies a fully-loaded `User` to modify on behalf of (takes precedence over `subAccountId`); `authority` overrides the signing authority (defaults to `overrides.user`'s authority, else `this.wallet.publicKey`).
	 * @throws If `overrides.user` is provided but its `UserAccount` isn't loaded.
	 * @returns The instruction.
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
	 * Modifies an open order (identified by its caller-supplied `userOrderId`) by closing it and
	 * replacing it with a new order in one instruction.
	 *
	 * Note: unlike `modifyOrder`, omitted `reduceOnly`/`bitFlags` are sent as `false`/`null`
	 * respectively rather than "leave unchanged" — passing this method's `orderParams` without
	 * `reduceOnly` will explicitly clear an existing reduce-only flag on the order.
	 * @param orderParams.userOrderId - The open order to modify (caller-supplied `userOrderId`).
	 * @param orderParams.newDirection - The new direction for the order.
	 * @param orderParams.newBaseAmount - The new base amount for the order, BASE_PRECISION (1e9).
	 * @param orderParams.newLimitPrice - The new limit price for the order, PRICE_PRECISION (1e6).
	 * @param orderParams.newOraclePriceOffset - The new oracle price offset for the order, PRICE_PRECISION (1e6), signed.
	 * @param orderParams.newTriggerPrice - Optional - the new trigger price for the order, PRICE_PRECISION (1e6).
	 * @param orderParams.auctionDuration - Only required if order type changed to market from something else; slots.
	 * @param orderParams.auctionStartPrice - Only required if order type changed to market from something else; PRICE_PRECISION (1e6), signed.
	 * @param orderParams.auctionEndPrice - Only required if order type changed to market from something else; PRICE_PRECISION (1e6), signed.
	 * @param orderParams.reduceOnly - Whether the modified order must only reduce the position; defaults to `false` if omitted.
	 * @param orderParams.postOnly - Post-only behavior for the modified order.
	 * @param orderParams.bitFlags - Bitmask, see `OrderParamsBitFlag`; defaults to unset if omitted.
	 * @param orderParams.policy - `ModifyOrderPolicy` bitmask (e.g. `MustModify`, `ExcludePreviousFill`).
	 * @param orderParams.maxTs - Unix timestamp after which the order expires.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param subAccountId - Sub-account the order belongs to; defaults to the active sub-account.
	 * @returns The transaction signature.
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

	/**
	 * Builds the `modifyOrderByUserOrderId` instruction. See `modifyOrderByUserOrderId` for field
	 * semantics/precisions, including the `reduceOnly`/`bitFlags` default-clearing note.
	 * @param orderParams - The parameters for the order to modify.
	 * @param subAccountId - Sub-account the order belongs to; defaults to the active sub-account.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: settles unrealized perp PnL to/from each user's quote spot balance for
	 * every `(user, marketIndex)` pair, one `settlePnl` instruction per pair in a single
	 * transaction. Permissionless — any signer can act as the settling authority. Defaults to
	 * `computeUnits: 1_400_000` if `txParams` is not supplied, since settling several users/markets
	 * in one transaction is compute-heavy.
	 * @param users - Users to settle, each with their user account public key and decoded account.
	 * @param marketIndexes - Perp market indexes to settle for every user in `users`.
	 * @param opts.filterInvalidMarkets - When true, drops any market index whose oracle currently
	 * fails `isOracleValid` (per the on-chain oracle guard rails) before building instructions,
	 * instead of letting the transaction fail on-chain for that market.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds one `settlePnl` instruction per `(user, marketIndex)` combination in `users` x
	 * `marketIndexes`. See `settlePNL`/`settlePNLIx` for per-instruction semantics.
	 * @param users - Users to settle, each with their user account public key and decoded account.
	 * @param marketIndexes - Perp market indexes to settle for every user in `users`.
	 * @param revenueShareEscrowMap - Optional builder/referral escrow lookup; when a user's escrow
	 * has completed builder or referral orders on a market being settled, its `RevenueShareEscrow`
	 * and builder/referrer accounts are attached so the on-chain sweep can pay them out.
	 * @returns The ordered instruction list.
	 */
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

	/**
	 * Keeper instruction: settles a single user's unrealized perp PnL on one market to/from their
	 * quote spot balance. Reads the live oracle (falling back to the AMM's freshness check only if
	 * the live oracle is degraded); requires the market not be in `Settlement` status (use
	 * `settleExpiredMarket`/expired-position settlement for that) and the quote spot market vault
	 * balance to reconcile afterward. Permissionless — any signer can act as the settling authority.
	 * @param settleeUserAccountPublicKey - Public key of the user account to settle.
	 * @param settleeUserAccount - Decoded user account to settle.
	 * @param marketIndex - Perp market index to settle.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param optionalIxs - Extra instructions prepended to the settle transaction.
	 * @param revenueShareEscrowMap - Optional builder/referral escrow lookup; see `settlePNLIx`.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `settlePnl` instruction. See `settlePNL` for semantics. When
	 * `revenueShareEscrowMap` is passed, inspects the settlee's `RevenueShareEscrow` for
	 * completed, unpaid builder-fee or referral-reward orders on `marketIndex` and, if found,
	 * appends the escrow PDA plus each relevant builder/referrer authority to
	 * `remainingAccounts` so the on-chain sweep can pay them during settlement. Falls back to
	 * attaching just the escrow PDA (for lazy cleanup) when the settlee has any builder order but
	 * isn't present in the map (stale-cache case).
	 * @param settleeUserAccountPublicKey - Public key of the user account to settle.
	 * @param settleeUserAccount - Decoded user account to settle.
	 * @param marketIndex - Perp market index to settle.
	 * @param revenueShareEscrowMap - Optional builder/referral escrow lookup keyed by authority.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: settles one user's unrealized perp PnL across several markets in a
	 * single `settleMultiplePnl` instruction/transaction. Fits at most ~4 markets per transaction
	 * (see `settleMultiplePNLsMultipleTxs` for more). Permissionless — any signer can act as the
	 * settling authority.
	 * @param settleeUserAccountPublicKey - Public key of the user account to settle.
	 * @param settleeUserAccount - Decoded user account to settle.
	 * @param marketIndexes - Perp market indexes to settle (all in one transaction).
	 * @param mode - `MustSettle` aborts the whole instruction if any per-market settlement fails;
	 * `TrySettle` logs and skips failures so the remaining markets still settle.
	 * @param revenueShareEscrowMap - Optional builder/referral escrow lookup; see `settlePNLIx`.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Settles one user's unrealized perp PnL across an arbitrary number of markets by splitting
	 * `marketIndexes` into groups of 4 (more than ~4 markets' worth of accounts won't fit in a
	 * single transaction) and sending one `settleMultiplePnl` transaction per group, sequentially.
	 * Compute units scale with group size (`300_000` per market, capped at `1_400_000`).
	 * @param settleeUserAccountPublicKey - Public key of the user account to settle.
	 * @param settleeUserAccount - Decoded user account to settle.
	 * @param marketIndexes - Perp market indexes to settle, in any quantity.
	 * @param mode - `MustSettle` or `TrySettle`; see `settleMultiplePNLs`.
	 * @param txParams - Optional compute-unit/priority-fee overrides (compute units are overridden
	 * per group regardless of what is passed here).
	 * @param optionalIxs - Extra instructions prepended to every group's transaction.
	 * @param revenueShareEscrowMap - Optional builder/referral escrow lookup; see `settlePNLIx`.
	 * @returns One transaction signature per group of up to 4 markets, in group order.
	 */
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

	/**
	 * Builds the `settleMultiplePnl` instruction. See `settleMultiplePNLs` for semantics. Attaches
	 * the settlee's `RevenueShareEscrow` and any relevant builder/referrer accounts when
	 * `revenueShareEscrowMap` shows completed builder/referral orders on any of `marketIndexes`
	 * (same logic as `settlePNLIx`, generalized across markets).
	 * @param settleeUserAccountPublicKey - Public key of the user account to settle.
	 * @param settleeUserAccount - Decoded user account to settle.
	 * @param marketIndexes - Perp market indexes to settle.
	 * @param mode - `MustSettle` or `TrySettle`; see `settleMultiplePNLs`.
	 * @param overrides.authority - Settling authority override, if different from this client's wallet.
	 * @param revenueShareEscrowMap - Optional builder/referral escrow lookup keyed by authority.
	 * @returns The instruction.
	 */
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

	/**
	 * Builds the `setUserStatusToBeingLiquidated` instruction. See `setUserStatusToBeingLiquidated`
	 * for semantics.
	 * @param userAccountPublicKey - Public key of the target user's user account.
	 * @param userAccount - Decoded user account of the target user.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: flags a user account as being liquidated (sets the `beingLiquidated`
	 * status bit) without performing any liquidation itself. Used to "claim" a liquidation ahead of
	 * the actual `liquidatePerp`/`liquidateSpot` call so a concurrent liquidator can't race it; the
	 * on-chain handler re-checks the user is actually below maintenance margin before setting the
	 * flag. Permissionless — any signer can act as liquidator.
	 * @param userAccountPublicKey - Public key of the target user's user account.
	 * @param userAccount - Decoded user account of the target user.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Keeper instruction: liquidates part or all of a user's perp position in `marketIndex` when the
	 * user is below maintenance margin (or already flagged `beingLiquidated`), transferring the
	 * position to the calling liquidator's sub-account at the oracle price (subject to `limitPrice`
	 * and the on-chain liquidation fee). Reverts if `userAccountPublicKey` equals the liquidator's
	 * own user account. Permissionless — any signer can act as liquidator, taking on the position
	 * and its PnL themselves.
	 * @param userAccountPublicKey - Public key of the user account being liquidated.
	 * @param userAccount - Decoded user account being liquidated.
	 * @param marketIndex - Perp market index of the position to liquidate.
	 * @param maxBaseAssetAmount - Maximum base amount the liquidator is willing to take on, BASE_PRECISION (1e9).
	 * @param limitPrice - Optional worst acceptable price for the liquidator, PRICE_PRECISION (1e6).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `liquidatePerp` instruction. See `liquidatePerp` for semantics.
	 * @param userAccountPublicKey - Public key of the user account being liquidated.
	 * @param userAccount - Decoded user account being liquidated.
	 * @param marketIndex - Perp market index of the position to liquidate.
	 * @param maxBaseAssetAmount - Maximum base amount the liquidator is willing to take on, BASE_PRECISION (1e9).
	 * @param limitPrice - Optional worst acceptable price for the liquidator, PRICE_PRECISION (1e6).
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: liquidates a user's perp position in `marketIndex` by filling it directly
	 * against the supplied `makerInfos` (instead of transferring it to the liquidator's own
	 * sub-account as `liquidatePerp` does). Reverts if `userAccountPublicKey` equals the liquidator's
	 * own user account. Permissionless — any signer can act as liquidator/filler.
	 * @param userAccountPublicKey - Public key of the user account being liquidated.
	 * @param userAccount - Decoded user account being liquidated.
	 * @param marketIndex - Perp market index of the position to liquidate.
	 * @param makerInfos - Maker(s) to fill the liquidated position against.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `liquidatePerpWithFill` instruction. See `liquidatePerpWithFill` for semantics.
	 * @param userAccountPublicKey - Public key of the user account being liquidated.
	 * @param userAccount - Decoded user account being liquidated.
	 * @param marketIndex - Perp market index of the position to liquidate.
	 * @param makerInfos - Maker(s) to fill the liquidated position against; each contributes a
	 * `(maker, makerStats)` pair appended to `remainingAccounts`.
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: liquidates a user's spot position by transferring `liabilityMarketIndex`
	 * debt from the user to the liquidator's own sub-account in exchange for `assetMarketIndex`
	 * collateral, when the user is below maintenance margin (or already flagged `beingLiquidated`).
	 * Reverts if `userAccountPublicKey` equals the liquidator's own user account. Permissionless —
	 * any signer can act as liquidator.
	 * @param userAccountPublicKey - Public key of the user account being liquidated.
	 * @param userAccount - Decoded user account being liquidated.
	 * @param assetMarketIndex - Spot market index of the collateral the liquidator receives.
	 * @param liabilityMarketIndex - Spot market index of the debt the liquidator repays/absorbs.
	 * @param maxLiabilityTransfer - Maximum liability amount the liquidator is willing to take on, in
	 * the liability spot market's token (mint) precision.
	 * @param limitPrice - Optional worst acceptable asset/liability price ratio, PRICE_PRECISION (1e6).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `liquidateSpot` instruction. See `liquidateSpot` for semantics.
	 * @param userAccountPublicKey - Public key of the user account being liquidated.
	 * @param userAccount - Decoded user account being liquidated.
	 * @param assetMarketIndex - Spot market index of the collateral the liquidator receives.
	 * @param liabilityMarketIndex - Spot market index of the debt the liquidator repays/absorbs.
	 * @param maxLiabilityTransfer - Maximum liability amount the liquidator is willing to take on, in
	 * the liability spot market's token (mint) precision.
	 * @param limitPrice - Optional worst acceptable asset/liability price ratio, PRICE_PRECISION (1e6).
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The instruction.
	 */
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

	/**
	 * Builds a Jupiter-routed spot-liquidation-with-swap instruction set: swaps the liquidator's
	 * `assetMarketIndex` proceeds into `liabilityMarketIndex` tokens via Jupiter inside a
	 * `beginSwap`/`endSwap` flash-loan sandwich (see `getLiquidateSpotWithSwapIx`), letting the
	 * liquidator repay the user's debt without needing to already hold the liability token. Fetches a
	 * quote from `jupiterClient` when `quote` is not supplied, and idempotently creates any missing
	 * associated token accounts.
	 * @param jupiterClient - Jupiter client used to fetch the quote/swap transaction.
	 * @param liabilityMarketIndex - Spot market index of the debt being repaid (swap output).
	 * @param assetMarketIndex - Spot market index of the collateral being sold (swap input).
	 * @param swapAmount - Amount of `assetMarketIndex` token to sell, in that market's mint precision.
	 * @param assetTokenAccount - Token account to debit for the swap input; defaults to this client's
	 * associated token account for `assetMarketIndex`, created if missing.
	 * @param liabilityTokenAccount - Token account to credit with the swap output; defaults to this
	 * client's associated token account for `liabilityMarketIndex`, created if missing.
	 * @param slippageBps - Max slippage in basis points passed to Jupiter.
	 * @param swapMode - Jupiter swap mode (`ExactIn`/`ExactOut`).
	 * @param onlyDirectRoutes - Restrict Jupiter to single-hop routes.
	 * @param quote - Pre-fetched Jupiter quote (skips an extra round-trip).
	 * @param userAccount - Decoded user account being liquidated.
	 * @param userAccountPublicKey - Public key of the user account being liquidated.
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @param maxAccounts - Caps the number of accounts Jupiter's route may use.
	 * @throws If no quote can be fetched and `quote` was not supplied.
	 * @returns The ordered instructions (pre-instructions, `beginSwap`, Jupiter swap, `endSwap`) and
	 * any address lookup tables the Jupiter route requires.
	 */
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
	 * Builds the `liquidateSpotWithSwapBegin`/`...End` instruction pair that sandwiches an
	 * external swap (e.g. Jupiter) so a liquidator can repay a user's `liabilityMarketIndex` debt
	 * using proceeds from selling `assetMarketIndex` collateral within the same transaction, without
	 * pre-funding the liability token. The on-chain handler validates the liability spot market's
	 * flash-loan balance is unwound by `endSwap`. See `getJupiterLiquidateSpotWithSwapIxV6` for the
	 * Jupiter-specific wrapper that assembles the full instruction list around this pair.
	 * @param liabilityMarketIndex - Spot market index of the debt being repaid (swap output/buy side).
	 * @param assetMarketIndex - Spot market index of the collateral being sold (swap input/sell side).
	 * @param swapAmount - Amount of `assetMarketIndex` token to sell, in that market's mint precision.
	 * @param assetTokenAccount - Token account to debit for the swap input.
	 * @param liabilityTokenAccount - Token account to credit with the swap output.
	 * @param userAccount - Decoded user account being liquidated.
	 * @param userAccountPublicKey - Public key of the user account being liquidated.
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns `beginSwapIx`/`endSwapIx` — the caller must place the external swap instructions
	 * between them.
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

	/**
	 * Keeper instruction: liquidates a user by transferring `liabilityMarketIndex` spot debt from the
	 * user to the liquidator in exchange for a matching amount of the user's positive unsettled perp
	 * PnL in `perpMarketIndex`. Only usable once the user's position size in `perpMarketIndex` is
	 * zero (the PnL must already be fully unrealized/settled-out, not backed by an open position).
	 * Reverts if `userAccountPublicKey` equals the liquidator's own user account. Permissionless —
	 * any signer can act as liquidator.
	 * @param userAccountPublicKey - Public key of the user account being liquidated.
	 * @param userAccount - Decoded user account being liquidated.
	 * @param perpMarketIndex - Perp market index whose unsettled PnL backs the transfer, QUOTE_PRECISION (1e6).
	 * @param liabilityMarketIndex - Spot market index of the debt being repaid.
	 * @param maxLiabilityTransfer - Maximum liability amount the liquidator is willing to take on, in
	 * the liability spot market's token (mint) precision.
	 * @param limitPrice - Optional worst acceptable liability/PnL price ratio, PRICE_PRECISION (1e6).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `liquidateBorrowForPerpPnl` instruction. See `liquidateBorrowForPerpPnl` for semantics.
	 * @param userAccountPublicKey - Public key of the user account being liquidated.
	 * @param userAccount - Decoded user account being liquidated.
	 * @param perpMarketIndex - Perp market index whose unsettled PnL backs the transfer.
	 * @param liabilityMarketIndex - Spot market index of the debt being repaid.
	 * @param maxLiabilityTransfer - Maximum liability amount the liquidator is willing to take on, in
	 * the liability spot market's token (mint) precision.
	 * @param limitPrice - Optional worst acceptable liability/PnL price ratio, PRICE_PRECISION (1e6).
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: liquidates a user by transferring negative unsettled perp PnL in
	 * `perpMarketIndex` from the user to the liquidator in exchange for `assetMarketIndex` spot
	 * collateral (the inverse of `liquidateBorrowForPerpPnl`). Only usable once the user's position
	 * size in `perpMarketIndex` is zero. Reverts if `userAccountPublicKey` equals the liquidator's
	 * own user account. Permissionless — any signer can act as liquidator.
	 * @param userAccountPublicKey - Public key of the user account being liquidated.
	 * @param userAccount - Decoded user account being liquidated.
	 * @param perpMarketIndex - Perp market index of the negative unsettled PnL being absorbed.
	 * @param assetMarketIndex - Spot market index of the collateral the liquidator receives.
	 * @param maxPnlTransfer - Maximum PnL amount the liquidator is willing to absorb, QUOTE_PRECISION (1e6).
	 * @param limitPrice - Optional worst acceptable PnL/asset price ratio, PRICE_PRECISION (1e6).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `liquidatePerpPnlForDeposit` instruction. See `liquidatePerpPnlForDeposit` for semantics.
	 * @param userAccountPublicKey - Public key of the user account being liquidated.
	 * @param userAccount - Decoded user account being liquidated.
	 * @param perpMarketIndex - Perp market index of the negative unsettled PnL being absorbed.
	 * @param assetMarketIndex - Spot market index of the collateral the liquidator receives.
	 * @param maxPnlTransfer - Maximum PnL amount the liquidator is willing to absorb, QUOTE_PRECISION (1e6).
	 * @param limitPrice - Optional worst acceptable PnL/asset price ratio, PRICE_PRECISION (1e6).
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: resolves a user's perp bankruptcy in `marketIndex` (negative equity that
	 * liquidation alone could not cover) by socializing the loss — first attempting to backstop it
	 * from the quote spot market's insurance fund, then socializing any remainder across the market's
	 * other position holders via the cumulative funding/PnL pool. Reverts if the resulting insurance
	 * payout would fully drain the insurance fund vault, or if `userAccountPublicKey` equals the
	 * liquidator's own user account. Permissionless — any signer can act as liquidator.
	 * @param userAccountPublicKey - Public key of the bankrupt user's user account.
	 * @param userAccount - Decoded user account of the bankrupt user.
	 * @param marketIndex - Perp market index of the bankrupt position.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `resolvePerpBankruptcy` instruction. See `resolvePerpBankruptcy` for semantics.
	 * Always settles against the quote spot market (`QUOTE_SPOT_MARKET_INDEX`).
	 * @param userAccountPublicKey - Public key of the bankrupt user's user account.
	 * @param userAccount - Decoded user account of the bankrupt user.
	 * @param marketIndex - Perp market index of the bankrupt position.
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The instruction.
	 */
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
	/**
	 * Keeper instruction: resolves a user's spot bankruptcy (negative balance in `marketIndex` that
	 * liquidation alone could not cover) by backstopping the deficit from that spot market's
	 * insurance fund. Reverts if `userAccountPublicKey` equals the liquidator's own user account.
	 * Permissionless — any signer can act as liquidator.
	 * @param userAccountPublicKey - Public key of the bankrupt user's user account.
	 * @param userAccount - Decoded user account of the bankrupt user.
	 * @param marketIndex - Spot market index of the bankrupt balance.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `resolveSpotBankruptcy` instruction. See `resolveSpotBankruptcy` for semantics.
	 * Adds the spot market's mint (and transfer-hook extra account metas, if applicable) to
	 * `remainingAccounts` for the token transfer from the insurance fund vault.
	 * @param userAccountPublicKey - Public key of the bankrupt user's user account.
	 * @param userAccount - Decoded user account of the bankrupt user.
	 * @param marketIndex - Spot market index of the bankrupt balance.
	 * @param liquidatorSubAccountId - Liquidator's sub-account to credit; defaults to the active sub-account.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: recomputes and applies `marketIndex`'s hourly-anchored funding rate
	 * (`cumulativeFundingRateLong`/`Short`, FUNDING_RATE_PRECISION, 1e9) from the current oracle/AMM
	 * mark-price spread, then updates the market's oracle-derived TWAP stats. No-ops (via
	 * `FundingWasNotUpdated`, which the underlying call surfaces as a failed transaction) if it is
	 * not yet time for the next update — `perp_market.market_stats.funding_period` seconds since the
	 * last update, on-the-hour aligned. Reverts if the market's funding is paused or the market is
	 * not `Active`/`ReduceOnly`. Permissionless — any signer can act as keeper.
	 * @param perpMarketIndex - Perp market index to update funding for.
	 * @param oracle - The market's oracle account (`perpMarket.oracle`).
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updateFundingRate` instruction. See `updateFundingRate` for semantics.
	 * @param perpMarketIndex - Perp market index to update funding for.
	 * @param oracle - The market's oracle account (`perpMarket.oracle`).
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: refreshes a `Prelaunch`-oracle-source perp market's synthetic oracle price
	 * from its own recent trading activity (used for markets without a live external price feed,
	 * e.g. pre-listing futures). Only valid when the market's `oracleSource` is `Prelaunch`.
	 * Permissionless — any signer can act as keeper.
	 * @param perpMarketIndex - Perp market index to update; must use the `Prelaunch` oracle source.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @throws If `perpMarketIndex`'s `oracleSource` is not `Prelaunch`.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updatePrelaunchOracle` instruction. See `updatePrelaunchOracle` for semantics.
	 * @param perpMarketIndex - Perp market index to update; must use the `Prelaunch` oracle source.
	 * @throws If `perpMarketIndex`'s `oracleSource` is not `Prelaunch`.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: estimates the market's bid/ask price from the given makers' resting DLOB
	 * orders (filtered to those within `BID_ASK_TWAP_MAX_ORACLE_DIVERGENCE_PERCENT` of the oracle
	 * price) and folds the estimate into `lastBidPriceTwap`/`lastAskPriceTwap`. Restricted: the
	 * calling wallet's `UserStats` must have `canUpdateBidAskTwap` set and at least 1000 USDC
	 * (`QUOTE_PRECISION`, 1e6) staked in the insurance fund (`ifStakedQuoteAssetAmount`), or the
	 * instruction reverts.
	 * @param perpMarketIndex - Perp market index to update.
	 * @param makers - `(maker, makerStats)` pairs whose resting orders are sampled for the estimate.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updatePerpBidAskTwap` instruction. See `updatePerpBidAskTwap` for semantics.
	 * @param perpMarketIndex - Perp market index to update.
	 * @param makers - `(maker, makerStats)` pairs whose resting orders are sampled for the estimate.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: settles accrued funding payments into the quote balance of every perp
	 * position the target user currently holds, using each market's latest
	 * `cumulativeFundingRateLong`/`Short` (FUNDING_RATE_PRECISION, 1e9). Fetches the user account
	 * fresh from the RPC (does not rely on this client's subscription cache) to determine which
	 * markets to include. Permissionless — any signer can act as keeper.
	 * @param userAccountPublicKey - Public key of the user account to settle funding for.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `settleFundingPayment` instruction. See `settleFundingPayment` for semantics. Fetches
	 * the user account directly via `program.account.user.fetch` and includes every market the user
	 * has a non-empty position in as a writable remaining account.
	 * @param userAccountPublicKey - Public key of the user account to settle funding for.
	 * @returns The instruction.
	 */
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

	/**
	 * Manually emits an event on this client's internal `eventEmitter`, as if it had come from the
	 * account subscriber. Intended for tests/tooling that need to simulate account-update events;
	 * not used by normal instruction-building code paths.
	 * @param eventName - Name of the event to emit; see `VelocityClientAccountEvents`.
	 * @param data - Optional event payload.
	 */
	public triggerEvent(
		eventName: keyof VelocityClientAccountEvents,
		data?: any
	) {
		this.eventEmitter.emit(eventName, data);
	}

	/**
	 * Reads the last-known primary oracle price for a perp market from the account subscriber's
	 * cache (no RPC call). This is the raw exchange oracle price, unadjusted by the market's MM
	 * oracle — use `getMMOracleDataForPerpMarket` when you need the price the program actually uses
	 * for fills/margin.
	 * @param marketIndex - Perp market index.
	 * @throws If subscribed oracle price data is not available for `marketIndex`.
	 * @returns Oracle price data; `price`/`confidence` are PRICE_PRECISION (1e6).
	 */
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

	/**
	 * Resolves the effective oracle price the program uses for `marketIndex` — the market's MM
	 * (market-maker-fed) oracle when it is fresher, valid, and not too divergent from the primary
	 * exchange oracle; otherwise falls back to the primary oracle. Mirrors the on-chain
	 * `get_mm_oracle_price_data` gating so client-side price reads (mark price, margin, liquidation
	 * previews) match what a fill/settlement will actually see.
	 *
	 * Falls back to the primary oracle (`getOracleDataForPerpMarket`) when any of the following hold:
	 *   - the MM oracle price is zero (uninitialized) or its computed `OracleValidity` is
	 *     `NonPositive`/`TooVolatile` (per `state.oracleGuardRails`);
	 *   - the primary oracle is judged more recent than the MM oracle — by sequence-id ordering when
	 *     both oracles have a usable, closely-matched `sequenceId`, otherwise by slot comparison;
	 *   - the MM and primary oracle prices diverge by more than 1% (`PERCENTAGE_PRECISION`, 1e6 scale).
	 *
	 * Otherwise returns the MM oracle's price/slot/confidence.
	 * @param marketIndex - Perp market index.
	 * @throws If subscribed oracle price data is not available for `marketIndex`.
	 * @returns Oracle price data (`price`/`confidence` at PRICE_PRECISION, 1e6) plus `isMMOracleActive`
	 * indicating whether the market has an initialized MM oracle at all (independent of which price
	 * was ultimately selected).
	 */
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

		// Do slot check for recency if sequence ids are zero or they're too divergent.
		// Mirrors Rust's sequence-id path guard `abs_diff < exchange_seq / 10_000`: the slot
		// path is the negation, so it fires on `>=` (not `>`).
		const doSlotCheckForRecency =
			oracleData.sequenceId == null ||
			oracleData.sequenceId.eq(ZERO) ||
			mmOracleSequenceId.eq(ZERO) ||
			oracleData.sequenceId
				.sub(perpMarket.marketStats.mmOracleSequenceId)
				.abs()
				.gte(oracleData.sequenceId.div(new BN(10_000)));

		let isExchangeOracleMoreRecent = true;
		if (
			doSlotCheckForRecency &&
			oracleData.slot.lte(perpMarket.marketStats.mmOracleSlot)
		) {
			isExchangeOracleMoreRecent = false;
		} else if (
			!doSlotCheckForRecency &&
			oracleData.sequenceId != null &&
			// Rust uses `exchange_seq > mm_seq`; equal sequence ids mean the exchange oracle is
			// NOT more recent, so the MM oracle is used. Use `lte` so equality clears the flag.
			oracleData.sequenceId.lte(mmOracleSequenceId)
		) {
			isExchangeOracleMoreRecent = false;
		}

		// Diff-adjusted confidence used only for the *returned* MM price data (mirrors
		// MMOraclePriceData::new's `adjusted_confidence = exchange.confidence + diff_premium`).
		const conf = getOracleConfidenceFromMMOracleData(
			perpMarket.marketStats.mmOraclePrice,
			oracleData
		);

		// UseMMOraclePrice only blocks on NonPositive/TooVolatile validity, not on
		// the twap-5min divergence band `isOracleTooDivergent` checks elsewhere.
		// Validity is computed with the RAW exchange confidence (not the diff-adjusted
		// `conf`), matching the program's get_mm_oracle_price_data, which feeds
		// `oracle_price_data.confidence` into `oracle_validity`. (Currently latent since the
		// gate below only inspects NonPositive/TooVolatile, but correct for TooUncertain too.)
		const mmOracleValidity = perpMarket.marketStats.mmOraclePrice.eq(ZERO)
			? OracleValidity.NonPositive
			: getOracleValidity(
					perpMarket,
					{
						price: perpMarket.marketStats.mmOraclePrice,
						slot: perpMarket.marketStats.mmOracleSlot,
						confidence: oracleData.confidence,
						hasSufficientNumberOfDataPoints: true,
					},
					stateAccountAndSlot.data.oracleGuardRails,
					new BN(stateAccountAndSlot.slot)
			  );
		const isMMOracleInvalidForUse =
			mmOracleValidity === OracleValidity.NonPositive ||
			mmOracleValidity === OracleValidity.TooVolatile;

		// Volatility-gate inputs, mirroring the same-named `MMOraclePriceData` predicates
		// (`state/oracle.rs`). Computed regardless of which price is selected below, so the
		// AMM-fill gate (`isFallbackAvailableLiquiditySource`) can reproduce `amm_fill_gates_ok`.
		const isMMOracleEnabled =
			isMMOracleActive && !perpMarket.marketStats.mmOraclePrice.eq(ZERO);
		const isMMOracleAsRecent = !isExchangeOracleMoreRecent;
		const isMMExchangeDiffBpsHigh = pctDiff.gt(PERCENTAGE_PRECISION.divn(100)); // 1% threshold

		if (
			isMMOracleInvalidForUse ||
			perpMarket.marketStats.mmOraclePrice.eq(ZERO) ||
			isExchangeOracleMoreRecent ||
			isMMExchangeDiffBpsHigh
		) {
			return {
				...oracleData,
				isMMOracleActive,
				isMMOracleEnabled,
				isMMOracleAsRecent,
				isMMExchangeDiffBpsHigh,
			};
		} else {
			return {
				price: perpMarket.marketStats.mmOraclePrice,
				slot: perpMarket.marketStats.mmOracleSlot,
				confidence: conf,
				hasSufficientNumberOfDataPoints: true,
				isMMOracleActive,
				isMMOracleEnabled,
				isMMOracleAsRecent,
				isMMExchangeDiffBpsHigh,
			};
		}
	}

	/**
	 * Reads the last-known oracle price for a spot market from the account subscriber's cache (no
	 * RPC call). Spot markets do not have an MM oracle — this is always the effective price used for
	 * margin/borrow-lending calculations.
	 * @param marketIndex - Spot market index.
	 * @throws If subscribed oracle price data is not available for `marketIndex`.
	 * @returns Oracle price data; `price`/`confidence` are PRICE_PRECISION (1e6).
	 */
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

	/**
	 * Creates this wallet's `InsuranceFundStake` PDA for `marketIndex`, required once before staking
	 * into that market's insurance fund for the first time. A caller may only initialize their own
	 * stake account. Reverts if insurance-fund init is paused for the market.
	 * @param marketIndex - Spot market index whose insurance fund to stake into.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `initializeInsuranceFundStake` instruction. See `initializeInsuranceFundStake` for
	 * semantics.
	 * @param marketIndex - Spot market index whose insurance fund to stake into.
	 * @returns The instruction.
	 */
	public async getInitializeInsuranceFundStakeIx(
		marketIndex: number,
		overrides?: {
			authority?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		const authority = overrides?.authority ?? this.wallet.publicKey;
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			authority,
			marketIndex
		);

		const accounts = {
			insuranceFundStake: ifStakeAccountPublicKey,
			spotMarket: this.getSpotMarketAccountOrThrow(marketIndex).pubkey,
			userStats: getUserStatsAccountPublicKey(
				this.program.programId,
				authority // only allow payer to initialize own insurance fund stake account
			),
			authority,
			payer: authority,
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

	/**
	 * Builds the `addInsuranceFundStake` instruction, transferring `amount` of the market's token
	 * from `collateralAccountPublicKey` into its insurance fund vault and minting the caller's
	 * `InsuranceFundStake` the corresponding IF shares. Reverts if `amount` is zero, the spot market
	 * is not active, insurance-fund add is paused, or a withdraw request is already in progress on
	 * the stake account. See `addInsuranceFundStake`/`getAddInsuranceFundStakeIxs` for a wrapper that
	 * also handles account creation and funding from a sub-account.
	 * @param marketIndex - Spot market index whose insurance fund to stake into.
	 * @param amount - Amount to stake, in the spot market's token (mint) precision.
	 * @param collateralAccountPublicKey - Token account to debit for the stake.
	 * @returns The instruction.
	 */
	public async getAddInsuranceFundStakeIx(
		marketIndex: number,
		amount: BN,
		collateralAccountPublicKey: PublicKey,
		overrides?: {
			authority?: PublicKey;
		}
	): Promise<TransactionInstruction> {
		const authority = overrides?.authority ?? this.wallet.publicKey;
		const spotMarket = this.getSpotMarketAccountOrThrow(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			authority,
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
						authority // only allow payer to add to own insurance fund stake account
					),
					authority,
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

	/**
	 * Starts the unstaking cooldown for this wallet's insurance fund stake in `marketIndex`, locking
	 * in the number of IF shares corresponding to `amount` at the current share price. The actual
	 * withdrawal must be completed with `removeInsuranceFundStake` after
	 * `spotMarket.insuranceFund.unstakingPeriod` seconds have elapsed; only one request may be
	 * in-flight per stake account (`cancelRequestRemoveInsuranceFundStake` to reset). A caller may
	 * only act on their own stake account.
	 * @param marketIndex - Spot market index of the insurance fund stake.
	 * @param amount - Amount to request removal of, in the spot market's token (mint) precision;
	 * converted to IF shares at the current vault share price.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Cancels this wallet's in-progress `requestRemoveInsuranceFundStake` for `marketIndex`, clearing
	 * the pending withdraw request so the stake resumes earning normally. Reverts if no withdraw
	 * request is currently in progress. A caller may only act on their own stake account.
	 * @param marketIndex - Spot market index of the insurance fund stake.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Completes a previously-requested insurance fund unstake for `marketIndex`, transferring the
	 * requested shares' worth of tokens from the insurance fund vault to `collateralAccountPublicKey`
	 * (creating it, and a temporary wrapped-SOL account if the market is SOL, when needed). Reverts
	 * if `spotMarket.insuranceFund.unstakingPeriod` has not yet elapsed since the matching
	 * `requestRemoveInsuranceFundStake`, or if the spot market's utilization is above the healthy
	 * threshold. A caller may only act on their own stake account.
	 * @param marketIndex - Spot market index of the insurance fund stake.
	 * @param collateralAccountPublicKey - Token account to receive the withdrawn tokens.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Keeper instruction: refreshes `authority`'s quote-market (`QUOTE_SPOT_MARKET_INDEX`) insurance
	 * fund stake bookkeeping (applies any pending rebase to the stake's share count/value) without
	 * adding or removing funds. `insuranceFundStake` and `userStats` must belong to the same
	 * authority. Permissionless — any signer can trigger the refresh for any staker.
	 * @param authority - Authority whose quote-market insurance fund stake to refresh.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updateUserQuoteAssetInsuranceStake` instruction. See
	 * `updateUserQuoteAssetInsuranceStake` for semantics. Always targets `QUOTE_SPOT_MARKET_INDEX`.
	 * @param authority - Authority whose quote-market insurance fund stake to refresh.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: sweeps the market's proportional share of accumulated protocol revenue from
	 * its spot vault into its insurance fund vault. Only callable once per
	 * `spotMarket.insuranceFund.revenueSettlePeriod` seconds (on-the-hour aligned from
	 * `lastRevenueSettleTs`); reverts early with the remaining wait time otherwise. Reverts if the
	 * market has `revenueSettlePeriod <= 0` (settling to IF disabled). Permissionless — any signer
	 * can trigger the sweep.
	 * @param spotMarketIndex - Spot market index to settle revenue for.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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
	/**
	 * Builds the `settleRevenueToInsuranceFund` instruction. See `settleRevenueToInsuranceFund` for
	 * semantics.
	 * @param spotMarketIndex - Spot market index to settle revenue for.
	 * @returns The instruction.
	 */
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

	/**
	 * Permissionless streaming-sweep keeper instruction: materializes a perp market's accrued pending
	 * fee carveouts out of the PnL pool — `pendingProtocolFee` to the market's protocol fee pool
	 * (runs first, buffer-exempt), then `pendingIfFee` to the quote spot market's revenue pool and
	 * `pendingAmmProvision` into the AMM's fee pool (both leave `feePoolBufferTarget` behind). Every
	 * drain reserves `max(netUserPnl, 0)` so user claims stay backed. This runs inline on every
	 * `settlePNL` already — this instruction lets a keeper run it on demand without settling anyone's
	 * PnL. Gates the oracle price used to value `netUserPnl` the same way `settlePNL` does (price-band
	 * + validity/divergence checks when the market has curve updates enabled).
	 * @param perpMarketIndex - Perp market index to sweep fees for.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `sweepPerpMarketFees` instruction. See `sweepPerpMarketFees` for semantics.
	 * @param perpMarketIndex - Perp market index to sweep fees for.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: backstops a perp market's negative PnL pool from the quote spot market's
	 * insurance fund (first attempting a revenue-to-IF settlement so the vault balance is
	 * up-to-date). `spotMarketIndex` must be `QUOTE_SPOT_MARKET_INDEX`. Permissionless — any signer
	 * can trigger it.
	 * @param spotMarketIndex - Spot market index backing the deficit; must be `QUOTE_SPOT_MARKET_INDEX`.
	 * @param perpMarketIndex - Perp market index whose PnL pool deficit to resolve.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @throws (on-chain) if `spotMarketIndex` is not the quote spot market.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `resolvePerpPnlDeficit` instruction. See `resolvePerpPnlDeficit` for semantics.
	 * @param spotMarketIndex - Spot market index backing the deficit; must be `QUOTE_SPOT_MARKET_INDEX`.
	 * @param perpMarketIndex - Perp market index whose PnL pool deficit to resolve.
	 * @returns The instruction.
	 */
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

	/**
	 * Builds the `depositIntoSpotMarketRevenuePool` instruction. See `depositIntoSpotMarketRevenuePool`
	 * for semantics.
	 * @param marketIndex - Spot market index whose revenue pool to donate into.
	 * @param amount - Amount to donate, in the spot market's token (mint) precision.
	 * @param userTokenAccountPublicKey - Token account to debit for the donation.
	 * @returns The instruction.
	 */
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

	/**
	 * Computes display/risk metadata for a perp market from currently-subscribed account state (no
	 * RPC call): minimum order size, maintenance margin ratio, PnL pool value, contract tier, and the
	 * maximum insurance available to the market.
	 * @param marketIndex - Perp market index.
	 * @returns `minOrderSize`/`marginMaintenance` in the market's native units; `pnlPoolValue` and
	 * `availableInsurance` in QUOTE_PRECISION (1e6).
	 */
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
	 * @param user
	 * @param orderParams When it carries a builder code, the builder fee (quoteAssetAmount * builderFeeTenthBps / 100_000) is added to takerFee.
	 * @returns : {takerFee: number, makerFee: number} Precision None
	 */
	public getMarketFees(
		marketType: MarketType,
		marketIndex?: number,
		user?: User,
		orderParams?: Pick<OrderParams, 'builderIdx' | 'builderFeeTenthBps'>
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

		// Referee discount (M11): mirrors `calculate_referee_fee_and_referrer_reward`
		// (`math/fees.rs`), which reduces the taker fee by
		// `referee_fee_numerator/referee_fee_denominator` when the taker is a referee
		// (`reward_referrer`). Applied after `feeAdjustment` and only to the taker fee —
		// maker rebates are untouched — matching the program's ordering. Referee status is
		// read from the client's `UserStats.referrerStatus` (`IsReferred` bit); if stats are
		// unavailable, no discount is applied (parity with a non-referred taker).
		if (user && feeTier.refereeFeeDenominator > 0) {
			const referrerStatus = this.getUserStats()?.getAccount()?.referrerStatus;
			const isReferee =
				referrerStatus !== undefined &&
				(referrerStatus & ReferrerStatus.IsReferred) > 0;
			if (isReferee) {
				takerFee -=
					(takerFee * feeTier.refereeFeeNumerator) /
					feeTier.refereeFeeDenominator;
			}
		}

		if (orderParams && hasBuilderParams(orderParams)) {
			takerFee += (orderParams.builderFeeTenthBps ?? 0) / 100_000;
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

	/**
	 * Posts a signed Pyth Lazer price update on-chain for one or more feeds, prepended with the
	 * Ed25519 signature-verification instruction the handler requires. Permissionless — any signer
	 * can post a valid, correctly-signed update.
	 * @param feedIds - Pyth Lazer feed IDs to update, in the same order as the encoded message.
	 * @param pythMessageHex - Hex-encoded, Pyth-signed Lazer update message.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `postPythLazerOracleUpdate` instruction pair. See `postPythLazerOracleUpdate` for
	 * semantics.
	 * @param feedIds - Pyth Lazer feed IDs to update, in the same order as the encoded message.
	 * @param pythMessageHex - Hex-encoded, Pyth-signed Lazer update message.
	 * @param precedingIxs - Instructions that will be placed before the returned pair in the final
	 * transaction; only their count is used, to compute the Ed25519 verify instruction's index.
	 * @param overrideCustomIxIndex - Explicit index of the verify instruction within the transaction,
	 * overriding the `precedingIxs.length + 1` default.
	 * @returns `[verifyIx, updateIx]` — the Ed25519 signature-verification instruction followed by the
	 * oracle-update instruction; both must be included, in order, in the same transaction.
	 */
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

	/**
	 * Builds the `pauseSpotMarketDepositWithdraw` instruction. See `pauseSpotMarketDepositWithdraw`
	 * for semantics.
	 * @param spotMarketIndex - Spot market index to pause.
	 * @returns The instruction.
	 */
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

	/**
	 * Emergency circuit-breaker instruction: pauses deposits and withdrawals for a spot market, but
	 * only when the on-chain handler detects the spot market's vault invariant has already been
	 * violated (actual vault balance diverges from the market's tracked deposit/borrow balances,
	 * e.g. from an exploit) — it reverts with an error if the vault amount is still valid, so this
	 * cannot be used to arbitrarily pause a healthy market. Permissionless — any signer can trigger
	 * it once the invariant is broken.
	 * @param spotMarketIndex - Spot market index to pause.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @throws (on-chain) if the spot market's vault amount is still valid (invariant not violated).
	 * @returns The transaction signature.
	 */
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

	/**
	 * Updates a perp market's market-maker (MM) oracle price using the program's high-frequency
	 * custom native entrypoint (bypasses Anchor's account deserialization overhead — see
	 * `createNativeInstructionDiscriminatorBuffer`). Restricted to the state's configured
	 * `hotMmOracleCrank` signer in production (unchecked under the `anchor-test` feature) and can be
	 * disabled entirely via a state feature-bit-flag kill switch. See `getMMOracleDataForPerpMarket`
	 * for how this price is subsequently gated against the primary oracle before use.
	 * @param marketIndex - Perp market index whose MM oracle to update.
	 * @param oraclePrice - New MM oracle price, PRICE_PRECISION (1e6). A value of `0` is a no-op.
	 * @param oracleSequenceId - Monotonically increasing sequence id for this update, used for
	 * recency comparisons against the primary oracle.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updateMmOracleNative` instruction. See `updateMmOracleNative` for semantics. Hand-
	 * assembles the instruction (perp market, signer, clock sysvar, state) rather than going through
	 * `this.program.instruction`, since this targets the native (non-Anchor) entrypoint.
	 * @param marketIndex - Perp market index whose MM oracle to update.
	 * @param oraclePrice - New MM oracle price, PRICE_PRECISION (1e6). A value of `0` is a no-op.
	 * @param oracleSequenceId - Monotonically increasing sequence id for this update.
	 * @returns The instruction.
	 */
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

	/**
	 * Updates a perp market's AMM spread adjustment using the program's high-frequency custom native
	 * entrypoint. Restricted to the state's configured `hotAmmSpreadAdjust` signer in production
	 * (unchecked under the `anchor-test` feature).
	 * @param marketIndex - Perp market index whose AMM spread adjustment to update.
	 * @param ammSpreadAdjustment - Percentage adjustment to the AMM's base long/short spread, as a
	 * signed byte (-128 to 127): negative narrows the spread by that percent, positive widens it,
	 * `0` is no adjustment.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updateAmmSpreadAdjustmentNative` instruction. See `updateAmmSpreadAdjustmentNative`
	 * for semantics. Hand-assembles the instruction (perp market, signer, state) rather than going
	 * through `this.program.instruction`, since this targets the native (non-Anchor) entrypoint.
	 * @param marketIndex - Perp market index whose AMM spread adjustment to update.
	 * @param ammSpreadAdjustment - Percentage adjustment to the AMM's base spread, signed byte (i8).
	 * @returns The instruction.
	 */
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

	/**
	 * Fetches an LP pool account by ID directly from the RPC (not from this client's subscription
	 * cache). An LP pool ("VLP") is a basket of spot-market "constituent" tokens that mints/redeems a
	 * pool token against deposits/withdrawals and absorbs perp AMM PnL to hedge the protocol's
	 * inventory risk (see `settlePerpToLpPool`).
	 * @param lpPoolId - LP pool ID.
	 * @returns The decoded LP pool account.
	 */
	public async getLpPoolAccount(lpPoolId: number): Promise<LPPoolAccount> {
		return (await (this.program.account as any).lpPool.fetch(
			getLpPoolPublicKey(this.program.programId, lpPoolId)
		)) as unknown as LPPoolAccount;
	}

	/**
	 * Fetches the target-base weights for an LP pool's constituents directly from the RPC. Target
	 * base is each constituent's ideal share of the pool, derived from the AMMs it backs
	 * (`updateLpConstituentTargetBase`); swap/add/remove-liquidity fees are priced off deviation from
	 * these targets.
	 * @param lpPoolId - LP pool ID.
	 * @returns The decoded constituent target-base account.
	 */
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

	/**
	 * Fetches the program's single global AMM cache account directly from the RPC — a snapshot of
	 * each hedge-enabled perp market's inventory/price/PnL used by LP pool AUM, target-base, and
	 * settlement instructions without having to reload every perp market individually.
	 * @returns The decoded AMM cache account.
	 */
	public async getAmmCache(): Promise<AmmCache> {
		return (await (this.program.account as any).ammCache.fetch(
			getAmmCachePublicKey(this.program.programId)
		)) as AmmCache;
	}

	/**
	 * Keeper instruction: recomputes each listed constituent's target-base weight from the current
	 * AMM cache (each hedge-enabled perp market's inventory relative to its constituents), used to
	 * price LP pool swap/add/remove-liquidity fees. Requires `updateAmmCache` to have run recently
	 * for the relevant markets. Permissionless — any signer can act as keeper.
	 * @param lpPoolId - LP pool ID.
	 * @param constituents - Constituent account public keys to recompute target base for.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updateLpConstituentTargetBase` instruction. See `updateLpConstituentTargetBase` for
	 * semantics.
	 * @param lpPoolId - LP pool ID.
	 * @param constituents - Constituent account public keys to recompute target base for, passed as
	 * read-only remaining accounts.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: recomputes an LP pool's total AUM and per-constituent value from each
	 * constituent's spot market and vault balance, refreshing `lastAumSlot`. Swaps and add/remove
	 * liquidity revert with `LpPoolAumDelayed` if this has not run within `LP_POOL_SWAP_AUM_UPDATE_DELAY`
	 * slots of the action, so it must typically precede those instructions in the same transaction
	 * (see `getAllUpdateLpPoolAumIxs`). Permissionless — any signer can act as keeper.
	 * @param lpPool - Decoded LP pool account to update.
	 * @param spotMarketIndexOfConstituents - Spot market index of every constituent in the pool, in
	 * the same order the pool's constituents were configured.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updateLpPoolAum` instruction. See `updateLpPoolAum` for semantics.
	 * @param lpPool - Decoded LP pool account to update.
	 * @param spotMarketIndexOfConstituents - Spot market index of every constituent in the pool.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: refreshes the global AMM cache's per-market inventory/price/PnL snapshot
	 * for the given hedge-enabled perp markets, feeding LP pool AUM, target-base, and settlement
	 * math. Permissionless — any signer can act as keeper.
	 * @param perpMarketIndexes - Perp market indexes to refresh; at most 50 per call.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @throws If more than 50 market indexes are supplied.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updateAmmCache` instruction. See `updateAmmCache` for semantics.
	 * @param perpMarketIndexes - Perp market indexes to refresh; at most 50.
	 * @throws If more than 50 market indexes are supplied.
	 * @returns The instruction.
	 */
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

	/**
	 * Keeper instruction: refreshes a single LP pool constituent's cached oracle price/slot from its
	 * spot market's oracle. Called ahead of AUM/target-base updates that need a fresh price for that
	 * constituent. Permissionless — any signer can act as keeper.
	 * @param constituent - Decoded constituent account to refresh.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `updateConstituentOracleInfo` instruction. See `updateConstituentOracleInfo` for
	 * semantics.
	 * @param constituent - Decoded constituent account to refresh.
	 * @returns The instruction.
	 */
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

	/**
	 * Swaps `inMarketIndex` tokens for `outMarketIndex` tokens directly against an LP pool's
	 * constituent vaults (not the DLOB/AMM), paying a fee priced off each constituent's deviation
	 * from its target-base weight. Reverts if pool swaps are disabled, `inMarketIndex` equals
	 * `outMarketIndex`, or `updateLpPoolAum` has not run within `LP_POOL_SWAP_AUM_UPDATE_DELAY` slots
	 * (see `getAllLpPoolSwapIxs` for a wrapper that prepends the required AUM refresh).
	 * @param inMarketIndex - Spot market index of the token being sold.
	 * @param outMarketIndex - Spot market index of the token being bought.
	 * @param inAmount - Amount of `inMarketIndex` token to sell, in that market's mint precision.
	 * @param minOutAmount - Minimum acceptable amount of `outMarketIndex` token to receive, in that
	 * market's mint precision.
	 * @param lpPool - LP pool public key.
	 * @param userAuthority - Authority whose associated token accounts fund/receive the swap.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `lpPoolSwap` instruction. See `lpPoolSwap` for semantics.
	 * @param inMarketIndex - Spot market index of the token being sold.
	 * @param outMarketIndex - Spot market index of the token being bought.
	 * @param inAmount - Amount of `inMarketIndex` token to sell, in that market's mint precision.
	 * @param minOutAmount - Minimum acceptable amount of `outMarketIndex` token to receive, in that
	 * market's mint precision.
	 * @param lpPool - LP pool public key.
	 * @param userAuthority - Authority whose associated token accounts fund/receive the swap.
	 * @returns The instruction.
	 */
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

	/**
	 * Simulation-only instruction: computes what `lpPoolSwap` would charge for the given swap without
	 * moving any funds (intended to be run via `simulateTransaction`/a view call, not actually
	 * confirmed on-chain). Useful for quoting a swap's fee before submitting it.
	 * @param inMarketIndex - Spot market index of the token being sold.
	 * @param outMarketIndex - Spot market index of the token being bought.
	 * @param inAmount - Amount of `inMarketIndex` token to sell, in that market's mint precision.
	 * @param inTargetWeight - Assumed target-base weight for the in-constituent (PERCENTAGE_PRECISION, 1e6).
	 * @param outTargetWeight - Assumed target-base weight for the out-constituent (PERCENTAGE_PRECISION, 1e6).
	 * @param lpPool - LP pool public key.
	 * @param constituentTargetBase - The pool's constituent target-base account.
	 * @param constituentInTokenAccount - In-constituent's vault token account.
	 * @param constituentOutTokenAccount - Out-constituent's vault token account.
	 * @param inConstituent - In-constituent account.
	 * @param outConstituent - Out-constituent account.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature (intended for simulation, not confirmation).
	 */
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

	/**
	 * Builds the `viewLpPoolSwapFees` instruction. See `viewLpPoolSwapFees` for semantics.
	 * @param inMarketIndex - Spot market index of the token being sold.
	 * @param outMarketIndex - Spot market index of the token being bought.
	 * @param inAmount - Amount of `inMarketIndex` token to sell, in that market's mint precision.
	 * @param inTargetWeight - Assumed target-base weight for the in-constituent (PERCENTAGE_PRECISION, 1e6).
	 * @param outTargetWeight - Assumed target-base weight for the out-constituent (PERCENTAGE_PRECISION, 1e6).
	 * @param lpPool - LP pool public key.
	 * @param constituentTargetBase - The pool's constituent target-base account.
	 * @param constituentInTokenAccount - In-constituent's vault token account.
	 * @param constituentOutTokenAccount - Out-constituent's vault token account.
	 * @param inConstituent - In-constituent account.
	 * @param outConstituent - Out-constituent account.
	 * @returns The instruction.
	 */
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

	/**
	 * Builds an idempotent instruction creating this wallet's associated token account for an LP
	 * pool's mint, needed before receiving pool tokens from `lpPoolAddLiquidity`.
	 * @param lpPool - Decoded LP pool account whose mint to create an account for.
	 * @returns The instruction.
	 */
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

	/**
	 * Creates this wallet's associated token account for an LP pool's mint. See
	 * `getCreateLpPoolTokenAccountIx`.
	 * @param lpPool - Decoded LP pool account whose mint to create an account for.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Deposits `inMarketIndex` tokens into an LP pool's matching constituent and mints LP pool tokens
	 * in return, priced at the pool's current AUM-derived share price. Reverts if mint/redeem is
	 * disabled, the constituent doesn't allow deposits (or is reduce-only and this isn't a
	 * reducing deposit), the pool is gated by a whitelist mint this wallet doesn't hold, or
	 * `updateLpPoolAum` has not run within `LP_POOL_SWAP_AUM_UPDATE_DELAY` slots (see
	 * `getAllLpPoolAddLiquidityIxs` for a wrapper that prepends the required AUM refresh).
	 * @param inMarketIndex - Spot market index of the token being deposited.
	 * @param inAmount - Amount to deposit, in `inMarketIndex`'s mint precision.
	 * @param minMintAmount - Minimum acceptable LP pool tokens to receive, in the pool mint's precision.
	 * @param lpPool - Decoded LP pool account to deposit into.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `lpPoolAddLiquidity` instruction (plus any needed wrapped-SOL / associated-token-
	 * account setup and teardown instructions). See `lpPoolAddLiquidity` for semantics.
	 * @param inMarketIndex - Spot market index of the token being deposited.
	 * @param inAmount - Amount to deposit, in `inMarketIndex`'s mint precision.
	 * @param minMintAmount - Minimum acceptable LP pool tokens to receive, in the pool mint's precision.
	 * @param lpPool - Decoded LP pool account to deposit into.
	 * @returns The ordered instructions to include in the transaction.
	 */
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

	/**
	 * Simulation-only instruction: computes what `lpPoolAddLiquidity` would mint/charge for the given
	 * deposit without moving any funds (intended for `simulateTransaction`, not confirmation).
	 * @param inMarketIndex - Spot market index of the token being deposited.
	 * @param inAmount - Amount to deposit, in `inMarketIndex`'s mint precision.
	 * @param lpPool - Decoded LP pool account to deposit into.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature (intended for simulation, not confirmation).
	 */
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

	/**
	 * Builds the `viewLpPoolAddLiquidityFees` instruction. See `viewLpPoolAddLiquidityFees` for semantics.
	 * @param inMarketIndex - Spot market index of the token being deposited.
	 * @param inAmount - Amount to deposit, in `inMarketIndex`'s mint precision.
	 * @param lpPool - Decoded LP pool account to deposit into.
	 * @returns The instruction.
	 */
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

	/**
	 * Burns LP pool tokens and withdraws `outMarketIndex` tokens from the pool's matching constituent
	 * in return, priced at the pool's current AUM-derived share price. Reverts if mint/redeem is
	 * disabled, the constituent doesn't allow withdrawals, or `updateLpPoolAum` has not run within
	 * `LP_POOL_SWAP_AUM_UPDATE_DELAY` slots (see `getAllLpPoolRemoveLiquidityIxs` for a wrapper that
	 * prepends the required perp settlement and AUM refresh).
	 * @param outMarketIndex - Spot market index of the token being withdrawn.
	 * @param lpToBurn - Amount of LP pool tokens to burn, in the pool mint's precision.
	 * @param minAmountOut - Minimum acceptable `outMarketIndex` tokens to receive, in that market's
	 * mint precision.
	 * @param lpPool - Decoded LP pool account to withdraw from.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `lpPoolRemoveLiquidity` instruction (plus an idempotent associated-token-account
	 * creation instruction for a wrapped-SOL output, if needed). See `lpPoolRemoveLiquidity` for
	 * semantics.
	 * @param outMarketIndex - Spot market index of the token being withdrawn.
	 * @param lpToBurn - Amount of LP pool tokens to burn, in the pool mint's precision.
	 * @param minAmountOut - Minimum acceptable `outMarketIndex` tokens to receive, in that market's
	 * mint precision.
	 * @param lpPool - Decoded LP pool account to withdraw from.
	 * @returns The ordered instructions to include in the transaction.
	 */
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

	/**
	 * Simulation-only instruction: computes what `lpPoolRemoveLiquidity` would return for the given
	 * burn without moving any funds (intended for `simulateTransaction`, not confirmation).
	 * @param outMarketIndex - Spot market index of the token being withdrawn.
	 * @param lpToBurn - Amount of LP pool tokens to burn, in the pool mint's precision.
	 * @param lpPool - Decoded LP pool account to withdraw from.
	 * @param txParams - Optional compute-unit/priority-fee overrides.
	 * @returns The transaction signature (intended for simulation, not confirmation).
	 */
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

	/**
	 * Builds the `viewLpPoolRemoveLiquidityFees` instruction. See `viewLpPoolRemoveLiquidityFees` for
	 * semantics.
	 * @param outMarketIndex - Spot market index of the token being withdrawn.
	 * @param lpToBurn - Amount of LP pool tokens to burn, in the pool mint's precision.
	 * @param lpPool - Decoded LP pool account to withdraw from.
	 * @returns The instruction.
	 */
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

	/**
	 * Convenience wrapper that prepends the AUM refresh `lpPoolAddLiquidity` requires (an
	 * `updateConstituentOracleInfo` per constituent, then `updateLpPoolAum`) ahead of either the real
	 * add-liquidity instruction or, when `view` is set, its fee-simulation counterpart.
	 * @param inMarketIndex - Spot market index of the token being deposited.
	 * @param inAmount - Amount to deposit, in `inMarketIndex`'s mint precision.
	 * @param minMintAmount - Minimum acceptable LP pool tokens to receive, in the pool mint's precision.
	 * @param lpPool - Decoded LP pool account to deposit into.
	 * @param constituentMap - All of the pool's constituents, used to refresh oracle info and AUM.
	 * @param includeUpdateConstituentOracleInfo - Whether to prepend an oracle-info refresh per
	 * constituent; defaults to `true`.
	 * @param view - When `true`, appends `getViewLpPoolAddLiquidityFeesIx` instead of the real deposit;
	 * defaults to `false`.
	 * @returns The ordered instructions to include in the transaction.
	 */
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

	/**
	 * Convenience wrapper that prepends what `lpPoolRemoveLiquidity` requires: settling every hedge-
	 * enabled perp market's PnL into the pool (`getAllSettlePerpToLpPoolIxs`) and refreshing AUM
	 * (`getAllUpdateLpPoolAumIxs`), ahead of either the real remove-liquidity instruction or, when
	 * `view` is set, its fee-simulation counterpart.
	 * @param outMarketIndex - Spot market index of the token being withdrawn.
	 * @param lpToBurn - Amount of LP pool tokens to burn, in the pool mint's precision.
	 * @param minAmountOut - Minimum acceptable `outMarketIndex` tokens to receive, in that market's
	 * mint precision.
	 * @param lpPool - Decoded LP pool account to withdraw from.
	 * @param constituentMap - All of the pool's constituents, used to refresh oracle info and AUM.
	 * @param includeUpdateConstituentOracleInfo - Whether to prepend an oracle-info refresh per
	 * constituent; defaults to `true`.
	 * @param view - When `true`, appends `getViewLpPoolRemoveLiquidityFeesIx` instead of the real
	 * withdrawal; defaults to `false`.
	 * @returns The ordered instructions to include in the transaction.
	 */
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

	/**
	 * Builds the full instruction set to refresh an LP pool's AUM: one `updateConstituentOracleInfo`
	 * per constituent (optional) followed by `updateLpPoolAum` across all of them.
	 * @param lpPool - Decoded LP pool account to update.
	 * @param constituentMap - All of the pool's constituents.
	 * @param includeUpdateConstituentOracleInfo - Whether to prepend an oracle-info refresh per
	 * constituent; defaults to `true`. Pass `false` when a caller has already refreshed oracle info
	 * earlier in the same transaction.
	 * @returns The ordered instructions to include in the transaction.
	 */
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

	/**
	 * Builds the full instruction set to refresh an LP pool's constituent target-base weights:
	 * `updateAmmCache` for the given markets, an optional `updateConstituentOracleInfo` per
	 * constituent, `updateLpConstituentTargetBase`, then a full AUM refresh
	 * (`getAllUpdateLpPoolAumIxs`, oracle info not repeated).
	 * @param perpMarketIndexes - Hedge-enabled perp market indexes to refresh in the AMM cache.
	 * @param lpPool - Decoded LP pool account to update.
	 * @param constituentMap - All of the pool's constituents.
	 * @param includeUpdateConstituentOracleInfo - Whether to include an oracle-info refresh per
	 * constituent; defaults to `true`.
	 * @returns The ordered instructions to include in the transaction.
	 */
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

	/**
	 * Convenience wrapper that prepends the AUM refresh `lpPoolSwap` requires ahead of the swap
	 * instruction itself.
	 * @param lpPool - Decoded LP pool account to swap against.
	 * @param constituentMap - All of the pool's constituents, used to refresh AUM.
	 * @param inMarketIndex - Spot market index of the token being sold.
	 * @param outMarketIndex - Spot market index of the token being bought.
	 * @param inAmount - Amount of `inMarketIndex` token to sell, in that market's mint precision.
	 * @param minOutAmount - Minimum acceptable amount of `outMarketIndex` token to receive, in that
	 * market's mint precision.
	 * @param userAuthority - Authority whose associated token accounts fund/receive the swap.
	 * @returns The ordered instructions to include in the transaction.
	 */
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

	/**
	 * Keeper instruction: settles quote PnL owed between one or more hedge-enabled perp markets' fee
	 * and PnL pools and the LP pool's quote constituent, bounded by the pool's settle cap. Requires
	 * `updateAmmCache` to have run recently for the given markets. Permissionless — any signer can
	 * act as keeper.
	 * @param lpPoolId - LP pool ID.
	 * @param perpMarketIndexes - Hedge-enabled perp market indexes to settle.
	 * @returns The transaction signature.
	 */
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

	/**
	 * Builds the `settlePerpToLpPool` instruction. See `settlePerpToLpPool` for semantics.
	 * @param lpPoolId - LP pool ID.
	 * @param perpMarketIndexes - Hedge-enabled perp market indexes to settle, passed as writable
	 * remaining accounts.
	 * @returns The instruction.
	 */
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

	/**
	 * Builds the full instruction set to settle perp PnL into an LP pool: `updateAmmCache` for the
	 * given markets followed by `settlePerpToLpPool`.
	 * @param lpPoolId - LP pool ID.
	 * @param marketIndexes - Hedge-enabled perp market indexes to settle.
	 * @returns The ordered instructions to include in the transaction.
	 */
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
	 * Signs (unless `preSigned`) and sends a transaction via this client's `txSender`, dispatching to
	 * `sendVersionedTransaction` or `send` based on whether `tx` is a `VersionedTransaction`. The
	 * shared low-level send path underlying nearly every instruction-building method on this class.
	 * @param tx - Transaction to send; legacy `Transaction` or `VersionedTransaction`.
	 * @param additionalSigners - Extra signers beyond this client's wallet (e.g. newly-created accounts).
	 * @param opts - Confirmation options; falls back to `this.opts` if not provided.
	 * @param preSigned - If `true`, `tx` is assumed already fully signed and is submitted as-is.
	 * @returns The transaction signature and the slot it was confirmed at.
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

	/**
	 * Assembles one or more instructions into a single unsigned transaction via `this.txHandler`,
	 * applying compute-unit/priority-fee instructions from `txParams`, resolving address lookup
	 * tables for versioned transactions, and fetching a recent blockhash if not supplied. Used by
	 * nearly every instruction-building method on this class before sending.
	 * @param instructions - Instruction(s) to include.
	 * @param txParams - Optional compute-unit/priority-fee overrides; defaults to `this.txParams`.
	 * @param txVersion - Legacy (`0`) vs versioned transaction; defaults to `this.txVersion`.
	 * @param lookupTables - Additional address lookup tables to use, beyond the client's configured
	 * market lookup tables.
	 * @param forceVersionedTransaction - Force a `VersionedTransaction` even if `txVersion` implies legacy.
	 * @param recentBlockhash - Pre-fetched blockhash to reuse instead of requesting a new one.
	 * @param optionalIxs - Instructions to append opportunistically if space/compute budget allows
	 * (dropped rather than causing failure if they don't fit).
	 * @returns The assembled (unsigned) transaction.
	 */
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

	/**
	 * Builds many independent transactions in one call — each entry in `instructions` becomes its own
	 * transaction via the same path as `buildTransaction`. An entry may build to `undefined` if the
	 * underlying `txHandler` implementation skips it (e.g. empty instruction list).
	 * @param instructions - One instruction-list per transaction to build.
	 * @param txParams - Optional compute-unit/priority-fee overrides applied to every transaction.
	 * @param txVersion - Legacy (`0`) vs versioned transaction; defaults to `this.txVersion`.
	 * @param lookupTables - Additional address lookup tables to use for every transaction.
	 * @param forceVersionedTransaction - Force `VersionedTransaction`s even if `txVersion` implies legacy.
	 * @returns The assembled (unsigned) transactions, in the same order as `instructions`.
	 */
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

	/**
	 * Like `buildBulkTransactions`, but keyed by caller-chosen labels instead of array position — each
	 * value in `instructionsMap` becomes its own transaction, returned under the same key.
	 * @param instructionsMap - Instruction-list(s) to build, keyed by an arbitrary caller-defined label.
	 * @param txParams - Optional compute-unit/priority-fee overrides applied to every transaction.
	 * @param txVersion - Legacy (`0`) vs versioned transaction; defaults to `this.txVersion`.
	 * @param lookupTables - Additional address lookup tables to use for every transaction.
	 * @param forceVersionedTransaction - Force `VersionedTransaction`s even if `txVersion` implies legacy.
	 * @returns A map from each input key to its assembled (unsigned) transaction.
	 */
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

	/**
	 * Like `buildTransactionsMap`, but additionally signs every built transaction with this client's
	 * wallet before returning — useful for batching several independent, pre-signed transactions
	 * (e.g. to submit separately or hand off to `sendSignedTx`).
	 * @param instructionsMap - Instruction-list(s) to build and sign, keyed by an arbitrary
	 * caller-defined label.
	 * @param txParams - Optional compute-unit/priority-fee overrides applied to every transaction.
	 * @param txVersion - Legacy (`0`) vs versioned transaction; defaults to `this.txVersion`.
	 * @param lookupTables - Additional address lookup tables to use for every transaction.
	 * @param forceVersionedTransaction - Force `VersionedTransaction`s even if `txVersion` implies legacy.
	 * @returns A map from each input key to its signed transaction.
	 */
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

	/**
	 * Determines whether placing `orderParams` would increase the magnitude of the sub-account's
	 * existing perp position in that market (same-direction add, or opening a new position) as
	 * opposed to reducing/flattening/flipping it. Used by `placePerpOrder`/`placeOrders`/
	 * `preparePlaceOrdersTx` to decide whether an `isolatedPositionDepositAmount` transfer should be
	 * prepended — that transfer only makes sense when the order grows the position.
	 * @param orderParams - Order to evaluate; `baseAssetAmount` is BASE_PRECISION (1e9).
	 * @param subAccountId - Sub-account whose existing position to compare against; defaults to the
	 * active sub-account.
	 * @returns `true` if there is no existing position in the market, the existing position is flat
	 * (zero), or the order's signed base amount increases the position's absolute size; `false` if it
	 * reduces, flattens, or flips it.
	 */
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
