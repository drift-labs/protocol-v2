import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import { DriftClient } from './driftClient';
import {
	isVariant,
	MarginCategory,
	Order,
	UserAccount,
	PerpPosition,
	SpotPosition,
	isOneOfVariant,
	PerpMarketAccount,
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
	MARGIN_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
	TEN,
	OPEN_ORDER_MARGIN_REQUIREMENT,
	FIVE_MINUTE,
	BASE_PRECISION,
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
	BN,
	SpotMarketAccount,
	getTokenValue,
	getStrictTokenValue,
	getSignedTokenAmount,
} from '.';
import {
	getTokenAmount,
	calculateAssetWeight,
	calculateLiabilityWeight,
	calculateWithdrawLimit,
} from './math/spotBalance';
import { calculateMarketOpenBidAsk } from './math/amm';
import {
	calculateBaseAssetValueWithOracle,
	calculateWorstCaseBaseAssetAmount,
} from './math/margin';
import { OraclePriceData } from './oracles/types';
import { UserConfig } from './userConfig';
import { PollingUserAccountSubscriber } from './accounts/pollingUserAccountSubscriber';
import { WebSocketUserAccountSubscriber } from './accounts/webSocketUserAccountSubscriber';
import {
	getWorstCaseTokenAmounts,
	isSpotPositionAvailable,
} from './math/spotPosition';

import { calculateLiveOracleTwap } from './math/oracles';

export class User {
	driftClient: DriftClient;
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

	public constructor(config: UserConfig) {
		this.driftClient = config.driftClient;
		this.userAccountPublicKey = config.userAccountPublicKey;
		if (config.accountSubscription?.type === 'polling') {
			this.accountSubscriber = new PollingUserAccountSubscriber(
				config.driftClient.program,
				config.userAccountPublicKey,
				config.accountSubscription.accountLoader
			);
		} else {
			this.accountSubscriber = new WebSocketUserAccountSubscriber(
				config.driftClient.program,
				config.userAccountPublicKey
			);
		}
		this.eventEmitter = this.accountSubscriber.eventEmitter;
	}

	/**
	 * Subscribe to User state accounts
	 * @returns SusbcriptionSuccess result
	 */
	public async subscribe(userAccount?: UserAccount): Promise<boolean> {
		this.isSubscribed = await this.accountSubscriber.subscribe(userAccount);
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

	public async forceGetUserAccount(): Promise<UserAccount> {
		await this.fetchAccounts();
		return this.accountSubscriber.getUserAccountAndSlot().data;
	}

	public getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined {
		return this.accountSubscriber.getUserAccountAndSlot();
	}

	/**
	 * Gets the user's current position for a given perp market. If the user has no position returns undefined
	 * @param marketIndex
	 * @returns userPerpPosition
	 */
	public getPerpPosition(marketIndex: number): PerpPosition | undefined {
		return this.getUserAccount().perpPositions.find(
			(position) => position.marketIndex === marketIndex
		);
	}

	/**
	 * Gets the user's current position for a given spot market. If the user has no position returns undefined
	 * @param marketIndex
	 * @returns userSpotPosition
	 */
	public getSpotPosition(marketIndex: number): SpotPosition | undefined {
		return this.getUserAccount().spotPositions.find(
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
			quoteBreakEvenAmount: ZERO,
			openOrders: 0,
			openBids: ZERO,
			openAsks: ZERO,
			settledPnl: ZERO,
			lpShares: ZERO,
			lastBaseAssetAmountPerLp: ZERO,
			lastQuoteAssetAmountPerLp: ZERO,
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
			await this.driftClient.connection.getParsedAccountInfo(
				this.userAccountPublicKey
			);
		return userAccountRPCResponse.value !== null;
	}

	/**
	 * calculates the total open bids/asks in a perp market (including lps)
	 * @returns : open bids
	 * @returns : open asks
	 */
	public getPerpBidAsks(marketIndex: number): [BN, BN] {
		const position = this.getPerpPosition(marketIndex);

		const [lpOpenBids, lpOpenAsks] = this.getLPBidAsks(marketIndex);

		const totalOpenBids = lpOpenBids.add(position.openBids);
		const totalOpenAsks = lpOpenAsks.add(position.openAsks);

		return [totalOpenBids, totalOpenAsks];
	}

	/**
	 * calculates the open bids and asks for an lp
	 * @returns : lp open bids
	 * @returns : lp open asks
	 */
	public getLPBidAsks(marketIndex: number): [BN, BN] {
		const position = this.getPerpPosition(marketIndex);
		if (position === undefined || position.lpShares.eq(ZERO)) {
			return [ZERO, ZERO];
		}

		const market = this.driftClient.getPerpMarketAccount(marketIndex);
		const [marketOpenBids, marketOpenAsks] = calculateMarketOpenBidAsk(
			market.amm.baseAssetReserve,
			market.amm.minBaseAssetReserve,
			market.amm.maxBaseAssetReserve,
			market.amm.orderStepSize
		);

		const lpOpenBids = marketOpenBids
			.mul(position.lpShares)
			.div(market.amm.sqrtK);
		const lpOpenAsks = marketOpenAsks
			.mul(position.lpShares)
			.div(market.amm.sqrtK);

		return [lpOpenBids, lpOpenAsks];
	}

	/**
	 * calculates the market position if the lp position was settled
	 * @returns : the settled userPosition
	 * @returns : the dust base asset amount (ie, < stepsize)
	 * @returns : pnl from settle
	 */
	public getSettledLPPosition(marketIndex: number): [PerpPosition, BN, BN] {
		const _position = this.getPerpPosition(marketIndex);
		const position = this.getClonedPosition(_position);

		if (position.lpShares.eq(ZERO)) {
			return [position, ZERO, ZERO];
		}

		const market = this.driftClient.getPerpMarketAccount(position.marketIndex);
		const nShares = position.lpShares;

		const deltaBaa = market.amm.baseAssetAmountPerLp
			.sub(position.lastBaseAssetAmountPerLp)
			.mul(nShares)
			.div(AMM_RESERVE_PRECISION);
		const deltaQaa = market.amm.quoteAssetAmountPerLp
			.sub(position.lastQuoteAssetAmountPerLp)
			.mul(nShares)
			.div(AMM_RESERVE_PRECISION);

		function sign(v: BN) {
			const sign = { true: new BN(1), false: new BN(-1) }[
				v.gte(ZERO).toString()
			];
			return sign;
		}

		function standardize(amount: BN, stepsize: BN) {
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
				new BN(position.remainderBaseAssetAmount),
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
	 * calculates Buying Power = free collateral / initial margin ratio
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getBuyingPower(marketIndex: number): BN {
		const perpPosition = this.getPerpPosition(marketIndex);
		const worstCaseBaseAssetAmount = perpPosition
			? calculateWorstCaseBaseAssetAmount(perpPosition)
			: ZERO;

		const freeCollateral = this.getFreeCollateral();

		return this.getBuyingPowerFromFreeCollateralAndBaseAssetAmount(
			marketIndex,
			freeCollateral,
			worstCaseBaseAssetAmount
		);
	}

	getBuyingPowerFromFreeCollateralAndBaseAssetAmount(
		marketIndex: number,
		freeCollateral: BN,
		baseAssetAmount: BN
	): BN {
		const marginRatio = calculateMarketMarginRatio(
			this.driftClient.getPerpMarketAccount(marketIndex),
			baseAssetAmount,
			'Initial'
		);

		return freeCollateral.mul(MARGIN_PRECISION).div(new BN(marginRatio));
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
		liquidationBuffer?: BN,
		strict = false
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
				true,
				strict
			)
		);
	}

	/**
	 * @returns The initial margin requirement in USDC. : QUOTE_PRECISION
	 */
	public getInitialMarginRequirement(): BN {
		return this.getMarginRequirement('Initial', undefined, true);
	}

	/**
	 * @returns The maintenance margin requirement in USDC. : QUOTE_PRECISION
	 */
	public getMaintenanceMarginRequirement(liquidationBuffer?: BN): BN {
		return this.getMarginRequirement('Maintenance', liquidationBuffer);
	}

	public getActivePerpPositions(): PerpPosition[] {
		return this.getUserAccount().perpPositions.filter(
			(pos) =>
				!pos.baseAssetAmount.eq(ZERO) ||
				!pos.quoteAssetAmount.eq(ZERO) ||
				!(pos.openOrders == 0) ||
				!pos.lpShares.eq(ZERO)
		);
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
		const quoteSpotMarket = this.driftClient.getQuoteSpotMarketAccount();
		return this.getActivePerpPositions()
			.filter((pos) => (marketIndex ? pos.marketIndex === marketIndex : true))
			.reduce((unrealizedPnl, perpPosition) => {
				const market = this.driftClient.getPerpMarketAccount(
					perpPosition.marketIndex
				);
				const oraclePriceData = this.getOracleDataForPerpMarket(
					market.marketIndex
				);

				if (perpPosition.lpShares.gt(ZERO)) {
					perpPosition = this.getSettledLPPosition(perpPosition.marketIndex)[0];
				}

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
				const market = this.driftClient.getPerpMarketAccount(
					perpPosition.marketIndex
				);
				return pnl.add(calculatePositionFundingPNL(market, perpPosition));
			}, ZERO);
	}

	public getSpotMarketLiabilityValue(
		marketIndex?: number,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict = false,
		now?: BN
	): BN {
		now = now || new BN(new Date().getTime() / 1000);
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
					this.driftClient.getSpotMarketAccount(spotPosition.marketIndex);

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
							liquidationBuffer,
							strict,
							now
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
						liquidationBuffer,
						strict,
						now
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

				newTotalLiabilityValue = newTotalLiabilityValue.add(
					new BN(spotPosition.openOrders).mul(OPEN_ORDER_MARGIN_REQUIREMENT)
				);

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
		liquidationBuffer?: BN,
		strict = false,
		now?: BN
	): BN {
		let liabilityValue = null;

		if (strict && spotMarketAccount.marketIndex != QUOTE_SPOT_MARKET_INDEX) {
			const estOracleTwap = calculateLiveOracleTwap(
				spotMarketAccount.historicalOracleData,
				oraclePriceData,
				now,
				FIVE_MINUTE // 5MIN
			);
			liabilityValue = getStrictTokenValue(
				tokenAmount,
				spotMarketAccount.decimals,
				oraclePriceData,
				estOracleTwap
			);
		} else {
			liabilityValue = getTokenValue(
				tokenAmount,
				spotMarketAccount.decimals,
				oraclePriceData
			);
		}

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
		includeOpenOrders?: boolean,
		strict = false,
		now?: BN
	): BN {
		now = now || new BN(new Date().getTime() / 1000);
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
					this.driftClient.getSpotMarketAccount(spotPosition.marketIndex);

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
							marginCategory,
							strict,
							now
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
						marginCategory,
						strict,
						now
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
		marginCategory?: MarginCategory,
		strict = false,
		now?: BN
	): BN {
		let assetValue = null;
		if (strict && spotMarketAccount.marketIndex != QUOTE_SPOT_MARKET_INDEX) {
			const estOracleTwap = calculateLiveOracleTwap(
				spotMarketAccount.historicalOracleData,
				oraclePriceData,
				now,
				FIVE_MINUTE // 5MIN
			);
			assetValue = getStrictTokenValue(
				tokenAmount,
				spotMarketAccount.decimals,
				oraclePriceData,
				estOracleTwap
			);
		} else {
			assetValue = getTokenValue(
				tokenAmount,
				spotMarketAccount.decimals,
				oraclePriceData
			);
		}

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
	 * calculates User Health by comparing total collateral and maint. margin requirement
	 * @returns : number (value from [0, 100])
	 */
	public getHealth(): number {
		const userAccount = this.getUserAccount();

		if (
			isVariant(userAccount.status, 'beingLiquidated') ||
			isVariant(userAccount.status, 'bankrupt')
		) {
			return 0;
		}

		const totalCollateral = this.getTotalCollateral('Maintenance');
		const maintenanceMarginReq = this.getMaintenanceMarginRequirement();

		let health: number;

		if (maintenanceMarginReq.eq(ZERO) && totalCollateral.gte(ZERO)) {
			health = 100;
		} else if (totalCollateral.lte(ZERO)) {
			health = 0;
		} else {
			const healthP1 =
				Math.max(
					0,
					(1 - maintenanceMarginReq.toNumber() / totalCollateral.toNumber()) *
						100
				) + 1;

			health = Math.min(1, Math.log(healthP1) / Math.log(100)) * 100;
			if (health > 1) {
				health = Math.round(health);
			} else {
				health = Math.round(health * 100) / 100;
			}
		}

		return health;
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
		return this.getActivePerpPositions().reduce(
			(totalPerpValue, perpPosition) => {
				const market = this.driftClient.getPerpMarketAccount(
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

					const [totalOpenBids, totalOpenAsks] = this.getPerpBidAsks(
						market.marketIndex
					);

					perpPosition.openAsks = totalOpenAsks;
					perpPosition.openBids = totalOpenBids;
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

					if (includeOpenOrders) {
						baseAssetValue = baseAssetValue.add(
							new BN(perpPosition.openOrders).mul(OPEN_ORDER_MARGIN_REQUIREMENT)
						);
					}
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
		oraclePriceData: OraclePriceData,
		includeOpenOrders = false
	): BN {
		const userPosition =
			this.getPerpPosition(marketIndex) || this.getEmptyPosition(marketIndex);
		const market = this.driftClient.getPerpMarketAccount(
			userPosition.marketIndex
		);
		return calculateBaseAssetValueWithOracle(
			market,
			userPosition,
			oraclePriceData,
			includeOpenOrders
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
		const market = this.driftClient.getPerpMarketAccount(position.marketIndex);

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
	 * calculates current user leverage which is (total liability size) / (net asset value)
	 * @returns : Precision TEN_THOUSAND
	 */
	public getLeverage(): BN {
		const totalPerpLiability = this.getTotalPerpPositionValue(
			undefined,
			undefined,
			true
		);
		const totalSpotLiability = this.getSpotMarketLiabilityValue(
			undefined,
			undefined,
			undefined,
			true
		);

		const totalLiabilityValue = totalPerpLiability.add(totalSpotLiability);

		const totalAssetValue = this.getTotalAssetValue();
		const netAssetValue = totalAssetValue.sub(totalSpotLiability);

		if (netAssetValue.eq(ZERO)) {
			return ZERO;
		}

		return totalLiabilityValue.mul(TEN_THOUSAND).div(netAssetValue);
	}

	getTotalLiabilityValue(marginCategory?: MarginCategory): BN {
		return this.getTotalPerpPositionValue(marginCategory, undefined, true).add(
			this.getSpotMarketLiabilityValue(
				undefined,
				marginCategory,
				undefined,
				true
			)
		);
	}

	getTotalAssetValue(marginCategory?: MarginCategory): BN {
		return this.getSpotMarketAssetValue(undefined, marginCategory, true).add(
			this.getUnrealizedPNL(true, undefined, marginCategory)
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
		const market = this.driftClient.getPerpMarketAccount(marketIndex);

		const totalPerpLiability = this.getTotalPerpPositionValue(
			undefined,
			undefined,
			true
		);
		const totalSpotLiability = this.getSpotMarketLiabilityValue(
			undefined,
			undefined,
			undefined,
			true
		);

		const totalAssetValue = this.getTotalAssetValue();

		const netAssetValue = totalAssetValue.sub(totalSpotLiability);

		if (netAssetValue.eq(ZERO)) {
			return ZERO;
		}

		const totalLiabilityValue = totalPerpLiability.add(totalSpotLiability);

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
			.div(netAssetValue);
	}

	/**
	 * calculates margin ratio: total collateral / |total position value|
	 * @returns : Precision TEN_THOUSAND
	 */
	public getMarginRatio(marginCategory?: MarginCategory): BN {
		const totalPerpLiability = this.getTotalPerpPositionValue(
			undefined,
			undefined,
			true
		);
		const totalSpotLiability = this.getSpotMarketLiabilityValue(
			undefined,
			undefined,
			undefined,
			true
		);

		const totalLiabilityValue = totalPerpLiability.add(totalSpotLiability);

		if (totalLiabilityValue.eq(ZERO)) {
			return BN_MAX;
		}

		const totalAssetValue = this.getTotalAssetValue(marginCategory);
		const netAssetValue = totalAssetValue.sub(totalSpotLiability);

		return netAssetValue.mul(TEN_THOUSAND).div(totalLiabilityValue);
	}

	public canBeLiquidated(): boolean {
		const totalCollateral = this.getTotalCollateral('Maintenance');

		// if user being liq'd, can continue to be liq'd until total collateral above the margin requirement plus buffer
		let liquidationBuffer = undefined;
		const isBeingLiquidated = isVariant(
			this.getUserAccount().status,
			'beingLiquidated'
		);

		if (isBeingLiquidated) {
			liquidationBuffer = new BN(
				this.driftClient.getStateAccount().liquidationMarginBufferRatio
			);
		}
		const maintenanceRequirement =
			this.getMaintenanceMarginRequirement(liquidationBuffer);
		return totalCollateral.lt(maintenanceRequirement);
	}

	public isBeingLiquidated(): boolean {
		return isOneOfVariant(this.getUserAccount().status, [
			'beingLiquidated',
			'bankrupt',
		]);
	}

	public isBankrupt(): boolean {
		return isVariant(this.getUserAccount().status, 'bankrupt');
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

			const market = this.driftClient.getPerpMarketAccount(
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
	 * Calculate the liquidation price of a spot position
	 * @param marketIndex
	 * @returns Precision : PRICE_PRECISION
	 */
	public spotLiquidationPrice(marketIndex: number): BN {
		const currentSpotPosition = this.getSpotPosition(marketIndex);

		if (!currentSpotPosition) {
			return new BN(-1);
		}

		const totalCollateral = this.getTotalCollateral('Maintenance');
		const maintenanceMarginRequirement = this.getMaintenanceMarginRequirement();
		const freeCollateral = BN.max(
			ZERO,
			totalCollateral.sub(maintenanceMarginRequirement)
		);

		const market = this.driftClient.getSpotMarketAccount(marketIndex);
		const signedTokenAmount = getSignedTokenAmount(
			getTokenAmount(
				currentSpotPosition.scaledBalance,
				market,
				currentSpotPosition.balanceType
			),
			currentSpotPosition.balanceType
		);

		if (signedTokenAmount.eq(ZERO)) {
			return new BN(-1);
		}

		let freeCollateralDelta = this.calculateFreeCollateralDeltaForSpot(
			market,
			signedTokenAmount
		);

		const oracle = market.oracle;
		const perpMarketWithSameOracle = this.driftClient
			.getPerpMarketAccounts()
			.find((market) => market.amm.oracle.equals(oracle));
		if (perpMarketWithSameOracle) {
			const perpPosition = this.getPerpPosition(
				perpMarketWithSameOracle.marketIndex
			);
			if (perpPosition) {
				const freeCollateralDeltaForPerp =
					this.calculateFreeCollateralDeltaForPerp(
						perpMarketWithSameOracle,
						perpPosition,
						ZERO
					);

				freeCollateralDelta = freeCollateralDelta.add(
					freeCollateralDeltaForPerp
				);
			}
		}

		if (freeCollateralDelta.eq(ZERO)) {
			return new BN(-1);
		}

		const oraclePrice =
			this.driftClient.getOracleDataForSpotMarket(marketIndex).price;
		const liqPriceDelta = freeCollateral
			.mul(QUOTE_PRECISION)
			.div(freeCollateralDelta);

		const liqPrice = oraclePrice.sub(liqPriceDelta);

		if (liqPrice.lt(ZERO)) {
			return new BN(-1);
		}

		return liqPrice;
	}

	/**
	 * Calculate the liquidation price of a perp position, with optional parameter to calculate the liquidation price after a trade
	 * @param marketIndex
	 * @param positionBaseSizeChange // change in position size to calculate liquidation price for : Precision 10^13
	 * @returns Precision : PRICE_PRECISION
	 */
	public liquidationPrice(
		marketIndex: number,
		positionBaseSizeChange: BN = ZERO
	): BN {
		const totalCollateral = this.getTotalCollateral('Maintenance');
		const maintenanceMarginRequirement = this.getMaintenanceMarginRequirement();
		const freeCollateral = BN.max(
			ZERO,
			totalCollateral.sub(maintenanceMarginRequirement)
		);

		const market = this.driftClient.getPerpMarketAccount(marketIndex);
		const currentPerpPosition = this.getPerpPosition(marketIndex);

		let freeCollateralDelta = this.calculateFreeCollateralDeltaForPerp(
			market,
			currentPerpPosition,
			positionBaseSizeChange
		);

		if (!freeCollateral) {
			return new BN(-1);
		}

		const oracle =
			this.driftClient.getPerpMarketAccount(marketIndex).amm.oracle;
		const spotMarketWithSameOracle = this.driftClient
			.getSpotMarketAccounts()
			.find((market) => market.oracle.equals(oracle));
		if (spotMarketWithSameOracle) {
			const spotPosition = this.getSpotPosition(
				spotMarketWithSameOracle.marketIndex
			);
			if (spotPosition) {
				const signedTokenAmount = getSignedTokenAmount(
					getTokenAmount(
						spotPosition.scaledBalance,
						spotMarketWithSameOracle,
						spotPosition.balanceType
					),
					spotPosition.balanceType
				);

				const spotFreeCollateralDelta =
					this.calculateFreeCollateralDeltaForSpot(
						spotMarketWithSameOracle,
						signedTokenAmount
					);
				freeCollateralDelta = freeCollateralDelta.add(spotFreeCollateralDelta);
			}
		}

		if (freeCollateralDelta.eq(ZERO)) {
			return new BN(-1);
		}

		const oraclePrice =
			this.driftClient.getOracleDataForPerpMarket(marketIndex).price;
		const liqPriceDelta = freeCollateral
			.mul(QUOTE_PRECISION)
			.div(freeCollateralDelta);

		const liqPrice = oraclePrice.sub(liqPriceDelta);

		if (liqPrice.lt(ZERO)) {
			return new BN(-1);
		}

		return liqPrice;
	}

	calculateFreeCollateralDeltaForPerp(
		market: PerpMarketAccount,
		perpPosition: PerpPosition,
		positionBaseSizeChange: BN
	): BN | undefined {
		const currentBaseAssetAmount = perpPosition.baseAssetAmount;

		const worstCaseBaseAssetAmount =
			calculateWorstCaseBaseAssetAmount(perpPosition);
		const orderBaseAssetAmount = worstCaseBaseAssetAmount.sub(
			currentBaseAssetAmount
		);
		const proposedBaseAssetAmount = currentBaseAssetAmount.add(
			positionBaseSizeChange
		);
		const proposedWorstCaseBaseAssetAmount = worstCaseBaseAssetAmount.add(
			positionBaseSizeChange
		);

		const marginRatio = calculateMarketMarginRatio(
			market,
			proposedWorstCaseBaseAssetAmount.abs(),
			'Maintenance'
		);
		const marginRatioQuotePrecision = new BN(marginRatio)
			.mul(QUOTE_PRECISION)
			.div(MARGIN_PRECISION);

		if (proposedWorstCaseBaseAssetAmount.eq(ZERO)) {
			return undefined;
		}

		let freeCollateralDelta = ZERO;
		if (proposedBaseAssetAmount.gt(ZERO)) {
			freeCollateralDelta = QUOTE_PRECISION.sub(marginRatioQuotePrecision)
				.mul(proposedBaseAssetAmount)
				.div(BASE_PRECISION);
		} else {
			freeCollateralDelta = QUOTE_PRECISION.neg()
				.sub(marginRatioQuotePrecision)
				.mul(proposedBaseAssetAmount.abs())
				.div(BASE_PRECISION);
		}

		if (!orderBaseAssetAmount.eq(ZERO)) {
			freeCollateralDelta = freeCollateralDelta.sub(marginRatioQuotePrecision);
		}

		return freeCollateralDelta;
	}

	calculateFreeCollateralDeltaForSpot(
		market: SpotMarketAccount,
		signedTokenAmount: BN
	): BN {
		const tokenPrecision = new BN(Math.pow(10, market.decimals));

		if (signedTokenAmount.gt(ZERO)) {
			const assetWeight = calculateAssetWeight(
				signedTokenAmount,
				market,
				'Maintenance'
			);

			return QUOTE_PRECISION.mul(assetWeight)
				.div(SPOT_MARKET_WEIGHT_PRECISION)
				.mul(signedTokenAmount)
				.div(tokenPrecision);
		} else {
			const liabilityWeight = calculateLiabilityWeight(
				signedTokenAmount.abs(),
				market,
				'Maintenance'
			);

			return QUOTE_PRECISION.neg()
				.mul(liabilityWeight)
				.div(SPOT_MARKET_WEIGHT_PRECISION)
				.mul(signedTokenAmount.abs())
				.div(tokenPrecision);
		}
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
			this.getPerpPosition(positionMarketIndex) ||
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

		return this.liquidationPrice(positionMarketIndex, closeBaseAmount);
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
			this.getPerpPosition(targetMarketIndex) ||
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
				const market = this.driftClient.getPerpMarketAccount(targetMarketIndex);
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
					const buyingPowerAfterClose =
						this.getBuyingPowerFromFreeCollateralAndBaseAssetAmount(
							targetMarketIndex,
							freeCollateralAfterClose,
							ZERO
						);
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
			this.getPerpPosition(targetMarketIndex) ||
			this.getEmptyPosition(targetMarketIndex);

		const oracleData = this.getOracleDataForPerpMarket(targetMarketIndex);

		let currentPositionQuoteAmount = this.getPerpPositionValue(
			targetMarketIndex,
			oracleData,
			includeOpenOrders
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

		const totalPerpPositionLiability = currentPerpPositionAfterTrade
			.add(totalPositionAfterTradeExcludingTargetMarket)
			.abs();

		const totalSpotLiability = this.getSpotMarketLiabilityValue(
			undefined,
			undefined,
			undefined,
			includeOpenOrders
		);

		const totalLiabilitiesAfterTrade =
			totalPerpPositionLiability.add(totalSpotLiability);

		const netAssetValue = totalAssetValue.sub(totalSpotLiability);

		if (netAssetValue.eq(ZERO)) {
			return ZERO;
		}

		const newLeverage = totalLiabilitiesAfterTrade
			.mul(TEN_THOUSAND)
			.div(netAssetValue);

		return newLeverage;
	}

	/**
	 * Calculates how much fee will be taken for a given sized trade
	 * @param quoteAmount
	 * @returns feeForQuote : Precision QUOTE_PRECISION
	 */
	public calculateFeeForQuoteAmount(quoteAmount: BN): BN {
		const feeTier =
			this.driftClient.getStateAccount().perpFeeStructure.feeTiers[0];
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
		const spotMarket = this.driftClient.getSpotMarketAccount(marketIndex);

		// eslint-disable-next-line prefer-const
		let { borrowLimit, withdrawLimit } = calculateWithdrawLimit(
			spotMarket,
			nowTs
		);

		const freeCollateral = this.getFreeCollateral();
		const oracleData = this.getOracleDataForSpotMarket(marketIndex);
		const precisionIncrease = TEN.pow(new BN(spotMarket.decimals - 6));

		const { canBypass, depositAmount: userDepositAmount } =
			this.canBypassWithdrawLimits(marketIndex);
		if (canBypass) {
			withdrawLimit = BN.max(withdrawLimit, userDepositAmount);
		}

		const amountWithdrawable = freeCollateral
			.mul(MARGIN_PRECISION)
			.div(new BN(spotMarket.initialAssetWeight))
			.mul(PRICE_PRECISION)
			.div(oracleData.price)
			.mul(precisionIncrease);

		const maxWithdrawValue = BN.min(
			BN.min(amountWithdrawable, userDepositAmount),
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

			const freeCollatAfterWithdraw = userDepositAmount.gt(ZERO)
				? freeCollateral.sub(weightedAssetValue)
				: freeCollateral;

			const maxLiabilityAllowed = freeCollatAfterWithdraw
				.mul(MARGIN_PRECISION)
				.div(new BN(spotMarket.initialLiabilityWeight))
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

	public canBypassWithdrawLimits(marketIndex: number): {
		canBypass: boolean;
		netDeposits: BN;
		depositAmount: BN;
		maxDepositAmount: BN;
	} {
		const spotMarket = this.driftClient.getSpotMarketAccount(marketIndex);
		const maxDepositAmount = spotMarket.withdrawGuardThreshold.div(new BN(10));
		const position = this.getSpotPosition(marketIndex);

		const netDeposits = this.getUserAccount().totalDeposits.sub(
			this.getUserAccount().totalWithdraws
		);

		if (!position) {
			return {
				canBypass: false,
				maxDepositAmount,
				depositAmount: ZERO,
				netDeposits,
			};
		}

		if (isVariant(position.balanceType, 'borrow')) {
			return {
				canBypass: false,
				maxDepositAmount,
				netDeposits,
				depositAmount: ZERO,
			};
		}

		const depositAmount = getTokenAmount(
			position.scaledBalance,
			spotMarket,
			'deposit'
		);

		if (netDeposits.lt(ZERO)) {
			return {
				canBypass: false,
				maxDepositAmount,
				depositAmount,
				netDeposits,
			};
		}

		return {
			canBypass: depositAmount.lt(maxDepositAmount),
			maxDepositAmount,
			netDeposits,
			depositAmount,
		};
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
			this.getPerpPosition(marketToIgnore) ||
			this.getEmptyPosition(marketToIgnore);

		const oracleData = this.getOracleDataForPerpMarket(marketToIgnore);

		let currentPerpPositionValueUSDC = ZERO;
		if (currentPerpPosition) {
			currentPerpPositionValueUSDC = this.getPerpPositionValue(
				marketToIgnore,
				oracleData,
				includeOpenOrders
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
			this.driftClient.getPerpMarketAccount(marketIndex).amm.oracle;
		const oracleData =
			this.driftClient.getOraclePriceDataAndSlot(oracleKey).data;

		return oracleData;
	}
	private getOracleDataForSpotMarket(marketIndex: number): OraclePriceData {
		const oracleKey = this.driftClient.getSpotMarketAccount(marketIndex).oracle;

		const oracleData =
			this.driftClient.getOraclePriceDataAndSlot(oracleKey).data;

		return oracleData;
	}
}
