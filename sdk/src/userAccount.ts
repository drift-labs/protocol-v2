import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	AMM_MANTISSA,
	ClearingHouse,
	QUOTE_BASE_PRECISION_DIFF,
} from './clearingHouse';
import { UserAccountData, UserPosition, UserPositionData } from './types';
import {
	ZERO,
	TEN_THOUSAND,
	BN_MAX,
	PARTIAL_LIQUIDATION_RATIO,
	FULL_LIQUIDATION_RATIO,
} from './constants/numericConstants';
import { PositionDirection } from '.';

interface UserAccountEvents {
	userAccountData: (payload: UserAccountData) => void;
	userPositionsData: (payload: UserPositionData) => void;
	update: void;
}

export class UserAccount {
	clearingHouse: ClearingHouse;
	userPublicKey: PublicKey;
	userAccountPublicKey?: PublicKey;
	userAccountData?: UserAccountData;
	userPositionsAccount?: UserPositionData;
	isSubscribed = false;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;

	public constructor(clearingHouse: ClearingHouse, userPublicKey: PublicKey) {
		this.clearingHouse = clearingHouse;
		this.userPublicKey = userPublicKey;

		this.eventEmitter = new EventEmitter();
	}

	public async subscribe(): Promise<boolean> {
		try {
			if (this.isSubscribed) {
				return;
			}

			await this.clearingHouse.subscribe();

			const userAccountPublicKey = await this.getPublicKey();

			// get current user account data
			const currentUserAccount = await this.clearingHouse.getUserAccountData(
				userAccountPublicKey
			);

			this.userAccountData = currentUserAccount;

			//get current positions data
			const currentUserPositionsAccount =
				await this.clearingHouse.getPositionsAccountData(
					this.userAccountData.positions
				);

			this.userPositionsAccount = currentUserPositionsAccount;

			// now that data is initialized, safe to use methods, set isSubscribed true
			this.isSubscribed = true;

			// callback with latest account data
			this.eventEmitter.emit('userAccountData', currentUserAccount);
			this.eventEmitter.emit('update');

			// callback with latest positions data
			this.eventEmitter.emit('userPositionsData', currentUserPositionsAccount);
			this.eventEmitter.emit('update');

			// set up subscriber for account data
			this.clearingHouse
				.getUserAccountClient()
				.subscribe(userAccountPublicKey, this.clearingHouse.opts.commitment)
				.on('change', async (updateData) => {
					this.userAccountData = updateData;

					this.eventEmitter.emit('userAccountData', updateData);
					this.eventEmitter.emit('update');
				});

			// set up subscriber for positions data
			this.clearingHouse
				.getPositionsAccountClient()
				.subscribe(
					this.userAccountData.positions,
					this.clearingHouse.opts.commitment
				)
				.on('change', async (updateData) => {
					this.userPositionsAccount = updateData;

					this.eventEmitter.emit('userPositionsData', updateData);
					this.eventEmitter.emit('update');
				});

			return true;
		} catch (error) {
			console.error(`Caught error trying to subscribe to UserAccount`, error);

			// run unsubscribe so that things are properly cleaned up
			this.unsubscribe(true);

			this.isSubscribed = false;

			return false;
		}
	}

	assertIsSubscribed() {
		if (!this.isSubscribed) {
			throw Error('You must call `subscribe` before using this function');
		}
	}

	public async unsubscribe(keepClearingHouseSubscription?: boolean) {
		this.clearingHouse
			.getUserAccountClient()
			.unsubscribe(await this.getPublicKey());

		this.clearingHouse
			.getPositionsAccountClient()
			.unsubscribe(this.userAccountData.positions);

		if (!keepClearingHouseSubscription) this.clearingHouse.unsubscribe();

		this.isSubscribed = false;
	}

	public async getPublicKey(): Promise<PublicKey> {
		if (this.userAccountPublicKey) {
			return this.userAccountPublicKey;
		}

		this.userAccountPublicKey = (
			await this.clearingHouse.getUserAccountPublicKey(this.userPublicKey)
		)[0];
		return this.userAccountPublicKey;
	}

	public async exists(): Promise<boolean> {
		const userAccountPublicKey = await this.getPublicKey();
		const userAccountRPCResponse =
			await this.clearingHouse.connection.getParsedAccountInfo(
				userAccountPublicKey
			);
		return userAccountRPCResponse.value !== null;
	}

	/**
	 * calculates Buying Power = FC * MAX_LEVERAGE
	 * return precision = 1e6 (USDC_PRECISION)
	 * @returns
	 */
	public getBuyingPower(): BN {
		this.assertIsSubscribed();
		return this.getFreeCollateral()
			.mul(this.getMaxLeverage('Initial'))
			.div(TEN_THOUSAND);
	}

	/**
	 * calculates Free Collateral = (TC - TPV) * MAX_LEVERAGE
	 * return precision = 1e6 (USDC_PRECISION)
	 * @returns
	 */
	public getFreeCollateral(): BN {
		this.assertIsSubscribed();
		return this.getTotalCollateral().sub(
			this.getTotalPositionValue()
				.mul(TEN_THOUSAND)
				.div(this.getMaxLeverage('Initial'))
		);
	}

	/**
	 * calculates unrealized position price pnl
	 * return precision = 1e6 (USDC_PRECISION)
	 * @returns
	 */
	public getUnrealizedPNL(withFunding?: boolean): BN {
		this.assertIsSubscribed();
		return this.userPositionsAccount.positions.reduce((pnl, marketPosition) => {
			return pnl.add(
				this.clearingHouse.calculatePositionPNL(marketPosition, withFunding)
			);
		}, ZERO);
	}

	/**
	 * calculates unrealized funding payment pnl
	 * return precision = 1e6 (USDC_PRECISION)
	 * @returns
	 */
	public getUnrealizedFundingPNL(): BN {
		this.assertIsSubscribed();
		return this.userPositionsAccount.positions.reduce((pnl, marketPosition) => {
			return pnl.add(
				this.clearingHouse.calculatePositionFundingPNL(marketPosition)
			);
		}, ZERO);
	}

	/**
	 * calculates TotalCollateral: collateral + unrealized pnl
	 * return precision = 1e6 (USDC_PRECISION)
	 * @returns
	 */
	public getTotalCollateral(): BN {
		this.assertIsSubscribed();

		return (
			this.userAccountData?.collateral.add(this.getUnrealizedPNL(true)) ??
			new BN(0)
		);
	}

	/**
	 * calculates sum of position value across all positions
	 * return precision = 1e10 (AMM_MANTISSA)
	 * @returns
	 */
	getTotalPositionValue(): BN {
		this.assertIsSubscribed();
		return this.userPositionsAccount.positions
			.reduce((positionValue, marketPosition) => {
				return positionValue.add(
					this.clearingHouse.calculateBaseAssetValue(marketPosition)
				);
			}, ZERO)
			.div(AMM_MANTISSA);
	}

	/**
	 * calculates position value from closing 100%
	 * return precision = 1e10 (AMM_MANTISSA)
	 * @returns
	 */
	public getPositionValue(positionIndex: number): BN {
		return this.clearingHouse
			.calculateBaseAssetValue(
				this.userPositionsAccount.positions[positionIndex]
			)
			.div(AMM_MANTISSA);
	}

	/**
	 * calculates average exit price for closing 100% of position
	 * return precision = 1e10 (AMM_MANTISSA)
	 * @returns
	 */
	public getPositionEstimatedExitPriceWithMantissa(position: UserPosition): BN {
		const baseAssetValue = this.clearingHouse.calculateBaseAssetValue(position);
		if (position.baseAssetAmount.eq(ZERO)) {
			return ZERO;
		}
		return baseAssetValue
			.mul(QUOTE_BASE_PRECISION_DIFF)
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
		const chState = this.clearingHouse.getState();
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
		this.assertIsSubscribed();
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
		for (const userPosition of this.userPositionsAccount.positions) {
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
	 * return precision = 1e10 (AMM_MANTISSA)
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

		const currentPrice = this.clearingHouse.calculateBaseAssetPriceWithMantissa(
			targetMarket.marketIndex
		);

		const totalCollateralUSDC = this.getTotalCollateral();

		// calculate the total position value ignoring any value from the target market of the trade
		const totalCurrentPositionValueIgnoringTargetUSDC =
			this.getTotalPositionValueExcludingMarket(targetMarket.marketIndex);

		const currentMarketPosition = this.userPositionsAccount?.positions?.find(
			(position) => position.marketIndex.eq(targetMarket.marketIndex)
		);

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

		const proposedMarketPositionValueUSDC = this.clearingHouse
			.calculateBaseAssetValue(proposedMarketPosition)
			.div(AMM_MANTISSA);

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
		const marketProportion = proposedMarketPositionValueUSDC
			.mul(TEN_THOUSAND)
			.div(targetTotalPositionValueUSDC);

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

		let liqPrice = new BN(-1);

		// if the user is long, then the liq price is the currentPrice multiplied by liqRatio/marginRatio (how many multiples lower does the current marginRatio have to go to reach the liqRatio), multiplied by the fraction of the proposed total position value that this market will take up
		if (!baseAssetSignIsNeg) {
			liqPrice = currentPrice
				.mul(liqRatio)
				.div(marginRatio)
				.mul(marketProportion)
				.div(TEN_THOUSAND);
		} else {
			// if the user is short, it's the reciprocal of the above
			liqPrice = currentPrice
				.mul(marginRatio)
				.div(liqRatio)
				.mul(TEN_THOUSAND)
				.div(marketProportion);
		}

		return liqPrice;
	}

	/**
	 * Calculates the estimated liquidation price for a position after closing a quote amount of the position.
	 * return precision = 1e10 (AMM_MANTISSA)
	 * @param positionMarketIndex
	 * @param closeQuoteAmount
	 * @returns
	 */
	public liquidationPriceAfterClose(
		positionMarketIndex: BN,
		closeQuoteAmount: BN
	): BN {
		const currentPosition = this.userPositionsAccount?.positions.find(
			(position) => position.marketIndex.eq(positionMarketIndex)
		);

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
			const currentPosition = this.getPositionForMarket(targetMarketIndex);

			if (!currentPosition) return ZERO;

			const side = tradeSide === PositionDirection.SHORT ? 'short' : 'long';

			if (side === 'long' && currentPosition?.baseAssetAmount.isNeg()) {
				return currentPosition.quoteAssetAmount;
			} else if (
				side === 'short' &&
				!currentPosition?.baseAssetAmount.isNeg()
			) {
				return currentPosition.quoteAssetAmount;
			}

			return ZERO;
		};

		// get current leverage
		const currentLeverage = this.getLeverage();

		// remaining leverage
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

		// deduct fee
		maxPositionSize = this.maxQuoteAmountAfterFee(maxPositionSize);

		return maxPositionSize;
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
		const currentPosition = this.getPositionForMarket(targetMarketIndex);
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
	 * Gets the user's current position for a given market
	 * @param marketIndex
	 * @returns userPosition
	 */
	private getPositionForMarket(marketIndex: BN): UserPosition {
		return this.userPositionsAccount.positions.find((position) =>
			position.marketIndex.eq(marketIndex)
		);
	}

	/**
	 * Outputs the max. IMPORTANT NOTE: the difference between the previous amount and the new amount isn't the same value as the amount of actual fee taken (you can use the calculateFeeForQuoteAmount method for this), because the fee is taken out prior to leverage.
	 * @param maxQuoteAmount
	 * @returns maxQuoteAfterFee - 10^6
	 */
	private maxQuoteAmountAfterFee(maxQuoteAmount: BN): BN {
		const feeStructure = this.clearingHouse.getState().feeStructure;

		return maxQuoteAmount
			.mul(
				feeStructure.feeDenominator.sub(
					feeStructure.feeNumerator.mul(this.getMaxLeverage().div(TEN_THOUSAND))
				)
			)
			.div(feeStructure.feeDenominator);
	}

	/**
	 * Calculates how much fee will be taken for a given sized trade
	 * @param quoteAmount
	 * @returns feeForQuote : 10^6
	 */
	public calculateFeeForQuoteAmount(quoteAmount: BN): BN {
		const feeStructure = this.clearingHouse.getState().feeStructure;

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
		const currentMarketPosition = this.getPositionForMarket(marketToIgnore);

		const currentMarketPositionValueUSDC = currentMarketPosition
			? this.clearingHouse
					.calculateBaseAssetValue(currentMarketPosition)
					.div(AMM_MANTISSA)
			: ZERO;

		return this.getTotalPositionValue().sub(currentMarketPositionValueUSDC);
	}

	public summary() {
		const marketPosition0 = this.userPositionsAccount.positions[0];
		const pos0PNL = this.clearingHouse.calculatePositionPNL(marketPosition0);
		const pos0Value =
			this.clearingHouse.calculateBaseAssetValue(marketPosition0);

		const pos0Px = this.clearingHouse.calculateBaseAssetPriceWithMantissa(
			marketPosition0.marketIndex
		);

		return {
			totalCollateral: this.getTotalCollateral(),
			uPnL: this.getUnrealizedPNL(),
			marginRatio: this.getMarginRatio(),
			freeCollateral: this.getFreeCollateral(),
			leverage: this.getLeverage(),
			buyingPower: this.getBuyingPower(),
			tPV: this.getTotalPositionValue(),

			pos0BAmt: marketPosition0.baseAssetAmount,
			pos0QAmt: marketPosition0.quoteAssetAmount,
			pos0Market: marketPosition0.marketIndex,
			pos0LiqPrice: this.liquidationPrice(marketPosition0),
			pos0Value: pos0Value,
			pos0Px: pos0Px,
			pos0PNL: pos0PNL,
		};
	}
}
