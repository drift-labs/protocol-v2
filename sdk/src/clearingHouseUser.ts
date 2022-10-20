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
	PRICE_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	ZERO,
	TEN_THOUSAND,
	BN_MAX,
	QUOTE_PRECISION,
	AMM_RESERVE_PRECISION,
	PRICE_TO_QUOTE_PRECISION,
	MARGIN_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
	TEN,
} from './constants/numericConstants';
import {
	UserAccountSubscriber,
	UserAccountEvents,
	DataAndSlot,
} from './accounts/types';
import {
	calculateReservePrice,
	calculateBaseAssetValue,
	calculatePositionFundingPNL,
	calculatePositionPNL,
	calculateUnrealizedAssetWeight,
	calculateMarketMarginRatio,
	PositionDirection,
	calculateTradeSlippage,
	BN,
	SpotMarketAccount,
	getTokenValue,
	SpotBalanceType,
} from '.';
import {
	getTokenAmount,
	calculateAssetWeight,
	calculateLiabilityWeight,
	calculateWithdrawLimit,
} from './math/spotBalance';
import {
	calculateBaseAssetValueWithOracle,
	calculateWorstCaseBaseAssetAmount,
} from './math/margin';
import { OraclePriceData } from './oracles/types';
import { ClearingHouseUserConfig } from './clearingHouseUserConfig';
import { PollingUserAccountSubscriber } from './accounts/pollingUserAccountSubscriber';
import { WebSocketUserAccountSubscriber } from './accounts/webSocketUserAccountSubscriber';
import {
	getWorstCaseTokenAmounts,
	isSpotPositionAvailable,
} from './math/spotPosition';
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
	public getUserPosition(marketIndex: number): PerpPosition | undefined {
		return this.getUserAccount().perpPositions.find(
			(position) => position.marketIndex === marketIndex
		);
	}

	public getEmptyPosition(marketIndex: number): PerpPosition {
		return {
			baseAssetAmount: ZERO,
			remainderBaseAssetAmount: 0,
			lastCumulativeFundingRate: ZERO,
			marketIndex,
			quoteAssetAmount: ZERO,
			quoteEntryAmount: ZERO,
			openOrders: 0,
			openBids: ZERO,
			openAsks: ZERO,
			settledPnl: ZERO,
			lpShares: ZERO,
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
	public getOrder(orderId: number): Order | undefined {
		return this.getUserAccount().orders.find(
			(order) => order.orderId === orderId
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
	public getSettledLPPosition(marketIndex: number): [PerpPosition, BN, BN] {
		const _position = this.getUserPosition(marketIndex);
		const position = this.getClonedPosition(_position);

		const market = this.clearingHouse.getPerpMarketAccount(
			position.marketIndex
		);
		const nShares = position.lpShares;

		const deltaBaa = market.amm.baseAssetAmountPerLp
			.sub(position.lastNetBaseAssetAmountPerLp)
			.mul(nShares)
			.div(AMM_RESERVE_PRECISION);
		const deltaQaa = market.amm.quoteAssetAmountPerLp
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
			market.amm.orderStepSize
		);

		position.remainderBaseAssetAmount += remainderBaa.toNumber();

		if (
			Math.abs(position.remainderBaseAssetAmount) >
			market.amm.orderStepSize.toNumber()
		) {
			const [newStandardizedBaa, newRemainderBaa] = standardize(
				position.remainderBaseAssetAmount,
				market.amm.orderStepSize
			);
			position.baseAssetAmount =
				position.baseAssetAmount.add(newStandardizedBaa);
			position.remainderBaseAssetAmount = newRemainderBaa.toNumber();
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
	public getBuyingPower(marketIndex: number): BN {
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
		marginCategory: MarginCategory,
		liquidationBuffer?: BN
	): BN {
		return this.getTotalPerpPositionValue(
			marginCategory,
			liquidationBuffer,
			true
		).add(
			this.getSpotMarketLiabilityValue(
				undefined,
				marginCategory,
				liquidationBuffer,
				true
			)
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
		marketIndex?: number,
		withWeightMarginCategory?: MarginCategory
	): BN {
		const quoteSpotMarket = this.clearingHouse.getQuoteSpotMarketAccount();
		return this.getUserAccount()
			.perpPositions.filter((pos) =>
				marketIndex ? pos.marketIndex === marketIndex : true
			)
			.reduce((unrealizedPnl, perpPosition) => {
				const market = this.clearingHouse.getPerpMarketAccount(
					perpPosition.marketIndex
				);
				const oraclePriceData = this.getOracleDataForPerpMarket(
					market.marketIndex
				);

				let positionUnrealizedPnl = calculatePositionPNL(
					market,
					perpPosition,
					withFunding,
					oraclePriceData
				);

				if (withWeightMarginCategory !== undefined) {
					if (positionUnrealizedPnl.gt(ZERO)) {
						positionUnrealizedPnl = positionUnrealizedPnl
							.mul(
								calculateUnrealizedAssetWeight(
									market,
									quoteSpotMarket,
									positionUnrealizedPnl,
									withWeightMarginCategory,
									oraclePriceData
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
	public getUnrealizedFundingPNL(marketIndex?: number): BN {
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
		marketIndex?: number,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean
	): BN {
		return this.getUserAccount().spotPositions.reduce(
			(totalLiabilityValue, spotPosition) => {
				if (
					isSpotPositionAvailable(spotPosition) ||
					(marketIndex !== undefined &&
						spotPosition.marketIndex !== marketIndex)
				) {
					return totalLiabilityValue;
				}

				const spotMarketAccount: SpotMarketAccount =
					this.clearingHouse.getSpotMarketAccount(spotPosition.marketIndex);

				if (spotPosition.marketIndex === QUOTE_SPOT_MARKET_INDEX) {
					if (isVariant(spotPosition.balanceType, 'borrow')) {
						const tokenAmount = getTokenAmount(
							spotPosition.scaledBalance,
							spotMarketAccount,
							spotPosition.balanceType
						);

						let weight = SPOT_MARKET_WEIGHT_PRECISION;
						if (marginCategory === 'Initial') {
							weight = BN.max(
								weight,
								new BN(this.getUserAccount().maxMarginRatio)
							);
						}

						const weightedTokenValue = tokenAmount
							.mul(weight)
							.div(SPOT_MARKET_WEIGHT_PRECISION);

						return totalLiabilityValue.add(weightedTokenValue);
					} else {
						return totalLiabilityValue;
					}
				}

				const oraclePriceData = this.getOracleDataForSpotMarket(
					spotPosition.marketIndex
				);

				if (!includeOpenOrders) {
					if (isVariant(spotPosition.balanceType, 'borrow')) {
						const tokenAmount = getTokenAmount(
							spotPosition.scaledBalance,
							spotMarketAccount,
							spotPosition.balanceType
						);
						const liabilityValue = this.getSpotLiabilityValue(
							tokenAmount,
							oraclePriceData,
							spotMarketAccount,
							marginCategory,
							liquidationBuffer
						);
						return totalLiabilityValue.add(liabilityValue);
					} else {
						return totalLiabilityValue;
					}
				}

				const [worstCaseTokenAmount, worstCaseQuoteTokenAmount] =
					getWorstCaseTokenAmounts(
						spotPosition,
						spotMarketAccount,
						this.getOracleDataForSpotMarket(spotPosition.marketIndex)
					);

				let newTotalLiabilityValue = totalLiabilityValue;
				if (worstCaseTokenAmount.lt(ZERO)) {
					const baseLiabilityValue = this.getSpotLiabilityValue(
						worstCaseTokenAmount.abs(),
						oraclePriceData,
						spotMarketAccount,
						marginCategory,
						liquidationBuffer
					);

					newTotalLiabilityValue =
						newTotalLiabilityValue.add(baseLiabilityValue);
				}

				if (worstCaseQuoteTokenAmount.lt(ZERO)) {
					let weight = SPOT_MARKET_WEIGHT_PRECISION;
					if (marginCategory === 'Initial') {
						weight = BN.max(
							weight,
							new BN(this.getUserAccount().maxMarginRatio)
						);
					}

					const weightedTokenValue = worstCaseQuoteTokenAmount
						.abs()
						.mul(weight)
						.div(SPOT_MARKET_WEIGHT_PRECISION);

					newTotalLiabilityValue =
						newTotalLiabilityValue.add(weightedTokenValue);
				}

				return newTotalLiabilityValue;
			},
			ZERO
		);
	}

	getSpotLiabilityValue(
		tokenAmount: BN,
		oraclePriceData: OraclePriceData,
		spotMarketAccount: SpotMarketAccount,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN
	): BN {
		let liabilityValue = getTokenValue(
			tokenAmount,
			spotMarketAccount.decimals,
			oraclePriceData
		);

		if (marginCategory !== undefined) {
			let weight = calculateLiabilityWeight(
				tokenAmount,
				spotMarketAccount,
				marginCategory
			);

			if (marginCategory === 'Initial') {
				weight = BN.max(weight, new BN(this.getUserAccount().maxMarginRatio));
			}

			if (liquidationBuffer !== undefined) {
				weight = weight.add(liquidationBuffer);
			}

			liabilityValue = liabilityValue
				.mul(weight)
				.div(SPOT_MARKET_WEIGHT_PRECISION);
		}

		return liabilityValue;
	}

	public getSpotMarketAssetValue(
		marketIndex?: number,
		marginCategory?: MarginCategory,
		includeOpenOrders?: boolean
	): BN {
		return this.getUserAccount().spotPositions.reduce(
			(totalAssetValue, spotPosition) => {
				if (
					isSpotPositionAvailable(spotPosition) ||
					(marketIndex !== undefined &&
						spotPosition.marketIndex !== marketIndex)
				) {
					return totalAssetValue;
				}

				// Todo this needs to account for whether it's based on initial or maintenance requirements
				const spotMarketAccount: SpotMarketAccount =
					this.clearingHouse.getSpotMarketAccount(spotPosition.marketIndex);

				if (spotPosition.marketIndex === QUOTE_SPOT_MARKET_INDEX) {
					if (isVariant(spotPosition.balanceType, 'deposit')) {
						const tokenAmount = getTokenAmount(
							spotPosition.scaledBalance,
							spotMarketAccount,
							spotPosition.balanceType
						);

						return totalAssetValue.add(tokenAmount);
					} else {
						return totalAssetValue;
					}
				}

				const oraclePriceData = this.getOracleDataForSpotMarket(
					spotPosition.marketIndex
				);

				if (!includeOpenOrders) {
					if (isVariant(spotPosition.balanceType, 'deposit')) {
						const tokenAmount = getTokenAmount(
							spotPosition.scaledBalance,
							spotMarketAccount,
							spotPosition.balanceType
						);
						const assetValue = this.getSpotAssetValue(
							tokenAmount,
							oraclePriceData,
							spotMarketAccount,
							marginCategory
						);
						return totalAssetValue.add(assetValue);
					} else {
						return totalAssetValue;
					}
				}

				const [worstCaseTokenAmount, worstCaseQuoteTokenAmount] =
					getWorstCaseTokenAmounts(
						spotPosition,
						spotMarketAccount,
						this.getOracleDataForSpotMarket(spotPosition.marketIndex)
					);

				let newTotalAssetValue = totalAssetValue;
				if (worstCaseTokenAmount.gt(ZERO)) {
					const baseAssetValue = this.getSpotAssetValue(
						worstCaseTokenAmount,
						oraclePriceData,
						spotMarketAccount,
						marginCategory
					);

					newTotalAssetValue = newTotalAssetValue.add(baseAssetValue);
				}

				if (worstCaseQuoteTokenAmount.gt(ZERO)) {
					newTotalAssetValue = newTotalAssetValue.add(
						worstCaseQuoteTokenAmount
					);
				}

				return newTotalAssetValue;
			},
			ZERO
		);
	}

	getSpotAssetValue(
		tokenAmount: BN,
		oraclePriceData: OraclePriceData,
		spotMarketAccount: SpotMarketAccount,
		marginCategory?: MarginCategory
	): BN {
		let assetValue = getTokenValue(
			tokenAmount,
			spotMarketAccount.decimals,
			oraclePriceData
		);

		if (marginCategory !== undefined) {
			const weight = calculateAssetWeight(
				tokenAmount,
				spotMarketAccount,
				marginCategory
			);

			assetValue = assetValue.mul(weight).div(SPOT_MARKET_WEIGHT_PRECISION);
		}

		return assetValue;
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
		return this.getSpotMarketAssetValue(undefined, marginCategory, true).add(
			this.getUnrealizedPNL(true, undefined, marginCategory)
		);
	}

	/**
	 * calculates sum of position value across all positions in margin system
	 * @returns : Precision QUOTE_PRECISION
	 */
	getTotalPerpPositionValue(
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean
	): BN {
		return this.getUserAccount().perpPositions.reduce(
			(totalPerpValue, perpPosition) => {
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

				let valuationPrice = this.getOracleDataForPerpMarket(
					market.marketIndex
				).price;

				if (isVariant(market.status, 'settlement')) {
					valuationPrice = market.expiryPrice;
				}

				const baseAssetAmount = includeOpenOrders
					? calculateWorstCaseBaseAssetAmount(perpPosition)
					: perpPosition.baseAssetAmount;

				let baseAssetValue = baseAssetAmount
					.abs()
					.mul(valuationPrice)
					.div(AMM_TO_QUOTE_PRECISION_RATIO.mul(PRICE_PRECISION));

				if (marginCategory) {
					let marginRatio = new BN(
						calculateMarketMarginRatio(
							market,
							baseAssetAmount.abs(),
							marginCategory
						)
					);

					if (marginCategory === 'Initial') {
						marginRatio = BN.max(
							marginRatio,
							new BN(this.getUserAccount().maxMarginRatio)
						);
					}

					if (liquidationBuffer !== undefined) {
						marginRatio = marginRatio.add(liquidationBuffer);
					}

					if (isVariant(market.status, 'settlement')) {
						marginRatio = ZERO;
					}

					baseAssetValue = baseAssetValue
						.mul(marginRatio)
						.div(MARGIN_PRECISION);
				}

				return totalPerpValue.add(baseAssetValue);
			},
			ZERO
		);
	}

	/**
	 * calculates position value in margin system
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getPerpPositionValue(
		marketIndex: number,
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
	 * @returns : Precision PRICE_PRECISION
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

		const oraclePriceData = this.getOracleDataForPerpMarket(
			position.marketIndex
		);

		if (amountToClose) {
			if (amountToClose.eq(ZERO)) {
				return [calculateReservePrice(market, oraclePriceData), ZERO];
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
			.mul(PRICE_PRECISION)
			.div(position.baseAssetAmount.abs());

		const pnlPerBase = exitPrice.sub(entryPrice);
		const pnl = pnlPerBase
			.mul(position.baseAssetAmount)
			.div(PRICE_PRECISION)
			.div(AMM_TO_QUOTE_PRECISION_RATIO);

		return [exitPrice, pnl];
	}

	/**
	 * calculates current user leverage across all positions
	 * @returns : Precision TEN_THOUSAND
	 */
	public getLeverage(): BN {
		const totalLiabilityValue = this.getTotalLiabilityValue();

		const totalAssetValue = this.getTotalAssetValue();

		if (totalAssetValue.eq(ZERO) && totalLiabilityValue.eq(ZERO)) {
			return ZERO;
		}

		return totalLiabilityValue.mul(TEN_THOUSAND).div(totalAssetValue);
	}

	getTotalLiabilityValue(): BN {
		return this.getTotalPerpPositionValue(undefined, undefined, true).add(
			this.getSpotMarketLiabilityValue(undefined, undefined, undefined, true)
		);
	}

	getTotalAssetValue(): BN {
		return this.getSpotMarketAssetValue(undefined, undefined, true).add(
			this.getUnrealizedPNL(true, undefined, undefined)
		);
	}

	/**
	 * calculates max allowable leverage exceeding hitting requirement category
	 * @params category {Initial, Maintenance}
	 * @returns : Precision TEN_THOUSAND
	 */
	public getMaxLeverage(
		marketIndex: number,
		category: MarginCategory = 'Initial'
	): BN {
		const market = this.clearingHouse.getPerpMarketAccount(marketIndex);

		const totalAssetValue = this.getTotalAssetValue();
		if (totalAssetValue.eq(ZERO)) {
			return ZERO;
		}

		const totalLiabilityValue = this.getTotalLiabilityValue();

		const marginRatio = calculateMarketMarginRatio(
			market,
			// worstCaseBaseAssetAmount.abs(),
			ZERO, // todo
			category
		);
		const freeCollateral = this.getFreeCollateral();

		// how much more liabilities can be opened w remaining free collateral
		const additionalLiabilities = freeCollateral
			.mul(MARGIN_PRECISION)
			.div(new BN(marginRatio));

		return totalLiabilityValue
			.add(additionalLiabilities)
			.mul(TEN_THOUSAND)
			.div(totalAssetValue);
	}

	/**
	 * calculates margin ratio: total collateral / |total position value|
	 * @returns : Precision TEN_THOUSAND
	 */
	public getMarginRatio(): BN {
		const totalLiabilityValue = this.getTotalLiabilityValue();

		if (totalLiabilityValue.eq(ZERO)) {
			return BN_MAX;
		}

		const totalAssetValue = this.getTotalAssetValue();

		return totalAssetValue.mul(TEN_THOUSAND).div(totalLiabilityValue);
	}

	public canBeLiquidated(): boolean {
		const totalCollateral = this.getTotalCollateral();

		// if user being liq'd, can continue to be liq'd until total collateral above the margin requirement plus buffer
		let liquidationBuffer = undefined;
		if (this.getUserAccount().isBeingLiquidated) {
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
	 * @returns Precision : PRICE_PRECISION
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
			this.getTotalPerpPositionValueExcludingMarket(perpPosition.marketIndex);

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
			remainderBaseAssetAmount: 0,
			quoteAssetAmount: new BN(0),
			lastCumulativeFundingRate: ZERO,
			quoteEntryAmount: new BN(0),
			openOrders: 0,
			openBids: new BN(0),
			openAsks: new BN(0),
			settledPnl: ZERO,
			lpShares: ZERO,
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
			this.getOracleDataForPerpMarket(market.marketIndex)
		);

		// total position value after trade
		const totalPositionValueAfterTrade =
			totalPositionValueExcludingTargetMarket.add(proposedPerpPositionValue);

		const marginRequirementExcludingTargetMarket =
			this.getUserAccount().perpPositions.reduce(
				(totalMarginRequirement, position) => {
					if (position.marketIndex !== perpPosition.marketIndex) {
						const market = this.clearingHouse.getPerpMarketAccount(
							position.marketIndex
						);
						const positionValue = calculateBaseAssetValueWithOracle(
							market,
							position,
							this.getOracleDataForPerpMarket(market.marketIndex)
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
			markPriceAfterTrade = calculateReservePrice(
				this.clearingHouse.getPerpMarketAccount(perpPosition.marketIndex),
				this.getOracleDataForPerpMarket(perpPosition.marketIndex)
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
				this.getOracleDataForPerpMarket(perpPosition.marketIndex)
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
	 * @returns : Precision PRICE_PRECISION
	 */
	public liquidationPriceAfterClose(
		positionMarketIndex: number,
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
		targetMarketIndex: number,
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

		const oracleData = this.getOracleDataForPerpMarket(targetMarketIndex);

		// add any position we have on the opposite side of the current trade, because we can "flip" the size of this position without taking any extra leverage.
		const oppositeSizeValueUSDC = targetingSameSide
			? ZERO
			: this.getPerpPositionValue(targetMarketIndex, oracleData);

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
				const perpPositionValue = this.getPerpPositionValue(
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
		targetMarketIndex: number,
		tradeQuoteAmount: BN,
		tradeSide: PositionDirection,
		includeOpenOrders = true
	): BN {
		const currentPosition =
			this.getUserPosition(targetMarketIndex) ||
			this.getEmptyPosition(targetMarketIndex);

		const oracleData = this.getOracleDataForPerpMarket(targetMarketIndex);

		let currentPositionQuoteAmount = this.getPerpPositionValue(
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
			this.getTotalPerpPositionValueExcludingMarket(
				targetMarketIndex,
				undefined,
				undefined,
				includeOpenOrders
			);

		const totalAssetValue = this.getTotalAssetValue();

		const totalPerpPositionValue = currentPerpPositionAfterTrade
			.add(totalPositionAfterTradeExcludingTargetMarket)
			.abs();

		const totalLiabilitiesAfterTrade = totalPerpPositionValue.add(
			this.getSpotMarketLiabilityValue(undefined, undefined, undefined, false)
		);

		if (totalAssetValue.eq(ZERO) && totalLiabilitiesAfterTrade.eq(ZERO)) {
			return ZERO;
		}

		const newLeverage = totalLiabilitiesAfterTrade
			.mul(TEN_THOUSAND)
			.div(totalAssetValue);

		return newLeverage;
	}

	/**
	 * Calculates how much fee will be taken for a given sized trade
	 * @param quoteAmount
	 * @returns feeForQuote : Precision QUOTE_PRECISION
	 */
	public calculateFeeForQuoteAmount(quoteAmount: BN): BN {
		const feeTier =
			this.clearingHouse.getStateAccount().perpFeeStructure.feeTiers[0];
		return quoteAmount
			.mul(new BN(feeTier.feeNumerator))
			.div(new BN(feeTier.feeDenominator));
	}

	/**
	 * Calculates a user's max withdrawal amounts for a spot market. If reduceOnly is true,
	 * it will return the max withdrawal amount without opening a liability for the user
	 * @param marketIndex
	 * @returns withdrawalLimit : Precision is the token precision for the chosen SpotMarket
	 */
	public getWithdrawalLimit(marketIndex: number, reduceOnly?: boolean): BN {
		const nowTs = new BN(Math.floor(Date.now() / 1000));
		const spotMarket = this.clearingHouse.getSpotMarketAccount(marketIndex);

		const { borrowLimit, withdrawLimit } = calculateWithdrawLimit(
			spotMarket,
			nowTs
		);

		const freeCollateral = this.getFreeCollateral();
		const oracleData = this.getOracleDataForSpotMarket(marketIndex);
		const precisionIncrease = TEN.pow(new BN(spotMarket.decimals - 6));

		const amountWithdrawable = freeCollateral
			.mul(MARGIN_PRECISION)
			.div(spotMarket.initialAssetWeight)
			.mul(PRICE_PRECISION)
			.div(oracleData.price)
			.mul(precisionIncrease);

		const userSpotPosition = this.getUserAccount().spotPositions.find(
			(spotPosition) =>
				isVariant(spotPosition.balanceType, 'deposit') &&
				spotPosition.marketIndex == marketIndex
		);

		const userSpotBalance = userSpotPosition
			? getTokenAmount(
					userSpotPosition.scaledBalance,
					this.clearingHouse.getSpotMarketAccount(marketIndex),
					SpotBalanceType.DEPOSIT
			  )
			: ZERO;

		const maxWithdrawValue = BN.min(
			BN.min(amountWithdrawable, userSpotBalance),
			withdrawLimit.abs()
		);

		if (reduceOnly) {
			return BN.max(maxWithdrawValue, ZERO);
		} else {
			const weightedAssetValue = this.getSpotMarketAssetValue(
				marketIndex,
				'Initial',
				false
			);

			const freeCollatAfterWithdraw = userSpotBalance.gt(ZERO)
				? freeCollateral.sub(weightedAssetValue)
				: freeCollateral;

			const maxLiabilityAllowed = freeCollatAfterWithdraw
				.mul(MARGIN_PRECISION)
				.div(spotMarket.initialLiabilityWeight)
				.mul(PRICE_PRECISION)
				.div(oracleData.price)
				.mul(precisionIncrease);

			const maxBorrowValue = BN.min(
				maxWithdrawValue.add(maxLiabilityAllowed),
				borrowLimit.abs()
			);

			return BN.max(maxBorrowValue, ZERO);
		}
	}

	/**
	 * Get the total position value, excluding any position coming from the given target market
	 * @param marketToIgnore
	 * @returns positionValue : Precision QUOTE_PRECISION
	 */
	private getTotalPerpPositionValueExcludingMarket(
		marketToIgnore: number,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean
	): BN {
		const currentPerpPosition =
			this.getUserPosition(marketToIgnore) ||
			this.getEmptyPosition(marketToIgnore);

		const oracleData = this.getOracleDataForPerpMarket(marketToIgnore);

		let currentPerpPositionValueUSDC = ZERO;
		if (currentPerpPosition) {
			currentPerpPositionValueUSDC = this.getPerpPositionValue(
				marketToIgnore,
				oracleData
			);
		}

		return this.getTotalPerpPositionValue(
			marginCategory,
			liquidationBuffer,
			includeOpenOrders
		).sub(currentPerpPositionValueUSDC);
	}

	private getOracleDataForPerpMarket(marketIndex: number): OraclePriceData {
		const oracleKey =
			this.clearingHouse.getPerpMarketAccount(marketIndex).amm.oracle;
		const oracleData =
			this.clearingHouse.getOraclePriceDataAndSlot(oracleKey).data;

		return oracleData;
	}
	private getOracleDataForSpotMarket(marketIndex: number): OraclePriceData {
		const oracleKey =
			this.clearingHouse.getSpotMarketAccount(marketIndex).oracle;

		const oracleData =
			this.clearingHouse.getOraclePriceDataAndSlot(oracleKey).data;

		return oracleData;
	}
}
