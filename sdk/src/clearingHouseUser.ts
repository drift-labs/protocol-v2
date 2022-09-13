import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import { ClearingHouse } from './clearingHouse';
import {
	isVariant,
	MarginCategory,
	Order,
	UserAccount,
	PerpPosition,
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
	SPOT_MARKET_WEIGHT_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION_EXP,
} from './constants/numericConstants';
import {
	UserAccountSubscriber,
	UserAccountEvents,
	DataAndSlot,
} from './accounts/types';
import {
	calculateMarkPrice,
	calculateBaseAssetValue,
	calculatePositionFundingPNL,
	calculatePositionPNL,
	calculateUnrealizedAssetWeight,
	calculateMarketMarginRatio,
	PositionDirection,
	calculateTradeSlippage,
	BN,
	SpotMarketAccount,
} from '.';
import {
	getTokenAmount,
	calculateAssetWeight,
	calculateLiabilityWeight,
} from './math/spotBalance';
import {
	calculateBaseAssetValueWithOracle,
	calculateWorstCaseBaseAssetAmount,
} from './math/margin';
import { OraclePriceData } from './oracles/types';
import { ClearingHouseUserConfig } from './clearingHouseUserConfig';
import { PollingUserAccountSubscriber } from './accounts/pollingUserAccountSubscriber';
import { WebSocketUserAccountSubscriber } from './accounts/webSocketUserAccountSubscriber';
export class ClearingHouseUser {
	clearingHouse: ClearingHouse;
	userAccountPublicKey: PublicKey;
	accountSubscriber: UserAccountSubscriber;
	_isSubscribed = false;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;

	public get isSubscribed() {
		return this._isSubscribed && this.accountSubscriber.isSubscribed;
	}

	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	public constructor(config: ClearingHouseUserConfig) {
		this.clearingHouse = config.clearingHouse;
		this.userAccountPublicKey = config.userAccountPublicKey;
		if (config.accountSubscription?.type === 'polling') {
			this.accountSubscriber = new PollingUserAccountSubscriber(
				config.clearingHouse.program,
				config.userAccountPublicKey,
				config.accountSubscription.accountLoader
			);
		} else {
			this.accountSubscriber = new WebSocketUserAccountSubscriber(
				config.clearingHouse.program,
				config.userAccountPublicKey
			);
		}
		this.eventEmitter = this.accountSubscriber.eventEmitter;
	}

	/**
	 * Subscribe to ClearingHouseUser state accounts
	 * @returns SusbcriptionSuccess result
	 */
	public async subscribe(): Promise<boolean> {
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
		return this.accountSubscriber.getUserAccountAndSlot().data;
	}

	public getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined {
		return this.accountSubscriber.getUserAccountAndSlot();
	}

	/**
	 * Gets the user's current position for a given market. If the user has no position returns undefined
	 * @param marketIndex
	 * @returns userPosition
	 */
	public getUserPosition(marketIndex: BN): PerpPosition | undefined {
		return this.getUserAccount().perpPositions.find((position) =>
			position.marketIndex.eq(marketIndex)
		);
	}

	public getEmptyPosition(marketIndex: BN): PerpPosition {
		return {
			baseAssetAmount: ZERO,
			remainderBaseAssetAmount: ZERO,
			lastCumulativeFundingRate: ZERO,
			marketIndex,
			quoteAssetAmount: ZERO,
			quoteEntryAmount: ZERO,
			openOrders: ZERO,
			openBids: ZERO,
			openAsks: ZERO,
			realizedPnl: ZERO,
			lpShares: ZERO,
			lastFeePerLp: ZERO,
			lastNetBaseAssetAmountPerLp: ZERO,
			lastNetQuoteAssetAmountPerLp: ZERO,
		};
	}

	public getClonedPosition(position: PerpPosition): PerpPosition {
		const clonedPosition = Object.assign({}, position);
		return clonedPosition;
	}

	/**
	 * @param orderId
	 * @returns Order
	 */
	public getOrder(orderId: BN): Order | undefined {
		return this.getUserAccount().orders.find((order) =>
			order.orderId.eq(orderId)
		);
	}

	/**
	 * @param userOrderId
	 * @returns Order
	 */
	public getOrderByUserOrderId(userOrderId: number): Order | undefined {
		return this.getUserAccount().orders.find(
			(order) => order.userOrderId === userOrderId
		);
	}

	public getUserAccountPublicKey(): PublicKey {
		return this.userAccountPublicKey;
	}

	public async exists(): Promise<boolean> {
		const userAccountRPCResponse =
			await this.clearingHouse.connection.getParsedAccountInfo(
				this.userAccountPublicKey
			);
		return userAccountRPCResponse.value !== null;
	}

	/**
	 * calculates the market position if the lp position was settled
	 * @returns : the settled userPosition
	 * @returns : the dust base asset amount (ie, < stepsize)
	 * @returns : pnl from settle
	 */
	public getSettledLPPosition(marketIndex: BN): [PerpPosition, BN, BN] {
		const _position = this.getUserPosition(marketIndex);
		const position = this.getClonedPosition(_position);

		const market = this.clearingHouse.getPerpMarketAccount(
			position.marketIndex
		);
		const nShares = position.lpShares;

		const deltaBaa = market.amm.marketPositionPerLp.baseAssetAmount
			.sub(position.lastNetBaseAssetAmountPerLp)
			.mul(nShares)
			.div(AMM_RESERVE_PRECISION);
		const deltaQaa = market.amm.marketPositionPerLp.quoteAssetAmount
			.sub(position.lastNetQuoteAssetAmountPerLp)
			.mul(nShares)
			.div(AMM_RESERVE_PRECISION);

		function sign(v: BN) {
			const sign = { true: new BN(1), false: new BN(-1) }[
				v.gte(ZERO).toString()
			];
			return sign;
		}

		function standardize(amount, stepsize) {
			const remainder = amount.abs().mod(stepsize).mul(sign(amount));
			const standardizedAmount = amount.sub(remainder);
			return [standardizedAmount, remainder];
		}

		const [standardizedBaa, remainderBaa] = standardize(
			deltaBaa,
			market.amm.baseAssetAmountStepSize
		);

		position.remainderBaseAssetAmount =
			position.remainderBaseAssetAmount.add(remainderBaa);

		if (
			position.remainderBaseAssetAmount
				.abs()
				.gte(market.amm.baseAssetAmountStepSize)
		) {
			const [newStandardizedBaa, newRemainderBaa] = standardize(
				position.remainderBaseAssetAmount,
				market.amm.baseAssetAmountStepSize
			);
			position.baseAssetAmount =
				position.baseAssetAmount.add(newStandardizedBaa);
			position.remainderBaseAssetAmount = newRemainderBaa;
		}

		let updateType;
		if (position.baseAssetAmount.eq(ZERO)) {
			updateType = 'open';
		} else if (sign(position.baseAssetAmount).eq(sign(deltaBaa))) {
			updateType = 'increase';
		} else if (position.baseAssetAmount.abs().gt(deltaBaa.abs())) {
			updateType = 'reduce';
		} else if (position.baseAssetAmount.abs().eq(deltaBaa.abs())) {
			updateType = 'close';
		} else {
			updateType = 'flip';
		}

		let newQuoteEntry;
		let pnl;
		if (updateType == 'open' || updateType == 'increase') {
			newQuoteEntry = position.quoteEntryAmount.add(deltaQaa);
			pnl = 0;
		} else if (updateType == 'reduce' || updateType == 'close') {
			newQuoteEntry = position.quoteEntryAmount.sub(
				position.quoteEntryAmount
					.mul(deltaBaa.abs())
					.div(position.baseAssetAmount.abs())
			);
			pnl = position.quoteEntryAmount.sub(newQuoteEntry).add(deltaQaa);
		} else {
			newQuoteEntry = deltaQaa.sub(
				deltaQaa.mul(position.baseAssetAmount.abs()).div(deltaBaa.abs())
			);
			pnl = position.quoteEntryAmount.add(deltaQaa.sub(newQuoteEntry));
		}
		position.quoteEntryAmount = newQuoteEntry;
		position.baseAssetAmount = position.baseAssetAmount.add(standardizedBaa);
		position.quoteAssetAmount = position.quoteAssetAmount.add(deltaQaa);

		if (position.baseAssetAmount.gt(ZERO)) {
			position.lastCumulativeFundingRate = market.amm.cumulativeFundingRateLong;
		} else if (position.baseAssetAmount.lt(ZERO)) {
			position.lastCumulativeFundingRate =
				market.amm.cumulativeFundingRateShort;
		} else {
			position.lastCumulativeFundingRate = ZERO;
		}

		return [position, remainderBaa, pnl];
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

	/**
	 * @returns The margin requirement of a certain type (Initial or Maintenance) in USDC. : QUOTE_PRECISION
	 */
	public getMarginRequirement(
		type: MarginCategory,
		liquidationBuffer?: BN
	): BN {
		return this.getUserAccount()
			.perpPositions.reduce((marginRequirement, perpPosition) => {
				const market = this.clearingHouse.getPerpMarketAccount(
					perpPosition.marketIndex
				);

				if (perpPosition.lpShares.gt(ZERO)) {
					// is an lp
					// clone so we dont mutate the position
					perpPosition = this.getClonedPosition(perpPosition);

					// settle position
					const [settledPosition, dustBaa, _] = this.getSettledLPPosition(
						market.marketIndex
					);
					perpPosition.baseAssetAmount =
						settledPosition.baseAssetAmount.add(dustBaa);
					perpPosition.quoteAssetAmount = settledPosition.quoteAssetAmount;

					// open orders
					let openAsks;
					if (market.amm.maxBaseAssetReserve > market.amm.baseAssetReserve) {
						openAsks = market.amm.maxBaseAssetReserve
							.sub(market.amm.baseAssetReserve)
							.mul(perpPosition.lpShares)
							.div(market.amm.sqrtK)
							.mul(new BN(-1));
					} else {
						openAsks = ZERO;
					}

					let openBids;
					if (market.amm.minBaseAssetReserve < market.amm.baseAssetReserve) {
						openBids = market.amm.baseAssetReserve
							.sub(market.amm.minBaseAssetReserve)
							.mul(perpPosition.lpShares)
							.div(market.amm.sqrtK);
					} else {
						openBids = ZERO;
					}

					perpPosition.openAsks = perpPosition.openAsks.add(openAsks);
					perpPosition.openBids = perpPosition.openBids.add(openBids);
				}

				let valuationPrice = this.getOracleDataForMarket(
					market.marketIndex
				).price;

				if (isVariant(market.status, 'settlement')) {
					valuationPrice = market.settlementPrice;
				}

				const worstCaseBaseAssetAmount =
					calculateWorstCaseBaseAssetAmount(perpPosition);

				const worstCaseAssetValue = worstCaseBaseAssetAmount
					.abs()
					.mul(valuationPrice)
					.div(AMM_TO_QUOTE_PRECISION_RATIO.mul(MARK_PRICE_PRECISION));

				const positionMarginRequirement = worstCaseAssetValue
					.mul(
						new BN(
							calculateMarketMarginRatio(
								market,
								worstCaseBaseAssetAmount.abs(),
								type
							)
						)
					)
					.div(MARGIN_PRECISION);

				if (liquidationBuffer !== undefined) {
					positionMarginRequirement.add(
						worstCaseAssetValue.mul(liquidationBuffer).div(MARGIN_PRECISION)
					);
				}

				return marginRequirement.add(positionMarginRequirement);
			}, ZERO)
			.add(
				this.getSpotMarketLiabilityValue(undefined, type, liquidationBuffer)
			);
	}

	/**
	 * @returns The initial margin requirement in USDC. : QUOTE_PRECISION
	 */
	public getInitialMarginRequirement(): BN {
		return this.getMarginRequirement('Initial');
	}

	/**
	 * @returns The maintenance margin requirement in USDC. : QUOTE_PRECISION
	 */
	public getMaintenanceMarginRequirement(liquidationBuffer?: BN): BN {
		return this.getMarginRequirement('Maintenance', liquidationBuffer);
	}

	/**
	 * calculates unrealized position price pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getUnrealizedPNL(
		withFunding?: boolean,
		marketIndex?: BN,
		withWeightMarginCategory?: MarginCategory
	): BN {
		return this.getUserAccount()
			.perpPositions.filter((pos) =>
				marketIndex ? pos.marketIndex === marketIndex : true
			)
			.reduce((unrealizedPnl, perpPosition) => {
				const market = this.clearingHouse.getPerpMarketAccount(
					perpPosition.marketIndex
				);
				let positionUnrealizedPnl = calculatePositionPNL(
					market,
					perpPosition,
					withFunding,
					this.getOracleDataForMarket(market.marketIndex)
				);

				if (withWeightMarginCategory !== undefined) {
					if (positionUnrealizedPnl.gt(ZERO)) {
						positionUnrealizedPnl = positionUnrealizedPnl
							.mul(
								calculateUnrealizedAssetWeight(
									market,
									positionUnrealizedPnl,
									withWeightMarginCategory
								)
							)
							.div(new BN(SPOT_MARKET_WEIGHT_PRECISION));
					}
				}

				return unrealizedPnl.add(positionUnrealizedPnl);
			}, ZERO);
	}

	/**
	 * calculates unrealized funding payment pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getUnrealizedFundingPNL(marketIndex?: BN): BN {
		return this.getUserAccount()
			.perpPositions.filter((pos) =>
				marketIndex ? pos.marketIndex === marketIndex : true
			)
			.reduce((pnl, perpPosition) => {
				const market = this.clearingHouse.getPerpMarketAccount(
					perpPosition.marketIndex
				);
				return pnl.add(calculatePositionFundingPNL(market, perpPosition));
			}, ZERO);
	}

	public getSpotMarketLiabilityValue(
		marketIndex?: BN,
		withWeightMarginCategory?: MarginCategory,
		liquidationBuffer?: BN
	): BN {
		return this.getUserAccount().spotPositions.reduce(
			(totalLiabilityValue, spotPosition) => {
				if (
					spotPosition.balance.eq(ZERO) ||
					isVariant(spotPosition.balanceType, 'deposit') ||
					(marketIndex !== undefined &&
						!spotPosition.marketIndex.eq(marketIndex))
				) {
					return totalLiabilityValue;
				}

				// Todo this needs to account for whether it's based on initial or maintenance requirements
				const spotMarketAccount: SpotMarketAccount =
					this.clearingHouse.getSpotMarketAccount(spotPosition.marketIndex);

				const tokenAmount = getTokenAmount(
					spotPosition.balance,
					spotMarketAccount,
					spotPosition.balanceType
				);

				let liabilityValue = tokenAmount
					.mul(
						this.getOracleDataForSpotMarket(spotMarketAccount.marketIndex).price
					)
					.div(MARK_PRICE_PRECISION)
					.div(
						new BN(10).pow(
							new BN(spotMarketAccount.decimals).sub(
								SPOT_MARKET_BALANCE_PRECISION_EXP
							)
						)
					);

				if (withWeightMarginCategory !== undefined) {
					let weight = calculateLiabilityWeight(
						tokenAmount,
						spotMarketAccount,
						withWeightMarginCategory
					);

					if (liquidationBuffer !== undefined) {
						weight = weight.add(liquidationBuffer);
					}

					liabilityValue = liabilityValue
						.mul(weight)
						.div(SPOT_MARKET_WEIGHT_PRECISION);
				}

				return totalLiabilityValue.add(liabilityValue);
			},
			ZERO
		);
	}

	public getSpotMarketAssetValue(
		marketIndex?: BN,
		withWeightMarginCategory?: MarginCategory
	): BN {
		return this.getUserAccount().spotPositions.reduce(
			(totalAssetValue, spotPosition) => {
				if (
					spotPosition.balance.eq(ZERO) ||
					isVariant(spotPosition.balanceType, 'borrow') ||
					(marketIndex !== undefined &&
						!spotPosition.marketIndex.eq(marketIndex))
				) {
					return totalAssetValue;
				}

				// Todo this needs to account for whether it's based on initial or maintenance requirements
				const spotMarketAccount: SpotMarketAccount =
					this.clearingHouse.getSpotMarketAccount(spotPosition.marketIndex);

				const tokenAmount = getTokenAmount(
					spotPosition.balance,
					spotMarketAccount,
					spotPosition.balanceType
				);

				let assetValue = tokenAmount
					.mul(
						this.getOracleDataForSpotMarket(spotMarketAccount.marketIndex).price
					)
					.div(MARK_PRICE_PRECISION)
					.div(
						new BN(10).pow(
							new BN(spotMarketAccount.decimals).sub(
								SPOT_MARKET_BALANCE_PRECISION_EXP
							)
						)
					);
				if (withWeightMarginCategory !== undefined) {
					const weight = calculateAssetWeight(
						tokenAmount,
						spotMarketAccount,
						withWeightMarginCategory
					);
					assetValue = assetValue.mul(weight).div(SPOT_MARKET_WEIGHT_PRECISION);
				}

				return totalAssetValue.add(assetValue);
			},
			ZERO
		);
	}

	public getNetSpotMarketValue(withWeightMarginCategory?: MarginCategory): BN {
		return this.getSpotMarketAssetValue(
			undefined,
			withWeightMarginCategory
		).sub(
			this.getSpotMarketLiabilityValue(undefined, withWeightMarginCategory)
		);
	}

	/**
	 * calculates TotalCollateral: collateral + unrealized pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getTotalCollateral(marginCategory: MarginCategory = 'Initial'): BN {
		return this.getSpotMarketAssetValue(undefined, marginCategory).add(
			this.getUnrealizedPNL(true, undefined, marginCategory)
		);
	}

	/**
	 * calculates sum of position value across all positions in margin system
	 * @returns : Precision QUOTE_PRECISION
	 */
	getTotalPositionValue(): BN {
		return this.getUserAccount().perpPositions.reduce(
			(positionValue, perpPosition) => {
				const market = this.clearingHouse.getPerpMarketAccount(
					perpPosition.marketIndex
				);
				const posVal = calculateBaseAssetValueWithOracle(
					market,
					perpPosition,
					this.getOracleDataForMarket(market.marketIndex)
				);

				return positionValue.add(posVal);
			},
			ZERO
		);
	}

	/**
	 * calculates position value in margin system
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getPositionValue(
		marketIndex: BN,
		oraclePriceData: OraclePriceData
	): BN {
		const userPosition =
			this.getUserPosition(marketIndex) || this.getEmptyPosition(marketIndex);
		const market = this.clearingHouse.getPerpMarketAccount(
			userPosition.marketIndex
		);
		return calculateBaseAssetValueWithOracle(
			market,
			userPosition,
			oraclePriceData
		);
	}

	public getPositionSide(
		currentPosition: Pick<PerpPosition, 'baseAssetAmount'>
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
	 * calculates average exit price (optionally for closing up to 100% of position)
	 * @returns : Precision MARK_PRICE_PRECISION
	 */
	public getPositionEstimatedExitPriceAndPnl(
		position: PerpPosition,
		amountToClose?: BN,
		useAMMClose = false
	): [BN, BN] {
		const market = this.clearingHouse.getPerpMarketAccount(
			position.marketIndex
		);

		const entryPrice = calculateEntryPrice(position);

		const oraclePriceData = this.getOracleDataForMarket(position.marketIndex);

		if (amountToClose) {
			if (amountToClose.eq(ZERO)) {
				return [calculateMarkPrice(market, oraclePriceData), ZERO];
			}
			position = {
				baseAssetAmount: amountToClose,
				lastCumulativeFundingRate: position.lastCumulativeFundingRate,
				marketIndex: position.marketIndex,
				quoteAssetAmount: position.quoteAssetAmount,
			} as PerpPosition;
		}

		let baseAssetValue: BN;

		if (useAMMClose) {
			baseAssetValue = calculateBaseAssetValue(
				market,
				position,
				oraclePriceData
			);
		} else {
			baseAssetValue = calculateBaseAssetValueWithOracle(
				market,
				position,
				oraclePriceData
			);
		}
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
		const market = this.clearingHouse.getPerpMarketAccount(marketIndex);

		const marginRatioCategory = calculateMarketMarginRatio(
			market,
			// worstCaseBaseAssetAmount.abs(),
			ZERO, // todo
			category
		);
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

	public canBeLiquidated(): boolean {
		const totalCollateral = this.getTotalCollateral();

		// if user being liq'd, can continue to be liq'd until total collateral above the margin requirement plus buffer
		let liquidationBuffer = undefined;
		if (this.getUserAccount().beingLiquidated) {
			liquidationBuffer = new BN(
				this.clearingHouse.getStateAccount().liquidationMarginBufferRatio
			);
		}
		const maintenanceRequirement =
			this.getMaintenanceMarginRequirement(liquidationBuffer);
		return totalCollateral.lt(maintenanceRequirement);
	}

	/**
	 * Checks if any user position cumulative funding differs from respective market cumulative funding
	 * @returns
	 */
	public needsToSettleFundingPayment(): boolean {
		for (const userPosition of this.getUserAccount().perpPositions) {
			if (userPosition.baseAssetAmount.eq(ZERO)) {
				continue;
			}

			const market = this.clearingHouse.getPerpMarketAccount(
				userPosition.marketIndex
			);
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
	 * @param PerpPosition
	 * @param positionBaseSizeChange // change in position size to calculate liquidation price for : Precision 10^13
	 * @param partial
	 * @returns Precision : MARK_PRICE_PRECISION
	 */
	public liquidationPrice(
		perpPosition: Pick<PerpPosition, 'marketIndex'>,
		positionBaseSizeChange: BN = ZERO
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
			this.getTotalPositionValueExcludingMarket(perpPosition.marketIndex);

		const currentPerpPosition =
			this.getUserPosition(perpPosition.marketIndex) ||
			this.getEmptyPosition(perpPosition.marketIndex);

		const currentPerpPositionBaseSize = currentPerpPosition.baseAssetAmount;

		const proposedBaseAssetAmount = currentPerpPositionBaseSize.add(
			positionBaseSizeChange
		);

		// calculate position for current market after trade
		const proposedPerpPosition: PerpPosition = {
			marketIndex: perpPosition.marketIndex,
			baseAssetAmount: proposedBaseAssetAmount,
			remainderBaseAssetAmount: ZERO,
			quoteAssetAmount: new BN(0),
			lastCumulativeFundingRate: ZERO,
			quoteEntryAmount: new BN(0),
			openOrders: new BN(0),
			openBids: new BN(0),
			openAsks: new BN(0),
			realizedPnl: ZERO,
			lpShares: ZERO,
			lastFeePerLp: ZERO,
			lastNetBaseAssetAmountPerLp: ZERO,
			lastNetQuoteAssetAmountPerLp: ZERO,
		};

		if (proposedBaseAssetAmount.eq(ZERO)) return new BN(-1);

		const market = this.clearingHouse.getPerpMarketAccount(
			proposedPerpPosition.marketIndex
		);

		const proposedPerpPositionValue = calculateBaseAssetValueWithOracle(
			market,
			proposedPerpPosition,
			this.getOracleDataForMarket(market.marketIndex)
		);

		// total position value after trade
		const totalPositionValueAfterTrade =
			totalPositionValueExcludingTargetMarket.add(proposedPerpPositionValue);

		const marginRequirementExcludingTargetMarket =
			this.getUserAccount().perpPositions.reduce(
				(totalMarginRequirement, position) => {
					if (!position.marketIndex.eq(perpPosition.marketIndex)) {
						const market = this.clearingHouse.getPerpMarketAccount(
							position.marketIndex
						);
						const positionValue = calculateBaseAssetValueWithOracle(
							market,
							position,
							this.getOracleDataForMarket(market.marketIndex)
						);
						const marketMarginRequirement = positionValue
							.mul(
								new BN(
									calculateMarketMarginRatio(
										market,
										position.baseAssetAmount.abs(),
										'Maintenance'
									)
								)
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
			proposedPerpPosition.baseAssetAmount.abs().gt(ZERO)
		) {
			return new BN(-1);
		}

		const marginRequirementAfterTrade =
			marginRequirementExcludingTargetMarket.add(
				proposedPerpPositionValue
					.mul(
						new BN(
							calculateMarketMarginRatio(
								market,
								proposedPerpPosition.baseAssetAmount.abs(),
								'Maintenance'
							)
						)
					)
					.div(MARGIN_PRECISION)
			);
		const freeCollateralAfterTrade = totalCollateral.sub(
			marginRequirementAfterTrade
		);

		const marketMaxLeverage = this.getMaxLeverage(
			proposedPerpPosition.marketIndex,
			'Maintenance'
		);

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
				this.clearingHouse.getPerpMarketAccount(perpPosition.marketIndex),
				this.getOracleDataForMarket(perpPosition.marketIndex)
			);
		} else {
			const direction = positionBaseSizeChange.gt(ZERO)
				? PositionDirection.LONG
				: PositionDirection.SHORT;
			markPriceAfterTrade = calculateTradeSlippage(
				direction,
				positionBaseSizeChange.abs(),
				this.clearingHouse.getPerpMarketAccount(perpPosition.marketIndex),
				'base',
				this.getOracleDataForMarket(perpPosition.marketIndex)
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
			.div(currentPosition.quoteAssetAmount.abs())
			.add(
				currentPosition.baseAssetAmount
					.mul(closeQuoteAmount)
					.mod(currentPosition.quoteAssetAmount.abs())
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

		const oracleData = this.getOracleDataForMarket(targetMarketIndex);

		// add any position we have on the opposite side of the current trade, because we can "flip" the size of this position without taking any extra leverage.
		const oppositeSizeValueUSDC = targetingSameSide
			? ZERO
			: this.getPositionValue(targetMarketIndex, oracleData);

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
				const market =
					this.clearingHouse.getPerpMarketAccount(targetMarketIndex);
				const perpPositionValue = this.getPositionValue(
					targetMarketIndex,
					oracleData
				);
				const totalCollateral = this.getTotalCollateral();
				const marginRequirement = this.getInitialMarginRequirement();
				const marginFreedByClosing = perpPositionValue
					.mul(new BN(market.marginRatioInitial))
					.div(MARGIN_PRECISION);
				const marginRequirementAfterClosing =
					marginRequirement.sub(marginFreedByClosing);

				if (marginRequirementAfterClosing.gt(totalCollateral)) {
					maxPositionSize = perpPositionValue;
				} else {
					const freeCollateralAfterClose = totalCollateral.sub(
						marginRequirementAfterClosing
					);
					const buyingPowerAfterClose = freeCollateralAfterClose
						.mul(this.getMaxLeverage(targetMarketIndex))
						.div(TEN_THOUSAND);
					maxPositionSize = perpPositionValue.add(buyingPowerAfterClose);
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

		const oracleData = this.getOracleDataForMarket(targetMarketIndex);

		let currentPositionQuoteAmount = this.getPositionValue(
			targetMarketIndex,
			oracleData
		);

		const currentSide =
			currentPosition && currentPosition.baseAssetAmount.isNeg()
				? PositionDirection.SHORT
				: PositionDirection.LONG;

		if (currentSide === PositionDirection.SHORT)
			currentPositionQuoteAmount = currentPositionQuoteAmount.neg();

		if (tradeSide === PositionDirection.SHORT)
			tradeQuoteAmount = tradeQuoteAmount.neg();

		const currentPerpPositionAfterTrade = currentPositionQuoteAmount
			.add(tradeQuoteAmount)
			.abs();

		const totalPositionAfterTradeExcludingTargetMarket =
			this.getTotalPositionValueExcludingMarket(targetMarketIndex);

		const totalCollateral = this.getTotalCollateral();
		if (totalCollateral.gt(ZERO)) {
			const newLeverage = currentPerpPositionAfterTrade
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
		const feeStructure = this.clearingHouse.getStateAccount().perpFeeStructure;

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
		const currentPerpPosition =
			this.getUserPosition(marketToIgnore) ||
			this.getEmptyPosition(marketToIgnore);

		const oracleData = this.getOracleDataForMarket(marketToIgnore);

		let currentPerpPositionValueUSDC = ZERO;
		if (currentPerpPosition) {
			currentPerpPositionValueUSDC = this.getPositionValue(
				marketToIgnore,
				oracleData
			);
		}

		return this.getTotalPositionValue().sub(currentPerpPositionValueUSDC);
	}

	private getOracleDataForMarket(marketIndex: BN): OraclePriceData {
		const oracleKey =
			this.clearingHouse.getPerpMarketAccount(marketIndex).amm.oracle;
		const oracleData =
			this.clearingHouse.getOraclePriceDataAndSlot(oracleKey).data;

		return oracleData;
	}
	private getOracleDataForSpotMarket(marketIndex: BN): OraclePriceData {
		const oracleKey =
			this.clearingHouse.getSpotMarketAccount(marketIndex).oracle;

		const oracleData =
			this.clearingHouse.getOraclePriceDataAndSlot(oracleKey).data;

		return oracleData;
	}
}
