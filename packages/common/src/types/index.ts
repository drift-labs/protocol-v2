export * from './position';
export * from './stats';

export interface IngestionState {
	id: string;
	currentSlot: number;
	shards: number;
	shardId: number;
	paused: boolean;
	ingestedSlots: number[];
	bypassSlots: number[];
	skippedSlots: number[];
	failedSlots: number[];
	missedSlots: number[];
	slotAtTip?: number;
	endSlot?: number;
	updatedAt?: number;
}

export enum IngestionSource {
	SEQUENTIAL = 'seq',
	GRPC = 'grpc',
	BACKFILL = 'backfill',
}

export interface BaseDynamoRecord {
	pk: string;
	sk: string;
}

// Core scalar types without undefined
type ScalarAttributeValue = null | boolean | number | bigint | string;

// Recursive type for document values
type DocumentAttributeValue =
	| ScalarAttributeValue
	| { [key: string]: DocumentAttributeValue }
	| DocumentAttributeValue[]
	| Set<number | string>;

// export interface ExpressionValues {
//   [key: string]: DocumentAttributeValue;
// }

export interface ExpressionValues {
	[key: string]: DocumentAttributeValue;
}

export interface TransactWriteItem {
	Put?: {
		Item: Record<string, any>;
		ConditionExpression?: string;
		ExpressionAttributeNames?: Record<string, string>;
		ExpressionAttributeValues?: Record<string, any>;
	};
	Delete?: {
		Key: {
			pk: string;
			sk: string;
		};
		ConditionExpression?: string;
		ExpressionAttributeNames?: Record<string, string>;
		ExpressionAttributeValues?: Record<string, any>;
	};
	Update?: {
		Key: {
			pk: string;
			sk: string;
		};
		UpdateExpression: string;
		ConditionExpression?: string;
		ExpressionAttributeNames?: Record<string, string>;
		ExpressionAttributeValues?: Record<string, any>;
	};
}

export type SlotRecord = BaseDynamoRecord & {
	slot: number;
	status: SlotStatus;
};

export enum SlotStatus {
	FAILED = 'failed',
	MISSED = 'missed',
	SKIPPED = 'skipped',
	INGESTED = 'ingested',
}

export type PaginationMetadata = {
	records: number;
	currentPage: number;
	nextPage: number | null;
	totalPages: number;
	totalRecords: number;
};

export type PageData<T> = {
	meta: PaginationMetadata;
	records: T[];
};

export type ProcessedRecord = {
	kinesisRecord: any;
	record: DBRecord;
};

export type ProcessedS3Record = {
	identifier: any;
	record: DBRecord;
};

export enum EntityTypes {
	Market = 'market',
	Authority = 'authority',
	User = 'user',
	Pool = 'pool',
}

export enum RecordTypes {
	DepositRecord = 'DepositRecord',
	RewardRecord = 'RewardRecord',
	FundingPaymentRecord = 'FundingPaymentRecord',
	LiquidationRecord = 'LiquidationRecord',
	FundingRateRecord = 'FundingRateRecord',
	OrderRecord = 'OrderRecord',
	OrderActionRecord = 'OrderActionRecord',
	OrderFillStatusRecord = 'OrderFillStatusRecord',
	TradeRecord = 'TradeRecord',
	PredictionRecord = 'PredictionRecord',
	SettlePnlRecord = 'SettlePnlRecord',
	NewUserRecord = 'NewUserRecord',
	LPRecord = 'LPRecord',
	LPMintRedeemRecord = 'LPMintRedeemRecord',
	InsuranceFundRecord = 'InsuranceFundRecord',
	SpotInterestRecord = 'SpotInterestRecord',
	InsuranceFundStakeRecord = 'InsuranceFundStakeRecord',
	InsuranceFundSwapRecord = 'InsuranceFundSwapRecord',
	CurveRecord = 'CurveRecord',
	SwapRecord = 'SwapRecord',
	SpotMarketVaultDepositRecord = 'SpotMarketVaultDepositRecord',
	CandleRecord = 'CandleRecord',
	FeeRecord = 'FeeRecord',

	NotificationRecord = 'NotificationRecord',
	NotificationPreferencesRecord = 'NotificationPreferencesRecord',
	DeviceRecord = 'DeviceRecord',
	AlertRecord = 'AlertRecord',
	WhitelistRecord = 'WhitelistRecord',
	ClaimRecord = 'ClaimRecord',

	VaultSnapshotRecord = 'VaultSnapshotRecord',
	VaultDepositorSnapshotRecord = 'VaultDepositorSnapshotRecord',
	TradeSnapshotRecord = 'TradeSnapshotRecord',
	EarnSnapshotRecord = 'EarnSnapshotRecord',
	ReferralSnapshotRecord = 'ReferralSnapshotRecord',
	PoolSnapshotRecord = 'PoolSnapshotRecord',

	VaultDepositorRecord = 'VaultDepositorRecord',
	VaultDepositorCumulativeRecord = 'VaultDepositorCumulativeRecord',
}

export enum RecordIngestionFailure {
	INSERT = 'insert_failure',
	ORDER_MISSING = 'order_missing',
}

export type DBRecord =
	| SettlePnlRecord
	| DepositRecord
	| RewardRecord
	| LiquidationRecord
	| LPRecord
	| FundingPaymentRecord
	| InsuranceFundStakeRecord
	| InsuranceFundRecord
	| FundingRateRecord
	| OrderActionRecord
	| SwapRecord
	| TradeRecord
	| PredictionRecord
	| OrderRecord
	| VaultDepositorRecord
	| InsuranceFundSwapRecord
	| LPMintRedeemRecord;

export enum SecondaryIndex {
	GSI1 = 'GSI1',
	GSI2 = 'GSI2',
}

export type RecordKeys = {
	pk: string;
	sk: string;
	GSI1PK?: string;
	GSI1SK?: string;
	GSI2PK?: string;
	GSI2SK?: string;
};

export enum SerializedMarketFilter {
	SPOT = 'spot',
	PERP = 'perp',
	PREDICTION = 'prediction',
}

export type TransformedRecord<T extends keyof typeof RecordTypes> = T extends 'OrderRecord'
	? OrderRecord[]
	: T extends 'OrderActionRecord'
	? OrderActionRecord[]
	: T extends 'TradeRecord'
	? TradeRecord[]
	: T extends 'PredictionRecord'
	? PredictionRecord[]
	: T extends 'SettlePnlRecord'
	? SettlePnlRecord[]
	: T extends 'DepositRecord'
	? DepositRecord[]
	: T extends 'LiquidationRecord'
	? LiquidationRecord[]
	: T extends 'LPRecord'
	? LPRecord[]
	: T extends 'LPMintRedeemRecord'
	? LPMintRedeemRecord[]
	: T extends 'FundingPaymentRecord'
	? FundingPaymentRecord[]
	: T extends 'InsuranceFundStakeRecord'
	? InsuranceFundStakeRecord[]
	: T extends 'InsuranceFundRecord'
	? InsuranceFundRecord[]
	: T extends 'FundingRateRecord'
	? FundingRateRecord[]
	: T extends 'VaultDepositorRecord'
	? VaultDepositorRecord[]
	: never[];

export enum LastOrderStatus {
	PARTIAL_FILL_CANCEL = 'partial_fill_cancelled',
	CANCELLED = 'cancelled',
	PARTIAL_FILL = 'partial_fill',
	FILLED = 'filled',
	OPEN = 'open',
	EXPIRED = 'expired',
	TRIGGERED = 'trigger',
}

export enum OrderLabel {
	MARKET = 'MARKET',
	LIMIT = 'LIMIT',
	ORACLE = 'ORACLE',
	ORACLE_LIMIT = 'ORACLE_LIMIT',
	STOP_MARKET = 'STOP_MARKET',
	STOP_LIMIT = 'STOP_LIMIT',
	TAKE_PROFIT_MARKET = 'TAKE_PROFIT_MARKET',
	TAKE_PROFIT_LIMIT = 'TAKE_PROFIT_LIMIT',
}

export type OrderRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	user: string;
	status: string;
	orderType: string;
	marketType: string;
	orderId: number;
	userOrderId: number;
	marketIndex: number;
	price: number;
	baseAssetAmount: number;
	quoteAssetAmount: number;
	baseAssetAmountFilled: number;
	quoteAssetAmountFilled: number;
	direction: string;
	reduceOnly: boolean;
	triggerPrice: number;
	triggerCondition: string;
	existingPositionDirection: string;
	postOnly: boolean;
	immediateOrCancel: boolean;
	oraclePriceOffset: number;
	auctionDuration: number;
	auctionStartPrice: number;
	auctionEndPrice: number;
	maxTs: number;
	symbol: string;
	entity: EntityTypes;
	source: IngestionSource;
	marketFilter: SerializedMarketFilter;

	// Additional OrderAction merged fields
	lastUpdatedTs?: number;
	lastActionStatus?: LastOrderStatus;
	lastActionExplanation?: string;
	cumulativeFee?: number;
};

export type OrderFillStatusRecord = {
	user: string;
	orderId: number;
	ts: number;
	marketFilter: SerializedMarketFilter;
	symbol: string;
};

export enum OrderAction {
	PLACE = 'place',
	CANCEL = 'cancel',
	EXPIRE = 'expire',
	FILL = 'fill',
	TRIGGER = 'trigger',
}

export type OrderActionRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	fillerReward: number;
	baseAssetAmountFilled: number;
	quoteAssetAmountFilled: number;
	takerFee: number;
	makerRebate: number;
	referrerReward: number;
	quoteAssetAmountSurplus: number;
	takerOrderBaseAssetAmount: number;
	takerOrderCumulativeBaseAssetAmountFilled: number;
	takerOrderCumulativeQuoteAssetAmountFilled: number;
	takerExistingQuoteEntryAmount: number | null;
	takerExistingBaseAssetAmount: number | null;
	makerOrderBaseAssetAmount: number;
	makerOrderCumulativeBaseAssetAmountFilled: number;
	makerOrderCumulativeQuoteAssetAmountFilled: number;
	makerExistingQuoteEntryAmount: number | null;
	makerExistingBaseAssetAmount: number | null;
	oraclePrice: number;
	makerFee: number;
	action: string;
	actionExplanation: string;
	marketIndex: number;
	marketType: string;
	filler: string;
	fillRecordId: string;
	taker: string;
	takerOrderId: string;
	takerOrderDirection: string;
	maker: string;
	makerOrderId: string;
	makerOrderDirection: string;
	spotFulfillmentMethodFee: number;
	symbol: string;
	user?: string;
	userOrderId?: number;
	userExistingQuoteEntryAmount?: number | null;
	userExistingBaseAssetAmount?: number | null;
	entity: EntityTypes;
	source: IngestionSource;
	marketFilter: SerializedMarketFilter;
	bitFlags: number;
};

export type TradeRecord = OrderActionRecord;
export type PredictionRecord = TradeRecord;

export type FeeRecord = {
	cumulativeFee: number;
	processedFillRecordIds: string[];
	lastUpdatedTs?: number;
};

export type SwapRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	user: string;
	amountOut: number;
	amountIn: number;
	outMarketIndex: number;
	inMarketIndex: number;
	outOraclePrice: number;
	inOraclePrice: number;
	fee: number;
	entity: EntityTypes;
	inSymbol: string;
	outSymbol: string;
	isInMarket?: boolean;
	source: IngestionSource;
};

export type SettlePnlRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	pnl: number;
	user: string;
	baseAssetAmount: number;
	quoteAssetAmountAfter: number;
	quoteEntryAmount: number;
	settlePrice: number;
	marketIndex: number;
	explanation: string;
	entity: EntityTypes;
	source: IngestionSource;
};

export type DepositRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	amount: number;
	oraclePrice: number;
	marketDepositBalance: number;
	marketWithdrawBalance: number;
	marketCumulativeDepositInterest: number;
	marketCumulativeBorrowInterest: number;
	totalDepositsAfter: number;
	totalWithdrawsAfter: number;
	depositRecordId: string;
	userAuthority: string;
	user: string;
	direction: string;
	marketIndex: number;
	explanation: string;
	symbol: string;
	entity: EntityTypes;
	source: IngestionSource;
};

export type RewardRecord = DepositRecord;

export type LiquidationRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	liquidationType: string;
	user: string;
	liquidator: string;
	marginRequirement: number;
	totalCollateral: number;
	marginFreed: number;
	liquidationId: string;
	bankrupt: boolean;
	canceledOrderIds: string[];
	liquidatePerp_marketIndex: number;
	liquidatePerp_oraclePrice: number;
	liquidatePerp_baseAssetAmount: number;
	liquidatePerp_quoteAssetAmount: number;
	liquidatePerp_lpShares: number;
	liquidatePerp_fillRecordId: string;
	liquidatePerp_userOrderId: string;
	liquidatePerp_liquidatorOrderId: string;
	liquidatePerp_liquidatorFee: number;
	liquidatePerp_ifFee: number;
	liquidateSpot_assetMarketIndex: number;
	liquidateSpot_assetPrice: number;
	liquidateSpot_assetTransfer: number;
	liquidateSpot_liabilityMarketIndex: number;
	liquidateSpot_liabilityPrice: number;
	liquidateSpot_liabilityTransfer: number;
	liquidateSpot_ifFee: number;
	liquidateBorrowForPerpPnl_perpMarketIndex: number;
	liquidateBorrowForPerpPnl_marketOraclePrice: number;
	liquidateBorrowForPerpPnl_pnlTransfer: number;
	liquidateBorrowForPerpPnl_liabilityMarketIndex: number;
	liquidateBorrowForPerpPnl_liabilityPrice: number;
	liquidateBorrowForPerpPnl_liabilityTransfer: number;
	liquidatePerpPnlForDeposit_perpMarketIndex: number;
	liquidatePerpPnlForDeposit_marketOraclePrice: number;
	liquidatePerpPnlForDeposit_pnlTransfer: number;
	liquidatePerpPnlForDeposit_assetMarketIndex: number;
	liquidatePerpPnlForDeposit_assetPrice: number;
	liquidatePerpPnlForDeposit_assetTransfer: number;
	perpBankruptcy_marketIndex: number;
	perpBankruptcy_pnl: number;
	perpBankruptcy_ifPayment: number;
	perpBankruptcy_clawbackUser: string;
	perpBankruptcy_clawbackUserPayment: number;
	perpBankruptcy_cumulativeFundingRateDelta: number;
	spotBankruptcy_marketIndex: number;
	spotBankruptcy_borrowAmount: number;
	spotBankruptcy_ifPayment: number;
	spotBankruptcy_cumulativeDepositInterestDelta: number;
	entity: EntityTypes;
	source: IngestionSource;
	bitFlags: number;
};

export type LPRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	user: string;
	action: string;
	marketIndex: number;
	nShares: number;
	deltaBaseAssetAmount: number;
	deltaQuoteAssetAmount: number;
	pnl: number;
	entity: EntityTypes;
	source: IngestionSource;
};

export type LPMintRedeemRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	authority: string;
	amount: number;
	fee: number;
	spotMarketIndex: number;
	oraclePrice: number;
	mint: string;
	lpAmount: number;
	lpFee: number;
	lpPrice: number;
	description: number;
	constituentIndex: number;
	mintRedeemId: string;
	lastAum: number;
	lastAumSlot: number;
	inMarketCurrentWeight: number;
	inMarketTargetWeight: number;
	lpPool: string;
	entity: EntityTypes;
	source: IngestionSource;
};

export type FundingPaymentRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	userAuthority: string;
	user: string;
	marketIndex: number;
	fundingPayment: number;
	baseAssetAmount: number;
	userLastCumulativeFunding: number;
	ammCumulativeFundingLong: number;
	ammCumulativeFundingShort: number;
	entity: EntityTypes;
	source: IngestionSource;
};

export type InsuranceFundStakeRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	amount: number;
	userAuthority: string;
	action: string;
	marketIndex: number;
	ifSharesBefore: number;
	userIfSharesBefore: number;
	totalIfSharesBefore: number;
	ifSharesAfter: number;
	userIfSharesAfter: number;
	totalIfSharesAfter: number;
	insuranceVaultAmountBefore: number;
	entity: EntityTypes;
	symbol: string;
	source: IngestionSource;
};

export type InsuranceFundSwapRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	rebalanceConfig: string;
	inIfTotalSharesBefore: number;
	outIfTotalSharesBefore: number;
	inIfUserSharesBefore: number;
	outIfUserSharesBefore: number;
	inIfTotalSharesAfter: number;
	outIfTotalSharesAfter: number;
	inIfUserSharesAfter: number;
	outIfUserSharesAfter: number;
	inAmount: number;
	outAmount: number;
	outOraclePrice: number;
	outOraclePriceTwap: number;
	inVaultAmountBefore: number;
	outVaultAmountBefore: number;
	inFundVaultAmountAfter: number;
	outFundVaultAmountAfter: number;
	inMarketIndex: number;
	outMarketIndex: number;
	inSymbol: string;
	outSymbol: string;
	isInMarket: boolean;
	source: IngestionSource;
	entity: EntityTypes;
};

export type InsuranceFundRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	spotMarketIndex: number;
	perpMarketIndex: number;
	userIfFactor: number;
	totalIfFactor: number;
	symbol: string;
	vaultAmountBefore: number;
	insuranceVaultAmountBefore: number;
	totalIfSharesBefore: number;
	totalIfSharesAfter: number;
	amount: number;
	entity: EntityTypes;
	source: IngestionSource;
};

export type FundingRateRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	recordId: string;
	marketIndex: number;
	symbol: string;
	fundingRate: number;
	fundingRateLong: number;
	fundingRateShort: number;
	cumulativeFundingRateLong: number;
	cumulativeFundingRateShort: number;
	oraclePriceTwap: number;
	markPriceTwap: number;
	periodRevenue: number;
	baseAssetAmountWithAmm: number;
	baseAssetAmountWithUnsettledLp: number;
	entity: EntityTypes;
	source: IngestionSource;
};

export type OffChainRecord =
	| CandleRecord
	| AlertRecord
	| DeviceRecord
	| NotificationPreferencesRecord
	| WhitelistRecord
	| NotificationRecord
	| ClaimRecord
	| VaultSnapshotRecord
	| VaultDepositorSnapshotRecord
	| EarnSnapshotRecord
	| TradeSnapshotRecord
	| VaultDepositorCumulativeRecord
	| ReferralSnapshotRecord
	| PoolSnapshotRecord
	| OrderFillStatusRecord;

export type CandleResolutions = '1' | '5' | '15' | '60' | '240' | 'D' | 'W' | 'M';

export type CandleRecord = {
	symbol: string;
	ts: number;
	resolution: CandleResolutions;
	fillOpen: number;
	fillHigh: number;
	fillClose: number;
	fillLow: number;
	oracleOpen: number;
	oracleHigh: number;
	oracleClose: number;
	oracleLow: number;
	quoteVolume: number;
	baseVolume: number;
	lastTradeTs?: number;
	lastFillRecordId?: string;
};

export enum DevicePlatform {
	IOS = 'ios',
	ANDROID = 'android',
	WEB = 'web',
}

export interface DeviceRecord {
	authorityId: string;
	deviceId: string;
	token?: string;
	platform?: DevicePlatform | '';
}

export enum AlertDirection {
	ABOVE = 'ABOVE',
	BELOW = 'BELOW',
}

export interface AlertRecord {
	authorityId: string;
	alertId: string;
	symbol: string;
	targetPrice: number;
	direction: AlertDirection;
	triggeredAt?: string;
}

export interface WhitelistRecord {
	whitelistId: string;
	authorityId: string;
	address: string;
	label: string;
	token: string;
	chainId: string;
}

export enum ClaimStatus {
	ACCRUING = 'accruing',
	ELIGIBLE = 'eligible',
	PROCESSING = 'processing',
	COMPLETED = 'completed',
}

export enum ClaimType {
	FIXED = 'fixed',
	ACCRUAL = 'accrual',
}

export interface ClaimRecord {
	campaignId: string;
	authorityId: string;
	status: ClaimStatus;
	amount: number;
	assetSymbol: string;
	claimType?: ClaimType;
	progressAmount?: number;
	progressCap?: number;
	claimableAmount?: number;
	claimedAmount?: number;
	lastSyncedAt?: number;
	claimedByDeviceId?: string;
	platform?: DevicePlatform | '';
	targetUserAccount?: string;
	campaignStartTs: number;
	campaignEndTs: number;
	processingStartedAt?: number;
	sendStartedAt?: number;
	processedAt?: number;
	rewardTxSig?: string;
	rewardRunnerAttemptCount?: number;
	lastError?: string;
	retryAfterTs?: number;
	updatedAt?: number;
}

export enum NotificationStatus {
	PENDING = 'PENDING',
	SENT = 'SENT',
	FAILED = 'FAILED',
	READ = 'READ',
}

export enum NotificationType {
	PRICE_ALERT = 'PRICE_ALERT',
	RECORD_UPDATE = 'RECORD_UPDATE',
	ACCOUNT_UPDATE = 'ACCOUNT_UPDATE',
	TEST = 'TEST',
	// Dashboard-originated broadcast types — the notifier providers gate on
	// `channels`, not `type`; Dialect maps unknown values to its default
	// template. Adding them here so internal callers stay typed.
	NEW_MARKET = 'NEW_MARKET',
	PRODUCT_UPDATE = 'PRODUCT_UPDATE',
	ANNOUNCEMENT = 'ANNOUNCEMENT',
	REDUCE_ONLY = 'REDUCE_ONLY',
	CUSTOM = 'CUSTOM',
}

export enum NotificationChannel {
	APP = 'app',
	PUSH = 'push',
}

export interface NotificationPreferencesRecord {
	authorityId: string;
	pushOptOutTypes: NotificationType[];
}

export interface NotificationRecord {
	notificationId: string;
	authorityId: string;
	title: string;
	body: string;
	type: NotificationType;
	status: NotificationStatus;
	channels?: NotificationChannel[];
	user?: string;
	data?: any;
	actions?: {
		label: string;
		link: string;
	}[];
	sentAt?: number;
	createdAt?: number;
}

export enum RiskBucket {
	HEALTHY = 'HEALTHY',
	MODERATE = 'MODERATE',
	AT_RISK = 'AT_RISK',
	CRITICAL = 'CRITICAL',
	LIQUIDATABLE = 'LIQUIDATABLE',
}

export type VaultDepositorRecord = {
	ts: number;
	txSig: string;
	txSigIndex: number;
	slot: number;
	vault: string;
	depositorAuthority: string;
	action: string;
	amount: number;
	spotMarketIndex: number;
	vaultSharesBefore: number;
	vaultSharesAfter: number;
	vaultEquityBefore: number;
	userVaultSharesBefore: number;
	totalVaultSharesBefore: number;
	userVaultSharesAfter: number;
	totalVaultSharesAfter: number;
	profitShare: number;
	managementFee: number;
	managementFeeShares: number;
	depositOraclePrice: number;
	entity: EntityTypes;
	source: IngestionSource;
};

export interface VaultDepositorCumulativeRecord {
	cumulativeDepositQuoteValue: number;
	cumulativeWithdrawalQuoteValue: number;
	processedTransactions: string[];
}

export interface VaultSnapshotRecord {
	ts: number;
	vault: string;
	userShares: number;
	totalShares: number;
	netDeposits: number;
	totalDeposits: number;
	totalWithdraws: number;
	totalWithdrawRequested: number;
	managerNetDeposits: number;
	managerTotalDeposits: number;
	managerTotalWithdraws: number;
	managerTotalProfitShare: number;
	managerTotalFee: number;
	isDaily: boolean;
	ttl?: number;
}

export interface Asset {
	marketIndex: number;
	balance: number;
	deposits: number;
	withdrawals: number;
	rewards: number;
	pnl: number;
	interestBaseValue: number;
	interestQuoteValue: number;
	oraclePrice: number;
}

export type EarnSnapshotRecord = {
	ts: number;
	user: string;
	authority: string;
	balanceSnapshotTs: number;
	assets: Asset[];
	isDaily: boolean;
	ttl?: number;
};

export interface VaultDepositorSnapshotRecord {
	ts: number;
	authority: string;
	user: string;
	vault: string;
	totalAccountValue: number;
	totalAccountBaseValue?: number;
	marketIndex: number;
	isDaily: boolean;
	ttl?: number;
}

export interface TradeSnapshotRecord {
	ts: number;
	authority: string;
	user: string;
	accountBalance: number;
	unrealizedPnl: number;
	cumulativeRealizedPnl: number;
	unsettledPnl: number;
	cumulativeSettledPnl: number;
	cumulativeFunding: number;
	cumulativeFeePaid: number;
	cumulativeFeeRebate: number;
	cumulativeTakerVolume: number;
	cumulativeMakerVolume: number;
	isDaily: boolean;
	ttl?: number;
}

export type ReferralSnapshotRecord = {
	ts: number;
	authority: string;
	referralRewards: string;
	referralCount: string;
	referredUsers: string[];
	referredVolume30D: string;
	ttl?: number;
};

export type PoolSnapshotRecord = {
	ts: number;
	pool: string;
	tvl: string;
	price: string;
	isDaily: boolean;
	ttl?: number;
};

export type SnapshotFrequency = 'daily' | 'hourly';

export type SnapshotRecordTypes =
	| RecordTypes.TradeSnapshotRecord
	| RecordTypes.VaultDepositorSnapshotRecord
	| RecordTypes.EarnSnapshotRecord
	| RecordTypes.VaultSnapshotRecord
	| RecordTypes.ReferralSnapshotRecord
	| RecordTypes.PoolSnapshotRecord;

export interface OraclePriceData {
	oracle: string;
	symbol: string;
	price: number;
	confidence: number;
	timestamp: number;
	slot: number;
	priceChange: number;
}
