import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	AMM,
	AssetTier,
	PerpPosition,
	BN,
	DriftClient,
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
	lpShares: new BN(0),
	remainderBaseAssetAmount: 0,
	lastBaseAssetAmountPerLp: new BN(0),
	lastQuoteAssetAmountPerLp: new BN(0),
	perLpBase: 0,
};

export const mockAMM: AMM = {
	perLpBase: 0,
	/* these values create a bid/ask price of 12 */
	baseAssetReserve: new BN(1).mul(BASE_PRECISION),
	quoteAssetReserve: new BN(12)
		.mul(QUOTE_PRECISION)
		.mul(AMM_TO_QUOTE_PRECISION_RATIO),
	sqrtK: new BN(1),
	pegMultiplier: new BN(1),
	maxSlippageRatio: 1_000_000,

	cumulativeFundingRate: new BN(0),
	lastFundingRate: new BN(0),
	lastFundingRateTs: new BN(0),
	lastMarkPriceTwap: new BN(0),
	lastMarkPriceTwap5Min: new BN(0),
	lastMarkPriceTwapTs: new BN(0),
	totalFeeEarnedPerLp: new BN(0),
	historicalOracleData: {
		lastOraclePrice: new BN(0),
		lastOracleConf: new BN(0),
		lastOracleDelay: new BN(0),
		lastOraclePriceTwap: new BN(0),
		lastOraclePriceTwap5Min: new BN(0),
		lastOraclePriceTwapTs: new BN(0),
	},
	lastOracleReservePriceSpreadPct: new BN(0),
	lastOracleConfPct: new BN(0),
	oracle: PublicKey.default,
	oracleSource: OracleSource.PYTH,
	fundingPeriod: new BN(0),
	cumulativeFundingRateLong: new BN(0),
	cumulativeFundingRateShort: new BN(0),
	totalFeeMinusDistributions: new BN(0),
	totalFeeWithdrawn: new BN(0),
	totalFee: new BN(0),
	userLpShares: new BN(0),
	baseAssetAmountWithUnsettledLp: new BN(0),
	orderStepSize: new BN(0),
	orderTickSize: new BN(1),
	last24HAvgFundingRate: new BN(0),
	lastFundingRateShort: new BN(0),
	lastFundingRateLong: new BN(0),
	concentrationCoef: new BN(0),
	lastTradeTs: new BN(0),
	lastOracleNormalisedPrice: new BN(0),
	maxOpenInterest: new BN(0),
	totalLiquidationFee: new BN(0),
	maxFillReserveFraction: 0,
	baseSpread: 0,
	curveUpdateIntensity: 0,
	baseAssetAmountWithAmm: new BN(0),
	baseAssetAmountLong: new BN(0),
	baseAssetAmountShort: new BN(0),
	quoteAssetAmount: new BN(0),
	terminalQuoteAssetReserve: new BN(0),
	feePool: {
		scaledBalance: new BN(0),
		marketIndex: 0,
	},
	totalExchangeFee: new BN(0),
	totalMmFee: new BN(0),
	netRevenueSinceLastFunding: new BN(0),
	lastUpdateSlot: new BN(0),
	lastOracleValid: true,
	lastBidPriceTwap: new BN(0),
	lastAskPriceTwap: new BN(0),
	longSpread: 0,
	shortSpread: 0,
	maxSpread: 0,
	ammJitIntensity: 0,
	maxBaseAssetReserve: new BN(0),
	minBaseAssetReserve: new BN(0),
	totalSocialLoss: new BN(0),
	baseAssetAmountPerLp: new BN(0),
	quoteAssetAmountPerLp: new BN(0),
	targetBaseAssetAmountPerLp: 0,

	quoteBreakEvenAmountLong: new BN(0),
	quoteBreakEvenAmountShort: new BN(0),
	quoteEntryAmountLong: new BN(0),
	quoteEntryAmountShort: new BN(0),

	markStd: new BN(0),
	oracleStd: new BN(0),
	longIntensityCount: 0,
	longIntensityVolume: new BN(0),
	shortIntensityCount: 0,
	shortIntensityVolume: new BN(0),
	volume24H: new BN(0),
	minOrderSize: new BN(0),
	maxPositionSize: new BN(0),

	bidBaseAssetReserve: new BN(0),
	bidQuoteAssetReserve: new BN(0),
	askBaseAssetReserve: new BN(0),
	askQuoteAssetReserve: new BN(0),

	netUnsettledFundingPnl: new BN(0),
	quoteAssetAmountWithUnsettledLp: new BN(0),
	referencePriceOffset: 0,
};

export const mockPerpMarkets: Array<PerpMarketAccount> = [
	{
		status: MarketStatus.INITIALIZED,
		name: [],
		contractType: ContractType.PERPETUAL,
		contractTier: ContractTier.A,
		expiryTs: new BN(0),
		expiryPrice: new BN(0),
		marketIndex: 0,
		pubkey: PublicKey.default,
		amm: mockAMM,
		numberOfUsersWithBase: 0,
		numberOfUsers: 0,
		marginRatioInitial: 2000,
		marginRatioMaintenance: 1000,
		highLeverageMarginRatioInitial: 0,
		highLeverageMarginRatioMaintenance: 0,
		nextFillRecordId: new BN(0),
		pnlPool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		ifLiquidationFee: 0,
		liquidatorFee: 0,
		imfFactor: 0,
		nextFundingRateRecordId: new BN(0),
		nextCurveRecordId: new BN(0),
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
		pausedOperations: 0,
		fuelBoostPosition: 0,
		fuelBoostMaker: 0,
		fuelBoostTaker: 0,
	},
	{
		status: MarketStatus.INITIALIZED,
		contractTier: ContractTier.A,
		nextFundingRateRecordId: new BN(0),
		nextCurveRecordId: new BN(0),
		name: [],
		contractType: ContractType.PERPETUAL,
		expiryTs: new BN(0),
		expiryPrice: new BN(0),
		marketIndex: 1,
		pubkey: PublicKey.default,
		amm: mockAMM,
		numberOfUsersWithBase: 0,
		numberOfUsers: 0,
		marginRatioInitial: 0,
		marginRatioMaintenance: 0,
		highLeverageMarginRatioInitial: 0,
		highLeverageMarginRatioMaintenance: 0,
		nextFillRecordId: new BN(0),
		pnlPool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		ifLiquidationFee: 0,
		liquidatorFee: 0,
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
		pausedOperations: 0,
		fuelBoostPosition: 0,
		fuelBoostMaker: 0,
		fuelBoostTaker: 0,
	},
	{
		status: MarketStatus.INITIALIZED,
		contractTier: ContractTier.A,
		nextFundingRateRecordId: new BN(0),
		nextCurveRecordId: new BN(0),
		name: [],
		contractType: ContractType.PERPETUAL,
		expiryTs: new BN(0),
		expiryPrice: new BN(0),
		marketIndex: 2,
		pubkey: PublicKey.default,
		amm: mockAMM,
		numberOfUsersWithBase: 0,
		numberOfUsers: 0,
		marginRatioInitial: 0,
		marginRatioMaintenance: 0,
		highLeverageMarginRatioInitial: 0,
		highLeverageMarginRatioMaintenance: 0,
		nextFillRecordId: new BN(0),
		pnlPool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		ifLiquidationFee: 0,
		liquidatorFee: 0,
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
		pausedOperations: 0,
		fuelBoostPosition: 0,
		fuelBoostMaker: 0,
		fuelBoostTaker: 0,
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
			totalFactor: 0,
			userFactor: 0,
		},
		ifLiquidationFee: 0,
		liquidatorFee: 0,
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
		orderStepSize: new BN(0),
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
		oracleSource: OracleSource.PYTH,
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
		fuelBoostDeposits: 0,
		fuelBoostBorrows: 0,
		fuelBoostTaker: 0,
		fuelBoostMaker: 0,
		fuelBoostInsurance: 0,
		tokenProgram: 0,
		poolId: 0,
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
			totalFactor: 0,
			userFactor: 0,
		},
		ifLiquidationFee: 0,
		liquidatorFee: 0,
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
		orderStepSize: new BN(0),
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
		oracleSource: OracleSource.PYTH,
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
		fuelBoostDeposits: 0,
		fuelBoostBorrows: 0,
		fuelBoostTaker: 0,
		fuelBoostMaker: 0,
		fuelBoostInsurance: 0,
		tokenProgram: 0,
		poolId: 0,
	},
	{
		status: MarketStatus.ACTIVE,
		assetTier: AssetTier.PROTECTED,
		name: [],
		maxTokenDeposits: new BN(100),
		marketIndex: 2,
		pubkey: PublicKey.default,
		mint: DevnetSpotMarkets[2].mint,
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
			totalFactor: 0,
			userFactor: 0,
		},
		ifLiquidationFee: 0,
		liquidatorFee: 0,
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
		orderStepSize: new BN(0),
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
		oracleSource: OracleSource.PYTH,
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
		fuelBoostDeposits: 0,
		fuelBoostBorrows: 0,
		fuelBoostTaker: 0,
		fuelBoostMaker: 0,
		fuelBoostInsurance: 0,
		tokenProgram: 0,
		poolId: 0,
	},
];

export const mockStateAccount: StateAccount = {
	admin: PublicKey.default,
	defaultMarketOrderTimeInForce: 0,
	defaultSpotAuctionDuration: 0,
	discountMint: PublicKey.default,
	exchangeStatus: 0,
	liquidationMarginBufferRatio: 0,
	lpCooldownTime: new BN(0),
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
			rewardNumerator: new BN(0),
			rewardDenominator: new BN(0),
			timeBasedRewardLowerBound: new BN(0),
		},
		flatFillerFee: new BN(0),
		referrerRewardEpochUpperBound: new BN(0),
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
			rewardNumerator: new BN(0),
			rewardDenominator: new BN(0),
			timeBasedRewardLowerBound: new BN(0),
		},
		flatFillerFee: new BN(0),
		referrerRewardEpochUpperBound: new BN(0),
	},
	srmVault: PublicKey.default,
	whitelistMint: PublicKey.default,
	maxNumberOfSubAccounts: 0,
	maxInitializeUserFee: 0,
};

export class MockUserMap implements UserMapInterface {
	private userMap = new Map<string, User>();
	private userAccountToAuthority = new Map<string, string>();
	private driftClient: DriftClient;

	constructor() {
		this.userMap = new Map();
		this.userAccountToAuthority = new Map();
		this.driftClient = new DriftClient({
			connection: new Connection('http://localhost:8899'),
			wallet: new Wallet(new Keypair()),
			programID: PublicKey.default,
		});
	}

	public async subscribe(): Promise<void> {}

	public async unsubscribe(): Promise<void> {}

	public async addPubkey(userAccountPublicKey: PublicKey): Promise<void> {
		const user = new User({
			driftClient: this.driftClient,
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
			driftClient: this.driftClient,
			userAccountPublicKey: PublicKey.default,
		});
	}

	public async mustGetWithSlot(_key: string): Promise<DataAndSlot<User>> {
		return {
			data: new User({
				driftClient: this.driftClient,
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
