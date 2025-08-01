import * as anchor from '@coral-xyz/anchor';
import {
	AnchorProvider,
	BN,
	Idl,
	Program,
	ProgramAccount,
} from '@coral-xyz/anchor';
import { Idl as Idl30, Program as Program30 } from '@coral-xyz/anchor-30';
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
	DriftClientMetricsEvents,
	HighLeverageModeConfig,
	isVariant,
	IWallet,
	MakerInfo,
	MappedRecord,
	MarketType,
	ModifyOrderParams,
	ModifyOrderPolicy,
	OpenbookV2FulfillmentConfigAccount,
	OptionalOrderParams,
	OracleSource,
	Order,
	OrderParams,
	OrderTriggerCondition,
	OrderType,
	PerpMarketAccount,
	PerpMarketExtendedInfo,
	PhoenixV1FulfillmentConfigAccount,
	PlaceAndTakeOrderSuccessCondition,
	PositionDirection,
	ReferrerInfo,
	ReferrerNameAccount,
	SerumV3FulfillmentConfigAccount,
	SettlePnlMode,
	SignedTxData,
	SpotBalanceType,
	SpotMarketAccount,
	SpotPosition,
	StateAccount,
	SwapReduceOnly,
	SignedMsgOrderParamsMessage,
	TakerInfo,
	TxParams,
	UserAccount,
	UserStatsAccount,
	ProtectedMakerModeConfig,
	SignedMsgOrderParamsDelegateMessage,
	TokenProgramFlag,
} from './types';
import driftIDL from './idl/drift.json';

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
	getDriftSignerPublicKey,
	getDriftStateAccountPublicKey,
	getFuelOverflowAccountPublicKey,
	getHighLeverageModeConfigPublicKey,
	getInsuranceFundStakeAccountPublicKey,
	getOpenbookV2FulfillmentConfigPublicKey,
	getPerpMarketPublicKey,
	getPhoenixFulfillmentConfigPublicKey,
	getProtectedMakerModeConfigPublicKey,
	getPythLazerOraclePublicKey,
	getPythPullOraclePublicKey,
	getReferrerNamePublicKeySync,
	getSerumFulfillmentConfigPublicKey,
	getSerumSignerPublicKey,
	getSpotMarketPublicKey,
	getSignedMsgUserAccountPublicKey,
	getUserAccountPublicKey,
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
	getSignedMsgWsDelegatesAccountPublicKey,
	getIfRebalanceConfigPublicKey,
} from './addresses/pda';
import {
	DataAndSlot,
	DelistedMarketSetting,
	DriftClientAccountEvents,
	DriftClientAccountSubscriber,
} from './accounts/types';
import { TxSender, TxSigAndSlot } from './tx/types';
import {
	BASE_PRECISION,
	GOV_SPOT_MARKET_INDEX,
	ONE,
	PERCENTAGE_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
	ZERO,
} from './constants/numericConstants';
import { findDirectionToClose, positionIsAvailable } from './math/position';
import { getSignedTokenAmount, getTokenAmount } from './math/spotBalance';
import { decodeName, DEFAULT_USER_NAME, encodeName } from './userName';
import { OraclePriceData } from './oracles/types';
import { DriftClientConfig } from './driftClientConfig';
import { PollingDriftClientAccountSubscriber } from './accounts/pollingDriftClientAccountSubscriber';
import { WebSocketDriftClientAccountSubscriber } from './accounts/webSocketDriftClientAccountSubscriber';
import { RetryTxSender } from './tx/retryTxSender';
import { User } from './user';
import { UserSubscriptionConfig } from './userConfig';
import {
	configs,
	DRIFT_ORACLE_RECEIVER_ID,
	DEFAULT_CONFIRMATION_OPTS,
	DRIFT_PROGRAM_ID,
	DriftEnv,
	PYTH_LAZER_STORAGE_ACCOUNT_KEY,
} from './config';
import { WRAPPED_SOL_MINT } from './constants/spotMarkets';
import { UserStats } from './userStats';
import { isSpotPositionAvailable } from './math/spotPosition';
import { calculateMarketMaxAvailableInsurance } from './math/market';
import { fetchUserStatsAccount } from './accounts/fetch';
import { castNumberToSpotPrecision } from './math/spotMarket';
import {
	JupiterClient,
	QuoteResponse,
	SwapMode,
} from './jupiter/jupiterClient';
import { getNonIdleUserFilter } from './memcmp';
import { UserStatsSubscriptionConfig } from './userStatsConfig';
import { getMarinadeDepositIx, getMarinadeFinanceProgram } from './marinade';
import { getOrderParams, isUpdateHighLeverageMode } from './orderParams';
import { numberToSafeBN } from './math/utils';
import { TransactionParamProcessor } from './tx/txParamProcessor';
import { isOracleValid, trimVaaSignatures } from './math/oracles';
import { TxHandler } from './tx/txHandler';
import {
	DEFAULT_RECEIVER_PROGRAM_ID,
	wormholeCoreBridgeIdl,
} from '@pythnetwork/pyth-solana-receiver';
import { parseAccumulatorUpdateData } from '@pythnetwork/price-service-sdk';
import {
	DEFAULT_WORMHOLE_PROGRAM_ID,
	getGuardianSetPda,
} from '@pythnetwork/pyth-solana-receiver/lib/address';
import { WormholeCoreBridgeSolana } from '@pythnetwork/pyth-solana-receiver/lib/idl/wormhole_core_bridge_solana';
import { PythSolanaReceiver } from '@pythnetwork/pyth-solana-receiver/lib/idl/pyth_solana_receiver';
import { getFeedIdUint8Array, trimFeedId } from './util/pythOracleUtils';
import { createMinimalEd25519VerifyIx } from './util/ed25519Utils';
import {
	createNativeInstructionDiscriminatorBuffer,
	isVersionedTransaction,
} from './tx/utils';
import pythSolanaReceiverIdl from './idl/pyth_solana_receiver.json';
import { asV0Tx, PullFeed, AnchorUtils } from '@switchboard-xyz/on-demand';
import { gprcDriftClientAccountSubscriber } from './accounts/grpcDriftClientAccountSubscriber';
import nacl from 'tweetnacl';
import { Slothash } from './slot/SlothashSubscriber';
import { getOracleId } from './oracles/oracleId';
import { SignedMsgOrderParams } from './types';
import { sha256 } from '@noble/hashes/sha256';
import { getOracleConfidenceFromMMOracleData } from './oracles/utils';

type RemainingAccountParams = {
	userAccounts: UserAccount[];
	writablePerpMarketIndexes?: number[];
	writableSpotMarketIndexes?: number[];
	readablePerpMarketIndex?: number | number[];
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
	env: DriftEnv;
	opts?: ConfirmOptions;
	useHotWalletAdmin?: boolean;
	users = new Map<string, User>();
	userStats?: UserStats;
	activeSubAccountId: number;
	userAccountSubscriptionConfig: UserSubscriptionConfig;
	userStatsAccountSubscriptionConfig: UserStatsSubscriptionConfig;
	accountSubscriber: DriftClientAccountSubscriber;
	eventEmitter: StrictEventEmitter<EventEmitter, DriftClientAccountEvents>;
	metricsEventEmitter: StrictEventEmitter<
		EventEmitter,
		DriftClientMetricsEvents
	>;
	_isSubscribed = false;
	txSender: TxSender;
	perpMarketLastSlotCache = new Map<number, number>();
	spotMarketLastSlotCache = new Map<number, number>();
	mustIncludePerpMarketIndexes = new Set<number>();
	mustIncludeSpotMarketIndexes = new Set<number>();
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

	txHandler: TxHandler;

	receiverProgram?: Program<PythSolanaReceiver>;
	wormholeProgram?: Program<WormholeCoreBridgeSolana>;
	sbOnDemandProgramdId: PublicKey;
	sbOnDemandProgram?: Program30<Idl30>;
	sbProgramFeedConfigs?: Map<string, any>;

	public get isSubscribed() {
		return this._isSubscribed && this.accountSubscriber.isSubscribed;
	}

	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	public constructor(config: DriftClientConfig) {
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
		this.program = new Program(
			driftIDL as Idl,
			config.programID ?? new PublicKey(DRIFT_PROGRAM_ID),
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
				driftClient: this,
				userStatsAccountPublicKey: getUserStatsAccountPublicKey(
					this.program.programId,
					this.authority
				),
				accountSubscription: this.userAccountSubscriptionConfig,
			});
		}

		this.marketLookupTable = config.marketLookupTable;
		if (!this.marketLookupTable) {
			this.marketLookupTable = new PublicKey(
				configs[this.env].MARKET_LOOKUP_TABLE
			);
		}

		this.marketLookupTables = config.marketLookupTables;
		if (!this.marketLookupTables) {
			this.marketLookupTables = configs[this.env].MARKET_LOOKUP_TABLES.map(
				(tableAddr) => new PublicKey(tableAddr)
			);
		}

		const delistedMarketSetting =
			config.delistedMarketSetting || DelistedMarketSetting.Unsubscribe;
		const noMarketsAndOraclesSpecified =
			config.perpMarketIndexes === undefined &&
			config.spotMarketIndexes === undefined &&
			config.oracleInfos === undefined;
		if (config.accountSubscription?.type === 'polling') {
			this.accountSubscriber = new PollingDriftClientAccountSubscriber(
				this.program,
				config.accountSubscription.accountLoader,
				config.perpMarketIndexes ?? [],
				config.spotMarketIndexes ?? [],
				config.oracleInfos ?? [],
				noMarketsAndOraclesSpecified,
				delistedMarketSetting
			);
		} else if (config.accountSubscription?.type === 'grpc') {
			this.accountSubscriber = new gprcDriftClientAccountSubscriber(
				config.accountSubscription.grpcConfigs,
				this.program,
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
			this.accountSubscriber = new WebSocketDriftClientAccountSubscriber(
				this.program,
				config.perpMarketIndexes ?? [],
				config.spotMarketIndexes ?? [],
				config.oracleInfos ?? [],
				noMarketsAndOraclesSpecified,
				delistedMarketSetting,
				{
					resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
					logResubMessages: config.accountSubscription?.logResubMessages,
				},
				config.accountSubscription?.commitment,
				config.accountSubscription?.perpMarketAccountSubscriber
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

		this.sbOnDemandProgramdId = configs[this.env].SB_ON_DEMAND_PID;
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
			driftClient: this,
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
			.filter((value) => value !== undefined)
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
			.filter((value) => value !== undefined)
			.map((value) => value.data);
	}

	public getQuoteSpotMarketAccount(): SpotMarketAccount {
		return this.accountSubscriber.getSpotMarketAccountAndSlot(
			QUOTE_SPOT_MARKET_INDEX
		).data;
	}

	public getOraclePriceDataAndSlot(
		oraclePublicKey: PublicKey,
		oracleSource: OracleSource
	): DataAndSlot<OraclePriceData> | undefined {
		return this.accountSubscriber.getOraclePriceDataAndSlot(
			getOracleId(oraclePublicKey, oracleSource)
		);
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

	public async getSerumV3FulfillmentConfigs(): Promise<
		SerumV3FulfillmentConfigAccount[]
	> {
		const accounts = await this.program.account.serumV3FulfillmentConfig.all();
		return accounts.map(
			(account) => account.account
		) as SerumV3FulfillmentConfigAccount[];
	}

	public async getPhoenixV1FulfillmentConfig(
		phoenixMarket: PublicKey
	): Promise<PhoenixV1FulfillmentConfigAccount> {
		const address = await getPhoenixFulfillmentConfigPublicKey(
			this.program.programId,
			phoenixMarket
		);
		return (await this.program.account.phoenixV1FulfillmentConfig.fetch(
			address
		)) as PhoenixV1FulfillmentConfigAccount;
	}

	public async getPhoenixV1FulfillmentConfigs(): Promise<
		PhoenixV1FulfillmentConfigAccount[]
	> {
		const accounts =
			await this.program.account.phoenixV1FulfillmentConfig.all();
		return accounts.map(
			(account) => account.account
		) as PhoenixV1FulfillmentConfigAccount[];
	}

	public async getOpenbookV2FulfillmentConfig(
		openbookMarket: PublicKey
	): Promise<OpenbookV2FulfillmentConfigAccount> {
		const address = getOpenbookV2FulfillmentConfigPublicKey(
			this.program.programId,
			openbookMarket
		);
		return (await this.program.account.openbookV2FulfillmentConfig.fetch(
			address
		)) as OpenbookV2FulfillmentConfigAccount;
	}

	public async getOpenbookV2FulfillmentConfigs(): Promise<
		OpenbookV2FulfillmentConfigAccount[]
	> {
		const accounts =
			await this.program.account.openbookV2FulfillmentConfig.all();
		return accounts.map(
			(account) => account.account
		) as OpenbookV2FulfillmentConfigAccount[];
	}

	/** @deprecated use fetchAllLookupTableAccounts() */
	public async fetchMarketLookupTableAccount(): Promise<AddressLookupTableAccount> {
		if (this.lookupTableAccount) return this.lookupTableAccount;

		if (!this.marketLookupTable) {
			console.log('Market lookup table address not set');
			return;
		}

		const lookupTableAccount = (
			await this.connection.getAddressLookupTable(this.marketLookupTable)
		).value;
		this.lookupTableAccount = lookupTableAccount;

		return lookupTableAccount;
	}

	public async fetchAllLookupTableAccounts(): Promise<
		AddressLookupTableAccount[]
	> {
		if (this.lookupTableAccounts) return this.lookupTableAccounts;

		if (!this.marketLookupTables) {
			console.log('Market lookup table address not set');
			return;
		}

		const lookupTableAccountResults = await Promise.all(
			this.marketLookupTables.map((lookupTable) =>
				this.connection.getAddressLookupTable(lookupTable)
			)
		);

		const lookupTableAccounts = lookupTableAccountResults.map(
			(result) => result.value
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
	 * Update the wallet to use for drift transactions and linked user account
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
		const newProgram = new Program(
			driftIDL as Idl,
			this.program.programId,
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
			driftClient: this,
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
			driftClient: this,
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
		this.userStatsAccountPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			this.authority
		);

		/* If changing the user authority ie switching from delegate to non-delegate account, need to re-subscribe to the user stats account */
		if (authorityChanged && this.userStats) {
			if (this.userStats.isSubscribed) {
				await this.userStats.unsubscribe();
			}

			this.userStats = new UserStats({
				driftClient: this,
				userStatsAccountPublicKey: this.userStatsAccountPublicKey,
				accountSubscription: this.userAccountSubscriptionConfig,
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

		if (this.users.has(userKey) && this.users.get(userKey).isSubscribed) {
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
		// save the rpc calls if driftclient is initialized without a real wallet
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
			let userAccounts = [];
			let delegatedAccounts = [];

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

	async getInitializeUserStatsIx(): Promise<TransactionInstruction> {
		return await this.program.instruction.initializeUserStats({
			accounts: {
				userStats: getUserStatsAccountPublicKey(
					this.program.programId,
					this.wallet.publicKey // only allow payer to initialize own user stats account
				),
				authority: this.wallet.publicKey,
				payer: this.wallet.publicKey,
				rent: anchor.web3.SYSVAR_RENT_PUBKEY,
				systemProgram: anchor.web3.SystemProgram.programId,
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
		numOrders: number
	): Promise<[PublicKey, TransactionInstruction]> {
		const signedMsgUserAccountPublicKey = getSignedMsgUserAccountPublicKey(
			this.program.programId,
			authority
		);
		const initializeUserAccountIx =
			await this.program.instruction.initializeSignedMsgUserOrders(numOrders, {
				accounts: {
					signedMsgUserOrders: signedMsgUserAccountPublicKey,
					authority,
					payer: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
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
					systemProgram: anchor.web3.SystemProgram.programId,
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
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
				},
			}
		);
		return ix;
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
					systemProgram: anchor.web3.SystemProgram.programId,
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
					systemProgram: anchor.web3.SystemProgram.programId,
				},
			}
		);
		return ix;
	}

	public async initializeFuelOverflow(
		authority?: PublicKey
	): Promise<TransactionSignature> {
		const ix = await this.getInitializeFuelOverflowIx(authority);
		const tx = await this.buildTransaction([ix], this.txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getInitializeFuelOverflowIx(
		authority?: PublicKey
	): Promise<TransactionInstruction> {
		return await this.program.instruction.initializeFuelOverflow({
			accounts: {
				fuelOverflow: getFuelOverflowAccountPublicKey(
					this.program.programId,
					authority ?? this.wallet.publicKey
				),
				userStats: getUserStatsAccountPublicKey(
					this.program.programId,
					authority ?? this.wallet.publicKey
				),
				authority: authority ?? this.wallet.publicKey,
				payer: this.wallet.publicKey,
				rent: anchor.web3.SYSVAR_RENT_PUBKEY,
				systemProgram: anchor.web3.SystemProgram.programId,
			},
		});
	}

	public async sweepFuel(authority?: PublicKey): Promise<TransactionSignature> {
		const ix = await this.getSweepFuelIx(authority);
		const tx = await this.buildTransaction([ix], this.txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getSweepFuelIx(
		authority?: PublicKey
	): Promise<TransactionInstruction> {
		return await this.program.instruction.sweepFuel({
			accounts: {
				fuelOverflow: getFuelOverflowAccountPublicKey(
					this.program.programId,
					authority ?? this.wallet.publicKey
				),
				userStats: getUserStatsAccountPublicKey(
					this.program.programId,
					authority ?? this.wallet.publicKey
				),
				authority: authority ?? this.wallet.publicKey,
				signer: this.wallet.publicKey,
			},
		});
	}

	private async getInitializeUserInstructions(
		subAccountId = 0,
		name?: string,
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
			const associatedTokenPublicKey = await getAssociatedTokenAddress(
				state.whitelistMint,
				this.wallet.publicKey
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

	async getNextSubAccountId(): Promise<number> {
		const userStats = this.getUserStats();
		let userStatsAccount: UserStatsAccount;
		if (!userStats) {
			userStatsAccount = await fetchUserStatsAccount(
				this.connection,
				this.program,
				this.wallet.publicKey
			);
		} else {
			userStatsAccount = userStats.getAccount();
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
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
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

		let remainingAccounts;
		try {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [this.getUserAccount(subAccountId)],
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
		const ix = await this.program.instruction.updateUserAdvancedLp(
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
		return (await this.program.account.user.all(
			filters
		)) as ProgramAccount<UserAccount>[];
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

		return programAccounts
			.map((programAccount) => programAccount.account as UserAccount)
			.sort((a, b) => a.subAccountId - b.subAccountId);
	}

	public async getUserAccountsAndAddressesForAuthority(
		authority: PublicKey
	): Promise<ProgramAccount<UserAccount>[]> {
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
			(programAccount) => programAccount as ProgramAccount<UserAccount>
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

		return programAccounts
			.map((programAccount) => programAccount.account as UserAccount)
			.sort((a, b) => a.subAccountId - b.subAccountId);
	}

	public async getReferredUserStatsAccountsByReferrer(
		referrer: PublicKey
	): Promise<UserStatsAccount[]> {
		const programAccounts = await this.program.account.userStats.all([
			{
				memcmp: {
					offset: 40,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(referrer.toBuffer()),
				},
			},
		]);

		return programAccounts.map(
			(programAccount) => programAccount.account as UserStatsAccount
		);
	}

	public async getReferrerNameAccountsForAuthority(
		authority: PublicKey
	): Promise<ReferrerNameAccount[]> {
		const programAccounts = await this.program.account.referrerName.all([
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

		const tokenPrograms = new Set<string>();
		for (const spotPosition of userAccount.spotPositions) {
			if (isSpotPositionAvailable(spotPosition)) {
				continue;
			}
			const spotMarket = this.getSpotMarketAccount(spotPosition.marketIndex);
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
				driftSigner: this.getSignerPublicKey(),
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
		const ix = await this.program.instruction.deleteSignedMsgUserOrders({
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
				rent: anchor.web3.SYSVAR_RENT_PUBKEY,
			},
		});
	}

	public getUser(subAccountId?: number, authority?: PublicKey): User {
		subAccountId = subAccountId ?? this.activeSubAccountId;
		authority = authority ?? this.authority;
		const userMapKey = this.getUserMapKey(subAccountId, authority);

		if (!this.users.has(userMapKey)) {
			throw new Error(`DriftClient has no user for user id ${userMapKey}`);
		}
		return this.users.get(userMapKey);
	}

	public hasUser(subAccountId?: number, authority?: PublicKey): boolean {
		subAccountId = subAccountId ?? this.activeSubAccountId;
		authority = authority ?? this.authority;
		const userMapKey = this.getUserMapKey(subAccountId, authority);

		return this.users.has(userMapKey);
	}

	public getUsers(): User[] {
		// delegate users get added to the end
		return [...this.users.values()]
			.filter((acct) =>
				acct.getUserAccount().authority.equals(this.wallet.publicKey)
			)
			.concat(
				[...this.users.values()].filter(
					(acct) =>
						!acct.getUserAccount().authority.equals(this.wallet.publicKey)
				)
			);
	}

	public getUserStats(): UserStats {
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
		return (await this.program.account.referrerName.fetch(
			referrerNameAccountPublicKey
		)) as ReferrerNameAccount;
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
		return this.getUserAccount(subAccountId).spotPositions.find(
			(spotPosition) => spotPosition.marketIndex === marketIndex
		);
	}

	public getQuoteAssetTokenAmount(): BN {
		return this.getTokenAmount(QUOTE_SPOT_MARKET_INDEX);
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
		const spotMarket = this.getSpotMarketAccount(marketIndex);
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
		const spotMarket = this.getSpotMarketAccount(marketIndex);
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
	 * Each drift instruction must include perp and sport market accounts in the ix remaining accounts.
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

	getRemainingAccounts(params: RemainingAccountParams): AccountMeta[] {
		const { oracleAccountMap, spotMarketAccountMap, perpMarketAccountMap } =
			this.getRemainingAccountMapsForUsers(params.userAccounts);

		if (params.useMarketLastSlotCache) {
			const lastUserSlot = this.getUserAccountAndSlot(
				params.userAccounts.length > 0
					? params.userAccounts[0].subAccountId
					: this.activeSubAccountId,
				params.userAccounts.length > 0
					? params.userAccounts[0].authority
					: this.authority
			)?.slot;

			for (const [
				marketIndex,
				slot,
			] of this.perpMarketLastSlotCache.entries()) {
				// if cache has more recent slot than user positions account slot, add market to remaining accounts
				// otherwise remove from slot
				if (slot > lastUserSlot) {
					this.addPerpMarketToRemainingAccountMaps(
						marketIndex,
						false,
						oracleAccountMap,
						spotMarketAccountMap,
						perpMarketAccountMap
					);
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
					this.addSpotMarketToRemainingAccountMaps(
						marketIndex,
						false,
						oracleAccountMap,
						spotMarketAccountMap
					);
				} else {
					this.spotMarketLastSlotCache.delete(marketIndex);
				}
			}
		}

		if (params.readablePerpMarketIndex !== undefined) {
			const readablePerpMarketIndexes = Array.isArray(
				params.readablePerpMarketIndex
			)
				? params.readablePerpMarketIndex
				: [params.readablePerpMarketIndex];
			for (const marketIndex of readablePerpMarketIndexes) {
				this.addPerpMarketToRemainingAccountMaps(
					marketIndex,
					false,
					oracleAccountMap,
					spotMarketAccountMap,
					perpMarketAccountMap
				);
			}
		}

		for (const perpMarketIndex of this.mustIncludePerpMarketIndexes.values()) {
			this.addPerpMarketToRemainingAccountMaps(
				perpMarketIndex,
				false,
				oracleAccountMap,
				spotMarketAccountMap,
				perpMarketAccountMap
			);
		}

		if (params.readableSpotMarketIndexes !== undefined) {
			for (const readableSpotMarketIndex of params.readableSpotMarketIndexes) {
				this.addSpotMarketToRemainingAccountMaps(
					readableSpotMarketIndex,
					false,
					oracleAccountMap,
					spotMarketAccountMap
				);
			}
		}

		for (const spotMarketIndex of this.mustIncludeSpotMarketIndexes.values()) {
			this.addSpotMarketToRemainingAccountMaps(
				spotMarketIndex,
				false,
				oracleAccountMap,
				spotMarketAccountMap
			);
		}

		if (params.writablePerpMarketIndexes !== undefined) {
			for (const writablePerpMarketIndex of params.writablePerpMarketIndexes) {
				this.addPerpMarketToRemainingAccountMaps(
					writablePerpMarketIndex,
					true,
					oracleAccountMap,
					spotMarketAccountMap,
					perpMarketAccountMap
				);
			}
		}

		if (params.writableSpotMarketIndexes !== undefined) {
			for (const writableSpotMarketIndex of params.writableSpotMarketIndexes) {
				this.addSpotMarketToRemainingAccountMaps(
					writableSpotMarketIndex,
					true,
					oracleAccountMap,
					spotMarketAccountMap
				);
			}
		}

		return [
			...oracleAccountMap.values(),
			...spotMarketAccountMap.values(),
			...perpMarketAccountMap.values(),
		];
	}

	addPerpMarketToRemainingAccountMaps(
		marketIndex: number,
		writable: boolean,
		oracleAccountMap: Map<string, AccountMeta>,
		spotMarketAccountMap: Map<number, AccountMeta>,
		perpMarketAccountMap: Map<number, AccountMeta>
	): void {
		const perpMarketAccount = this.getPerpMarketAccount(marketIndex);
		perpMarketAccountMap.set(marketIndex, {
			pubkey: perpMarketAccount.pubkey,
			isSigner: false,
			isWritable: writable,
		});
		const oracleWritable =
			writable && isVariant(perpMarketAccount.amm.oracleSource, 'prelaunch');
		oracleAccountMap.set(perpMarketAccount.amm.oracle.toString(), {
			pubkey: perpMarketAccount.amm.oracle,
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
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
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

	public getOrder(orderId: number, subAccountId?: number): Order | undefined {
		return this.getUserAccount(subAccountId)?.orders.find(
			(order) => order.orderId === orderId
		);
	}

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
		tokenProgram = TOKEN_PROGRAM_ID
	): Promise<PublicKey> {
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		if (useNative && spotMarket.mint.equals(WRAPPED_SOL_MINT)) {
			return this.wallet.publicKey;
		}
		const mint = spotMarket.mint;
		return await getAssociatedTokenAddress(
			mint,
			this.wallet.publicKey,
			undefined,
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
					pubkey: anchor.web3.SystemProgram.programId,
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
		reduceOnly = false
	): Promise<TransactionInstruction[]> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);

		const signerAuthority = this.wallet.publicKey;

		const createWSOLTokenAccount =
			isSolMarket && associatedTokenAccount.equals(signerAuthority);

		const instructions = [];

		if (createWSOLTokenAccount) {
			const { ixs, pubkey } = await this.getWrappedSolAccountCreationIxs(
				amount,
				true
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
			true
		);

		instructions.push(depositCollateralIx);

		// Close the wrapped sol account at the end of the transaction
		if (createWSOLTokenAccount) {
			instructions.push(
				createCloseAccountInstruction(
					associatedTokenAccount,
					signerAuthority,
					signerAuthority,
					[]
				)
			);
		}

		return instructions;
	}

	public async createDepositTxn(
		amount: BN,
		marketIndex: number,
		associatedTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly = false,
		txParams?: TxParams,
		initSwiftAccount = false
	): Promise<VersionedTransaction | Transaction> {
		const instructions = await this.getDepositTxnIx(
			amount,
			marketIndex,
			associatedTokenAccount,
			subAccountId,
			reduceOnly
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
	 */
	public async deposit(
		amount: BN,
		marketIndex: number,
		associatedTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly = false,
		txParams?: TxParams,
		initSwiftAccount = false
	): Promise<TransactionSignature> {
		const tx = await this.createDepositTxn(
			amount,
			marketIndex,
			associatedTokenAccount,
			subAccountId,
			reduceOnly,
			txParams,
			initSwiftAccount
		);

		const { txSig, slot } = await this.sendTransaction(tx, [], this.opts);
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
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			subAccountId ?? this.activeSubAccountId
		);

		let remainingAccounts = [];
		if (userInitialized) {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [await this.forceGetUserAccount(subAccountId)],
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

		this.addTokenMintToRemainingAccounts(spotMarketAccount, remainingAccounts);
		if (this.isTransferHook(spotMarketAccount)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				spotMarketAccount.mint,
				remainingAccounts
			);
		}

		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarketAccount);
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
					tokenProgram,
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

	public async getWrappedSolAccountCreationIxs(
		amount: BN,
		includeRent?: boolean
	): Promise<{
		ixs: anchor.web3.TransactionInstruction[];
		/** @deprecated - this array is always going to be empty, in the current implementation */
		signers: Signer[];
		pubkey: PublicKey;
	}> {
		const authority = this.wallet.publicKey;

		// Generate a random seed for wrappedSolAccount.
		const seed = Keypair.generate().publicKey.toBase58().slice(0, 32);

		// Calculate a publicKey that will be controlled by the authority.
		const wrappedSolAccount = await PublicKey.createWithSeed(
			authority,
			seed,
			TOKEN_PROGRAM_ID
		);

		const result = {
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
		const extraAccountMetas = getExtraAccountMetas(
			await this.connection.getAccountInfo(extraAccountMetasAddress)!
		);

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
	): anchor.web3.TransactionInstruction {
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
		poolId?: number
	): Promise<{
		ixs: TransactionInstruction[];
		userAccountPublicKey: PublicKey;
	}> {
		const ixs = [];

		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(
				subAccountId,
				name,
				referrerInfo
			);

		const isSignedMsgUserOrdersAccountInitialized =
			await this.isSignedMsgUserOrdersAccountInitialized(this.wallet.publicKey);

		if (!isSignedMsgUserOrdersAccountInitialized) {
			const [, initializeSignedMsgUserOrdersAccountIx] =
				await this.getInitializeSignedMsgUserOrdersAccountIx(
					this.wallet.publicKey,
					8
				);
			ixs.push(initializeSignedMsgUserOrdersAccountIx);
		}

		const spotMarket = this.getSpotMarketAccount(marketIndex);

		const isSolMarket = spotMarket.mint.equals(WRAPPED_SOL_MINT);

		const authority = this.wallet.publicKey;

		const isFromSubaccount =
			fromSubAccountId !== null &&
			fromSubAccountId !== undefined &&
			!isNaN(fromSubAccountId);

		donateAmount = donateAmount ? donateAmount : ZERO;

		const createWSOLTokenAccount =
			(isSolMarket &&
				userTokenAccount.equals(authority) &&
				!isFromSubaccount) ||
			!donateAmount.eq(ZERO);

		const wSolAmount = isSolMarket ? amount.add(donateAmount) : donateAmount;

		let wsolTokenAccount: PublicKey;
		if (createWSOLTokenAccount) {
			const { ixs: startIxs, pubkey } =
				await this.getWrappedSolAccountCreationIxs(wSolAmount, true);

			wsolTokenAccount = pubkey;

			if (isSolMarket) {
				userTokenAccount = pubkey;
			}

			ixs.push(...startIxs);
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
					false
			  );

		if (subAccountId === 0) {
			if (
				!(await this.checkIfAccountExists(this.getUserStatsAccountPublicKey()))
			) {
				ixs.push(await this.getInitializeUserStatsIx());
			}
		}
		ixs.push(initializeUserAccountIx);

		if (poolId) {
			ixs.push(await this.getUpdateUserPoolIdIx(poolId, subAccountId));
		}

		ixs.push(depositCollateralIx);

		if (!donateAmount.eq(ZERO)) {
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
		if (createWSOLTokenAccount) {
			ixs.push(
				createCloseAccountInstruction(
					wsolTokenAccount,
					authority,
					authority,
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
		poolId?: number
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
				poolId
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
		poolId?: number
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
				poolId
			);
		const additionalSigners: Array<Signer> = [];

		const { txSig, slot } = await this.sendTransaction(
			tx,
			additionalSigners,
			this.opts
		);
		this.spotMarketLastSlotCache.set(marketIndex, slot);

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
		subAccountId?: number,
		updateFuel = false
	): Promise<TransactionInstruction[]> {
		const withdrawIxs: anchor.web3.TransactionInstruction[] = [];

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);

		const authority = this.wallet.publicKey;

		if (updateFuel) {
			const updateFuelIx = await this.getUpdateUserFuelBonusIx(
				await this.getUserAccountPublicKey(subAccountId),
				this.getUserAccount(subAccountId),
				this.authority
			);
			withdrawIxs.push(updateFuelIx);
		}

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
		txParams?: TxParams,
		updateFuel = false
	): Promise<TransactionSignature> {
		const additionalSigners: Array<Signer> = [];

		const withdrawIxs = await this.getWithdrawalIxs(
			amount,
			marketIndex,
			associatedTokenAddress,
			reduceOnly,
			subAccountId,
			updateFuel
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
		this.spotMarketLastSlotCache.set(marketIndex, slot);
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

		let allWithdrawIxs: anchor.web3.TransactionInstruction[] = [];

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
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [marketIndex],
			readableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		this.addTokenMintToRemainingAccounts(spotMarketAccount, remainingAccounts);
		if (this.isTransferHook(spotMarketAccount)) {
			await this.addExtraAccountMetasToRemainingAccounts(
				spotMarketAccount.mint,
				remainingAccounts
			);
		}

		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarketAccount);

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
					user,
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

		const userMapKey = this.getUserMapKey(
			fromSubAccountId,
			this.wallet.publicKey
		);
		if (this.users.has(userMapKey)) {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [this.users.get(userMapKey).getUserAccount()],
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
			this.spotMarketLastSlotCache.set(depositFromMarketIndex, slot);
			this.spotMarketLastSlotCache.set(depositToMarketIndex, slot);
			this.spotMarketLastSlotCache.set(borrowFromMarketIndex, slot);
			this.spotMarketLastSlotCache.set(borrowToMarketIndex, slot);
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

		const userAccounts = [this.getUserAccount(fromSubAccountId)];

		if (!isToNewSubAccount) {
			userAccounts.push(this.getUserAccount(toSubAccountId));
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
		const depositFromSpotMarket = this.getSpotMarketAccount(
			depositFromMarketIndex
		);
		const borrowFromSpotMarket = this.getSpotMarketAccount(
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
					depositFromSpotMarketVault: this.getSpotMarketAccount(
						depositFromMarketIndex
					).vault,
					depositToSpotMarketVault:
						this.getSpotMarketAccount(depositToMarketIndex).vault,
					borrowFromSpotMarketVault: this.getSpotMarketAccount(
						borrowFromMarketIndex
					).vault,
					borrowToSpotMarketVault:
						this.getSpotMarketAccount(borrowToMarketIndex).vault,
					driftSigner: this.getSignerPublicKey(),
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
				this.getUserAccount(fromSubAccountId),
				this.getUserAccount(toSubAccountId),
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
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		return await this.program.instruction.updateSpotMarketCumulativeInterest({
			accounts: {
				state: await this.getStatePublicKey(),
				spotMarket: spotMarket.pubkey,
				spotMarketVault: spotMarket.vault,
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
			await this.buildTransaction(
				await this.settleLPIx(settleeUserAccountPublicKey, marketIndex),
				txParams
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
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getRemovePerpLpSharesIx(
					marketIndex,
					sharesToBurn,
					subAccountId
				),
				txParams
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
			await this.buildTransaction(
				await this.getRemovePerpLpSharesInExpiringMarket(
					marketIndex,
					userAccountPublicKey,
					sharesToBurn
				),
				txParams
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
		sharesToBurn?: BN,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		if (sharesToBurn == undefined) {
			const userAccount = this.getUserAccount(subAccountId);
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
					user,
					authority: this.wallet.publicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async addPerpLpShares(
		amount: BN,
		marketIndex: number,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getAddPerpLpSharesIx(amount, marketIndex, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(marketIndex, slot);
		return txSig;
	}

	public async getAddPerpLpSharesIx(
		amount: BN,
		marketIndex: number,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		return this.program.instruction.addPerpLpShares(amount, marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				authority: this.wallet.publicKey,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public getQuoteValuePerLpShare(marketIndex: number): BN {
		const perpMarketAccount = this.getPerpMarketAccount(marketIndex);

		const openBids = BN.max(
			perpMarketAccount.amm.baseAssetReserve.sub(
				perpMarketAccount.amm.minBaseAssetReserve
			),
			ZERO
		);

		const openAsks = BN.max(
			perpMarketAccount.amm.maxBaseAssetReserve.sub(
				perpMarketAccount.amm.baseAssetReserve
			),
			ZERO
		);

		const oraclePriceData = this.getOracleDataForPerpMarket(marketIndex);

		const maxOpenBidsAsks = BN.max(openBids, openAsks);
		const quoteValuePerLpShare = maxOpenBidsAsks
			.mul(oraclePriceData.price)
			.mul(QUOTE_PRECISION)
			.div(PRICE_PRECISION)
			.div(perpMarketAccount.amm.sqrtK);

		return quoteValuePerLpShare;
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
		referrerInfo?: ReferrerInfo,
		cancelExistingOrders?: boolean,
		settlePnl?: boolean
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

		const ixPromisesForTxs: Record<TxKeys, Promise<TransactionInstruction>> = {
			cancelExistingOrdersTx: undefined,
			settlePnlTx: undefined,
			fillTx: undefined,
			marketOrderTx: undefined,
		};

		const txKeys = Object.keys(ixPromisesForTxs);

		ixPromisesForTxs.marketOrderTx = this.getPlaceOrdersIx(
			[orderParams, ...bracketOrdersParams],
			userAccount.subAccountId
		);

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
				referrerInfo,
				userAccount.subAccountId
			);
		}

		const ixs = await Promise.all(Object.values(ixPromisesForTxs));

		const ixsMap = ixs.reduce((acc, ix, i) => {
			acc[txKeys[i]] = ix;
			return acc;
		}, {}) as MappedRecord<typeof ixPromisesForTxs, TransactionInstruction>;

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
		referrerInfo?: ReferrerInfo,
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
			referrerInfo,
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

		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);

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
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getPlacePerpOrderIx(orderParams, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);
		return txSig;
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
				: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: false,
			readablePerpMarketIndex: orderParams.marketIndex,
			readableSpotMarketIndexes: isDepositToTradeTx
				? [depositToTradeArgs?.depositMarketIndex]
				: undefined,
		});

		if (isUpdateHighLeverageMode(orderParams.bitFlags)) {
			remainingAccounts.push({
				pubkey: getHighLeverageModeConfigPublicKey(this.program.programId),
				isWritable: true,
				isSigner: false,
			});
		}

		return await this.program.instruction.placePerpOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
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
					? this.getStateAccount().admin
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
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					spotMarket: spotMarketPublicKey,
					perpMarket: perpMarketPublicKey,
				},
			}
		);
	}

	public async cancelOrder(
		orderId?: number,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getCancelOrderIx(orderId, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrderIx(
		orderId?: number,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
		});

		return await this.program.instruction.cancelOrder(orderId ?? null, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				authority: this.wallet.publicKey,
			},
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

		const order = this.getOrderByUserId(userOrderId);
		const oracle = this.getPerpMarketAccount(order.marketIndex).amm.oracle;

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
		});

		return await this.program.instruction.cancelOrderByUserId(userOrderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				authority: this.wallet.publicKey,
				oracle,
			},
			remainingAccounts,
		});
	}

	public async cancelOrdersByIds(
		orderIds?: number[],
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getCancelOrdersByIdsIx(orderIds, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrdersByIdsIx(
		orderIds?: number[],
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
		});

		return await this.program.instruction.cancelOrdersByIds(orderIds, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				authority: this.wallet.publicKey,
			},
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
		marketType: MarketType | null,
		marketIndex: number | null,
		direction: PositionDirection | null,
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
			userAccounts: [this.getUserAccount(subAccountId)],
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
					user,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
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
		optionalIxs?: TransactionInstruction[]
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			(
				await this.preparePlaceOrdersTx(
					params,
					txParams,
					subAccountId,
					optionalIxs
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
		optionalIxs?: TransactionInstruction[]
	) {
		const lookupTableAccounts = await this.fetchAllLookupTableAccounts();

		const tx = await this.buildTransaction(
			await this.getPlaceOrdersIx(params, subAccountId),
			txParams,
			undefined,
			lookupTableAccounts,
			undefined,
			undefined,
			optionalIxs
		);

		return {
			placeOrdersTx: tx,
		};
	}

	public async getPlaceOrdersIx(
		params: OptionalOrderParams[],
		subAccountId?: number
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
			userAccounts: [this.getUserAccount(subAccountId)],
			readablePerpMarketIndex,
			readableSpotMarketIndexes,
			useMarketLastSlotCache: true,
		});

		for (const param of params) {
			if (isUpdateHighLeverageMode(param.bitFlags)) {
				remainingAccounts.push({
					pubkey: getHighLeverageModeConfigPublicKey(this.program.programId),
					isWritable: true,
					isSigner: false,
				});
			}
		}

		const formattedParams = params.map((item) => getOrderParams(item));

		return await this.program.instruction.placeOrders(formattedParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async fillPerpOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order?: Pick<Order, 'marketIndex' | 'orderId'>,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		fillerSubAccountId?: number,
		fillerAuthority?: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getFillPerpOrderIx(
					userAccountPublicKey,
					user,
					order,
					makerInfo,
					referrerInfo,
					fillerSubAccountId,
					undefined,
					fillerAuthority
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
		order: Pick<Order, 'marketIndex' | 'orderId'>,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		fillerSubAccountId?: number,
		isSignedMsg?: boolean,
		fillerAuthority?: PublicKey
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
			  ).marketIndex;

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

		if (referrerInfo) {
			const referrerIsMaker =
				makerInfo.find((maker) => maker.maker.equals(referrerInfo.referrer)) !==
				undefined;
			if (!referrerIsMaker) {
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
		}

		const orderId = isSignedMsg ? null : order.orderId;
		return await this.program.instruction.fillPerpOrder(orderId, null, {
			accounts: {
				state: await this.getStatePublicKey(),
				filler,
				fillerStats: fillerStatsPublicKey,
				user: userAccountPublicKey,
				userStats: userStatsPublicKey,
				authority: this.wallet.publicKey,
			},
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
		orderParams: OptionalOrderParams,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			(await this.preparePlaceSpotOrderTx(orderParams, txParams, subAccountId))
				.placeSpotOrderTx,
			[],
			this.opts,
			false
		);
		this.spotMarketLastSlotCache.set(orderParams.marketIndex, slot);
		this.spotMarketLastSlotCache.set(QUOTE_SPOT_MARKET_INDEX, slot);
		return txSig;
	}

	public async preparePlaceSpotOrderTx(
		orderParams: OptionalOrderParams,
		txParams?: TxParams,
		subAccountId?: number
	) {
		const tx = await this.buildTransaction(
			await this.getPlaceSpotOrderIx(orderParams, subAccountId),
			txParams
		);

		return {
			placeSpotOrderTx: tx,
		};
	}

	public async getPlaceSpotOrderIx(
		orderParams: OptionalOrderParams,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.SPOT });
		const userAccountPublicKey = await this.getUserAccountPublicKey(
			subAccountId
		);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
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
		order?: Pick<Order, 'marketIndex' | 'orderId'>,
		fulfillmentConfig?:
			| SerumV3FulfillmentConfigAccount
			| PhoenixV1FulfillmentConfigAccount
			| OpenbookV2FulfillmentConfigAccount,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getFillSpotOrderIx(
					userAccountPublicKey,
					user,
					order,
					fulfillmentConfig,
					makerInfo,
					referrerInfo
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getFillSpotOrderIx(
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
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const filler = fillerPublicKey ?? (await this.getUserAccountPublicKey());
		const fillerStatsPublicKey = this.getUserStatsAccountPublicKey();

		const marketIndex = order
			? order.marketIndex
			: userAccount.orders.find(
					(order) => order.orderId === userAccount.nextOrderId - 1
			  ).marketIndex;

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
			writableSpotMarketIndexes: [marketIndex, QUOTE_SPOT_MARKET_INDEX],
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

		const orderId = order.orderId;

		this.addSpotFulfillmentAccounts(
			marketIndex,
			remainingAccounts,
			fulfillmentConfig
		);

		return await this.program.instruction.fillSpotOrder(
			orderId,
			fulfillmentConfig ? fulfillmentConfig.fulfillmentType : null,
			null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					filler,
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
		fulfillmentConfig?:
			| SerumV3FulfillmentConfigAccount
			| PhoenixV1FulfillmentConfigAccount
			| OpenbookV2FulfillmentConfigAccount
	): void {
		if (fulfillmentConfig) {
			if ('serumProgramId' in fulfillmentConfig) {
				this.addSerumRemainingAccounts(
					marketIndex,
					remainingAccounts,
					fulfillmentConfig
				);
			} else if ('phoenixProgramId' in fulfillmentConfig) {
				this.addPhoenixRemainingAccounts(
					marketIndex,
					remainingAccounts,
					fulfillmentConfig
				);
			} else if ('openbookV2ProgramId' in fulfillmentConfig) {
				this.addOpenbookRemainingAccounts(
					marketIndex,
					remainingAccounts,
					fulfillmentConfig
				);
			} else {
				throw Error('Invalid fulfillment config type');
			}
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
	): void {
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

	addPhoenixRemainingAccounts(
		marketIndex: number,
		remainingAccounts: AccountMeta[],
		fulfillmentConfig: PhoenixV1FulfillmentConfigAccount
	): void {
		remainingAccounts.push({
			pubkey: fulfillmentConfig.pubkey,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.phoenixProgramId,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.phoenixLogAuthority,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.phoenixMarket,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getSignerPublicKey(),
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.phoenixBaseVault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.phoenixQuoteVault,
			isWritable: true,
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
			pubkey: TOKEN_PROGRAM_ID,
			isWritable: false,
			isSigner: false,
		});
	}

	addOpenbookRemainingAccounts(
		marketIndex: number,
		remainingAccounts: AccountMeta[],
		fulfillmentConfig: OpenbookV2FulfillmentConfigAccount
	): void {
		remainingAccounts.push({
			pubkey: fulfillmentConfig.pubkey,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getSignerPublicKey(),
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2ProgramId,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2Market,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2MarketAuthority,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2EventHeap,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2Bids,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2Asks,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2BaseVault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2QuoteVault,
			isWritable: true,
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
			pubkey: TOKEN_PROGRAM_ID,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: SystemProgram.programId,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getSpotMarketAccount(marketIndex).pubkey,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getQuoteSpotMarketAccount().pubkey,
			isWritable: true,
			isSigner: false,
		});

		if (fulfillmentConfig.remainingAccounts) {
			for (const remainingAccount of fulfillmentConfig.remainingAccounts) {
				remainingAccounts.push({
					pubkey: remainingAccount,
					isWritable: true,
					isSigner: false,
				});
			}
		}
	}

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
	public async swap({
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
	}): Promise<TransactionSignature> {
		const quoteToUse = quote ?? v6?.quote;

		const res = await this.getJupiterSwapIxV6({
			jupiterClient,
			outMarketIndex,
			inMarketIndex,
			outAssociatedTokenAccount,
			inAssociatedTokenAccount,
			amount,
			slippageBps,
			swapMode,
			quote: quoteToUse,
			reduceOnly,
			onlyDirectRoutes,
		});
		const ixs = res.ixs;
		const lookupTables = res.lookupTables;

		const tx = (await this.buildTransaction(
			ixs,
			txParams,
			0,
			lookupTables
		)) as VersionedTransaction;

		const { txSig, slot } = await this.sendTransaction(tx);
		this.spotMarketLastSlotCache.set(outMarketIndex, slot);
		this.spotMarketLastSlotCache.set(inMarketIndex, slot);

		return txSig;
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
		const outMarket = this.getSpotMarketAccount(outMarketIndex);
		const inMarket = this.getSpotMarketAccount(inMarketIndex);

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
			throw new Error("Could not fetch Jupiter's quote. Please try again.");
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
			if (this.hasUser() && this.getUser().getUserAccountAndSlot()) {
				userAccounts.push(this.getUser().getUserAccountAndSlot()!.data);
			}
		} catch (err) {
			// ignore
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			writableSpotMarketIndexes: [outMarketIndex, inMarketIndex],
			readableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		const outSpotMarket = this.getSpotMarketAccount(outMarketIndex);
		const inSpotMarket = this.getSpotMarketAccount(inMarketIndex);

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
					driftSigner: this.getStateAccount().signer,
					instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
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
					driftSigner: this.getStateAccount().signer,
					instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
				},
				remainingAccounts,
			}
		);

		return { beginSwapIx, endSwapIx };
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
		const wSOLMint = this.getSpotMarketAccount(1).mint;
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
		return await this.program.instruction.triggerOrder(orderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				filler,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
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
		const userAccount = (await this.program.account.user.fetch(
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

	public async updateUserFuelBonus(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		userAuthority: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateUserFuelBonusIx(
					userAccountPublicKey,
					user,
					userAuthority
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateUserFuelBonusIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		userAuthority: PublicKey
	): Promise<TransactionInstruction> {
		const userStatsAccountPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAuthority
		);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
		});

		return await this.program.instruction.updateUserFuelBonus({
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				userStats: userStatsAccountPublicKey,
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

		return await this.program.instruction.updateUserOpenOrdersCount({
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
		referrerInfo?: ReferrerInfo,
		successCondition?: PlaceAndTakeOrderSuccessCondition,
		auctionDurationPercentage?: number,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getPlaceAndTakePerpOrderIx(
					orderParams,
					makerInfo,
					referrerInfo,
					successCondition,
					auctionDurationPercentage,
					subAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);
		return txSig;
	}

	public async preparePlaceAndTakePerpOrderWithAdditionalOrders(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		bracketOrdersParams = new Array<OptionalOrderParams>(),
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
	}> {
		const placeAndTakeIxs: TransactionInstruction[] = [];

		type TxKeys = 'placeAndTakeTx' | 'cancelExistingOrdersTx' | 'settlePnlTx';

		const txsToSign: Record<TxKeys, Transaction | VersionedTransaction> = {
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
				referrerInfo,
				undefined,
				auctionDurationPercentage,
				subAccountId
			);

			placeAndTakeIxs.push(placeAndTakeIx);

			if (bracketOrdersParams.length > 0) {
				const bracketOrdersIx = await this.getPlaceOrdersIx(
					bracketOrdersParams,
					subAccountId
				);
				placeAndTakeIxs.push(bracketOrdersIx);
			}

			const shouldUseSimulationComputeUnits =
				txParams?.useSimulatedComputeUnits;
			const shouldExitIfSimulationFails = exitEarlyIfSimFails;

			const txParamsWithoutImplicitSimulation: TxParams = {
				...txParams,
				useSimulatedComputeUnits: false,
			};

			if (shouldUseSimulationComputeUnits || shouldExitIfSimulationFails) {
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
					this.getUserAccount(subAccountId),
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
		referrerInfo?: ReferrerInfo,
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
	}> {
		const txsToSign =
			await this.preparePlaceAndTakePerpOrderWithAdditionalOrders(
				orderParams,
				makerInfo,
				referrerInfo,
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

		const { txSig, slot } = await this.sendTransaction(
			signedTxs.placeAndTakeTx,
			[],
			this.opts,
			true
		);

		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);

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
		referrerInfo?: ReferrerInfo,
		successCondition?: PlaceAndTakeOrderSuccessCondition,
		auctionDurationPercentage?: number,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.PERP });
		const userStatsPublicKey = await this.getUserStatsAccountPublicKey();
		const user = await this.getUserAccountPublicKey(subAccountId);

		makerInfo = Array.isArray(makerInfo)
			? makerInfo
			: makerInfo
			? [makerInfo]
			: [];

		const userAccounts = [this.getUserAccount(subAccountId)];
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

		if (referrerInfo) {
			const referrerIsMaker =
				makerInfo.find((maker) => maker.maker.equals(referrerInfo.referrer)) !==
				undefined;
			if (!referrerIsMaker) {
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
		}

		if (isUpdateHighLeverageMode(orderParams.bitFlags)) {
			remainingAccounts.push({
				pubkey: getHighLeverageModeConfigPublicKey(this.program.programId),
				isWritable: true,
				isSigner: false,
			});
		}

		let optionalParams = null;
		if (auctionDurationPercentage || successCondition) {
			optionalParams =
				((auctionDurationPercentage ?? 100) << 8) | (successCondition ?? 0);
		}

		return await this.program.instruction.placeAndTakePerpOrder(
			orderParams,
			optionalParams,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user,
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
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getPlaceAndMakePerpOrderIx(
					orderParams,
					takerInfo,
					referrerInfo,
					subAccountId
				),
				txParams
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
		referrerInfo?: ReferrerInfo,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.PERP });
		const userStatsPublicKey = this.getUserStatsAccountPublicKey();
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccount(subAccountId),
				takerInfo.takerUserAccount,
			],
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
					user,
					userStats: userStatsPublicKey,
					taker: takerInfo.taker,
					takerStats: takerInfo.takerStats,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
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

	/*
	 * Borsh encode signedMsg taker order params
	 */
	public encodeSignedMsgOrderParamsMessage(
		orderParamsMessage:
			| SignedMsgOrderParamsMessage
			| SignedMsgOrderParamsDelegateMessage,
		delegateSigner?: boolean
	): Buffer {
		const anchorIxName = delegateSigner
			? 'global' + ':' + 'SignedMsgOrderParamsDelegateMessage'
			: 'global' + ':' + 'SignedMsgOrderParamsMessage';
		const prefix = Buffer.from(sha256(anchorIxName).slice(0, 8));
		const buf = Buffer.concat([
			prefix,
			delegateSigner
				? this.program.coder.types.encode(
						'SignedMsgOrderParamsDelegateMessage',
						orderParamsMessage as SignedMsgOrderParamsDelegateMessage
				  )
				: this.program.coder.types.encode(
						'SignedMsgOrderParamsMessage',
						orderParamsMessage as SignedMsgOrderParamsMessage
				  ),
		]);
		return buf;
	}

	/*
	 * Decode signedMsg taker order params from borsh buffer
	 */
	public decodeSignedMsgOrderParamsMessage(
		encodedMessage: Buffer,
		delegateSigner?: boolean
	): SignedMsgOrderParamsMessage | SignedMsgOrderParamsDelegateMessage {
		const decodeStr = delegateSigner
			? 'SignedMsgOrderParamsDelegateMessage'
			: 'SignedMsgOrderParamsMessage';
		return this.program.coder.types.decode(
			decodeStr,
			encodedMessage.slice(8) // assumes discriminator
		);
	}

	public signMessage(
		message: Uint8Array,
		keypair: Keypair = this.wallet.payer
	): Buffer {
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
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [takerInfo.takerUserAccount],
			useMarketLastSlotCache: false,
			readablePerpMarketIndex: marketIndex,
		});

		const isDelegateSigner = takerInfo.signingAuthority.equals(
			takerInfo.takerUserAccount.delegate
		);

		const borshBuf = Buffer.from(
			signedSignedMsgOrderParams.orderParams.toString(),
			'hex'
		);
		try {
			const { signedMsgOrderParams } = this.decodeSignedMsgOrderParamsMessage(
				borshBuf,
				isDelegateSigner
			);
			if (isUpdateHighLeverageMode(signedMsgOrderParams.bitFlags)) {
				remainingAccounts.push({
					pubkey: getHighLeverageModeConfigPublicKey(this.program.programId),
					isWritable: true,
					isSigner: false,
				});
			}
		} catch (err) {
			console.error('invalid signed order encoding');
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
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number,
		precedingIxs: TransactionInstruction[] = [],
		overrideCustomIxIndex?: number
	): Promise<TransactionSignature> {
		const ixs = await this.getPlaceAndMakeSignedMsgPerpOrderIxs(
			signedSignedMsgOrderParams,
			signedMsgOrderUuid,
			takerInfo,
			orderParams,
			referrerInfo,
			subAccountId,
			precedingIxs,
			overrideCustomIxIndex
		);
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(ixs, txParams),
			[],
			this.opts
		);

		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);
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
		referrerInfo?: ReferrerInfo,
		subAccountId?: number,
		precedingIxs: TransactionInstruction[] = [],
		overrideCustomIxIndex?: number
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
				this.getUserAccount(subAccountId),
				takerInfo.takerUserAccount,
			],
			useMarketLastSlotCache: false,
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
		orderParams: OptionalOrderParams,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number
	) {
		const tx = await this.buildTransaction(
			await this.getPlaceAndTakeSpotOrderIx(
				orderParams,
				fulfillmentConfig,
				makerInfo,
				referrerInfo,
				subAccountId
			),
			txParams
		);

		return {
			placeAndTakeSpotOrderTx: tx,
		};
	}

	public async placeAndTakeSpotOrder(
		orderParams: OptionalOrderParams,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			(
				await this.preparePlaceAndTakeSpotOrder(
					orderParams,
					fulfillmentConfig,
					makerInfo,
					referrerInfo,
					txParams,
					subAccountId
				)
			).placeAndTakeSpotOrderTx,
			[],
			this.opts,
			false
		);
		this.spotMarketLastSlotCache.set(orderParams.marketIndex, slot);
		this.spotMarketLastSlotCache.set(QUOTE_SPOT_MARKET_INDEX, slot);
		return txSig;
	}

	public async getPlaceAndTakeSpotOrderIx(
		orderParams: OptionalOrderParams,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.SPOT });
		const userStatsPublicKey = this.getUserStatsAccountPublicKey();
		const user = await this.getUserAccountPublicKey(subAccountId);

		const userAccounts = [this.getUserAccount(subAccountId)];
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
					user,
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
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getPlaceAndMakeSpotOrderIx(
					orderParams,
					takerInfo,
					fulfillmentConfig,
					referrerInfo,
					subAccountId
				),
				txParams
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
		referrerInfo?: ReferrerInfo,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.SPOT });
		const userStatsPublicKey = this.getUserStatsAccountPublicKey();
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccount(subAccountId),
				takerInfo.takerUserAccount,
			],
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
					user,
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
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
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

		return await this.program.instruction.modifyOrder(orderId, orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
			},
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
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
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

		return await this.program.instruction.modifyOrderByUserId(
			userOrderId,
			orderParams,
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
				const perpMarketAccount = this.getPerpMarketAccount(marketIndex);
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
		marketIndexes: number[]
	): Promise<Array<TransactionInstruction>> {
		const ixs = [];
		for (const { settleeUserAccountPublicKey, settleeUserAccount } of users) {
			for (const marketIndex of marketIndexes) {
				ixs.push(
					await this.settlePNLIx(
						settleeUserAccountPublicKey,
						settleeUserAccount,
						marketIndex
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
		optionalIxs?: TransactionInstruction[]
	): Promise<TransactionSignature> {
		const lookupTableAccounts = await this.fetchAllLookupTableAccounts();

		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.settlePNLIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketIndex
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

	public async settleMultiplePNLs(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndexes: number[],
		mode: SettlePnlMode,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.settleMultiplePNLsIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketIndexes,
					mode
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
		optionalIxs?: TransactionInstruction[]
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
				mode
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
		mode: SettlePnlMode
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [settleeUserAccount],
			writablePerpMarketIndexes: marketIndexes,
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		return await this.program.instruction.settleMultiplePnls(
			marketIndexes,
			mode,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
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
		this.perpMarketLastSlotCache.set(marketIndex, slot);
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
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
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
					liquidator,
					liquidatorStats: liquidatorStatsPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
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
		this.perpMarketLastSlotCache.set(marketIndex, slot);
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
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
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
					liquidator,
					liquidatorStats: liquidatorStatsPublicKey,
				},
				remainingAccounts: remainingAccounts,
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
		userStatsAccountPublicKey,
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
		userStatsAccountPublicKey: PublicKey;
		liquidatorSubAccountId?: number;
		maxAccounts?: number;
	}): Promise<{
		ixs: TransactionInstruction[];
		lookupTables: AddressLookupTableAccount[];
	}> {
		const liabilityMarket = this.getSpotMarketAccount(liabilityMarketIndex);
		const assetMarket = this.getSpotMarketAccount(assetMarketIndex);

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
			throw new Error("Could not fetch Jupiter's quote. Please try again.");
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
			userStatsAccountPublicKey,
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
	public async getLiquidateSpotWithSwapIx({
		liabilityMarketIndex,
		assetMarketIndex,
		swapAmount: swapAmount,
		assetTokenAccount,
		liabilityTokenAccount,
		userAccount,
		userAccountPublicKey,
		userStatsAccountPublicKey,
		liquidatorSubAccountId,
	}: {
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
	}> {
		const liquidatorAccountPublicKey = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const userAccounts = [userAccount];
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			writableSpotMarketIndexes: [liabilityMarketIndex, assetMarketIndex],
			readableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		const liabilitySpotMarket = this.getSpotMarketAccount(liabilityMarketIndex);
		const assetSpotMarket = this.getSpotMarketAccount(assetMarketIndex);

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
						userStats: userStatsAccountPublicKey,
						liquidator: liquidatorAccountPublicKey,
						liquidatorStats: liquidatorStatsPublicKey,
						authority: this.wallet.publicKey,
						liabilitySpotMarketVault: liabilitySpotMarket.vault,
						assetSpotMarketVault: assetSpotMarket.vault,
						assetTokenAccount: assetTokenAccount,
						liabilityTokenAccount: liabilityTokenAccount,
						tokenProgram: assetTokenProgram,
						driftSigner: this.getStateAccount().signer,
						instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
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
					userStats: userStatsAccountPublicKey,
					liquidator: liquidatorAccountPublicKey,
					liquidatorStats: liquidatorStatsPublicKey,
					authority: this.wallet.publicKey,
					liabilitySpotMarketVault: liabilitySpotMarket.vault,
					assetSpotMarketVault: assetSpotMarket.vault,
					assetTokenAccount: assetTokenAccount,
					liabilityTokenAccount: liabilityTokenAccount,
					tokenProgram: assetTokenProgram,
					driftSigner: this.getStateAccount().signer,
					instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
				},
				remainingAccounts,
			}
		);

		return { beginSwapIx, endSwapIx };
	}

	public async getInsuranceFundSwapIx({
		inMarketIndex,
		outMarketIndex,
		amountIn,
		inTokenAccount,
		outTokenAccount,
	}: {
		inMarketIndex: number;
		outMarketIndex: number;
		amountIn: BN;
		inTokenAccount: PublicKey;
		outTokenAccount: PublicKey;
	}): Promise<{
		beginSwapIx: TransactionInstruction;
		endSwapIx: TransactionInstruction;
	}> {
		const remainingAccounts = await this.getRemainingAccounts({
			userAccounts: [],
			writableSpotMarketIndexes: [inMarketIndex, outMarketIndex],
		});

		const inSpotMarket = this.getSpotMarketAccount(inMarketIndex);
		const outSpotMarket = this.getSpotMarketAccount(outMarketIndex);

		if (this.isToken2022(inSpotMarket) || this.isToken2022(outSpotMarket)) {
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
			if (this.isTransferHook(inSpotMarket)) {
				this.addExtraAccountMetasToRemainingAccounts(
					inSpotMarket.mint,
					remainingAccounts
				);
			}
			if (this.isTransferHook(outSpotMarket)) {
				this.addExtraAccountMetasToRemainingAccounts(
					outSpotMarket.mint,
					remainingAccounts
				);
			}
		}

		const ifRebalanceConfig = getIfRebalanceConfigPublicKey(
			this.program.programId,
			inMarketIndex,
			outMarketIndex
		);

		const beginSwapIx = await this.program.instruction.beginInsuranceFundSwap(
			inMarketIndex,
			outMarketIndex,
			amountIn,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					outInsuranceFundVault: outSpotMarket.insuranceFund.vault,
					inInsuranceFundVault: inSpotMarket.insuranceFund.vault,
					outTokenAccount,
					inTokenAccount,
					ifRebalanceConfig: ifRebalanceConfig,
					tokenProgram: TOKEN_PROGRAM_ID,
					driftSigner: this.getStateAccount().signer,
					instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
				},
				remainingAccounts,
			}
		);

		const endSwapIx = await this.program.instruction.endInsuranceFundSwap(
			inMarketIndex,
			outMarketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					outInsuranceFundVault: outSpotMarket.insuranceFund.vault,
					inInsuranceFundVault: inSpotMarket.insuranceFund.vault,
					outTokenAccount,
					inTokenAccount,
					ifRebalanceConfig: ifRebalanceConfig,
					tokenProgram: TOKEN_PROGRAM_ID,
					driftSigner: this.getStateAccount().signer,
					instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
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
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
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
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
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
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
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
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
			writableSpotMarketIndexes: [marketIndex],
		});

		const spotMarket = this.getSpotMarketAccount(marketIndex);
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
				driftSigner: this.getSignerPublicKey(),
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
		return await this.program.instruction.updateFundingRate(perpMarketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				perpMarket: perpMarketPublicKey,
				oracle: oracle,
			},
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
		const perpMarket = this.getPerpMarketAccount(perpMarketIndex);

		if (!isVariant(perpMarket.amm.oracleSource, 'prelaunch')) {
			throw new Error(`Wrong oracle source ${perpMarket.amm.oracleSource}`);
		}

		return await this.program.instruction.updatePrelaunchOracle({
			accounts: {
				state: await this.getStatePublicKey(),
				perpMarket: perpMarket.pubkey,
				oracle: perpMarket.amm.oracle,
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
		const perpMarket = this.getPerpMarketAccount(perpMarketIndex);

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
				oracle: perpMarket.amm.oracle,
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
		const perpMarket = this.getPerpMarketAccount(marketIndex);
		const isMMOracleActive = !perpMarket.amm.mmOracleSlot.eq(ZERO);
		return {
			...this.accountSubscriber.getOraclePriceDataAndSlotForPerpMarket(
				marketIndex
			).data,
			isMMOracleActive,
		};
	}

	public getMMOracleDataForPerpMarket(marketIndex: number): OraclePriceData {
		const perpMarket = this.getPerpMarketAccount(marketIndex);
		const oracleData = this.getOracleDataForPerpMarket(marketIndex);
		const stateAccountAndSlot = this.accountSubscriber.getStateAccountAndSlot();
		const pctDiff = perpMarket.amm.mmOraclePrice
			.sub(oracleData.price)
			.abs()
			.mul(PERCENTAGE_PRECISION)
			.div(BN.max(oracleData.price, ONE));
		if (
			!isOracleValid(
				perpMarket,
				oracleData,
				stateAccountAndSlot.data.oracleGuardRails,
				stateAccountAndSlot.slot
			) ||
			perpMarket.amm.mmOraclePrice.eq(ZERO) ||
			perpMarket.amm.mmOracleSlot < oracleData.slot ||
			pctDiff.gt(PERCENTAGE_PRECISION.divn(100)) // 1% threshold
		) {
			return { ...oracleData, fetchedWithMMOracle: true };
		} else {
			const conf = getOracleConfidenceFromMMOracleData({
				mmOraclePrice: perpMarket.amm.mmOraclePrice,
				mmOracleSlot: perpMarket.amm.mmOracleSlot,
				oraclePriceData: oracleData,
			});
			return {
				price: perpMarket.amm.mmOraclePrice,
				slot: perpMarket.amm.mmOracleSlot,
				confidence: conf,
				hasSufficientNumberOfDataPoints: true,
				fetchedWithMMOracle: true,
				isMMOracleActive: oracleData.isMMOracleActive,
			};
		}
	}

	public getOracleDataForSpotMarket(marketIndex: number): OraclePriceData {
		return this.accountSubscriber.getOraclePriceDataAndSlotForSpotMarket(
			marketIndex
		).data;
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
			spotMarket: this.getSpotMarketAccount(marketIndex).pubkey,
			userStats: getUserStatsAccountPublicKey(
				this.program.programId,
				this.wallet.publicKey // only allow payer to initialize own insurance fund stake account
			),
			authority: this.wallet.publicKey,
			payer: this.wallet.publicKey,
			rent: anchor.web3.SYSVAR_RENT_PUBKEY,
			systemProgram: anchor.web3.SystemProgram.programId,
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
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const remainingAccounts = [];
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
					driftSigner: this.getSignerPublicKey(),
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

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
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
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const ix = await this.program.instruction.requestRemoveInsuranceFundStake(
			marketIndex,
			amount,
			{
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
			}
		);

		const tx = await this.buildTransaction(ix, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async cancelRequestRemoveInsuranceFundStake(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const ix =
			await this.program.instruction.cancelRequestRemoveInsuranceFundStake(
				marketIndex,
				{
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
				}
			);

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
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
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

		const remainingAccounts = [];
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
					driftSigner: this.getSignerPublicKey(),
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
		const spotMarket = this.getSpotMarketAccount(marketIndex);
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

	public async updateUserGovTokenInsuranceStake(
		authority: PublicKey,
		txParams?: TxParams,
		env: DriftEnv = 'mainnet-beta'
	): Promise<TransactionSignature> {
		const ix =
			env == 'mainnet-beta'
				? await this.getUpdateUserGovTokenInsuranceStakeIx(authority)
				: await this.getUpdateUserGovTokenInsuranceStakeDevnetIx(authority);
		const tx = await this.buildTransaction(ix, txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUpdateUserGovTokenInsuranceStakeIx(
		authority: PublicKey
	): Promise<TransactionInstruction> {
		const marketIndex = GOV_SPOT_MARKET_INDEX;
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			authority,
			marketIndex
		);
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			authority
		);

		const ix = this.program.instruction.updateUserGovTokenInsuranceStake({
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

	public async getUpdateUserGovTokenInsuranceStakeDevnetIx(
		authority: PublicKey,
		amount: BN = new BN(1)
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			authority
		);

		const ix = this.program.instruction.updateUserGovTokenInsuranceStakeDevnet(
			amount,
			{
				accounts: {
					userStats: userStatsPublicKey,
					signer: this.wallet.publicKey,
				},
			}
		);

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
		const spotMarketAccount = this.getSpotMarketAccount(spotMarketIndex);
		const tokenProgramId = this.getTokenProgramForSpotMarket(spotMarketAccount);

		const remainingAccounts = [];
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
					driftSigner: this.getSignerPublicKey(),
					insuranceFundVault: spotMarketAccount.insuranceFund.vault,
					tokenProgram: tokenProgramId,
				},
				remainingAccounts,
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
			userAccounts: [this.getUserAccount()],
			writablePerpMarketIndexes: [perpMarketIndex],
			writableSpotMarketIndexes: [spotMarketIndex],
		});

		const spotMarket = this.getSpotMarketAccount(spotMarketIndex);
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
					driftSigner: this.getSignerPublicKey(),
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
		const spotMarket = await this.getSpotMarketAccount(marketIndex);

		const remainingAccounts = [];
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
	 * This ix will donate your funds to drift revenue pool. It does not deposit into your user account
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
		const marketAccount = this.getPerpMarketAccount(marketIndex);
		const quoteAccount = this.getSpotMarketAccount(QUOTE_SPOT_MARKET_INDEX);

		const extendedInfo: PerpMarketExtendedInfo = {
			marketIndex,
			minOrderSize: marketAccount.amm?.minOrderSize,
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
		user?: User,
		enteringHighLeverageMode?: boolean
	) {
		let feeTier;
		const userHLM =
			(user?.isHighLeverageMode('Initial') ?? false) ||
			enteringHighLeverageMode;
		if (user && !userHLM) {
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
			let marketAccount = null;
			if (isVariant(marketType, 'perp')) {
				marketAccount = this.getPerpMarketAccount(marketIndex);
			} else {
				marketAccount = this.getSpotMarketAccount(marketIndex);
			}

			takerFee += (takerFee * marketAccount.feeAdjustment) / 100;
			if (userHLM) {
				takerFee *= 2;
			}
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

	public getReceiverProgram(): Program<PythSolanaReceiver> {
		if (this.receiverProgram === undefined) {
			this.receiverProgram = new Program(
				pythSolanaReceiverIdl as PythSolanaReceiver,
				DEFAULT_RECEIVER_PROGRAM_ID,
				this.provider
			);
		}
		return this.receiverProgram;
	}

	public async getSwitchboardOnDemandProgram(): Promise<Program30<Idl30>> {
		if (this.sbOnDemandProgram === undefined) {
			this.sbOnDemandProgram = await AnchorUtils.loadProgramFromConnection(
				this.connection
			);
		}
		return this.sbOnDemandProgram;
	}

	public async postPythPullOracleUpdateAtomic(
		vaaString: string,
		feedId: string
	): Promise<TransactionSignature> {
		const postIxs = await this.getPostPythPullOracleUpdateAtomicIxs(
			vaaString,
			feedId
		);
		const tx = await this.buildTransaction(postIxs);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async postMultiPythPullOracleUpdatesAtomic(
		vaaString: string,
		feedIds: string[]
	): Promise<TransactionSignature> {
		const postIxs = await this.getPostPythPullOracleUpdateAtomicIxs(
			vaaString,
			feedIds
		);
		const tx = await this.buildTransaction(postIxs);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getPostPythPullOracleUpdateAtomicIxs(
		vaaString: string,
		feedIds: string | string[],
		numSignatures = 2
	): Promise<TransactionInstruction[]> {
		const accumulatorUpdateData = parseAccumulatorUpdateData(
			Buffer.from(vaaString, 'base64')
		);
		const guardianSetIndex = accumulatorUpdateData.vaa.readUInt32BE(1);
		const guardianSet = getGuardianSetPda(
			guardianSetIndex,
			DEFAULT_WORMHOLE_PROGRAM_ID
		);

		const trimmedVaa = trimVaaSignatures(
			accumulatorUpdateData.vaa,
			numSignatures
		);

		const postIxs: TransactionInstruction[] = [];
		if (accumulatorUpdateData.updates.length > 1) {
			const encodedParams = this.getReceiverProgram().coder.types.encode(
				'PostMultiUpdatesAtomicParams',
				{
					vaa: trimmedVaa,
					merklePriceUpdates: accumulatorUpdateData.updates,
				}
			);
			const feedIdsToUse: string[] =
				typeof feedIds === 'string' ? [feedIds] : feedIds;
			const pubkeys = feedIdsToUse.map((feedId) => {
				return getPythPullOraclePublicKey(
					this.program.programId,
					getFeedIdUint8Array(feedId)
				);
			});

			const remainingAccounts: Array<AccountMeta> = pubkeys.map((pubkey) => {
				return {
					pubkey,
					isSigner: false,
					isWritable: true,
				};
			});
			postIxs.push(
				this.program.instruction.postMultiPythPullOracleUpdatesAtomic(
					encodedParams,
					{
						accounts: {
							keeper: this.wallet.publicKey,
							pythSolanaReceiver: DRIFT_ORACLE_RECEIVER_ID,
							guardianSet,
						},
						remainingAccounts,
					}
				)
			);
		} else {
			let feedIdToUse = typeof feedIds === 'string' ? feedIds : feedIds[0];
			feedIdToUse = trimFeedId(feedIdToUse);
			postIxs.push(
				await this.getSinglePostPythPullOracleAtomicIx(
					{
						vaa: trimmedVaa,
						merklePriceUpdate: accumulatorUpdateData.updates[0],
					},
					feedIdToUse,
					guardianSet
				)
			);
		}
		return postIxs;
	}

	private async getSinglePostPythPullOracleAtomicIx(
		params: {
			vaa: Buffer;
			merklePriceUpdate: {
				message: Buffer;
				proof: number[][];
			};
		},
		feedId: string,
		guardianSet: PublicKey
	): Promise<TransactionInstruction> {
		const feedIdBuffer = getFeedIdUint8Array(feedId);
		const receiverProgram = this.getReceiverProgram();

		const encodedParams = receiverProgram.coder.types.encode(
			'PostUpdateAtomicParams',
			params
		);

		return this.program.instruction.postPythPullOracleUpdateAtomic(
			feedIdBuffer,
			encodedParams,
			{
				accounts: {
					keeper: this.wallet.publicKey,
					pythSolanaReceiver: DRIFT_ORACLE_RECEIVER_ID,
					guardianSet,
					priceFeed: getPythPullOraclePublicKey(
						this.program.programId,
						feedIdBuffer
					),
				},
			}
		);
	}

	public async updatePythPullOracle(
		vaaString: string,
		feedId: string
	): Promise<TransactionSignature> {
		feedId = trimFeedId(feedId);
		const accumulatorUpdateData = parseAccumulatorUpdateData(
			Buffer.from(vaaString, 'base64')
		);
		const guardianSetIndex = accumulatorUpdateData.vaa.readUInt32BE(1);
		const guardianSet = getGuardianSetPda(
			guardianSetIndex,
			DEFAULT_WORMHOLE_PROGRAM_ID
		);

		const [postIxs, encodedVaaAddress] = await this.getBuildEncodedVaaIxs(
			accumulatorUpdateData.vaa,
			guardianSet
		);

		for (const update of accumulatorUpdateData.updates) {
			postIxs.push(
				await this.getUpdatePythPullOracleIxs(
					{
						merklePriceUpdate: update,
					},
					feedId,
					encodedVaaAddress.publicKey
				)
			);
		}

		const tx = await this.buildTransaction(postIxs);
		const { txSig } = await this.sendTransaction(
			tx,
			[encodedVaaAddress],
			this.opts
		);

		return txSig;
	}

	public async getUpdatePythPullOracleIxs(
		params: {
			merklePriceUpdate: {
				message: Buffer;
				proof: number[][];
			};
		},
		feedId: string,
		encodedVaaAddress: PublicKey
	): Promise<TransactionInstruction> {
		const feedIdBuffer = getFeedIdUint8Array(feedId);
		const receiverProgram = this.getReceiverProgram();

		const encodedParams = receiverProgram.coder.types.encode(
			'PostUpdateParams',
			params
		);

		return this.program.instruction.updatePythPullOracle(
			feedIdBuffer,
			encodedParams,
			{
				accounts: {
					keeper: this.wallet.publicKey,
					pythSolanaReceiver: DRIFT_ORACLE_RECEIVER_ID,
					encodedVaa: encodedVaaAddress,
					priceFeed: getPythPullOraclePublicKey(
						this.program.programId,
						feedIdBuffer
					),
				},
			}
		);
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

	public async getPostManySwitchboardOnDemandUpdatesAtomicIxs(
		feeds: PublicKey[],
		recentSlothash?: Slothash,
		numSignatures = 3
	): Promise<TransactionInstruction[] | undefined> {
		const program = await this.getSwitchboardOnDemandProgram();
		const [pullIxs, _luts, _rawResponse] =
			await PullFeed.fetchUpdateManyLightIx(program, {
				feeds,
				numSignatures,
				recentSlothashes: recentSlothash
					? [[new BN(recentSlothash.slot), recentSlothash.hash]]
					: undefined,
				chain: 'solana',
				network: this.env,
			});
		if (!pullIxs) {
			return undefined;
		}
		return pullIxs;
	}

	// @deprecated use getPostManySwitchboardOnDemandUpdatesAtomicIxs instead. This function no longer returns the required ixs due to upstream sdk changes.
	public async getPostSwitchboardOnDemandUpdateAtomicIx(
		feed: PublicKey,
		recentSlothash?: Slothash,
		numSignatures = 3
	): Promise<TransactionInstruction | undefined> {
		const program = await this.getSwitchboardOnDemandProgram();
		const feedAccount = new PullFeed(program, feed);
		if (!this.sbProgramFeedConfigs) {
			this.sbProgramFeedConfigs = new Map();
		}
		if (!this.sbProgramFeedConfigs.has(feedAccount.pubkey.toString())) {
			const feedConfig = await feedAccount.loadConfigs();
			this.sbProgramFeedConfigs.set(feed.toString(), feedConfig);
		}
		const [pullIx, _responses, success] = await PullFeed.fetchUpdateManyIx(
			program,
			{
				feeds: [feed],
				numSignatures,
				recentSlothashes: recentSlothash
					? [[new BN(recentSlothash.slot), recentSlothash.hash]]
					: undefined,
			}
		);
		if (!success) {
			return undefined;
		}
		return pullIx[0];
	}

	public async postSwitchboardOnDemandUpdate(
		feed: PublicKey,
		recentSlothash?: Slothash,
		numSignatures = 3
	): Promise<TransactionSignature> {
		const pullIx = await this.getPostSwitchboardOnDemandUpdateAtomicIx(
			feed,
			recentSlothash,
			numSignatures
		);
		if (!pullIx) {
			return undefined;
		}
		const tx = await asV0Tx({
			connection: this.connection,
			ixs: [pullIx],
			payer: this.wallet.publicKey,
			computeUnitLimitMultiple: 1.3,
			lookupTables: await this.fetchAllLookupTableAccounts(),
		});
		const { txSig } = await this.sendTransaction(tx, [], {
			commitment: 'processed',
			skipPreflight: true,
			maxRetries: 0,
		});
		return txSig;
	}

	private async getBuildEncodedVaaIxs(
		vaa: Buffer,
		guardianSet: PublicKey
	): Promise<[TransactionInstruction[], Keypair]> {
		const postIxs: TransactionInstruction[] = [];

		if (this.wormholeProgram === undefined) {
			this.wormholeProgram = new Program(
				wormholeCoreBridgeIdl,
				DEFAULT_WORMHOLE_PROGRAM_ID,
				this.provider
			);
		}

		const encodedVaaKeypair = new Keypair();
		postIxs.push(
			await this.wormholeProgram.account.encodedVaa.createInstruction(
				encodedVaaKeypair,
				vaa.length + 46
			)
		);

		// Why do we need this too?
		postIxs.push(
			await this.wormholeProgram.methods
				.initEncodedVaa()
				.accounts({
					encodedVaa: encodedVaaKeypair.publicKey,
				})
				.instruction()
		);

		// Split the write into two ixs
		postIxs.push(
			await this.wormholeProgram.methods
				.writeEncodedVaa({
					index: 0,
					data: vaa.subarray(0, 755),
				})
				.accounts({
					draftVaa: encodedVaaKeypair.publicKey,
				})
				.instruction()
		);

		postIxs.push(
			await this.wormholeProgram.methods
				.writeEncodedVaa({
					index: 755,
					data: vaa.subarray(755),
				})
				.accounts({
					draftVaa: encodedVaaKeypair.publicKey,
				})
				.instruction()
		);

		// Verify
		postIxs.push(
			await this.wormholeProgram.methods
				.verifyEncodedVaaV1()
				.accounts({
					guardianSet,
					draftVaa: encodedVaaKeypair.publicKey,
				})
				.instruction()
		);

		return [postIxs, encodedVaaKeypair];
	}

	public async enableUserHighLeverageMode(
		subAccountId: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getEnableHighLeverageModeIx(subAccountId),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getEnableHighLeverageModeIx(
		subAccountId: number,
		depositToTradeArgs?: {
			isMakingNewAccount: boolean;
			depositMarketIndex: number;
			orderMarketIndex: number;
		}
	): Promise<TransactionInstruction> {
		const isDepositToTradeTx = depositToTradeArgs !== undefined;

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: depositToTradeArgs?.isMakingNewAccount
				? []
				: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: false,
			readablePerpMarketIndex: depositToTradeArgs?.orderMarketIndex,
			readableSpotMarketIndexes: isDepositToTradeTx
				? [depositToTradeArgs?.depositMarketIndex]
				: undefined,
		});

		const ix = await this.program.instruction.enableUserHighLeverageMode(
			subAccountId,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: getUserAccountPublicKeySync(
						this.program.programId,
						this.wallet.publicKey,
						subAccountId
					),
					authority: this.wallet.publicKey,
					highLeverageModeConfig: getHighLeverageModeConfigPublicKey(
						this.program.programId
					),
				},
				remainingAccounts,
			}
		);

		return ix;
	}

	public async disableUserHighLeverageMode(
		user: PublicKey,
		userAccount?: UserAccount,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getDisableHighLeverageModeIx(user, userAccount),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getDisableHighLeverageModeIx(
		user: PublicKey,
		userAccount?: UserAccount
	): Promise<TransactionInstruction> {
		const remainingAccounts = userAccount
			? this.getRemainingAccounts({
					userAccounts: [userAccount],
			  })
			: undefined;

		const ix = await this.program.instruction.disableUserHighLeverageMode(
			false,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user,
					authority: this.wallet.publicKey,
					highLeverageModeConfig: getHighLeverageModeConfigPublicKey(
						this.program.programId
					),
				},
				remainingAccounts,
			}
		);

		return ix;
	}

	public async fetchHighLeverageModeConfig(): Promise<HighLeverageModeConfig> {
		const config = await this.program.account.highLeverageModeConfig.fetch(
			getHighLeverageModeConfigPublicKey(this.program.programId)
		);
		return config as HighLeverageModeConfig;
	}

	public async fetchProtectedMakerModeConfig(): Promise<ProtectedMakerModeConfig> {
		const config = await this.program.account.protectedMakerModeConfig.fetch(
			getProtectedMakerModeConfigPublicKey(this.program.programId)
		);
		return config as ProtectedMakerModeConfig;
	}

	public async updateUserProtectedMakerOrders(
		subAccountId: number,
		protectedOrders: boolean,
		authority?: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateUserProtectedMakerOrdersIx(
					subAccountId,
					protectedOrders,
					authority
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateUserProtectedMakerOrdersIx(
		subAccountId: number,
		protectedOrders: boolean,
		authority?: PublicKey
	): Promise<TransactionInstruction> {
		const ix = await this.program.instruction.updateUserProtectedMakerOrders(
			subAccountId,
			protectedOrders,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: getUserAccountPublicKeySync(
						this.program.programId,
						authority ?? this.authority,
						subAccountId
					),
					authority: this.wallet.publicKey,
					protectedMakerModeConfig: getProtectedMakerModeConfigPublicKey(
						this.program.programId
					),
				},
			}
		);

		return ix;
	}

	public async getPauseSpotMarketDepositWithdrawIx(
		spotMarketIndex: number
	): Promise<TransactionInstruction> {
		const spotMarket = await this.getSpotMarketAccount(spotMarketIndex);
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
					pubkey: this.getPerpMarketAccount(marketIndex).pubkey,
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
			computeUnits: 1000,
			computeUnitsPrice: 0,
		});
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public getUpdateAmmSpreadAdjustmentNativeIx(
		marketIndex: number,
		ammSpreadAdjustment: number // i8
	): TransactionInstruction {
		const discriminatorBuffer = createNativeInstructionDiscriminatorBuffer(1);
		const data = Buffer.alloc(discriminatorBuffer.length + 4);
		data.set(discriminatorBuffer, 0);
		data.writeInt8(ammSpreadAdjustment, 5); // next byte

		// Build the instruction manually
		return new TransactionInstruction({
			programId: this.program.programId,
			keys: [
				{
					pubkey: this.getPerpMarketAccount(marketIndex).pubkey,
					isWritable: true,
					isSigner: false,
				},
				{
					pubkey: this.wallet.publicKey,
					isWritable: false,
					isSigner: true,
				},
			],
			data,
		});
	}

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
	 * @param opts :: Will fallback to DriftClient's opts if not provided
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
	): Promise<(Transaction | VersionedTransaction)[]> {
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
}
