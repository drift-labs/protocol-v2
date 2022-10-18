import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	AMM,
	AssetTier,
	PerpPosition,
	BN,
	ClearingHouse,
	ClearingHouseUser,
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
} from '../../src';
import { ExchangeStatus } from '../../lib';

export const mockPerpPosition: PerpPosition = {
	baseAssetAmount: new BN(0),
	lastCumulativeFundingRate: new BN(0),
	marketIndex: 0,
	quoteAssetAmount: new BN(0),
	quoteEntryAmount: new BN(0),
	openOrders: 0,
	openBids: new BN(0),
	openAsks: new BN(0),
	settledPnl: new BN(0),
	lpShares: new BN(0),
	remainderBaseAssetAmount: 0,
	lastNetBaseAssetAmountPerLp: new BN(0),
	lastNetQuoteAssetAmountPerLp: new BN(0),
};

export const mockAMM: AMM = {
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
	lastMarkPriceTwap5min: new BN(0),
	lastMarkPriceTwapTs: new BN(0),
	historicalOracleData: {
		lastOraclePrice: new BN(0),
		lastOracleConf: new BN(0),
		lastOracleDelay: new BN(0),
		lastOraclePriceTwap: new BN(0),
		lastOraclePriceTwap5min: new BN(0),
		lastOraclePriceTwapTs: new BN(0),
	},
	lastOracleReservePriceSpreadPct: new BN(0),
	lastOracleConfPct: new BN(0),
	oracle: PublicKey.default,
	oracleSource: OracleSource.PYTH,
	fundingPeriod: new BN(0),
	cumulativeFundingRateLong: new BN(0),
	cumulativeFundingRateShort: new BN(0),
	cumulativeFundingRateLp: new BN(0),
	totalFeeMinusDistributions: new BN(0),
	totalFeeWithdrawn: new BN(0),
	totalFee: new BN(0),
	cumulativeFundingPaymentPerLp: new BN(0),
	cumulativeFeePerLp: new BN(0),
	cumulativeNetBaseAssetAmountPerLp: new BN(0),
	userLpShares: new BN(0),
	baseAssetAmountWithUnsettledLp: new BN(0),
	orderStepSize: new BN(0),
	orderTickSize: new BN(1),
	maxFillReserveFraction: 0,
	baseSpread: 0,
	curveUpdateIntensity: 0,
	baseAssetAmountWithAmm: new BN(0),
	baseAssetAmountLong: new BN(0),
	baseAssetAmountShort: new BN(0),
	quoteAssetAmountLong: new BN(0),
	quoteAssetAmountShort: new BN(0),
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
	longSpread: new BN(0),
	shortSpread: new BN(0),
	maxSpread: 0,
	ammJitIntensity: 0,
	maxBaseAssetReserve: new BN(0),
	minBaseAssetReserve: new BN(0),
	cumulativeSocialLoss: new BN(0),
	baseAssetAmountPerLp: new BN(0),
	quoteAssetAmountPerLp: new BN(0),
};

export const mockPerpMarkets: Array<PerpMarketAccount> = [
	{
		status: MarketStatus.INITIALIZED,
		name: [],
		contractType: ContractType.PERPETUAL,
		expiryTs: new BN(0),
		expiryPrice: new BN(0),
		marketIndex: 0,
		pubkey: PublicKey.default,
		amm: mockAMM,
		numberOfUsers: new BN(0),
		marginRatioInitial: 0,
		marginRatioMaintenance: 0,
		nextFillRecordId: new BN(0),
		pnlPool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		ifLiquidationFee: new BN(0),
		liquidatorFee: new BN(0),
		imfFactor: new BN(0),
		unrealizedPnlImfFactor: new BN(0),
		unrealizedPnlMaxImbalance: new BN(0),
		unrealizedPnlInitialAssetWeight: 0,
		unrealizedPnlMaintenanceAssetWeight: 0,
		insuranceClaim: {
			revenueWithdrawSinceLastSettle: new BN(0),
			maxRevenueWithdrawPerPeriod: new BN(0),
			lastRevenueWithdrawTs: new BN(0),
			quoteSettledInsurance: new BN(0),
			quoteMaxInsurance: new BN(0),
		},
	},
	{
		status: MarketStatus.INITIALIZED,
		name: [],
		contractType: ContractType.PERPETUAL,
		expiryTs: new BN(0),
		expiryPrice: new BN(0),
		marketIndex: 1,
		pubkey: PublicKey.default,
		amm: mockAMM,
		numberOfUsers: new BN(0),
		marginRatioInitial: 0,
		marginRatioMaintenance: 0,
		nextFillRecordId: new BN(0),
		pnlPool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		ifLiquidationFee: new BN(0),
		liquidatorFee: new BN(0),
		imfFactor: new BN(0),
		unrealizedPnlImfFactor: new BN(0),
		unrealizedPnlMaxImbalance: new BN(0),
		unrealizedPnlInitialAssetWeight: 0,
		unrealizedPnlMaintenanceAssetWeight: 0,
		insuranceClaim: {
			revenueWithdrawSinceLastSettle: new BN(0),
			maxRevenueWithdrawPerPeriod: new BN(0),
			lastRevenueWithdrawTs: new BN(0),
			quoteSettledInsurance: new BN(0),
			quoteMaxInsurance: new BN(0),
		},
	},
	{
		status: MarketStatus.INITIALIZED,
		name: [],
		contractType: ContractType.PERPETUAL,
		expiryTs: new BN(0),
		expiryPrice: new BN(0),
		marketIndex: 2,
		pubkey: PublicKey.default,
		amm: mockAMM,
		numberOfUsers: new BN(0),
		marginRatioInitial: 0,
		marginRatioMaintenance: 0,
		nextFillRecordId: new BN(0),
		pnlPool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		ifLiquidationFee: new BN(0),
		liquidatorFee: new BN(0),
		imfFactor: new BN(0),
		unrealizedPnlImfFactor: new BN(0),
		unrealizedPnlMaxImbalance: new BN(0),
		unrealizedPnlInitialAssetWeight: 0,
		unrealizedPnlMaintenanceAssetWeight: 0,
		insuranceClaim: {
			revenueWithdrawSinceLastSettle: new BN(0),
			maxRevenueWithdrawPerPeriod: new BN(0),
			lastRevenueWithdrawTs: new BN(0),
			quoteSettledInsurance: new BN(0),
			quoteMaxInsurance: new BN(0),
		},
	},
];

export const mockSpotMarkets: Array<SpotMarketAccount> = [
	{
		status: MarketStatus.ACTIVE,
		assetTier: AssetTier.COLLATERAL,
		maxTokenDeposits: new BN(100),
		marketIndex: 0,
		pubkey: PublicKey.default,
		mint: DevnetSpotMarkets[0].mint,
		vault: PublicKey.default,
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
		ifLiquidationFee: new BN(0),
		liquidatorFee: new BN(0),
		decimals: 6,
		optimalUtilization: 0,
		optimalBorrowRate: 0,
		maxBorrowRate: 0,
		cumulativeDepositInterest: new BN(0),
		cumulativeBorrowInterest: new BN(0),
		depositBalance: new BN(0),
		borrowBalance: new BN(0),
		lastInterestTs: new BN(0),
		lastTwapTs: new BN(0),
		oracle: PublicKey.default,
		initialAssetWeight: new BN(0),
		maintenanceAssetWeight: new BN(0),
		initialLiabilityWeight: new BN(0),
		maintenanceLiabilityWeight: new BN(0),
		imfFactor: new BN(0),
		withdrawGuardThreshold: new BN(0),
		depositTokenTwap: new BN(0),
		borrowTokenTwap: new BN(0),
		utilizationTwap: new BN(0),
		orderStepSize: new BN(0),
		orderTickSize: new BN(0),
		nextFillRecordId: new BN(0),
		spotFeePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		totalSpotFee: new BN(0),
		oracleSource: OracleSource.PYTH,
		historicalOracleData: {
			lastOraclePrice: new BN(0),
			lastOracleConf: new BN(0),
			lastOracleDelay: new BN(0),
			lastOraclePriceTwap: new BN(0),
			lastOraclePriceTwap5min: new BN(0),
			lastOraclePriceTwapTs: new BN(0),
		},
		historicalIndexData: {
			lastIndexBidPrice: new BN(0),
			lastIndexAskPrice: new BN(0),
			lastIndexPriceTwap: new BN(0),
			lastIndexPriceTwap5Min: new BN(0),
			lastIndexPriceTwapTs: new BN(0),
		},
	},
	{
		status: MarketStatus.ACTIVE,
		assetTier: AssetTier.CROSS,
		maxTokenDeposits: new BN(100),
		marketIndex: 1,
		pubkey: PublicKey.default,
		mint: DevnetSpotMarkets[1].mint,
		vault: PublicKey.default,
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
		ifLiquidationFee: new BN(0),
		liquidatorFee: new BN(0),
		decimals: 9,
		optimalUtilization: 0,
		optimalBorrowRate: 0,
		maxBorrowRate: 0,
		cumulativeDepositInterest: new BN(0),
		cumulativeBorrowInterest: new BN(0),
		depositBalance: new BN(0),
		borrowBalance: new BN(0),
		lastInterestTs: new BN(0),
		lastTwapTs: new BN(0),
		oracle: PublicKey.default,
		initialAssetWeight: new BN(0),
		maintenanceAssetWeight: new BN(0),
		initialLiabilityWeight: new BN(0),
		maintenanceLiabilityWeight: new BN(0),
		imfFactor: new BN(0),
		withdrawGuardThreshold: new BN(0),
		depositTokenTwap: new BN(0),
		borrowTokenTwap: new BN(0),
		utilizationTwap: new BN(0),
		orderStepSize: new BN(0),
		orderTickSize: new BN(0),
		nextFillRecordId: new BN(0),
		spotFeePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		totalSpotFee: new BN(0),
		oracleSource: OracleSource.PYTH,
		historicalOracleData: {
			lastOraclePrice: new BN(0),
			lastOracleConf: new BN(0),
			lastOracleDelay: new BN(0),
			lastOraclePriceTwap: new BN(0),
			lastOraclePriceTwap5min: new BN(0),
			lastOraclePriceTwapTs: new BN(0),
		},
		historicalIndexData: {
			lastIndexBidPrice: new BN(0),
			lastIndexAskPrice: new BN(0),
			lastIndexPriceTwap: new BN(0),
			lastIndexPriceTwap5Min: new BN(0),
			lastIndexPriceTwapTs: new BN(0),
		},
	},
	{
		status: MarketStatus.ACTIVE,
		assetTier: AssetTier.PROTECTED,
		maxTokenDeposits: new BN(100),
		marketIndex: 2,
		pubkey: PublicKey.default,
		mint: DevnetSpotMarkets[2].mint,
		vault: PublicKey.default,
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
		ifLiquidationFee: new BN(0),
		liquidatorFee: new BN(0),
		decimals: 6,
		optimalUtilization: 0,
		optimalBorrowRate: 0,
		maxBorrowRate: 0,
		cumulativeDepositInterest: new BN(0),
		cumulativeBorrowInterest: new BN(0),
		depositBalance: new BN(0),
		borrowBalance: new BN(0),
		lastInterestTs: new BN(0),
		lastTwapTs: new BN(0),
		oracle: PublicKey.default,
		initialAssetWeight: new BN(0),
		maintenanceAssetWeight: new BN(0),
		initialLiabilityWeight: new BN(0),
		maintenanceLiabilityWeight: new BN(0),
		imfFactor: new BN(0),
		withdrawGuardThreshold: new BN(0),
		depositTokenTwap: new BN(0),
		borrowTokenTwap: new BN(0),
		utilizationTwap: new BN(0),
		orderStepSize: new BN(0),
		orderTickSize: new BN(0),
		nextFillRecordId: new BN(0),
		spotFeePool: {
			scaledBalance: new BN(0),
			marketIndex: 0,
		},
		totalSpotFee: new BN(0),
		oracleSource: OracleSource.PYTH,
		historicalOracleData: {
			lastOraclePrice: new BN(0),
			lastOracleConf: new BN(0),
			lastOracleDelay: new BN(0),
			lastOraclePriceTwap: new BN(0),
			lastOraclePriceTwap5min: new BN(0),
			lastOraclePriceTwapTs: new BN(0),
		},
		historicalIndexData: {
			lastIndexBidPrice: new BN(0),
			lastIndexAskPrice: new BN(0),
			lastIndexPriceTwap: new BN(0),
			lastIndexPriceTwap5Min: new BN(0),
			lastIndexPriceTwapTs: new BN(0),
		},
	},
];

export const mockStateAccount: StateAccount = {
	admin: PublicKey.default,
	defaultMarketOrderTimeInForce: 0,
	defaultSpotAuctionDuration: 0,
	discountMint: PublicKey.default,
	exchangeStatus: ExchangeStatus.ACTIVE,
	liquidationMarginBufferRatio: 0,
	lpCooldownTime: new BN(0),
	minPerpAuctionDuration: 0,
	numberOfMarkets: 0,
	numberOfSpotMarkets: 0,
	oracleGuardRails: {
		priceDivergence: {
			markOracleDivergenceNumerator: new BN(0),
			markOracleDivergenceDenominator: new BN(0),
		},
		validity: {
			slotsBeforeStaleForAmm: new BN(0),
			slotsBeforeStaleForMargin: new BN(0),
			confidenceIntervalMaxSize: new BN(0),
			tooVolatileRatio: new BN(0),
		},
		useForLiquidations: true,
	},
	perpFeeStructure: {
		feeTiers: [
			{
				feeNumerator: 0,
				feeDenominator: 0,
				makerRebateNumerator: 0,
				makerRebateDenominator: 0,
				referrerRewardNumerator: 0,
				referrerRewardDenominator: 0,
				refereeFeeNumerator: 0,
				refereeFeeDenominator: 0,
			},
		],
		makerRebateNumerator: new BN(0),
		makerRebateDenominator: new BN(0),
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
				makerRebateDenominator: 0,
				referrerRewardNumerator: 0,
				referrerRewardDenominator: 0,
				refereeFeeNumerator: 0,
				refereeFeeDenominator: 0,
			},
		],
		makerRebateNumerator: new BN(0),
		makerRebateDenominator: new BN(0),
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
};

// export const mockUserMap = new UserMap(
// 	new ClearingHouse({
// 		connection: new Connection('http://localhost:8899'),
// 		wallet: new Wallet(new Keypair()),
// 		programID: PublicKey.default,
// 	}),
// 	{
// 		type: 'websocket',
// 	}
// );

export class MockUserMap implements UserMapInterface {
	private userMap = new Map<string, ClearingHouseUser>();
	private userAccountToAuthority = new Map<string, string>();
	private clearingHouse: ClearingHouse;

	constructor() {
		this.userMap = new Map();
		this.userAccountToAuthority = new Map();
		this.clearingHouse = new ClearingHouse({
			connection: new Connection('http://localhost:8899'),
			wallet: new Wallet(new Keypair()),
			programID: PublicKey.default,
		});
	}

	public async fetchAllUsers(): Promise<void> {}

	public async addPubkey(userAccountPublicKey: PublicKey): Promise<void> {
		const user = new ClearingHouseUser({
			clearingHouse: this.clearingHouse,
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

	public get(_key: string): ClearingHouseUser | undefined {
		return undefined;
	}

	public async mustGet(_key: string): Promise<ClearingHouseUser> {
		return new ClearingHouseUser({
			clearingHouse: this.clearingHouse,
			userAccountPublicKey: PublicKey.default,
		});
	}

	public getUserAuthority(key: string): PublicKey | undefined {
		return new PublicKey(
			this.userAccountToAuthority.get(key) || PublicKey.default.toBase58()
		);
	}

	public async updateWithOrderRecord(_record: OrderRecord): Promise<void> {}

	public values(): IterableIterator<ClearingHouseUser> {
		return this.userMap.values();
	}
}
