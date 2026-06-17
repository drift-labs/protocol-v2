export interface LiquidationStats {
	'24h': { count: string; amount: string };
	'30d': { count: string; amount: string };
}

export interface BankruptcyStats {
	totalAmount: string;
	ifPayment: string;
	socialLoss: string;
	totalCount: string;
}

export interface Vault {
	pubkey: string;
	manager: string;
	tokenAccount: string;
	userStats: string;
	user: string;
	delegate: string;
	liquidationDelegate: string;
	userShares: number;
	totalShares: number;
	sharesBase: number;
	lastFeeUpdateTs: number;
	liquidationStartTs: number;
	redeemPeriod: number;
	initTs: number;
	totalWithdrawRequested: number;
	maxTokens: number;
	netDeposits: number;
	totalDeposits: number;
	totalWithdraws: number;
	managerNetDeposits: number;
	managerTotalDeposits: number;
	managerTotalWithdraws: number;
	managerTotalFee: number;
	managerTotalProfitShare: number;
	lastManagerWithdrawRequest: {
		shares: number;
		value: number;
		ts: number;
	};
	minDepositAmount: number;
	profitShare: number;
	managementFee: number;
	hurdleRate: number;
	spotMarketIndex: number;
	permissioned: boolean;
}

export enum RateHistoryType {
	DEPOSIT = 'deposit',
	BORROW = 'borrow',
	DEPOSIT_BALANCE = 'deposit_balance',
	BORROW_BALANCE = 'borrow_balance',
}
export type Rates = [number, string][];

export interface AuctionLatencyStats {
	marketType: string;
	marketIndex: string;
	market: string;
	cohort: FillCohort;
	takerOrderType: FillTakerOrderType;
	takerOrderDirection: FillDirection;
	bitFlag: FillBitFlag;
	auctionProgressCount: string;
	auctionProgressMin: string;
	auctionProgressMax: string;
	auctionProgressAvg: string;
	auctionProgressP10: string;
	auctionProgressP25: string;
	auctionProgressP50: string;
	auctionProgressP75: string;
	auctionProgressP99: string;
	fillVsOracleAbsMin: string;
	fillVsOracleAbsMax: string;
	fillVsOracleAbsAvg: string;
	fillVsOracleAbsP10: string;
	fillVsOracleAbsP25: string;
	fillVsOracleAbsP50: string;
	fillVsOracleAbsP75: string;
	fillVsOracleAbsP99: string;
	fillVsOracleAbsBpsMin: string;
	fillVsOracleAbsBpsMax: string;
	fillVsOracleAbsBpsAvg: string;
	fillVsOracleAbsBpsP10: string;
	fillVsOracleAbsBpsP25: string;
	fillVsOracleAbsBpsP50: string;
	fillVsOracleAbsBpsP75: string;
	fillVsOracleAbsBpsP99: string;
}

export interface TriggerOrderFillStats {
	marketType: string;
	marketIndex: string;
	market: string;
	orderType: 'triggerMarket' | 'triggerLimit' | 'all';
	cohort: string;
	slotsToFillP10: string;
	slotsToFillP25: string;
	slotsToFillP50: string;
	slotsToFillP75: string;
	slotsToFillP99: string;
	slotsToFillMax: string;
	slotsToFillAvg: string;

	fillVsTriggerMin: string;
	fillVsTriggerMax: string;
	fillVsTriggerAvg: string;
	fillVsTriggerP10: string;
	fillVsTriggerP25: string;
	fillVsTriggerP50: string;
	fillVsTriggerP75: string;
	fillVsTriggerP99: string;

	triggerMarketCount: string;
	triggerLimitCount: string;
	totalTriggeredOrders: string;

	reduceOnlyCount: string;
	nonReduceOnlyCount: string;
}

export type FillActionExplanation =
	| 'orderFilledWithAmm'
	| 'orderFilledWithAmmJit'
	| 'orderFilledWithMatch'
	| 'orderFilledWithMatchJit'
	| 'orderFilledWithAmmJitLpSplit'
	| 'orderFilledWithLpJit'
	| 'orderFillWithSerum'
	| 'orderFillWithPhoenix';
export type FillBitFlag = '' | 'all' | '0' | '1';
export type FillTakerOrderType =
	| ''
	| 'all'
	| 'market'
	| 'limit'
	| 'triggerMarket'
	| 'triggerLimit'
	| 'oracle';
export type FillCohort = '' | 'all' | '0' | '1000' | '10000' | '100000' | '500000' | '1000000';
export type FillDirection = 'all' | 'long' | 'short';

export interface FillLiquiditySourceStats {
	marketType: string;
	marketIndex: string;
	market: string;
	cohort: FillCohort;
	takerOrderType: FillTakerOrderType;
	bitFlag: FillBitFlag;
	totalMatch?: string;
	totalMatchJit?: string;
	totalAmm?: string;
	totalAmmJit?: string;
	totalAmmJitLpSplit?: string;
	totalLpJit?: string;
	totalSerum?: string;
	totalPhoenix?: string;
	countMatch?: string;
	countMatchJit?: string;
	countAmm?: string;
	countAmmJit?: string;
	countAmmJitLpSplit?: string;
	countLpJit?: string;
	countSerum?: string;
	countPhoenix?: string;
}

export interface LeaderboardEntry {
	authority: string;
	volume: number;
	pnl: number;
	rank: number;
}

export interface UserStats {
	volume: number;
	pnl: number;
}

export interface UserRankResult {
	volume: number | null;
	pnl: number | null;
	rank: {
		pnl: number | null;
		volume: number | null;
	};
}

export enum LeaderboardSort {
	PNL = 'pnl',
	VOLUME = 'volume',
}

export enum VolumeInterval {
	ONE_HOUR = '1h',
	TWENTY_FOUR_HOUR = '24h',
	THIRTY_DAYS = '30d',
}

export interface VolumeData {
	symbol: string;
	quoteVolume: string;
	baseVolume: string;
	marketIndex: number;
	marketType: string;
}

export interface MarketInfo {
	symbol: string;
	marketIndex: number;
	marketType: string;
}

export enum UiStatus {
	VISIBLE = 'visible',
	HIDDEN = 'hidden',
	SCHEDULED_TO_HIDE = 'scheduled_to_hide',
}

export interface MarketData {
	symbol: string;
	marketIndex: number;
	marketType: string;
	uiStatus?: UiStatus;
	uiHideAtTs?: number;
	openInterest?: {
		long: string;
		short: string;
	};
	fundingRate?: {
		long: string;
		short: string;
	};
	fundingRateUpdateTs?: number;
	fundingRate24h?: string;
	priceChange24h?: string | null;
	priceChange24hPercent?: string | null;
	priceHigh?: {
		oracle: string;
		fill: string;
	};
	priceLow?: {
		oracle: string;
		fill: string;
	};
	deposits?: string;
	borrows?: string;
	status?: string;
	baseAsset?: string;
	quoteAsset?: string;
	precision?: number;
	limits?: {
		amount?: {
			min?: number;
			max?: number;
		};
		leverage?: {
			min?: number;
			max?: number;
		};
		withdraw?: {
			min?: number;
			max?: number;
		};
		deposit?: {
			min?: number;
			max?: number;
		};
	};
	name?: string;
	fees?: {
		maker: number;
		taker: number;
	};
}

export interface PricingData {
	symbol: string;
	marketIndex: number;
	marketType: string;
	oraclePrice: string;
	price: string;
	markPrice?: string;
}

export type MarketSummary = MarketData & VolumeData & PricingData;

export interface FundingRateStats {
	marketIndex: number;
	symbol: string;
	fundingRates: {
		'24h': string;
		'7d': string;
		'30d': string;
		'1y': string;
	};
}

export interface InsuranceFundStats {
	totalRevenue: string;
	perpLiqsTotal: string;
	spotLiqsTotal: string;
	marketSharePriceData: {
		marketIndex: number;
		symbol: string;
		apy: string;
	}[];
}
