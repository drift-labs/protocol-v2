import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import { ClearingHouse } from './clearingHouse';
import {
	isVariant,
	MarginCategory,
	Order,
	UserAccount,
	UserOrdersAccount,
	UserPosition,
	UserPositionsAccount,
} from './types';
import { calculateEntryPrice } from './math/position';
import {
	MARK_PRICE_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	ZERO,
	TEN_THOUSAND,
	BN_MAX,
	QUOTE_PRECISION,
	AMM_RESERVE_PRECISION,
	PRICE_TO_QUOTE_PRECISION,
	MARGIN_PRECISION,
} from './constants/numericConstants';
import { UserAccountSubscriber, UserAccountEvents } from './accounts/types';
import {
	calculateMarkPrice,
	calculateBaseAssetValue,
	calculatePositionFundingPNL,
	calculatePositionPNL,
	PositionDirection,
	getUserOrdersAccountPublicKey,
	calculateTradeSlippage,
	BN,
} from '.';
import { getUserAccountPublicKey } from './addresses';
import {
	getClearingHouseUser,
	getWebSocketClearingHouseUserConfig,
} from './factory/clearingHouseUser';

export class ClearingHouseUser {
	clearingHouse: ClearingHouse;
	authority: PublicKey;
	accountSubscriber: UserAccountSubscriber;
	userAccountPublicKey?: PublicKey;
	userOrdersAccountPublicKey?: PublicKey;
	_isSubscribed = false;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;

	public get isSubscribed() {
		return this._isSubscribed && this.accountSubscriber.isSubscribed;
	}

	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	/**
	 * @deprecated You should use getClearingHouseUser factory method instead
	 * @param clearingHouse
	 * @param authority
	 * @returns
	 */
	public static from(
		clearingHouse: ClearingHouse,
		authority: PublicKey
	): ClearingHouseUser {
		if (clearingHouse.accountSubscriber.type !== 'websocket')
			throw 'This method only works for clearing houses with a websocket account listener. Try using the getClearingHouseUser factory method to initialize a ClearingHouseUser instead';

		const config = getWebSocketClearingHouseUserConfig(
			clearingHouse,
			authority
		);
		return getClearingHouseUser(config);
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

	/**
	 * Subscribe to ClearingHouseUser state accounts
	 * @returns SusbcriptionSuccess result
	 */
	public async subscribe(): Promise<boolean> {
		// Clearing house should already be subscribed, but await for the subscription just incase to avoid race condition
		await this.clearingHouse.subscribe();

		this.isSubscribed = await this.accountSubscriber.subscribe();
		return this.isSubscribed;
	}

	/**
	 *	Forces the accountSubscriber to fetch account updates from rpc
	 */
	public async fetchAccounts(): Promise<void> {
		await this.accountSubscriber.fetch();
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

	public getUserOrdersAccount(): UserOrdersAccount | undefined {
		return this.accountSubscriber.getUserOrdersAccount();
	}

	/**
	 * Gets the user's current position for a given market. If the user has no position returns undefined
	 * @param marketIndex
	 * @returns userPosition
	 */
	public getUserPosition(marketIndex: BN): UserPosition | undefined {
		return this.getUserPositionsAccount().positions.find((position) =>
			position.marketIndex.eq(marketIndex)
		);
	}

	public getEmptyPosition(marketIndex: BN): UserPosition {
		return {
			baseAssetAmount: ZERO,
			lastCumulativeFundingRate: ZERO,
			marketIndex,
			quoteAssetAmount: ZERO,
			openOrders: ZERO,
		};
	}

	/**
	 * @param orderId
	 * @returns Order
	 */
	public getOrder(orderId: BN): Order | undefined {
		return this.getUserOrdersAccount().orders.find((order) =>
			order.orderId.eq(orderId)
		);
	}

	/**
	 * @param userOrderId
	 * @returns Order
	 */
	public getOrderByUserOrderId(userOrderId: number): Order | undefined {
		return this.getUserOrdersAccount().orders.find(
			(order) => order.userOrderId === userOrderId
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

	public async getUserOrdersAccountPublicKey(): Promise<PublicKey> {
		if (this.userOrdersAccountPublicKey) {
			return this.userOrdersAccountPublicKey;
		}

		this.userOrdersAccountPublicKey = await getUserOrdersAccountPublicKey(
			this.clearingHouse.program.programId,
			await this.getUserAccountPublicKey()
		);
		return this.userOrdersAccountPublicKey;
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
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getBuyingPower(marketIndex: BN | number): BN {
		return this.getFreeCollateral()
			.mul(this.getMaxLeverage(marketIndex, 'Initial'))
			.div(TEN_THOUSAND);
	}

	/**
	 * calculates Free Collateral = Total collateral - initial margin requirement
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getFreeCollateral(): BN {
		const totalCollateral = this.getTotalCollateral();
		const initialMarginRequirement = this.getInitialMarginRequirement();
		const freeCollateral = totalCollateral.sub(initialMarginRequirement);
		return freeCollateral.gte(ZERO) ? freeCollateral : ZERO;
	}

	public getInitialMarginRequirement(): BN {
		return this.getUserPositionsAccount().positions.reduce(
			(marginRequirement, marketPosition) => {
				const market = this.clearingHouse.getMarket(marketPosition.marketIndex);
				return marginRequirement.add(
					calculateBaseAssetValue(market, marketPosition)
						.mul(new BN(market.marginRatioInitial))
						.div(MARGIN_PRECISION)
				);
			},
			ZERO
		);
	}

	/**
	 * @returns The partial margin requirement in USDC. : QUOTE_PRECISION
	 */
	public getPartialMarginRequirement(): BN {
		return this.getUserPositionsAccount().positions.reduce(
			(marginRequirement, marketPosition) => {
				const market = this.clearingHouse.getMarket(marketPosition.marketIndex);
				return marginRequirement.add(
					calculateBaseAssetValue(market, marketPosition)
						.mul(new BN(market.marginRatioPartial))
						.div(MARGIN_PRECISION)
				);
			},
			ZERO
		);
	}

	/**
	 * calculates unrealized position price pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getUnrealizedPNL(withFunding?: boolean, marketIndex?: BN): BN {
		return this.getUserPositionsAccount()
			.positions.filter((pos) =>
				marketIndex ? pos.marketIndex === marketIndex : true
			)
			.reduce((pnl, marketPosition) => {
				const market = this.clearingHouse.getMarket(marketPosition.marketIndex);
				return pnl.add(
					calculatePositionPNL(market, marketPosition, withFunding)
				);
			}, ZERO);
	}

	/**
	 * calculates unrealized funding payment pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getUnrealizedFundingPNL(marketIndex?: BN): BN {
		return this.getUserPositionsAccount()
			.positions.filter((pos) =>
				marketIndex ? pos.marketIndex === marketIndex : true
			)
			.reduce((pnl, marketPosition) => {
				const market = this.clearingHouse.getMarket(marketPosition.marketIndex);
				return pnl.add(calculatePositionFundingPNL(market, marketPosition));
			}, ZERO);
	}

	/**
	 * calculates TotalCollateral: collateral + unrealized pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getTotalCollateral(): BN {
		return (
			this.getUserAccount().collateral.add(this.getUnrealizedPNL(true)) ??
			new BN(0)
		);
	}

	/**
	 * calculates sum of position value across all positions
	 * @returns : Precision QUOTE_PRECISION
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
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getPositionValue(marketIndex: BN): BN {
		const userPosition =
			this.getUserPosition(marketIndex) || this.getEmptyPosition(marketIndex);
		const market = this.clearingHouse.getMarket(userPosition.marketIndex);
		return calculateBaseAssetValue(market, userPosition);
	}

	public getPositionSide(
		currentPosition: Pick<UserPosition, 'baseAssetAmount'>
	): PositionDirection | undefined {
		if (currentPosition.baseAssetAmount.gt(ZERO)) {
			return PositionDirection.LONG;
		} else if (currentPosition.baseAssetAmount.lt(ZERO)) {
			return PositionDirection.SHORT;
		} else {
			return undefined;
		}
	}

	/**
	 * calculates average exit price for closing 100% of position
	 * @returns : Precision MARK_PRICE_PRECISION
	 */
	public getPositionEstimatedExitPriceAndPnl(
		position: UserPosition,
		amountToClose?: BN
	): [BN, BN] {
		const market = this.clearingHouse.getMarket(position.marketIndex);

		const entryPrice = calculateEntryPrice(position);

		if (amountToClose) {
			if (amountToClose.eq(ZERO)) {
				return [calculateMarkPrice(market), ZERO];
			}
			position = {
				baseAssetAmount: amountToClose,
				lastCumulativeFundingRate: position.lastCumulativeFundingRate,
				marketIndex: position.marketIndex,
				quoteAssetAmount: position.quoteAssetAmount,
			} as UserPosition;
		}

		const baseAssetValue = calculateBaseAssetValue(market, position);
		if (position.baseAssetAmount.eq(ZERO)) {
			return [ZERO, ZERO];
		}

		const exitPrice = baseAssetValue
			.mul(AMM_TO_QUOTE_PRECISION_RATIO)
			.mul(MARK_PRICE_PRECISION)
			.div(position.baseAssetAmount.abs());

		const pnlPerBase = exitPrice.sub(entryPrice);
		const pnl = pnlPerBase
			.mul(position.baseAssetAmount)
			.div(MARK_PRICE_PRECISION)
			.div(AMM_TO_QUOTE_PRECISION_RATIO);

		return [exitPrice, pnl];
	}

	/**
	 * calculates current user leverage across all positions
	 * @returns : Precision TEN_THOUSAND
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
	 * @params category {Initial, Partial, Maintenance}
	 * @returns : Precision TEN_THOUSAND
	 */
	public getMaxLeverage(
		marketIndex: BN | number,
		category: MarginCategory = 'Initial'
	): BN {
		const market = this.clearingHouse.getMarket(marketIndex);
		let marginRatioCategory: number;

		switch (category) {
			case 'Initial':
				marginRatioCategory = market.marginRatioInitial;
				break;
			case 'Maintenance':
				marginRatioCategory = market.marginRatioMaintenance;
				break;
			case 'Partial':
				marginRatioCategory = market.marginRatioPartial;
				break;
			default:
				marginRatioCategory = market.marginRatioInitial;
				break;
		}
		const maxLeverage = TEN_THOUSAND.mul(TEN_THOUSAND).div(
			new BN(marginRatioCategory)
		);
		return maxLeverage;
	}

	/**
	 * calculates margin ratio: total collateral / |total position value|
	 * @returns : Precision TEN_THOUSAND
	 */
	public getMarginRatio(): BN {
		const totalPositionValue = this.getTotalPositionValue();

		if (totalPositionValue.eq(ZERO)) {
			return BN_MAX;
		}

		return this.getTotalCollateral().mul(TEN_THOUSAND).div(totalPositionValue);
	}

	public canBeLiquidated(): [boolean, BN] {
		const totalCollateral = this.getTotalCollateral();
		const partialMaintenanceRequirement = this.getPartialMarginRequirement();
		const marginRatio = this.getMarginRatio();
		const canLiquidate = totalCollateral.lt(partialMaintenanceRequirement);
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
	 * @param marketPosition
	 * @param positionBaseSizeChange // change in position size to calculate liquidation price for : Precision 10^13
	 * @param partial
	 * @returns Precision : MARK_PRICE_PRECISION
	 */
	public liquidationPrice(
		marketPosition: Pick<UserPosition, 'marketIndex'>,
		positionBaseSizeChange: BN = ZERO,
		partial = false
	): BN {
		// solves formula for example canBeLiquidated below

		/* example: assume BTC price is $40k (examine 10% up/down)

        if 10k deposit and levered 10x short BTC => BTC up $400 means:
        1. higher base_asset_value (+$4k)
        2. lower collateral (-$4k)
        3. (10k - 4k)/(100k + 4k) => 6k/104k => .0576

        for 10x long, BTC down $400:
        3. (10k - 4k) / (100k - 4k) = 6k/96k => .0625 */

		const totalCollateral = this.getTotalCollateral();

		// calculate the total position value ignoring any value from the target market of the trade
		const totalPositionValueExcludingTargetMarket =
			this.getTotalPositionValueExcludingMarket(marketPosition.marketIndex);

		const currentMarketPosition =
			this.getUserPosition(marketPosition.marketIndex) ||
			this.getEmptyPosition(marketPosition.marketIndex);

		const currentMarketPositionBaseSize = currentMarketPosition.baseAssetAmount;

		const proposedBaseAssetAmount = currentMarketPositionBaseSize.add(
			positionBaseSizeChange
		);

		// calculate position for current market after trade
		const proposedMarketPosition: UserPosition = {
			marketIndex: marketPosition.marketIndex,
			baseAssetAmount: proposedBaseAssetAmount,
			lastCumulativeFundingRate:
				currentMarketPosition.lastCumulativeFundingRate,
			quoteAssetAmount: new BN(0),
			openOrders: new BN(0),
		};

		if (proposedBaseAssetAmount.eq(ZERO)) return new BN(-1);

		const market = this.clearingHouse.getMarket(
			proposedMarketPosition.marketIndex
		);

		const proposedMarketPositionValue = calculateBaseAssetValue(
			market,
			proposedMarketPosition
		);

		// total position value after trade
		const totalPositionValueAfterTrade =
			totalPositionValueExcludingTargetMarket.add(proposedMarketPositionValue);

		const marginRequirementExcludingTargetMarket =
			this.getUserPositionsAccount().positions.reduce(
				(totalMarginRequirement, position) => {
					if (!position.marketIndex.eq(marketPosition.marketIndex)) {
						const market = this.clearingHouse.getMarket(position.marketIndex);
						const positionValue = calculateBaseAssetValue(market, position);
						const marketMarginRequirement = positionValue
							.mul(
								partial
									? new BN(market.marginRatioPartial)
									: new BN(market.marginRatioMaintenance)
							)
							.div(MARGIN_PRECISION);
						totalMarginRequirement = totalMarginRequirement.add(
							marketMarginRequirement
						);
					}
					return totalMarginRequirement;
				},
				ZERO
			);

		const freeCollateralExcludingTargetMarket = totalCollateral.sub(
			marginRequirementExcludingTargetMarket
		);

		// if the position value after the trade is less than free collateral, there is no liq price
		if (
			totalPositionValueAfterTrade.lte(freeCollateralExcludingTargetMarket) &&
			proposedMarketPosition.baseAssetAmount.abs().gt(ZERO)
		) {
			return new BN(-1);
		}

		const marginRequirementAfterTrade =
			marginRequirementExcludingTargetMarket.add(
				proposedMarketPositionValue
					.mul(
						partial
							? new BN(market.marginRatioPartial)
							: new BN(market.marginRatioMaintenance)
					)
					.div(MARGIN_PRECISION)
			);
		const freeCollateralAfterTrade = totalCollateral.sub(
			marginRequirementAfterTrade
		);

		const marketMaxLeverage = partial
			? this.getMaxLeverage(proposedMarketPosition.marketIndex, 'Partial')
			: this.getMaxLeverage(proposedMarketPosition.marketIndex, 'Maintenance');

		let priceDelta;
		if (proposedBaseAssetAmount.lt(ZERO)) {
			priceDelta = freeCollateralAfterTrade
				.mul(marketMaxLeverage) // precision is TEN_THOUSAND
				.div(marketMaxLeverage.add(TEN_THOUSAND))
				.mul(PRICE_TO_QUOTE_PRECISION)
				.mul(AMM_RESERVE_PRECISION)
				.div(proposedBaseAssetAmount);
		} else {
			priceDelta = freeCollateralAfterTrade
				.mul(marketMaxLeverage) // precision is TEN_THOUSAND
				.div(marketMaxLeverage.sub(TEN_THOUSAND))
				.mul(PRICE_TO_QUOTE_PRECISION)
				.mul(AMM_RESERVE_PRECISION)
				.div(proposedBaseAssetAmount);
		}

		let markPriceAfterTrade;
		if (positionBaseSizeChange.eq(ZERO)) {
			markPriceAfterTrade = calculateMarkPrice(
				this.clearingHouse.getMarket(marketPosition.marketIndex)
			);
		} else {
			const direction = positionBaseSizeChange.gt(ZERO)
				? PositionDirection.LONG
				: PositionDirection.SHORT;
			markPriceAfterTrade = calculateTradeSlippage(
				direction,
				positionBaseSizeChange.abs(),
				this.clearingHouse.getMarket(marketPosition.marketIndex),
				'base'
			)[3]; // newPrice after swap
		}

		if (priceDelta.gt(markPriceAfterTrade)) {
			return new BN(-1);
		}

		return markPriceAfterTrade.sub(priceDelta);
	}

	/**
	 * Calculates the estimated liquidation price for a position after closing a quote amount of the position.
	 * @param positionMarketIndex
	 * @param closeQuoteAmount
	 * @returns : Precision MARK_PRICE_PRECISION
	 */
	public liquidationPriceAfterClose(
		positionMarketIndex: BN,
		closeQuoteAmount: BN
	): BN {
		const currentPosition =
			this.getUserPosition(positionMarketIndex) ||
			this.getEmptyPosition(positionMarketIndex);

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
	 *
	 * To Calculate Max Quote Available:
	 *
	 * Case 1: SameSide
	 * 	=> Remaining quote to get to maxLeverage
	 *
	 * Case 2: NOT SameSide && currentLeverage <= maxLeverage
	 * 	=> Current opposite position x2 + remaining to get to maxLeverage
	 *
	 * Case 3: NOT SameSide && currentLeverage > maxLeverage && otherPositions - currentPosition > maxLeverage
	 * 	=> strictly reduce current position size
	 *
	 * Case 4: NOT SameSide && currentLeverage > maxLeverage && otherPositions - currentPosition < maxLeverage
	 * 	=> current position + remaining to get to maxLeverage
	 *
	 * @param targetMarketIndex
	 * @param tradeSide
	 * @returns tradeSizeAllowed : Precision QUOTE_PRECISION
	 */
	public getMaxTradeSizeUSDC(
		targetMarketIndex: BN,
		tradeSide: PositionDirection
	): BN {
		const currentPosition =
			this.getUserPosition(targetMarketIndex) ||
			this.getEmptyPosition(targetMarketIndex);

		const targetSide = isVariant(tradeSide, 'short') ? 'short' : 'long';

		const currentPositionSide = currentPosition?.baseAssetAmount.isNeg()
			? 'short'
			: 'long';

		const targetingSameSide = !currentPosition
			? true
			: targetSide === currentPositionSide;

		// add any position we have on the opposite side of the current trade, because we can "flip" the size of this position without taking any extra leverage.
		const oppositeSizeValueUSDC = targetingSameSide
			? ZERO
			: this.getPositionValue(targetMarketIndex);

		let maxPositionSize = this.getBuyingPower(targetMarketIndex);
		if (maxPositionSize.gte(ZERO)) {
			if (oppositeSizeValueUSDC.eq(ZERO)) {
				// case 1 : Regular trade where current total position less than max, and no opposite position to account for
				// do nothing
			} else {
				// case 2 : trade where current total position less than max, but need to account for flipping the current position over to the other side
				maxPositionSize = maxPositionSize.add(
					oppositeSizeValueUSDC.mul(new BN(2))
				);
			}
		} else {
			// current leverage is greater than max leverage - can only reduce position size

			if (!targetingSameSide) {
				const market = this.clearingHouse.getMarket(targetMarketIndex);
				const marketPositionValue = this.getPositionValue(targetMarketIndex);
				const totalCollateral = this.getTotalCollateral();
				const marginRequirement = this.getInitialMarginRequirement();
				const marginFreedByClosing = marketPositionValue
					.mul(new BN(market.marginRatioInitial))
					.div(MARGIN_PRECISION);
				const marginRequirementAfterClosing =
					marginRequirement.sub(marginFreedByClosing);

				if (marginRequirementAfterClosing.gt(totalCollateral)) {
					maxPositionSize = marketPositionValue;
				} else {
					const freeCollateralAfterClose = totalCollateral.sub(
						marginRequirementAfterClosing
					);
					const buyingPowerAfterClose = freeCollateralAfterClose
						.mul(this.getMaxLeverage(targetMarketIndex))
						.div(TEN_THOUSAND);
					maxPositionSize = marketPositionValue.add(buyingPowerAfterClose);
				}
			} else {
				// do nothing if targetting same side
			}
		}

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
	 * @returns leverageRatio : Precision TEN_THOUSAND
	 */
	public accountLeverageRatioAfterTrade(
		targetMarketIndex: BN,
		tradeQuoteAmount: BN,
		tradeSide: PositionDirection
	): BN {
		const currentPosition =
			this.getUserPosition(targetMarketIndex) ||
			this.getEmptyPosition(targetMarketIndex);

		let currentPositionQuoteAmount = this.getPositionValue(targetMarketIndex);

		const currentSide =
			currentPosition && currentPosition.baseAssetAmount.isNeg()
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

		const totalCollateral = this.getTotalCollateral();
		if (totalCollateral.gt(ZERO)) {
			const newLeverage = currentMarketPositionAfterTrade
				.add(totalPositionAfterTradeExcludingTargetMarket)
				.abs()
				.mul(TEN_THOUSAND)
				.div(totalCollateral);
			return newLeverage;
		} else {
			return new BN(0);
		}
	}

	/**
	 * Calculates how much fee will be taken for a given sized trade
	 * @param quoteAmount
	 * @returns feeForQuote : Precision QUOTE_PRECISION
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
	 * @returns positionValue : Precision QUOTE_PRECISION
	 */
	private getTotalPositionValueExcludingMarket(marketToIgnore: BN): BN {
		const currentMarketPosition =
			this.getUserPosition(marketToIgnore) ||
			this.getEmptyPosition(marketToIgnore);

		let currentMarketPositionValueUSDC = ZERO;
		if (currentMarketPosition) {
			currentMarketPositionValueUSDC = this.getPositionValue(marketToIgnore);
		}

		return this.getTotalPositionValue().sub(currentMarketPositionValueUSDC);
	}
}
