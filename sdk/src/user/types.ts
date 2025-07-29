import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	HealthComponent,
	HealthComponents,
	MarginCategory,
	Order,
	PerpPosition,
	SpotPosition,
	UserAccount,
	UserStatus,
	MarketType,
	PositionDirection,
	SpotMarketAccount,
	PerpMarketAccount,
	FeeTier,
} from '../types';
import {
	DataAndSlot,
	UserAccountEvents,
	UserAccountSubscriber,
} from '../accounts/types';
import { BN } from '@coral-xyz/anchor';
import { OraclePriceData } from '../oracles/types';
import { StrictOraclePrice } from '../oracles/strictOraclePrice';
import { IUserStats } from '../userStats/types';

export interface IUser {
	userAccountPublicKey: PublicKey;
	accountSubscriber: UserAccountSubscriber;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	isSubscribed: boolean;

	/**
	 * Subscribe to User state accounts
	 * @returns SusbcriptionSuccess result
	 */
	subscribe(userAccount?: UserAccount): Promise<boolean>;

	/**
	 *	Forces the accountSubscriber to fetch account updates from rpc
	 */
	fetchAccounts(): Promise<void>;

	unsubscribe(): Promise<void>;

	getUserAccount(): UserAccount;

	forceGetUserAccount(): Promise<UserAccount>;

	getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined;

	getPerpPositionForUserAccount(
		userAccount: UserAccount,
		marketIndex: number
	): PerpPosition | undefined;

	/**
	 * Gets the user's current position for a given perp market. If the user has no position returns undefined
	 * @param marketIndex
	 * @returns userPerpPosition
	 */
	getPerpPosition(marketIndex: number): PerpPosition | undefined;

	getPerpPositionAndSlot(
		marketIndex: number
	): DataAndSlot<PerpPosition | undefined>;

	getSpotPositionForUserAccount(
		userAccount: UserAccount,
		marketIndex: number
	): SpotPosition | undefined;

	/**
	 * Gets the user's current position for a given spot market. If the user has no position returns undefined
	 * @param marketIndex
	 * @returns userSpotPosition
	 */
	getSpotPosition(marketIndex: number): SpotPosition | undefined;

	getSpotPositionAndSlot(
		marketIndex: number
	): DataAndSlot<SpotPosition | undefined>;

	getEmptySpotPosition(marketIndex: number): SpotPosition;

	/**
	 * Returns the token amount for a given market. The spot market precision is based on the token mint decimals.
	 * Positive if it is a deposit, negative if it is a borrow.
	 *
	 * @param marketIndex
	 */
	getTokenAmount(marketIndex: number): BN;

	getEmptyPosition(marketIndex: number): PerpPosition;

	getClonedPosition(position: PerpPosition): PerpPosition;

	getOrderForUserAccount(
		userAccount: UserAccount,
		orderId: number
	): Order | undefined;

	/**
	 * @param orderId
	 * @returns Order
	 */
	getOrder(orderId: number): Order | undefined;

	getOrderAndSlot(orderId: number): DataAndSlot<Order | undefined>;

	getOrderByUserIdForUserAccount(
		userAccount: UserAccount,
		userOrderId: number
	): Order | undefined;

	/**
	 * @param userOrderId
	 * @returns Order
	 */
	getOrderByUserOrderId(userOrderId: number): Order | undefined;

	getOrderByUserOrderIdAndSlot(
		userOrderId: number
	): DataAndSlot<Order | undefined>;

	getOpenOrdersForUserAccount(userAccount?: UserAccount): Order[];

	getOpenOrders(): Order[];

	getOpenOrdersAndSlot(): DataAndSlot<Order[]>;

	getUserAccountPublicKey(): PublicKey;

	exists(): Promise<boolean>;

	/**
	 * calculates the total open bids/asks in a perp market (including lps)
	 * @returns : open bids
	 * @returns : open asks
	 */
	getPerpBidAsks(marketIndex: number): [BN, BN];

	/**
	 * calculates the open bids and asks for an lp
	 * optionally pass in lpShares to see what bid/asks a user *would* take on
	 * @returns : lp open bids
	 * @returns : lp open asks
	 */
	getLPBidAsks(marketIndex: number, lpShares?: BN): [BN, BN];

	/**
	 * calculates the market position if the lp position was settled
	 * @returns : the settled userPosition
	 * @returns : the dust base asset amount (ie, < stepsize)
	 * @returns : pnl from settle
	 */
	getPerpPositionWithLPSettle(
		marketIndex: number,
		originalPosition?: PerpPosition,
		burnLpShares?: boolean,
		includeRemainderInBaseAmount?: boolean
	): [PerpPosition, BN, BN];

	/**
	 * calculates Buying Power = free collateral / initial margin ratio
	 * @returns : Precision QUOTE_PRECISION
	 */
	getPerpBuyingPower(
		marketIndex: number,
		collateralBuffer?: BN,
		enterHighLeverageMode?: boolean
	): BN;

	getPerpBuyingPowerFromFreeCollateralAndBaseAssetAmount(
		marketIndex: number,
		freeCollateral: BN,
		baseAssetAmount: BN,
		enterHighLeverageMode?: boolean
	): BN;

	/**
	 * calculates Free Collateral = Total collateral - margin requirement
	 * @returns : Precision QUOTE_PRECISION
	 */
	getFreeCollateral(
		marginCategory?: MarginCategory,
		enterHighLeverageMode?: boolean
	): BN;

	/**
	 * @returns The margin requirement of a certain type (Initial or Maintenance) in USDC. : QUOTE_PRECISION
	 */
	getMarginRequirement(
		marginCategory: MarginCategory,
		liquidationBuffer?: BN,
		strict?: boolean,
		includeOpenOrders?: boolean,
		enteringHighLeverage?: boolean
	): BN;

	/**
	 * @returns The initial margin requirement in USDC. : QUOTE_PRECISION
	 */
	getInitialMarginRequirement(enterHighLeverageMode?: boolean): BN;

	/**
	 * @returns The maintenance margin requirement in USDC. : QUOTE_PRECISION
	 */
	getMaintenanceMarginRequirement(liquidationBuffer?: BN): BN;

	getActivePerpPositionsForUserAccount(
		userAccount: UserAccount
	): PerpPosition[];

	getActivePerpPositions(): PerpPosition[];

	getActivePerpPositionsAndSlot(): DataAndSlot<PerpPosition[]>;

	getActiveSpotPositionsForUserAccount(
		userAccount: UserAccount
	): SpotPosition[];

	getActiveSpotPositions(): SpotPosition[];

	getActiveSpotPositionsAndSlot(): DataAndSlot<SpotPosition[]>;

	/**
	 * calculates unrealized position price pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	getUnrealizedPNL(
		withFunding?: boolean,
		marketIndex?: number,
		withWeightMarginCategory?: MarginCategory,
		strict?: boolean,
		liquidationBuffer?: BN
	): BN;

	/**
	 * calculates unrealized funding payment pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	getUnrealizedFundingPNL(marketIndex?: number): BN;

	getFuelBonus(
		now: BN,
		includeSettled?: boolean,
		includeUnsettled?: boolean,
		givenUserStats?: IUserStats
	): {
		depositFuel: BN;
		borrowFuel: BN;
		positionFuel: BN;
		takerFuel: BN;
		makerFuel: BN;
		insuranceFuel: BN;
	};

	getSpotMarketAssetAndLiabilityValue(
		marketIndex?: number,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict?: boolean,
		now?: BN
	): { totalAssetValue: BN; totalLiabilityValue: BN };

	getSpotMarketLiabilityValue(
		marketIndex?: number,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict?: boolean,
		now?: BN
	): BN;

	getSpotLiabilityValue(
		tokenAmount: BN,
		strictOraclePrice: StrictOraclePrice,
		spotMarketAccount: SpotMarketAccount,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN
	): BN;

	getSpotMarketAssetValue(
		marketIndex?: number,
		marginCategory?: MarginCategory,
		includeOpenOrders?: boolean,
		strict?: boolean,
		now?: BN
	): BN;

	getSpotAssetValue(
		tokenAmount: BN,
		strictOraclePrice: StrictOraclePrice,
		spotMarketAccount: SpotMarketAccount,
		marginCategory?: MarginCategory
	): BN;

	getSpotPositionValue(
		marketIndex: number,
		marginCategory?: MarginCategory,
		includeOpenOrders?: boolean,
		strict?: boolean,
		now?: BN
	): BN;

	getNetSpotMarketValue(withWeightMarginCategory?: MarginCategory): BN;

	/**
	 * calculates TotalCollateral: collateral + unrealized pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	getTotalCollateral(
		marginCategory?: MarginCategory,
		strict?: boolean,
		includeOpenOrders?: boolean,
		liquidationBuffer?: BN
	): BN;

	getLiquidationBuffer(): BN | undefined;

	/**
	 * calculates User Health by comparing total collateral and maint. margin requirement
	 * @returns : number (value from [0, 100])
	 */
	getHealth(): number;

	calculateWeightedPerpPositionLiability(
		perpPosition: PerpPosition,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict?: boolean,
		enteringHighLeverage?: boolean
	): BN;

	/**
	 * calculates position value of a single perp market in margin system
	 * @returns : Precision QUOTE_PRECISION
	 */
	getPerpMarketLiabilityValue(
		marketIndex: number,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict?: boolean
	): BN;

	/**
	 * calculates sum of position value across all positions in margin system
	 * @returns : Precision QUOTE_PRECISION
	 */
	getTotalPerpPositionLiability(
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict?: boolean,
		enteringHighLeverage?: boolean
	): BN;

	/**
	 * calculates position value based on oracle
	 * @returns : Precision QUOTE_PRECISION
	 */
	getPerpPositionValue(
		marketIndex: number,
		oraclePriceData: OraclePriceData,
		includeOpenOrders?: boolean
	): BN;

	/**
	 * calculates position liabiltiy value in margin system
	 * @returns : Precision QUOTE_PRECISION
	 */
	getPerpLiabilityValue(
		marketIndex: number,
		oraclePriceData: OraclePriceData,
		includeOpenOrders?: boolean
	): BN;

	getPositionSide(
		currentPosition: Pick<PerpPosition, 'baseAssetAmount'>
	): PositionDirection | undefined;

	/**
	 * calculates average exit price (optionally for closing up to 100% of position)
	 * @returns : Precision PRICE_PRECISION
	 */
	getPositionEstimatedExitPriceAndPnl(
		position: PerpPosition,
		amountToClose?: BN,
		useAMMClose?: boolean
	): [BN, BN];

	/**
	 * calculates current user leverage which is (total liability size) / (net asset value)
	 * @returns : Precision TEN_THOUSAND
	 */
	getLeverage(includeOpenOrders?: boolean): BN;

	calculateLeverageFromComponents({
		perpLiabilityValue,
		perpPnl,
		spotAssetValue,
		spotLiabilityValue,
	}: {
		perpLiabilityValue: BN;
		perpPnl: BN;
		spotAssetValue: BN;
		spotLiabilityValue: BN;
	}): BN;

	getLeverageComponents(
		includeOpenOrders?: boolean,
		marginCategory?: MarginCategory
	): {
		perpLiabilityValue: BN;
		perpPnl: BN;
		spotAssetValue: BN;
		spotLiabilityValue: BN;
	};

	isDustDepositPosition(spotMarketAccount: SpotMarketAccount): boolean;

	getSpotMarketAccountsWithDustPosition(): SpotMarketAccount[];

	getTotalLiabilityValue(marginCategory?: MarginCategory): BN;

	getTotalAssetValue(marginCategory?: MarginCategory): BN;

	getNetUsdValue(): BN;

	/**
	 * Calculates the all time P&L of the user.
	 *
	 * Net withdraws + Net spot market value + Net unrealized P&L -
	 */
	getTotalAllTimePnl(): BN;

	/**
	 * calculates max allowable leverage exceeding hitting requirement category
	 * for large sizes where imf factor activates, result is a lower bound
	 * @param marginCategory {Initial, Maintenance}
	 * @param isLp if calculating max leveraging for adding lp, need to add buffer
	 * @param enterHighLeverageMode can pass this as true to calculate max leverage if the user was to enter high leverage mode
	 * @returns : Precision TEN_THOUSAND
	 */
	getMaxLeverageForPerp(
		perpMarketIndex: number,
		_marginCategory?: MarginCategory,
		isLp?: boolean,
		enterHighLeverageMode?: boolean
	): BN;

	/**
	 * calculates max allowable leverage exceeding hitting requirement category
	 * @param spotMarketIndex
	 * @param direction
	 * @returns : Precision TEN_THOUSAND
	 */
	getMaxLeverageForSpot(
		spotMarketIndex: number,
		direction: PositionDirection
	): BN;

	/**
	 * calculates margin ratio: 1 / leverage
	 * @returns : Precision TEN_THOUSAND
	 */
	getMarginRatio(): BN;

	canBeLiquidated(): {
		canBeLiquidated: boolean;
		marginRequirement: BN;
		totalCollateral: BN;
	};

	isBeingLiquidated(): boolean;

	hasStatus(status: UserStatus): boolean;

	isBankrupt(): boolean;

	isHighLeverageMode(marginCategory: MarginCategory): boolean;

	/**
	 * Checks if any user position cumulative funding differs from respective market cumulative funding
	 * @returns
	 */
	needsToSettleFundingPayment(): boolean;

	/**
	 * Calculate the liquidation price of a spot position
	 * @param marketIndex
	 * @returns Precision : PRICE_PRECISION
	 */
	spotLiquidationPrice(marketIndex: number, positionBaseSizeChange?: BN): BN;

	/**
	 * Calculate the liquidation price of a perp position, with optional parameter to calculate the liquidation price after a trade
	 * @param marketIndex
	 * @param positionBaseSizeChange // change in position size to calculate liquidation price for : Precision 10^9
	 * @param estimatedEntryPrice
	 * @param marginCategory // allow Initial to be passed in if we are trying to calculate price for DLP de-risking
	 * @param includeOpenOrders
	 * @param offsetCollateral // allows calculating the liquidation price after this offset collateral is added to the user's account (e.g. : what will the liquidation price be for this position AFTER I deposit $x worth of collateral)
	 * @returns Precision : PRICE_PRECISION
	 */
	liquidationPrice(
		marketIndex: number,
		positionBaseSizeChange?: BN,
		estimatedEntryPrice?: BN,
		marginCategory?: MarginCategory,
		includeOpenOrders?: boolean,
		offsetCollateral?: BN,
		enteringHighLeverage?: boolean
	): BN;

	calculateEntriesEffectOnFreeCollateral(
		market: PerpMarketAccount,
		oraclePrice: BN,
		perpPosition: PerpPosition,
		positionBaseSizeChange: BN,
		estimatedEntryPrice: BN,
		includeOpenOrders: boolean,
		enteringHighLeverage?: boolean,
		marginCategory?: MarginCategory
	): BN;

	calculateFreeCollateralDeltaForPerp(
		market: PerpMarketAccount,
		perpPosition: PerpPosition,
		positionBaseSizeChange: BN,
		oraclePrice: BN,
		marginCategory?: MarginCategory,
		includeOpenOrders?: boolean,
		enteringHighLeverage?: boolean
	): BN | undefined;

	calculateFreeCollateralDeltaForSpot(
		market: SpotMarketAccount,
		signedTokenAmount: BN,
		marginCategory?: MarginCategory
	): BN;

	/**
	 * Calculates the estimated liquidation price for a position after closing a quote amount of the position.
	 * @param positionMarketIndex
	 * @param closeQuoteAmount
	 * @returns : Precision PRICE_PRECISION
	 */
	liquidationPriceAfterClose(
		positionMarketIndex: number,
		closeQuoteAmount: BN,
		estimatedEntryPrice?: BN
	): BN;

	getMarginUSDCRequiredForTrade(
		targetMarketIndex: number,
		baseSize: BN,
		estEntryPrice?: BN
	): BN;

	getCollateralDepositRequiredForTrade(
		targetMarketIndex: number,
		baseSize: BN,
		collateralIndex: number
	): BN;

	/**
	 * Separates the max trade size into two parts:
	 * - tradeSize: The maximum trade size for target direction
	 * - oppositeSideTradeSize: the trade size for closing the opposite direction
	 * @param targetMarketIndex
	 * @param tradeSide
	 * @param isLp
	 * @returns { tradeSize: BN, oppositeSideTradeSize: BN} : Precision QUOTE_PRECISION
	 */
	getMaxTradeSizeUSDCForPerp(
		targetMarketIndex: number,
		tradeSide: PositionDirection,
		isLp?: boolean,
		enterHighLeverageMode?: boolean
	): { tradeSize: BN; oppositeSideTradeSize: BN };

	/**
	 * Get the maximum trade size for a given market, taking into account the user's current leverage, positions, collateral, etc.
	 *
	 * @param targetMarketIndex
	 * @param direction
	 * @param currentQuoteAssetValue
	 * @param currentSpotMarketNetValue
	 * @returns tradeSizeAllowed : Precision QUOTE_PRECISION
	 */
	getMaxTradeSizeUSDCForSpot(
		targetMarketIndex: number,
		direction: PositionDirection,
		currentQuoteAssetValue?: BN,
		currentSpotMarketNetValue?: BN
	): BN;

	/**
	 * Calculates the max amount of token that can be swapped from inMarket to outMarket
	 * Assumes swap happens at oracle price
	 *
	 * @param inMarketIndex
	 * @param outMarketIndex
	 * @param calculateSwap function to similate in to out swa
	 * @param iterationLimit how long to run appromixation before erroring out
	 */
	getMaxSwapAmount({
		inMarketIndex,
		outMarketIndex,
		calculateSwap,
		iterationLimit,
	}: {
		inMarketIndex: number;
		outMarketIndex: number;
		calculateSwap?: (inAmount: BN) => BN;
		iterationLimit?: number;
	}): { inAmount: BN; outAmount: BN; leverage: BN };

	cloneAndUpdateSpotPosition(
		position: SpotPosition,
		tokenAmount: BN,
		market: SpotMarketAccount
	): SpotPosition;

	calculateSpotPositionFreeCollateralContribution(
		spotPosition: SpotPosition,
		strictOraclePrice: StrictOraclePrice
	): BN;

	calculateSpotPositionLeverageContribution(
		spotPosition: SpotPosition,
		strictOraclePrice: StrictOraclePrice
	): {
		totalAssetValue: BN;
		totalLiabilityValue: BN;
	};

	/**
	 * Estimates what the user leverage will be after swap
	 * @param inMarketIndex
	 * @param outMarketIndex
	 * @param inAmount
	 * @param outAmount
	 */
	accountLeverageAfterSwap({
		inMarketIndex,
		outMarketIndex,
		inAmount,
		outAmount,
	}: {
		inMarketIndex: number;
		outMarketIndex: number;
		inAmount: BN;
		outAmount: BN;
	}): BN;

	/**
	 * Returns the leverage ratio for the account after adding (or subtracting) the given quote size to the given position
	 * @param targetMarketIndex
	 * @param: targetMarketType
	 * @param tradeQuoteAmount
	 * @param tradeSide
	 * @param includeOpenOrders
	 * @returns leverageRatio : Precision TEN_THOUSAND
	 */
	accountLeverageRatioAfterTrade(
		targetMarketIndex: number,
		targetMarketType: MarketType,
		tradeQuoteAmount: BN,
		tradeSide: PositionDirection,
		includeOpenOrders?: boolean
	): BN;

	getUserFeeTier(marketType: MarketType, now?: BN): FeeTier;

	/**
	 * Calculates how much perp fee will be taken for a given sized trade
	 * @param quoteAmount
	 * @returns feeForQuote : Precision QUOTE_PRECISION
	 */
	calculateFeeForQuoteAmount(
		quoteAmount: BN,
		marketIndex?: number,
		enteringHighLeverageMode?: boolean
	): BN;

	/**
	 * Calculates a user's max withdrawal amounts for a spot market. If reduceOnly is true,
	 * it will return the max withdrawal amount without opening a liability for the user
	 * @param marketIndex
	 * @returns withdrawalLimit : Precision is the token precision for the chosen SpotMarket
	 */
	getWithdrawalLimit(marketIndex: number, reduceOnly?: boolean): BN;

	canBypassWithdrawLimits(marketIndex: number): {
		canBypass: boolean;
		netDeposits: BN;
		depositAmount: BN;
		maxDepositAmount: BN;
	};

	canMakeIdle(slot: BN): boolean;

	getSafestTiers(): { perpTier: number; spotTier: number };

	getPerpPositionHealth({
		marginCategory,
		perpPosition,
		oraclePriceData,
		quoteOraclePriceData,
	}: {
		marginCategory: MarginCategory;
		perpPosition: PerpPosition;
		oraclePriceData?: OraclePriceData;
		quoteOraclePriceData?: OraclePriceData;
	}): HealthComponent;

	getHealthComponents({
		marginCategory,
	}: {
		marginCategory: MarginCategory;
	}): HealthComponents;
}
