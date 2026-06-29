import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	AMM,
	AssetTier,
	MarketStats,
	PerpPosition,
	BN,
	VelocityClient,
	User,
	PerpMarketAccount,
	SpotMarketAccount,
	MarketStatus,
	ContractType,
	OracleSource,
	DevnetSpotMarkets,
	BASE_PRECISION,
	QUOTE_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	StateAccount,
	UserMapInterface,
	Wallet,
	OrderRecord,
	ZERO,
	ContractTier,
	SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	PRICE_PRECISION,
	DataAndSlot,
} from '../../src';
import { EventEmitter } from 'events';

export const mockPerpPosition: PerpPosition = {
	baseAssetAmount: new BN(0),
	lastCumulativeFundingRate: new BN(0),
	marketIndex: 0,
	quoteAssetAmount: new BN(0),
	quoteBreakEvenAmount: new BN(0),
	quoteEntryAmount: new BN(0),
	openOrders: 0,
	openBids: new BN(0),
	openAsks: new BN(0),
	settledPnl: new BN(0),
	remainderBaseAssetAmount: 0,
	maxMarginRatio: 1,
	isolatedPositionScaledBalance: new BN(0),
	positionFlag: 0,
};

export const mockAMM: AMM = {
	/* these values create a bid/ask price of 12 */
	baseAssetReserve: new BN(1).mul(BASE_PRECISION),
	quoteAssetReserve: new BN(12)
		.mul(QUOTE_PRECISION)
		.mul(AMM_TO_QUOTE_PRECISION_RATIO),
	// zero-spread mock: bid/ask reserves mirror the base/quote reserves
	askBaseAssetReserve: new BN(1).mul(BASE_PRECISION),
	askQuoteAssetReserve: new BN(12)
		.mul(QUOTE_PRECISION)
		.mul(AMM_TO_QUOTE_PRECISION_RATIO),
	bidBaseAssetReserve: new BN(1).mul(BASE_PRECISION),
	bidQuoteAssetReserve: new BN(12)
		.mul(QUOTE_PRECISION)
		.mul(AMM_TO_QUOTE_PRECISION_RATIO),
	sqrtK: new BN(1),
	pegMultiplier: new BN(1),
	maxSlippageRatio: 1_000_000,
	lastOracleReservePriceSpreadPct: new BN(0),
	lastSpreadUpdateSlot: new BN(0),
	longSpread: 0,
	shortSpread: 0,
	referencePriceOffset: 0,

	feePool: {
		scaledBalance: new BN(0),
		marketIndex: 0,
	},
	concentrationCoef: new BN(0),
	minBaseAssetReserve: new BN(0),
	maxBaseAssetReserve: new BN(0),
	terminalQuoteAssetReserve: new BN(0),
	baseAssetAmountWithAmm: new BN(0),
	totalFee: new BN(0),
	totalMmFee: new BN(0),
	totalFeeMinusDistributions: new BN(0),
	totalFeeWithdrawn: new BN(0),
	lastUpdateSlot: new BN(0),
	netRevenueSinceLastFunding: new BN(0),
	lastCumulativeFundingRateLong: new BN(0),
	lastCumulativeFundingRateShort: new BN(0),
	baseSpread: 0,
	maxSpread: 0,
	maxFillReserveFraction: 0,
	curveUpdateIntensity: 0,
	ammJitIntensity: 0,
	ammSpreadAdjustment: 0,
	ammInventorySpreadAdjustment: 0,
	referencePriceOffsetDeadbandPct: 0,
	fundingBiasSensitivity: 0,
};

// Per-market analytics/oracle/twap data that was moved off AMM onto its own
// MarketStats sub-struct. mockPerpMarkets clones this for each market.
export const mockMarketStats: MarketStats = {
	lastMarkPriceTwap: new BN(0),
	lastMarkPriceTwap5Min: new BN(0),
	lastMarkPriceTwapTs: new BN(0),
	lastBidPriceTwap: new BN(0),
	lastAskPriceTwap: new BN(0),
	markStd: new BN(0),
	oracleStd: new BN(0),
	lastOracleConfPct: new BN(0),
	volume24H: new BN(0),
	longIntensityVolume: new BN(0),
	shortIntensityVolume: new BN(0),
	lastTradeTs: new BN(0),
	last24HAvgFundingRate: new BN(0),
	fundingPeriod: new BN(0),
	minOrderSize: new BN(0),
	mmOraclePrice: new BN(0),
	mmOracleSlot: new BN(0),
	mmOracleSequenceId: new BN(0),
	lastOracleNormalisedPrice: new BN(0),
	lastReferencePriceOffset: 0,
	lastOracleValid: true,
	lastFundingOracleTwap: new BN(0),
	historicalOracleData: {
		lastOraclePrice: new BN(0),
		lastOracleConf: new BN(0),
		lastOracleDelay: new BN(0),
		lastOraclePriceTwap: new BN(0),
		lastOraclePriceTwap5Min: new BN(0),
		lastOraclePriceTwapTs: new BN(0),
	},
};

// Fields shared by every mock perp market: the AMM, its MarketStats, the
// fields migrated off AMM to the top-level PerpMarket, and the other required
// PerpMarketAccount members the dlob/amm tests don't individually tweak.
function mockPerpMarketCommon(): Omit<
	PerpMarketAccount,
	| 'marketIndex'
	| 'marginRatioInitial'
	| 'marginRatioMaintenance'
	| 'contractTier'
> {
	return {
		status: MarketStatus.INITIALIZED,
		lastFillPrice: new BN(0),
		name: [],
		contractType: ContractType.PERPETUAL,
		expiryTs: new BN(0),
		expiryPrice: new BN(0),
		pubkey: PublicKey.default,
		amm: mockAMM,
		marketStats: mockMarketStats,
		numberOfUsersWithBase: 0,
		numberOfUsers: 0,
		nextFillRecordId: new BN(0),
		nextFundingRateRecordId: new BN(0),
		pnlPool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		protocolFeePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		feeLedger: {
			totalExchangeFee: new BN(0),
			totalLiquidationFee: new BN(0),
			pendingProtocolFee: new BN(0),
			pendingIfFee: new BN(0),
			ammProtocolFeesReceived: new BN(0),
			pendingAmmProvision: new BN(0),
		},
		liquidatorFee: 0,
		ifLiquidationFee: 0,
		protocolLiquidationFee: 0,
		feePoolBufferTarget: new BN(0),
		imfFactor: 0,
		unrealizedPnlImfFactor: 0,
		unrealizedPnlMaxImbalance: ZERO,
		unrealizedPnlInitialAssetWeight: 0,
		unrealizedPnlMaintenanceAssetWeight: 0,
		insuranceClaim: {
			revenueWithdrawSinceLastSettle: new BN(0),
			maxRevenueWithdrawPerPeriod: new BN(0),
			lastRevenueWithdrawTs: new BN(0),
			quoteSettledInsurance: new BN(0),
			quoteMaxInsurance: new BN(0),
		},
		quoteSpotMarketIndex: 0,
		feeAdjustment: 0,
		poolId: 0,
		pausedOperations: 0,
		hedgeConfig: {
			poolId: 0,
			status: 0,
			pausedOperations: 0,
			exchangeFeeExclusionScalar: 0,
			feeTransferScalar: 0,
		},
		marketConfig: 0,

		// Fields migrated off AMM to top-level PerpMarket
		oracle: PublicKey.default,
		oracleSource: OracleSource.PYTH_LAZER,
		oracleSlotDelayOverride: 0,
		oracleLowRiskSlotDelayOverride: 0,
		baseAssetAmountLong: new BN(0),
		baseAssetAmountShort: new BN(0),
		quoteAssetAmount: new BN(0),
		quoteEntryAmountLong: new BN(0),
		quoteEntryAmountShort: new BN(0),
		quoteBreakEvenAmountLong: new BN(0),
		quoteBreakEvenAmountShort: new BN(0),
		totalSocialLoss: new BN(0),
		maxOpenInterest: new BN(0),
		cumulativeFundingRateLong: new BN(0),
		cumulativeFundingRateShort: new BN(0),
		lastFundingRate: new BN(0),
		lastFundingRateLong: new BN(0),
		lastFundingRateShort: new BN(0),
		lastFundingRateTs: new BN(0),
		netUnsettledFundingPnl: new BN(0),
		fundingClampThreshold: 5,
		fundingRampSlope: 1000000,
		orderStepSize: new BN(1),
		orderTickSize: new BN(1),
	};
}

export const mockPerpMarkets: Array<PerpMarketAccount> = [
	{
		...mockPerpMarketCommon(),
		contractTier: ContractTier.A,
		marketIndex: 0,
		marginRatioInitial: 2000,
		marginRatioMaintenance: 1000,
	},
	{
		...mockPerpMarketCommon(),
		contractTier: ContractTier.A,
		marketIndex: 1,
		marginRatioInitial: 0,
		marginRatioMaintenance: 0,
	},
	{
		...mockPerpMarketCommon(),
		contractTier: ContractTier.A,
		marketIndex: 2,
		marginRatioInitial: 0,
		marginRatioMaintenance: 0,
	},
];

export const mockSpotMarkets: Array<SpotMarketAccount> = [
	{
		status: MarketStatus.ACTIVE,
		assetTier: AssetTier.COLLATERAL,
		name: [],
		maxTokenDeposits: new BN(1000000 * QUOTE_PRECISION.toNumber()),
		marketIndex: 0,
		pubkey: PublicKey.default,
		mint: DevnetSpotMarkets[0].mint,
		vault: PublicKey.default,
		minOrderSize: ZERO,
		maxPositionSize: ZERO,
		revenuePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		insuranceFund: {
			vault: PublicKey.default,
			totalShares: new BN(0),
			userShares: new BN(0),
			sharesBase: new BN(0),
			unstakingPeriod: new BN(0),
			lastRevenueSettleTs: new BN(0),
			revenueSettlePeriod: new BN(0),
			ifFeeFactor: 0,
		},
		ifLiquidationFee: 0,
		liquidatorFee: 0,
		protocolFeePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		protocolLiquidationFee: 0,
		protocolFeeFactor: 0,
		decimals: 6,
		optimalUtilization: 0,
		optimalBorrowRate: 0,
		maxBorrowRate: 0,
		cumulativeDepositInterest: SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
		cumulativeBorrowInterest: SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
		totalSocialLoss: new BN(0),
		totalQuoteSocialLoss: new BN(0),
		depositBalance: new BN(0),
		borrowBalance: new BN(0),
		lastInterestTs: new BN(0),
		lastTwapTs: new BN(0),
		expiryTs: new BN(0),
		oracle: PublicKey.default,
		initialAssetWeight: SPOT_MARKET_WEIGHT_PRECISION.toNumber(),
		maintenanceAssetWeight: SPOT_MARKET_WEIGHT_PRECISION.toNumber(),
		initialLiabilityWeight: SPOT_MARKET_WEIGHT_PRECISION.toNumber(),
		maintenanceLiabilityWeight: SPOT_MARKET_WEIGHT_PRECISION.toNumber(),
		scaleInitialAssetWeightStart: new BN(0),
		imfFactor: 0,
		withdrawGuardThreshold: new BN(0),
		depositTokenTwap: new BN(0),
		borrowTokenTwap: new BN(0),
		utilizationTwap: new BN(0),
		orderStepSize: new BN(1),
		orderTickSize: new BN(0),
		nextFillRecordId: new BN(0),
		nextDepositRecordId: new BN(0),
		ordersEnabled: true,
		spotFeePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		totalSpotFee: new BN(0),
		totalSwapFee: new BN(0),
		flashLoanAmount: new BN(0),
		flashLoanInitialTokenAmount: new BN(0),
		oracleSource: OracleSource.PYTH_LAZER,
		historicalOracleData: {
			lastOraclePrice: PRICE_PRECISION,
			lastOracleConf: new BN(0),
			lastOracleDelay: new BN(0),
			lastOraclePriceTwap: PRICE_PRECISION,
			lastOraclePriceTwap5Min: PRICE_PRECISION,
			lastOraclePriceTwapTs: new BN(0),
		},
		historicalIndexData: {
			lastIndexBidPrice: PRICE_PRECISION,
			lastIndexAskPrice: PRICE_PRECISION,
			lastIndexPriceTwap: PRICE_PRECISION,
			lastIndexPriceTwap5Min: PRICE_PRECISION,
			lastIndexPriceTwapTs: new BN(0),
		},
		pausedOperations: 0,
		ifPausedOperations: 0,
		maxTokenBorrowsFraction: 0,
		minBorrowRate: 0,
		tokenProgramFlag: 0,
		poolId: 0,
		feeAdjustment: 0,
	},
	{
		status: MarketStatus.ACTIVE,
		assetTier: AssetTier.CROSS,
		name: [],
		maxTokenDeposits: new BN(100),
		marketIndex: 1,
		pubkey: PublicKey.default,
		mint: DevnetSpotMarkets[1].mint,
		vault: PublicKey.default,
		revenuePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		minOrderSize: ZERO,
		maxPositionSize: ZERO,
		insuranceFund: {
			vault: PublicKey.default,
			totalShares: new BN(0),
			userShares: new BN(0),
			sharesBase: new BN(0),
			unstakingPeriod: new BN(0),
			lastRevenueSettleTs: new BN(0),
			revenueSettlePeriod: new BN(0),
			ifFeeFactor: 0,
		},
		ifLiquidationFee: 0,
		liquidatorFee: 0,
		protocolFeePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		protocolLiquidationFee: 0,
		protocolFeeFactor: 0,
		decimals: 9,
		optimalUtilization: 0,
		optimalBorrowRate: 0,
		maxBorrowRate: 0,
		cumulativeDepositInterest: SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
		cumulativeBorrowInterest: SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
		totalSocialLoss: new BN(0),
		totalQuoteSocialLoss: new BN(0),
		depositBalance: new BN(0),
		borrowBalance: new BN(0),
		lastInterestTs: new BN(0),
		lastTwapTs: new BN(0),
		expiryTs: new BN(0),
		oracle: PublicKey.default,
		initialAssetWeight: 0,
		maintenanceAssetWeight: 0,
		initialLiabilityWeight: 0,
		maintenanceLiabilityWeight: 0,
		scaleInitialAssetWeightStart: new BN(0),
		imfFactor: 0,
		withdrawGuardThreshold: new BN(0),
		depositTokenTwap: new BN(0),
		borrowTokenTwap: new BN(0),
		utilizationTwap: new BN(0),
		orderStepSize: new BN(1),
		orderTickSize: new BN(0),
		nextFillRecordId: new BN(0),
		nextDepositRecordId: new BN(0),
		ordersEnabled: true,
		spotFeePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		totalSpotFee: new BN(0),
		totalSwapFee: new BN(0),
		flashLoanAmount: new BN(0),
		flashLoanInitialTokenAmount: new BN(0),
		oracleSource: OracleSource.PYTH_LAZER,
		historicalOracleData: {
			lastOraclePrice: new BN(0),
			lastOracleConf: new BN(0),
			lastOracleDelay: new BN(0),
			lastOraclePriceTwap: new BN(0),
			lastOraclePriceTwap5Min: new BN(0),
			lastOraclePriceTwapTs: new BN(0),
		},
		historicalIndexData: {
			lastIndexBidPrice: new BN(0),
			lastIndexAskPrice: new BN(0),
			lastIndexPriceTwap: new BN(0),
			lastIndexPriceTwap5Min: new BN(0),
			lastIndexPriceTwapTs: new BN(0),
		},
		pausedOperations: 0,
		ifPausedOperations: 0,
		maxTokenBorrowsFraction: 0,
		minBorrowRate: 0,
		tokenProgramFlag: 0,
		poolId: 0,
		feeAdjustment: 0,
	},
	{
		status: MarketStatus.ACTIVE,
		assetTier: AssetTier.PROTECTED,
		name: [],
		maxTokenDeposits: new BN(100),
		marketIndex: 2,
		pubkey: PublicKey.default,
		// DevnetSpotMarkets only has 2 entries; mock market 2 uses a
		// placeholder mint like its other placeholder pubkeys
		mint: PublicKey.default,
		vault: PublicKey.default,
		revenuePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		minOrderSize: ZERO,
		maxPositionSize: ZERO,
		insuranceFund: {
			vault: PublicKey.default,
			totalShares: new BN(0),
			userShares: new BN(0),
			sharesBase: new BN(0),
			unstakingPeriod: new BN(0),
			lastRevenueSettleTs: new BN(0),
			revenueSettlePeriod: new BN(0),
			ifFeeFactor: 0,
		},
		ifLiquidationFee: 0,
		liquidatorFee: 0,
		protocolFeePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		protocolLiquidationFee: 0,
		protocolFeeFactor: 0,
		decimals: 6,
		optimalUtilization: 0,
		optimalBorrowRate: 0,
		maxBorrowRate: 0,
		cumulativeDepositInterest: SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
		cumulativeBorrowInterest: SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
		totalSocialLoss: new BN(0),
		totalQuoteSocialLoss: new BN(0),
		depositBalance: new BN(0),
		borrowBalance: new BN(0),
		lastInterestTs: new BN(0),
		lastTwapTs: new BN(0),
		expiryTs: new BN(0),
		oracle: PublicKey.default,
		initialAssetWeight: 0,
		maintenanceAssetWeight: 0,
		initialLiabilityWeight: 0,
		maintenanceLiabilityWeight: 0,
		scaleInitialAssetWeightStart: new BN(0),
		imfFactor: 0,
		withdrawGuardThreshold: new BN(0),
		depositTokenTwap: new BN(0),
		borrowTokenTwap: new BN(0),
		utilizationTwap: new BN(0),
		orderStepSize: new BN(1),
		orderTickSize: new BN(0),
		nextFillRecordId: new BN(0),
		nextDepositRecordId: new BN(0),
		ordersEnabled: true,
		spotFeePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		totalSpotFee: new BN(0),
		totalSwapFee: new BN(0),
		flashLoanAmount: new BN(0),
		flashLoanInitialTokenAmount: new BN(0),
		oracleSource: OracleSource.PYTH_LAZER,
		historicalOracleData: {
			lastOraclePrice: new BN(0),
			lastOracleConf: new BN(0),
			lastOracleDelay: new BN(0),
			lastOraclePriceTwap: new BN(0),
			lastOraclePriceTwap5Min: new BN(0),
			lastOraclePriceTwapTs: new BN(0),
		},
		historicalIndexData: {
			lastIndexBidPrice: new BN(0),
			lastIndexAskPrice: new BN(0),
			lastIndexPriceTwap: new BN(0),
			lastIndexPriceTwap5Min: new BN(0),
			lastIndexPriceTwapTs: new BN(0),
		},
		pausedOperations: 0,
		ifPausedOperations: 0,
		maxTokenBorrowsFraction: 0,
		minBorrowRate: 0,
		tokenProgramFlag: 0,
		poolId: 0,
		feeAdjustment: 0,
	},
];

export const mockStateAccount: StateAccount = {
	coldAdmin: PublicKey.default,
	warmAdmin: PublicKey.default,
	pauseAdmin: PublicKey.default,
	hotAmmCrank: PublicKey.default,
	hotLpCache: PublicKey.default,
	hotLpSwap: PublicKey.default,
	hotLpSettle: PublicKey.default,
	hotFeatureFlag: PublicKey.default,
	hotFuel: PublicKey.default,
	hotUserFlag: PublicKey.default,
	hotVaultDeposit: PublicKey.default,
	hotMmOracleCrank: PublicKey.default,
	hotAmmSpreadAdjust: PublicKey.default,
	hotFeeWithdraw: PublicKey.default,
	protocolFeeRecipientPerp: PublicKey.default,
	protocolFeeRecipientSpot: PublicKey.default,
	featureBitFlags: 0,
	lpPoolFeatureBitFlags: 0,
	solvencyStatus: 0,
	defaultMarketOrderTimeInForce: 0,
	defaultSpotAuctionDuration: 0,
	discountMint: PublicKey.default,
	exchangeStatus: 0,
	liquidationMarginBufferRatio: 0,
	minPerpAuctionDuration: 0,
	numberOfMarkets: 0,
	numberOfSpotMarkets: 0,
	numberOfSubAccounts: new BN(0),
	numberOfAuthorities: new BN(0),
	initialPctToLiquidate: 0,
	liquidationDuration: 0,
	oracleGuardRails: {
		priceDivergence: {
			markOraclePercentDivergence: new BN(0),
			oracleTwap5MinPercentDivergence: new BN(0),
		},
		validity: {
			slotsBeforeStaleForAmm: new BN(0),
			slotsBeforeStaleForMargin: new BN(0),
			confidenceIntervalMaxSize: new BN(0),
			tooVolatileRatio: new BN(0),
		},
	},
	perpFeeStructure: {
		feeTiers: [
			{
				feeNumerator: 0,
				feeDenominator: 0,
				makerRebateNumerator: 0,
				makerRebateDenominator: 1,
				referrerRewardNumerator: 0,
				referrerRewardDenominator: 0,
				refereeFeeNumerator: 0,
				refereeFeeDenominator: 0,
			},
		],
		fillerRewardStructure: {
			rewardNumerator: 0,
			rewardDenominator: 0,
			timeBasedRewardLowerBound: new BN(0),
		},
		flatFillerFee: new BN(0),
		ammFeeNumerator: 0,
		ifFeeNumerator: 0,
	},
	settlementDuration: 0,
	signer: PublicKey.default,
	signerNonce: 0,
	spotFeeStructure: {
		feeTiers: [
			{
				feeNumerator: 0,
				feeDenominator: 0,
				makerRebateNumerator: 0,
				makerRebateDenominator: 1,
				referrerRewardNumerator: 0,
				referrerRewardDenominator: 0,
				refereeFeeNumerator: 0,
				refereeFeeDenominator: 0,
			},
		],
		fillerRewardStructure: {
			rewardNumerator: 0,
			rewardDenominator: 0,
			timeBasedRewardLowerBound: new BN(0),
		},
		flatFillerFee: new BN(0),
		ammFeeNumerator: 0,
		ifFeeNumerator: 0,
	},
	srmVault: PublicKey.default,
	whitelistMint: PublicKey.default,
	maxNumberOfSubAccounts: 0,
	maxInitializeUserFee: 0,
};

export class MockUserMap implements UserMapInterface {
	eventEmitter: EventEmitter = new EventEmitter();
	private userMap = new Map<string, User>();
	private userAccountToAuthority = new Map<string, string>();
	private velocityClient: VelocityClient;

	constructor() {
		this.userMap = new Map();
		this.userAccountToAuthority = new Map();
		this.velocityClient = new VelocityClient({
			connection: new Connection('http://localhost:8899'),
			wallet: new Wallet(new Keypair()),
			programID: PublicKey.default,
		});
	}

	public async subscribe(): Promise<void> {}

	public async unsubscribe(): Promise<void> {}

	public async addPubkey(userAccountPublicKey: PublicKey): Promise<void> {
		const user = new User({
			velocityClient: this.velocityClient,
			userAccountPublicKey: userAccountPublicKey,
		});
		this.userMap.set(userAccountPublicKey.toBase58(), user);
	}

	// mock function
	public addUserAccountAuthority(
		userAccountPublicKey: PublicKey,
		authorityPublicKey: PublicKey
	): void {
		if (!this.userMap.has(userAccountPublicKey.toBase58())) {
			this.addPubkey(userAccountPublicKey);
		}
		this.userAccountToAuthority.set(
			userAccountPublicKey.toBase58(),
			authorityPublicKey.toBase58()
		);
	}

	public has(key: string): boolean {
		return this.userMap.has(key);
	}

	public get(_key: string): User | undefined {
		return undefined;
	}

	public getWithSlot(_key: string): DataAndSlot<User> | undefined {
		return undefined;
	}

	public async mustGet(_key: string): Promise<User> {
		return new User({
			velocityClient: this.velocityClient,
			userAccountPublicKey: PublicKey.default,
		});
	}

	public async mustGetWithSlot(_key: string): Promise<DataAndSlot<User>> {
		return {
			data: new User({
				velocityClient: this.velocityClient,
				userAccountPublicKey: PublicKey.default,
			}),
			slot: 0,
		};
	}

	public getUserAuthority(key: string): PublicKey | undefined {
		return new PublicKey(
			this.userAccountToAuthority.get(key) || PublicKey.default.toBase58()
		);
	}

	public async updateWithOrderRecord(_record: OrderRecord): Promise<void> {}

	public values(): IterableIterator<User> {
		return this.userMap.values();
	}

	public *valuesWithSlot(): IterableIterator<DataAndSlot<User>> {
		for (const user of this.userMap.values()) {
			yield {
				data: user,
				slot: 0,
			};
		}
	}

	public entries(): IterableIterator<[string, User]> {
		return this.userMap.entries();
	}

	public *entriesWithSlot(): IterableIterator<[string, DataAndSlot<User>]> {
		for (const [key, user] of this.userMap.entries()) {
			yield [
				key,
				{
					data: user,
					slot: 0,
				},
			];
		}
	}
}
