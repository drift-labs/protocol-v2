import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import { ClearingHouse } from './clearingHouse';
import { UserAccount, UserPosition, UserPositionsAccount } from './types';
import {
	MARK_PRICE_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	ZERO,
	TEN_THOUSAND,
	BN_MAX,
	PARTIAL_LIQUIDATION_RATIO,
	FULL_LIQUIDATION_RATIO,
	QUOTE_PRECISION,
} from './constants/numericConstants';
import { UserAccountSubscriber, UserAccountEvents } from './accounts/types';
import { DefaultUserAccountSubscriber } from './accounts/defaultUserAccountSubscriber';
import {
	calculateMarkPrice,
	calculateBaseAssetValue,
	calculatePositionFundingPNL,
	calculatePositionPNL,
	PositionDirection,
} from '.';
import { getUserAccountPublicKey } from './addresses';

export class ClearingHouseUser {
	clearingHouse: ClearingHouse;
	authority: PublicKey;
	accountSubscriber: UserAccountSubscriber;
	userAccountPublicKey?: PublicKey;
	isSubscribed = false;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;

	public static from(
		clearingHouse: ClearingHouse,
		authority: PublicKey
	): ClearingHouseUser {
		const accountSubscriber = new DefaultUserAccountSubscriber(
			clearingHouse.program,
			authority
		);
		return new ClearingHouseUser(clearingHouse, authority, accountSubscriber);
	}

	public constructor(
		clearingHouse: ClearingHouse,
		authority: PublicKey,
		accountSubscriber: UserAccountSubscriber
	) {
		this.clearingHouse = clearingHouse;
		this.authority = authority;
		this.accountSubscriber = accountSubscriber;
		this.eventEmitter = this.accountSubscriber.eventEmitter;
	}

	public async subscribe(): Promise<boolean> {
		// Clearing house should already be subscribed, but await for the subscription to avoid race condition
		await this.clearingHouse.subscribe();

		this.isSubscribed = await this.accountSubscriber.subscribe();
		return this.isSubscribed;
	}

	public async unsubscribe(): Promise<void> {
		await this.accountSubscriber.unsubscribe();
		this.isSubscribed = false;
	}

	public getUserAccount(): UserAccount {
		return this.accountSubscriber.getUserAccount();
	}

	public getUserPositionsAccount(): UserPositionsAccount {
		return this.accountSubscriber.getUserPositionsAccount();
	}

	/**
	 * Gets the user's current position for a given market
	 * @param marketIndex
	 * @returns userPosition
	 */
	public getUserPosition(marketIndex: BN): UserPosition {
		return this.getUserPositionsAccount().positions.find((position) =>
			position.marketIndex.eq(marketIndex)
		);
	}

	public async getUserAccountPublicKey(): Promise<PublicKey> {
		if (this.userAccountPublicKey) {
			return this.userAccountPublicKey;
		}

		this.userAccountPublicKey = await getUserAccountPublicKey(
			this.clearingHouse.program.programId,
			this.authority
		);
		return this.userAccountPublicKey;
	}

	public async exists(): Promise<boolean> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userAccountRPCResponse =
			await this.clearingHouse.connection.getParsedAccountInfo(
				userAccountPublicKey
			);
		return userAccountRPCResponse.value !== null;
	}

	/**
	 * calculates Buying Power = FC * MAX_LEVERAGE
	 * return precision = 1e6 (QUOTE_PRECISION)
	 * @returns
	 */
	public getBuyingPower(): BN {
		return this.getFreeCollateral()
			.mul(this.getMaxLeverage('Initial'))
			.div(TEN_THOUSAND);
	}

	/**
	 * calculates Free Collateral = (TC - TPV) * MAX_LEVERAGE
	 * return precision = 1e6 (QUOTE_PRECISION)
	 * @returns
	 */
	public getFreeCollateral(): BN {
		return this.getTotalCollateral().sub(
			this.getTotalPositionValue()
				.mul(TEN_THOUSAND)
				.div(this.getMaxLeverage('Initial'))
		);
	}

	/**
	 * calculates unrealized position price pnl
	 * return precision = 1e6 (QUOTE_PRECISION)
	 * @returns
	 */
	public getUnrealizedPNL(withFunding?: boolean): BN {
		return this.getUserPositionsAccount().positions.reduce(
			(pnl, marketPosition) => {
				const market = this.clearingHouse.getMarket(marketPosition.marketIndex);
				return pnl.add(
					calculatePositionPNL(market, marketPosition, withFunding)
				);
			},
			ZERO
		);
	}

	/**
	 * calculates unrealized funding payment pnl
	 * return precision = 1e6 (QUOTE_PRECISION)
	 * @returns
	 */
	public getUnrealizedFundingPNL(): BN {
		return this.getUserPositionsAccount().positions.reduce(
			(pnl, marketPosition) => {
				const market = this.clearingHouse.getMarket(marketPosition.marketIndex);
				return pnl.add(calculatePositionFundingPNL(market, marketPosition));
			},
			ZERO
		);
	}

	/**
	 * calculates TotalCollateral: collateral + unrealized pnl
	 * return precision = 1e6 (QUOTE_PRECISION)
	 * @returns
	 */
	public getTotalCollateral(): BN {
		return (
			this.getUserAccount().collateral.add(this.getUnrealizedPNL(true)) ??
			new BN(0)
		);
	}

	/**
	 * calculates sum of position value across all positions
	 * return precision = 1e6 (QUOTE_PRECISION)
	 * @returns
	 */
	getTotalPositionValue(): BN {
		return this.getUserPositionsAccount().positions.reduce(
			(positionValue, marketPosition) => {
				const market = this.clearingHouse.getMarket(marketPosition.marketIndex);
				return positionValue.add(
					calculateBaseAssetValue(market, marketPosition)
				);
			},
			ZERO
		);
	}

	/**
	 * calculates position value from closing 100%
	 * return precision = 1e6 (QUOTE_PRECISION)
	 * @returns
	 */
	public getPositionValue(marketIndex: BN): BN {
		const userPosition = this.getUserPosition(marketIndex);
		const market = this.clearingHouse.getMarket(userPosition.marketIndex);
		return calculateBaseAssetValue(market, userPosition);
	}

	public getPositionSide(currentPosition: Pick<UserPosition, 'baseAssetAmount'>): PositionDirection | undefined {
		if(currentPosition.baseAssetAmount.gt(ZERO)){
			return PositionDirection.LONG;
		} else if (currentPosition.baseAssetAmount.lt(ZERO)) {
			return PositionDirection.SHORT;
		} else {
			return undefined;
		}
	}

	/**
	 * calculates average exit price for closing 100% of position
	 * return precision = 1e10 (MARK_PRICE_PRECISION)
	 * @returns
	 */
	public getPositionEstimatedExitPrice(position: UserPosition): BN {
		const market = this.clearingHouse.getMarket(position.marketIndex);
		const baseAssetValue = calculateBaseAssetValue(market, position);
		if (position.baseAssetAmount.eq(ZERO)) {
			return ZERO;
		}
		return baseAssetValue
			.mul(AMM_TO_QUOTE_PRECISION_RATIO)
			.mul(MARK_PRICE_PRECISION)
			.div(position.baseAssetAmount.abs());
	}

	/**
	 * calculates current user leverage across all positions
	 * return precision = 1e4 (TEN_THOUSAND)
	 * @returns
	 */
	public getLeverage(): BN {
		const totalCollateral = this.getTotalCollateral();
		const totalPositionValue = this.getTotalPositionValue();
		if (totalPositionValue.eq(ZERO) && totalCollateral.eq(ZERO)) {
			return ZERO;
		}
		return totalPositionValue.mul(TEN_THOUSAND).div(totalCollateral);
	}

	/**
	 * calculates max allowable leverage exceeding hitting requirement category
	 * return precision = 1e4 (TEN_THOUSAND)
	 * @params category {Initial, Partial, Maintenance}
	 * @returns
	 */
	public getMaxLeverage(category?: 'Initial' | 'Partial' | 'Maintenance'): BN {
		const chState = this.clearingHouse.getStateAccount();
		let marginRatioCategory: BN;

		switch (category) {
			case 'Initial':
				marginRatioCategory = chState.marginRatioInitial;
				break;
			case 'Maintenance':
				marginRatioCategory = chState.marginRatioMaintenance;
				break;
			case 'Partial':
				marginRatioCategory = chState.marginRatioPartial;
				break;
			default:
				marginRatioCategory = chState.marginRatioInitial;
				break;
		}
		const maxLeverage = TEN_THOUSAND.mul(TEN_THOUSAND).div(marginRatioCategory);
		return maxLeverage;
	}

	/**
	 * calculates margin ratio: total collateral / |total position value|
	 * return precision = 1e4 (TEN_THOUSAND)
	 * @returns
	 */
	public getMarginRatio(): BN {
		const totalPositionValue = this.getTotalPositionValue();

		if (totalPositionValue.eq(ZERO)) {
			return BN_MAX;
		}

		return this.getTotalCollateral().mul(TEN_THOUSAND).div(totalPositionValue);
	}

	public canBeLiquidated(): [boolean, BN] {
		const marginRatio = this.getMarginRatio();
		const canLiquidate = marginRatio.lte(PARTIAL_LIQUIDATION_RATIO);
		return [canLiquidate, marginRatio];
	}

	/**
	 * Checks if any user position cumulative funding differs from respective market cumulative funding
	 * @returns
	 */
	public needsToSettleFundingPayment(): boolean {
		const marketsAccount = this.clearingHouse.getMarketsAccount();
		for (const userPosition of this.getUserPositionsAccount().positions) {
			if (userPosition.baseAssetAmount.eq(ZERO)) {
				continue;
			}

			const market =
				marketsAccount.markets[userPosition.marketIndex.toNumber()];
			if (
				market.amm.cumulativeFundingRateLong.eq(
					userPosition.lastCumulativeFundingRate
				) ||
				market.amm.cumulativeFundingRateShort.eq(
					userPosition.lastCumulativeFundingRate
				)
			) {
				continue;
			}

			return true;
		}
		return false;
	}

	/**
	 * Calculate the liquidation price of a position, with optional parameter to calculate the liquidation price after a trade
	 * return precision = 1e10 (MARK_PRICE_PRECISION)
	 * @param targetMarket
	 * @param positionBaseSizeChange // change in position size to calculate liquidation price for - 10^13
	 * @param partial
	 * @returns
	 */
	public liquidationPrice(
		targetMarket: Pick<UserPosition, 'marketIndex'>,
		positionBaseSizeChange: BN = ZERO,
		partial = false
	): BN {
		// +/-(margin_ratio-liq_ratio) * price_now = price_liq
		// todo: margin_ratio is not symmetric on price action (both numer and denom change)
		// margin_ratio = collateral / base_asset_value

		/* example: assume BTC price is $40k (examine 10% up/down)
		
		if 10k deposit and levered 10x short BTC => BTC up $400 means:
		1. higher base_asset_value (+$4k)
		2. lower collateral (-$4k)
		3. (10k - 4k)/(100k + 4k) => 6k/104k => .0576

		for 10x long, BTC down $400:
		3. (10k - 4k) / (100k - 4k) = 6k/96k => .0625 */

		const currentPrice = calculateMarkPrice(
			this.clearingHouse.getMarket(targetMarket.marketIndex)
		);

		const totalCollateralUSDC = this.getTotalCollateral();

		// calculate the total position value ignoring any value from the target market of the trade
		const totalCurrentPositionValueIgnoringTargetUSDC =
			this.getTotalPositionValueExcludingMarket(targetMarket.marketIndex);

		const currentMarketPosition =
			this.getUserPosition(targetMarket.marketIndex);

		const currentMarketPositionBaseSize = currentMarketPosition
			? currentMarketPosition.baseAssetAmount
			: ZERO;

		// calculate position for current market after trade
		const proposedMarketPosition: UserPosition = {
			marketIndex: targetMarket.marketIndex,
			baseAssetAmount: currentMarketPositionBaseSize.add(
				positionBaseSizeChange
			),
			lastCumulativeFundingRate: new BN(0),
			quoteAssetAmount: new BN(0),
		};

		const market = this.clearingHouse.getMarket(
			proposedMarketPosition.marketIndex
		);

		const proposedMarketPositionValueUSDC = calculateBaseAssetValue(
			market,
			proposedMarketPosition
		);

		// total position value after trade
		const targetTotalPositionValueUSDC =
			totalCurrentPositionValueIgnoringTargetUSDC.add(
				proposedMarketPositionValueUSDC
			);

		// if the position value after the trade is less than total collateral, there is no liq price
		if (targetTotalPositionValueUSDC.lte(totalCollateralUSDC)) {
			return new BN(-1);
		}

		// proportion of proposed market position to overall position
		// const marketProportion = proposedMarketPositionValueUSDC
		// 	.mul(TEN_THOUSAND)
		// 	.div(targetTotalPositionValueUSDC);

		// get current margin ratio based on current collateral and proposed total position value
		let marginRatio;
		if (targetTotalPositionValueUSDC.eq(ZERO)) {
			marginRatio = BN_MAX;
		} else {
			marginRatio = totalCollateralUSDC
				.mul(TEN_THOUSAND)
				.div(targetTotalPositionValueUSDC);
		}

		let liqRatio = FULL_LIQUIDATION_RATIO;
		if (partial) {
			liqRatio = PARTIAL_LIQUIDATION_RATIO;
		}

		// sign of position in current market after the trade
		const baseAssetSignIsNeg = proposedMarketPosition.baseAssetAmount.isNeg();

		// console.log(
		// 	convertToNumber(currentPrice),
		// convertToNumber(liqRatio),
		// convertToNumber(marginRatio),
		// convertToNumber(marketProportion),
		// );

		// // if the user is long, then the liq price is the currentPrice multiplied by liqRatio/marginRatio (how many multiples lower does the current marginRatio have to go to reach the liqRatio), multiplied by the fraction of the proposed total position value that this market will take up
		// if (!baseAssetSignIsNeg) {
		// 	liqPrice = currentPrice
		// 		.mul(liqRatio)
		// 		.div(marginRatio)
		// 		.mul(marketProportion)
		// 		.div(TEN_THOUSAND);
		// } else {
		// 	// if the user is short, it's the reciprocal of the above
		// 	liqPrice = currentPrice
		// 		.mul(marginRatio)
		// 		.div(liqRatio)
		// 		.mul(TEN_THOUSAND)
		// 		.div(marketProportion);
		// }

		let pctChange = marginRatio.abs().sub(liqRatio);
		// if user is short, higher price is liq
		if (baseAssetSignIsNeg) {
			pctChange = pctChange.add(TEN_THOUSAND);
		} else {
			if (TEN_THOUSAND.lte(pctChange)) {
				// no liquidation price, position is a fully/over collateralized long
				// handle as NaN on UI
				return new BN(-1);
			}
			pctChange = TEN_THOUSAND.sub(pctChange);
		}

		const liqPrice = currentPrice.mul(pctChange).div(TEN_THOUSAND);

		return liqPrice;
	}

	/**
	 * Calculates the estimated liquidation price for a position after closing a quote amount of the position.
	 * return precision = 1e10 (MARK_PRICE_PRECISION)
	 * @param positionMarketIndex
	 * @param closeQuoteAmount
	 * @returns
	 */
	public liquidationPriceAfterClose(
		positionMarketIndex: BN,
		closeQuoteAmount: BN
	): BN {
		const currentPosition = this.getUserPosition(positionMarketIndex);

		const closeBaseAmount = currentPosition.baseAssetAmount
			.mul(closeQuoteAmount)
			.div(currentPosition.quoteAssetAmount)
			.add(
				currentPosition.baseAssetAmount
					.mul(closeQuoteAmount)
					.mod(currentPosition.quoteAssetAmount)
			)
			.neg();

		return this.liquidationPrice(
			{
				marketIndex: positionMarketIndex,
			},
			closeBaseAmount
		);
	}

	/**
	 * Get the maximum trade size for a given market, taking into account the user's current leverage, positions, collateral, etc.
	 * @param marketIndex
	 * @param tradeSide
	 * @param userMaxLeverageSetting - leverage 10^4
	 * @returns tradeSizeAllowed - quoteSize 10^6
	 */
	public getMaxTradeSizeUSDC(
		targetMarketIndex: BN,
		tradeSide: PositionDirection,
		userMaxLeverageSetting: BN
	): BN {
		// inline function which get's the current position size on the opposite side of the target trade
		const getOppositePositionValueUSDC = () => {
			if (!currentPosition) return ZERO;

			const side = tradeSide === PositionDirection.SHORT ? 'short' : 'long';

			if (side === 'long' && currentPosition?.baseAssetAmount.isNeg()) {
				return this.getPositionValue(targetMarketIndex);
			} else if (
				side === 'short' &&
				!currentPosition?.baseAssetAmount.isNeg()
			) {
				return this.getPositionValue(targetMarketIndex);
			}

			return ZERO;
		};

		const currentPosition = this.getUserPosition(targetMarketIndex);

		// get current leverage
		const currentLeverage = this.getLeverage();

		// remaining leverage
		// let remainingLeverage = userMaxLeverageSetting;

		const remainingLeverage = BN.max(
				userMaxLeverageSetting.sub(currentLeverage),
				ZERO
			);

		// get total collateral
		const totalCollateral = this.getTotalCollateral();

		// position side allowed based purely on current leverage
		let maxPositionSize = remainingLeverage
			.mul(totalCollateral)
			.div(TEN_THOUSAND);

		// add any position we have on the opposite side of the current trade, because we can "flip" the size of this position without taking any extra leverage.
		const oppositeSizeValueUSDC = getOppositePositionValueUSDC();

		maxPositionSize = maxPositionSize.add(oppositeSizeValueUSDC);

		// subtract oneMillionth of maxPositionSize
		// => to avoid rounding errors when taking max leverage
		const oneMilli = maxPositionSize.div(QUOTE_PRECISION);
		return maxPositionSize.sub(oneMilli);
	}

	// TODO - should this take the price impact of the trade into account for strict accuracy?

	/**
	 * Returns the leverage ratio for the account after adding (or subtracting) the given quote size to the given position
	 * @param targetMarketIndex
	 * @param positionMarketIndex
	 * @param tradeQuoteAmount
	 * @returns leverageRatio 10^4
	 */
	public accountLeverageRatioAfterTrade(
		targetMarketIndex: BN,
		tradeQuoteAmount: BN,
		tradeSide: PositionDirection
	): BN {
		const currentPosition = this.getUserPosition(targetMarketIndex);
		let currentPositionQuoteAmount = currentPosition.quoteAssetAmount;

		const currentSide = currentPosition.baseAssetAmount.isNeg()
			? PositionDirection.SHORT
			: PositionDirection.LONG;

		if (currentSide === PositionDirection.SHORT)
			currentPositionQuoteAmount = currentPositionQuoteAmount.neg();

		if (tradeSide === PositionDirection.SHORT)
			tradeQuoteAmount = tradeQuoteAmount.neg();

		const currentMarketPositionAfterTrade = currentPositionQuoteAmount
			.add(tradeQuoteAmount)
			.abs();

		const totalPositionAfterTradeExcludingTargetMarket =
			this.getTotalPositionValueExcludingMarket(targetMarketIndex);

		return currentMarketPositionAfterTrade
			.add(totalPositionAfterTradeExcludingTargetMarket)
			.abs()
			.mul(TEN_THOUSAND)
			.div(this.getTotalCollateral());
	}

	/**
	 * Calculates how much fee will be taken for a given sized trade
	 * @param quoteAmount
	 * @returns feeForQuote : 10^6
	 */
	public calculateFeeForQuoteAmount(quoteAmount: BN): BN {
		const feeStructure = this.clearingHouse.getStateAccount().feeStructure;

		return quoteAmount
			.mul(feeStructure.feeNumerator)
			.div(feeStructure.feeDenominator);
	}

	/**
	 * Get the total position value, excluding any position coming from the given target market
	 * @param marketToIgnore
	 * @returns positionValue
	 */
	private getTotalPositionValueExcludingMarket(marketToIgnore: BN): BN {
		const currentMarketPosition = this.getUserPosition(marketToIgnore);

		let currentMarketPositionValueUSDC = ZERO;
		if (currentMarketPosition) {
			const market = this.clearingHouse.getMarket(
				currentMarketPosition.marketIndex
			);
			currentMarketPositionValueUSDC = calculateBaseAssetValue(
				market,
				currentMarketPosition
			);
		}

		return this.getTotalPositionValue().sub(currentMarketPositionValueUSDC);
	}
}
