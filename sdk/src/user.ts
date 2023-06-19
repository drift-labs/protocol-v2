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
import { calculateEntryPrice, positionIsAvailable } from './math/position';
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
	ONE,
	TWO,
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
	MarketType,
	getStrictTokenValue,
	calculateSpotMarketMarginRatio,
	getSignedTokenAmount,
	SpotBalanceType,
	sigNum,
	getBalance,
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
import { getPerpMarketTierNumber, getSpotMarketTierNumber } from './math/tiers';

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
		} else if (config.accountSubscription?.type === 'custom') {
			this.accountSubscriber = config.accountSubscription.userAccountSubscriber;
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

	getEmptySpotPosition(marketIndex: number): SpotPosition {
		return {
			marketIndex,
			scaledBalance: ZERO,
			balanceType: SpotBalanceType.DEPOSIT,
			cumulativeDeposits: ZERO,
			openAsks: ZERO,
			openBids: ZERO,
			openOrders: 0,
		};
	}

	/**
	 * Returns the token amount for a given market. The spot market precision is based on the token mint decimals.
	 * Positive if it is a deposit, negative if it is a borrow.
	 *
	 * @param marketIndex
	 */
	public getTokenAmount(marketIndex: number): BN {
		const spotPosition = this.getSpotPosition(marketIndex);
		if (spotPosition === undefined) {
			return ZERO;
		}
		const spotMarket = this.driftClient.getSpotMarketAccount(marketIndex);
		return getSignedTokenAmount(
			getTokenAmount(
				spotPosition.scaledBalance,
				spotMarket,
				spotPosition.balanceType
			),
			spotPosition.balanceType
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

	public getOpenOrders(): Order[] {
		return this.getUserAccount()?.orders.filter((order) =>
			isVariant(order.status, 'open')
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
	public getPerpPositionWithLPSettle(
		marketIndex: number,
		originalPosition?: PerpPosition
	): [PerpPosition, BN, BN] {
		originalPosition =
			originalPosition ??
			this.getPerpPosition(marketIndex) ??
			this.getEmptyPosition(marketIndex);

		if (originalPosition.lpShares.eq(ZERO)) {
			return [originalPosition, ZERO, ZERO];
		}

		const position = this.getClonedPosition(originalPosition);

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
			return v.isNeg() ? new BN(-1) : new BN(1);
		}

		function standardize(amount: BN, stepSize: BN) {
			const remainder = amount.abs().mod(stepSize).mul(sign(amount));
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
			pnl = ZERO;
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
	public getPerpBuyingPower(marketIndex: number): BN {
		const perpPosition = this.getPerpPosition(marketIndex);
		const worstCaseBaseAssetAmount = perpPosition
			? calculateWorstCaseBaseAssetAmount(perpPosition)
			: ZERO;

		const freeCollateral = this.getFreeCollateral();

		return this.getPerpBuyingPowerFromFreeCollateralAndBaseAssetAmount(
			marketIndex,
			freeCollateral,
			worstCaseBaseAssetAmount
		);
	}

	getPerpBuyingPowerFromFreeCollateralAndBaseAssetAmount(
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
		const totalCollateral = this.getTotalCollateral('Initial', true);
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
			true,
			strict
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

	public getActiveSpotPositions(): SpotPosition[] {
		return this.getUserAccount().spotPositions.filter(
			(pos) => !isSpotPositionAvailable(pos)
		);
	}

	/**
	 * calculates unrealized position price pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getUnrealizedPNL(
		withFunding?: boolean,
		marketIndex?: number,
		withWeightMarginCategory?: MarginCategory,
		strict = false
	): BN {
		return this.getActivePerpPositions()
			.filter((pos) => (marketIndex ? pos.marketIndex === marketIndex : true))
			.reduce((unrealizedPnl, perpPosition) => {
				const market = this.driftClient.getPerpMarketAccount(
					perpPosition.marketIndex
				);
				const oraclePriceData = this.getOracleDataForPerpMarket(
					market.marketIndex
				);

				const quoteSpotMarket = this.driftClient.getSpotMarketAccount(
					market.quoteSpotMarketIndex
				);
				const quoteOraclePriceData = this.getOracleDataForSpotMarket(
					market.quoteSpotMarketIndex
				);

				if (perpPosition.lpShares.gt(ZERO)) {
					perpPosition = this.getPerpPositionWithLPSettle(
						perpPosition.marketIndex
					)[0];
				}

				let positionUnrealizedPnl = calculatePositionPNL(
					market,
					perpPosition,
					withFunding,
					oraclePriceData
				);

				let quotePrice;
				if (strict && positionUnrealizedPnl.gt(ZERO)) {
					quotePrice = BN.min(
						quoteOraclePriceData.price,
						quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
					);
				} else if (strict && positionUnrealizedPnl.lt(ZERO)) {
					quotePrice = BN.max(
						quoteOraclePriceData.price,
						quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
					);
				} else {
					quotePrice = quoteOraclePriceData.price;
				}

				positionUnrealizedPnl = positionUnrealizedPnl
					.mul(quotePrice)
					.div(new BN(PRICE_PRECISION));

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

	public getSpotMarketAssetAndLiabilityValue(
		marketIndex?: number,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict = false,
		now?: BN
	): { totalAssetValue: BN; totalLiabilityValue: BN } {
		now = now || new BN(new Date().getTime() / 1000);
		let netQuoteValue = ZERO;
		let totalAssetValue = ZERO;
		let totalLiabilityValue = ZERO;
		for (const spotPosition of this.getUserAccount().spotPositions) {
			const countForBase =
				marketIndex === undefined || spotPosition.marketIndex === marketIndex;

			const countForQuote =
				marketIndex === undefined ||
				marketIndex === QUOTE_SPOT_MARKET_INDEX ||
				(includeOpenOrders && spotPosition.openOrders !== 0);
			if (
				isSpotPositionAvailable(spotPosition) ||
				(!countForBase && !countForQuote)
			) {
				continue;
			}

			const spotMarketAccount: SpotMarketAccount =
				this.driftClient.getSpotMarketAccount(spotPosition.marketIndex);

			const oraclePriceData = this.getOracleDataForSpotMarket(
				spotPosition.marketIndex
			);

			if (
				spotPosition.marketIndex === QUOTE_SPOT_MARKET_INDEX &&
				countForQuote
			) {
				const tokenAmount = getSignedTokenAmount(
					getTokenAmount(
						spotPosition.scaledBalance,
						spotMarketAccount,
						spotPosition.balanceType
					),
					spotPosition.balanceType
				);

				if (isVariant(spotPosition.balanceType, 'borrow')) {
					const weightedTokenValue = this.getSpotLiabilityValue(
						tokenAmount,
						oraclePriceData,
						spotMarketAccount,
						marginCategory,
						liquidationBuffer,
						strict,
						now
					).abs();

					netQuoteValue = netQuoteValue.sub(weightedTokenValue);
				} else {
					const weightedTokenValue = this.getSpotAssetValue(
						tokenAmount,
						oraclePriceData,
						spotMarketAccount,
						marginCategory,
						strict,
						now
					);

					netQuoteValue = netQuoteValue.add(weightedTokenValue);
				}

				continue;
			}

			if (!includeOpenOrders && countForBase) {
				if (isVariant(spotPosition.balanceType, 'borrow')) {
					const tokenAmount = getSignedTokenAmount(
						getTokenAmount(
							spotPosition.scaledBalance,
							spotMarketAccount,
							spotPosition.balanceType
						),
						SpotBalanceType.BORROW
					);
					const liabilityValue = this.getSpotLiabilityValue(
						tokenAmount,
						oraclePriceData,
						spotMarketAccount,
						marginCategory,
						liquidationBuffer,
						strict,
						now
					).abs();
					totalLiabilityValue = totalLiabilityValue.add(liabilityValue);

					continue;
				} else {
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
					totalAssetValue = totalAssetValue.add(assetValue);

					continue;
				}
			}

			const [worstCaseTokenAmount, worstCaseQuoteTokenAmount] =
				getWorstCaseTokenAmounts(
					spotPosition,
					spotMarketAccount,
					this.getOracleDataForSpotMarket(spotPosition.marketIndex)
				);

			if (worstCaseTokenAmount.gt(ZERO) && countForBase) {
				const baseAssetValue = this.getSpotAssetValue(
					worstCaseTokenAmount,
					oraclePriceData,
					spotMarketAccount,
					marginCategory,
					strict,
					now
				);

				totalAssetValue = totalAssetValue.add(baseAssetValue);
			}

			if (worstCaseTokenAmount.lt(ZERO) && countForBase) {
				const baseLiabilityValue = this.getSpotLiabilityValue(
					worstCaseTokenAmount,
					oraclePriceData,
					spotMarketAccount,
					marginCategory,
					liquidationBuffer,
					strict,
					now
				).abs();

				totalLiabilityValue = totalLiabilityValue.add(baseLiabilityValue);
			}

			if (worstCaseQuoteTokenAmount.gt(ZERO) && countForQuote) {
				netQuoteValue = netQuoteValue.add(worstCaseQuoteTokenAmount);
			}

			if (worstCaseQuoteTokenAmount.lt(ZERO) && countForQuote) {
				let weight = SPOT_MARKET_WEIGHT_PRECISION;
				if (marginCategory === 'Initial') {
					weight = BN.max(weight, new BN(this.getUserAccount().maxMarginRatio));
				}

				const weightedTokenValue = worstCaseQuoteTokenAmount
					.abs()
					.mul(weight)
					.div(SPOT_MARKET_WEIGHT_PRECISION);

				netQuoteValue = netQuoteValue.sub(weightedTokenValue);
			}

			totalLiabilityValue = totalLiabilityValue.add(
				new BN(spotPosition.openOrders).mul(OPEN_ORDER_MARGIN_REQUIREMENT)
			);
		}

		if (marketIndex === undefined || marketIndex === QUOTE_SPOT_MARKET_INDEX) {
			if (netQuoteValue.gt(ZERO)) {
				totalAssetValue = totalAssetValue.add(netQuoteValue);
			} else {
				totalLiabilityValue = totalLiabilityValue.add(netQuoteValue.abs());
			}
		}

		return { totalAssetValue, totalLiabilityValue };
	}

	public getSpotMarketLiabilityValue(
		marketIndex?: number,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict = false,
		now?: BN
	): BN {
		const { totalLiabilityValue } = this.getSpotMarketAssetAndLiabilityValue(
			marketIndex,
			marginCategory,
			liquidationBuffer,
			includeOpenOrders,
			strict,
			now
		);
		return totalLiabilityValue;
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

		if (strict) {
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
		const { totalAssetValue } = this.getSpotMarketAssetAndLiabilityValue(
			marketIndex,
			marginCategory,
			undefined,
			includeOpenOrders,
			strict,
			now
		);
		return totalAssetValue;
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
		if (strict) {
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

	public getSpotTokenAmount(marketIndex: number): BN {
		const spotPosition = this.getSpotPosition(marketIndex);
		return getTokenAmount(
			spotPosition.scaledBalance,
			this.driftClient.getSpotMarketAccount(marketIndex),
			spotPosition.balanceType
		);
	}

	public getSpotPositionValue(
		marketIndex: number,
		marginCategory?: MarginCategory,
		includeOpenOrders?: boolean,
		strict = false,
		now?: BN
	): BN {
		const { totalAssetValue, totalLiabilityValue } =
			this.getSpotMarketAssetAndLiabilityValue(
				marketIndex,
				marginCategory,
				undefined,
				includeOpenOrders,
				strict,
				now
			);

		return totalAssetValue.sub(totalLiabilityValue);
	}

	public getNetSpotMarketValue(withWeightMarginCategory?: MarginCategory): BN {
		const { totalAssetValue, totalLiabilityValue } =
			this.getSpotMarketAssetAndLiabilityValue(
				undefined,
				withWeightMarginCategory
			);

		return totalAssetValue.sub(totalLiabilityValue);
	}

	/**
	 * calculates TotalCollateral: collateral + unrealized pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getTotalCollateral(
		marginCategory: MarginCategory = 'Initial',
		strict = false
	): BN {
		return this.getSpotMarketAssetValue(
			undefined,
			marginCategory,
			true,
			strict
		).add(this.getUnrealizedPNL(true, undefined, marginCategory, strict));
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
		includeOpenOrders?: boolean,
		strict = false
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
					const [settledPosition, dustBaa, _] =
						this.getPerpPositionWithLPSettle(market.marketIndex);
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

					const quoteSpotMarket = this.driftClient.getSpotMarketAccount(
						market.quoteSpotMarketIndex
					);
					const quoteOraclePriceData =
						this.driftClient.getOraclePriceDataAndSlot(
							quoteSpotMarket.oracle
						).data;

					let quotePrice;
					if (strict) {
						quotePrice = BN.max(
							quoteOraclePriceData.price,
							quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
						);
					} else {
						quotePrice = quoteOraclePriceData.price;
					}

					baseAssetValue = baseAssetValue
						.mul(quotePrice)
						.div(PRICE_PRECISION)
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
			this.getPerpPositionWithLPSettle(marketIndex)[0] ||
			this.getEmptyPosition(marketIndex);
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
		return this.calculateLeverageFromComponents(this.getLeverageComponents());
	}

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
	}): BN {
		const totalLiabilityValue = perpLiabilityValue.add(spotLiabilityValue);
		const totalAssetValue = spotAssetValue.add(perpPnl);
		const netAssetValue = totalAssetValue.sub(spotLiabilityValue);

		if (netAssetValue.eq(ZERO)) {
			return ZERO;
		}

		return totalLiabilityValue.mul(TEN_THOUSAND).div(netAssetValue);
	}

	getLeverageComponents(): {
		perpLiabilityValue: BN;
		perpPnl: BN;
		spotAssetValue: BN;
		spotLiabilityValue: BN;
	} {
		const perpLiability = this.getTotalPerpPositionValue(
			undefined,
			undefined,
			true
		);
		const perpPnl = this.getUnrealizedPNL(true);

		const {
			totalAssetValue: spotAssetValue,
			totalLiabilityValue: spotLiabilityValue,
		} = this.getSpotMarketAssetAndLiabilityValue(
			undefined,
			undefined,
			undefined,
			true
		);

		return {
			perpLiabilityValue: perpLiability,
			perpPnl,
			spotAssetValue,
			spotLiabilityValue,
		};
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
	public getMaxLeverageForPerp(
		perpMarketIndex: number,
		category: MarginCategory = 'Initial'
	): BN {
		const market = this.driftClient.getPerpMarketAccount(perpMarketIndex);

		const { perpLiabilityValue, perpPnl, spotAssetValue, spotLiabilityValue } =
			this.getLeverageComponents();

		const totalAssetValue = spotAssetValue.add(perpPnl);

		const netAssetValue = totalAssetValue.sub(spotLiabilityValue);

		if (netAssetValue.eq(ZERO)) {
			return ZERO;
		}

		const totalLiabilityValue = perpLiabilityValue.add(spotLiabilityValue);

		const marginRatio = calculateMarketMarginRatio(
			market,
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
	 * calculates max allowable leverage exceeding hitting requirement category
	 * @param spotMarketIndex
	 * @param direction
	 * @returns : Precision TEN_THOUSAND
	 */
	public getMaxLeverageForSpot(
		spotMarketIndex: number,
		direction: PositionDirection
	): BN {
		const { perpLiabilityValue, perpPnl, spotAssetValue, spotLiabilityValue } =
			this.getLeverageComponents();

		const totalLiabilityValue = perpLiabilityValue.add(spotLiabilityValue);
		const totalAssetValue = spotAssetValue.add(perpPnl);

		const netAssetValue = totalAssetValue.sub(spotLiabilityValue);

		if (netAssetValue.eq(ZERO)) {
			return ZERO;
		}

		const currentQuoteAssetValue = this.getSpotMarketAssetValue(
			QUOTE_SPOT_MARKET_INDEX
		);
		const currentQuoteLiabilityValue = this.getSpotMarketLiabilityValue(
			QUOTE_SPOT_MARKET_INDEX
		);
		const currentQuoteValue = currentQuoteAssetValue.sub(
			currentQuoteLiabilityValue
		);

		const currentSpotMarketAssetValue =
			this.getSpotMarketAssetValue(spotMarketIndex);
		const currentSpotMarketLiabilityValue =
			this.getSpotMarketLiabilityValue(spotMarketIndex);
		const currentSpotMarketNetValue = currentSpotMarketAssetValue.sub(
			currentSpotMarketLiabilityValue
		);

		const tradeQuoteAmount = this.getMaxTradeSizeUSDCForSpot(
			spotMarketIndex,
			direction,
			currentQuoteAssetValue,
			currentSpotMarketNetValue
		);

		let assetValueToAdd = ZERO;
		let liabilityValueToAdd = ZERO;

		const newQuoteNetValue = isVariant(direction, 'short')
			? currentQuoteValue.add(tradeQuoteAmount)
			: currentQuoteValue.sub(tradeQuoteAmount);
		const newQuoteAssetValue = BN.max(newQuoteNetValue, ZERO);
		const newQuoteLiabilityValue = BN.min(newQuoteNetValue, ZERO).abs();

		assetValueToAdd = assetValueToAdd.add(
			newQuoteAssetValue.sub(currentQuoteAssetValue)
		);
		liabilityValueToAdd = liabilityValueToAdd.add(
			newQuoteLiabilityValue.sub(currentQuoteLiabilityValue)
		);

		const newSpotMarketNetValue = isVariant(direction, 'long')
			? currentSpotMarketNetValue.add(tradeQuoteAmount)
			: currentSpotMarketNetValue.sub(tradeQuoteAmount);
		const newSpotMarketAssetValue = BN.max(newSpotMarketNetValue, ZERO);
		const newSpotMarketLiabilityValue = BN.min(
			newSpotMarketNetValue,
			ZERO
		).abs();

		assetValueToAdd = assetValueToAdd.add(
			newSpotMarketAssetValue.sub(currentSpotMarketAssetValue)
		);
		liabilityValueToAdd = liabilityValueToAdd.add(
			newSpotMarketLiabilityValue.sub(currentSpotMarketLiabilityValue)
		);

		const finalTotalAssetValue = totalAssetValue.add(assetValueToAdd);
		const finalTotalSpotLiability = spotLiabilityValue.add(liabilityValueToAdd);

		const finalTotalLiabilityValue =
			totalLiabilityValue.add(liabilityValueToAdd);

		const finalNetAssetValue = finalTotalAssetValue.sub(
			finalTotalSpotLiability
		);

		return finalTotalLiabilityValue.mul(TEN_THOUSAND).div(finalNetAssetValue);
	}

	/**
	 * calculates margin ratio: 1 / leverage
	 * @returns : Precision TEN_THOUSAND
	 */
	public getMarginRatio(): BN {
		const { perpLiabilityValue, perpPnl, spotAssetValue, spotLiabilityValue } =
			this.getLeverageComponents();

		const totalLiabilityValue = perpLiabilityValue.add(spotLiabilityValue);
		const totalAssetValue = spotAssetValue.add(perpPnl);

		if (totalLiabilityValue.eq(ZERO)) {
			return BN_MAX;
		}

		const netAssetValue = totalAssetValue.sub(spotLiabilityValue);

		return netAssetValue.mul(TEN_THOUSAND).div(totalLiabilityValue);
	}

	public canBeLiquidated(): {
		canBeLiquidated: boolean;
		marginRequirement: BN;
		totalCollateral: BN;
	} {
		const totalCollateral = this.getTotalCollateral('Maintenance');

		// if user being liq'd, can continue to be liq'd until total collateral above the margin requirement plus buffer
		let liquidationBuffer = undefined;
		if (this.isBeingLiquidated()) {
			liquidationBuffer = new BN(
				this.driftClient.getStateAccount().liquidationMarginBufferRatio
			);
		}
		const marginRequirement =
			this.getMaintenanceMarginRequirement(liquidationBuffer);
		const canBeLiquidated = totalCollateral.lt(marginRequirement);

		return {
			canBeLiquidated,
			marginRequirement,
			totalCollateral,
		};
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
	public spotLiquidationPrice(
		marketIndex: number,
		positionBaseSizeChange: BN = ZERO
	): BN {
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
		let signedTokenAmount = getSignedTokenAmount(
			getTokenAmount(
				currentSpotPosition.scaledBalance,
				market,
				currentSpotPosition.balanceType
			),
			currentSpotPosition.balanceType
		);
		signedTokenAmount = signedTokenAmount.add(positionBaseSizeChange);

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
					freeCollateralDeltaForPerp || ZERO
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
		const currentPerpPosition =
			this.getPerpPosition(marketIndex) || this.getEmptyPosition(marketIndex);

		let freeCollateralDelta = this.calculateFreeCollateralDeltaForPerp(
			market,
			currentPerpPosition,
			positionBaseSizeChange
		);

		if (!freeCollateralDelta) {
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
				freeCollateralDelta = freeCollateralDelta.add(
					spotFreeCollateralDelta || ZERO
				);
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
	public getMaxTradeSizeUSDCForPerp(
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

		let maxPositionSize = this.getPerpBuyingPower(targetMarketIndex);
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
						this.getPerpBuyingPowerFromFreeCollateralAndBaseAssetAmount(
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

		return maxPositionSize;
	}

	/**
	 * Get the maximum trade size for a given market, taking into account the user's current leverage, positions, collateral, etc.
	 *
	 * @param targetMarketIndex
	 * @param direction
	 * @param currentQuoteAssetValue
	 * @param currentSpotMarketNetValue
	 * @returns tradeSizeAllowed : Precision QUOTE_PRECISION
	 */
	public getMaxTradeSizeUSDCForSpot(
		targetMarketIndex: number,
		direction: PositionDirection,
		currentQuoteAssetValue?: BN,
		currentSpotMarketNetValue?: BN
	): BN {
		const market = this.driftClient.getSpotMarketAccount(targetMarketIndex);

		currentQuoteAssetValue = this.getSpotMarketAssetValue(
			QUOTE_SPOT_MARKET_INDEX
		);

		currentSpotMarketNetValue =
			currentSpotMarketNetValue ?? this.getSpotPositionValue(targetMarketIndex);

		let freeCollateral = this.getFreeCollateral();
		const marginRatio = calculateSpotMarketMarginRatio(
			market,
			'Initial',
			ZERO,
			isVariant(direction, 'long')
				? SpotBalanceType.DEPOSIT
				: SpotBalanceType.BORROW
		);

		let tradeAmount = ZERO;
		if (this.getUserAccount().isMarginTradingEnabled) {
			// if the user is buying/selling and already short/long, need to account for closing out short/long
			if (isVariant(direction, 'long') && currentSpotMarketNetValue.lt(ZERO)) {
				tradeAmount = currentSpotMarketNetValue.abs();
				const marginRatio = calculateSpotMarketMarginRatio(
					market,
					'Initial',
					this.getSpotTokenAmount(targetMarketIndex),
					SpotBalanceType.BORROW
				);
				freeCollateral = freeCollateral.add(
					tradeAmount.mul(new BN(marginRatio)).div(MARGIN_PRECISION)
				);
			} else if (
				isVariant(direction, 'short') &&
				currentSpotMarketNetValue.gt(ZERO)
			) {
				tradeAmount = currentSpotMarketNetValue;
				const marginRatio = calculateSpotMarketMarginRatio(
					market,
					'Initial',
					this.getSpotTokenAmount(targetMarketIndex),
					SpotBalanceType.DEPOSIT
				);
				freeCollateral = freeCollateral.add(
					tradeAmount.mul(new BN(marginRatio)).div(MARGIN_PRECISION)
				);
			}

			tradeAmount = tradeAmount.add(
				freeCollateral.mul(MARGIN_PRECISION).div(new BN(marginRatio))
			);
		} else if (isVariant(direction, 'long')) {
			tradeAmount = BN.min(
				currentQuoteAssetValue,
				freeCollateral.mul(MARGIN_PRECISION).div(new BN(marginRatio))
			);
		} else {
			tradeAmount = BN.max(ZERO, currentSpotMarketNetValue);
		}

		return tradeAmount;
	}

	/**
	 * Calculates the max amount of token that can be swapped from inMarket to outMarket
	 * Assumes swap happens at oracle price
	 *
	 * @param inMarketIndex
	 * @param outMarketIndex
	 * @param marginTradingEnabled
	 */
	public getMaxSwapAmount({
		inMarketIndex,
		outMarketIndex,
	}: {
		inMarketIndex: number;
		outMarketIndex: number;
	}): { inAmount: BN; outAmount: BN; leverage: BN } {
		const inMarket = this.driftClient.getSpotMarketAccount(inMarketIndex);
		const outMarket = this.driftClient.getSpotMarketAccount(outMarketIndex);

		const inOraclePrice = this.getOracleDataForSpotMarket(inMarketIndex).price;
		const outOraclePrice =
			this.getOracleDataForSpotMarket(outMarketIndex).price;

		const inPrecision = new BN(10 ** inMarket.decimals);
		const outPrecision = new BN(10 ** outMarket.decimals);

		const outSaferThanIn =
			inMarket.initialAssetWeight < outMarket.initialAssetWeight;

		const inSpotPosition =
			this.getSpotPosition(inMarketIndex) ||
			this.getEmptySpotPosition(inMarketIndex);
		const outSpotPosition =
			this.getSpotPosition(outMarketIndex) ||
			this.getEmptySpotPosition(outMarketIndex);

		const freeCollateral = this.getFreeCollateral();

		const inContributionInitial =
			this.calculateSpotPositionFreeCollateralContribution(inSpotPosition);
		const {
			totalAssetValue: inTotalAssetValueInitial,
			totalLiabilityValue: inTotalLiabilityValueInitial,
		} = this.calculateSpotPositionLeverageContribution(inSpotPosition);
		const outContributionInitial =
			this.calculateSpotPositionFreeCollateralContribution(outSpotPosition);
		const {
			totalAssetValue: outTotalAssetValueInitial,
			totalLiabilityValue: outTotalLiabilityValueInitial,
		} = this.calculateSpotPositionLeverageContribution(outSpotPosition);
		const initialContribution = inContributionInitial.add(
			outContributionInitial
		);

		const { perpLiabilityValue, perpPnl, spotAssetValue, spotLiabilityValue } =
			this.getLeverageComponents();

		const calculateOutSwap = (inSwap: BN) => {
			return inSwap
				.mul(outPrecision)
				.mul(inOraclePrice)
				.div(outOraclePrice)
				.div(inPrecision);
		};

		let inSwap = ZERO;
		let outSwap = ZERO;
		const inTokenAmount = this.getSpotTokenAmount(inMarketIndex);
		if (freeCollateral.lt(ONE)) {
			if (outSaferThanIn) {
				inSwap = inTokenAmount;
				outSwap = calculateOutSwap(inSwap);
			}
		} else {
			let minSwap = ZERO;
			let maxSwap = freeCollateral
				.mul(inPrecision)
				.mul(SPOT_MARKET_WEIGHT_PRECISION)
				.div(SPOT_MARKET_WEIGHT_PRECISION.div(TEN))
				.div(inOraclePrice); // just assume user can go 10x
			inSwap = maxSwap.div(TWO);
			const error = BN.min(QUOTE_PRECISION, freeCollateral.div(new BN(100)));

			let freeCollateralAfter = freeCollateral;
			while (freeCollateralAfter.gt(error) || freeCollateralAfter.isNeg()) {
				outSwap = calculateOutSwap(inSwap);

				const inPositionAfter = this.cloneAndUpdateSpotPosition(
					inSpotPosition,
					inSwap.neg(),
					inMarket
				);
				const outPositionAfter = this.cloneAndUpdateSpotPosition(
					outSpotPosition,
					outSwap,
					outMarket
				);

				const inContributionAfter =
					this.calculateSpotPositionFreeCollateralContribution(inPositionAfter);
				const outContributionAfter =
					this.calculateSpotPositionFreeCollateralContribution(
						outPositionAfter
					);
				const contributionAfter = inContributionAfter.add(outContributionAfter);

				const contributionDelta = contributionAfter.sub(initialContribution);

				freeCollateralAfter = freeCollateral.add(contributionDelta);

				if (freeCollateralAfter.gt(error)) {
					minSwap = inSwap;
					inSwap = minSwap.add(maxSwap).div(TWO);
				} else if (freeCollateralAfter.isNeg()) {
					maxSwap = inSwap;
					inSwap = minSwap.add(maxSwap).div(TWO);
				}
			}
		}

		const inPositionAfter = this.cloneAndUpdateSpotPosition(
			inSpotPosition,
			inSwap.neg(),
			inMarket
		);
		const outPositionAfter = this.cloneAndUpdateSpotPosition(
			outSpotPosition,
			outSwap,
			outMarket
		);

		const {
			totalAssetValue: inTotalAssetValueAfter,
			totalLiabilityValue: inTotalLiabilityValueAfter,
		} = this.calculateSpotPositionLeverageContribution(inPositionAfter);

		const {
			totalAssetValue: outTotalAssetValueAfter,
			totalLiabilityValue: outTotalLiabilityValueAfter,
		} = this.calculateSpotPositionLeverageContribution(outPositionAfter);

		const spotAssetValueDelta = inTotalAssetValueAfter
			.add(outTotalAssetValueAfter)
			.sub(inTotalAssetValueInitial)
			.sub(outTotalAssetValueInitial);
		const spotLiabilityValueDelta = inTotalLiabilityValueAfter
			.add(outTotalLiabilityValueAfter)
			.sub(inTotalLiabilityValueInitial)
			.sub(outTotalLiabilityValueInitial);

		const spotAssetValueAfter = spotAssetValue.add(spotAssetValueDelta);
		const spotLiabilityValueAfter = spotLiabilityValue.add(
			spotLiabilityValueDelta
		);

		const leverage = this.calculateLeverageFromComponents({
			perpLiabilityValue,
			perpPnl,
			spotAssetValue: spotAssetValueAfter,
			spotLiabilityValue: spotLiabilityValueAfter,
		});

		return { inAmount: inSwap, outAmount: outSwap, leverage };
	}

	cloneAndUpdateSpotPosition(
		position: SpotPosition,
		tokenAmount: BN,
		market: SpotMarketAccount
	): SpotPosition {
		const clonedPosition = Object.assign({}, position);
		if (tokenAmount.eq(ZERO)) {
			return clonedPosition;
		}

		const preTokenAmount = getTokenAmount(
			position.scaledBalance,
			market,
			position.balanceType
		);

		if (sigNum(preTokenAmount).eq(sigNum(tokenAmount))) {
			const scaledBalanceDelta = getBalance(
				tokenAmount,
				market,
				position.balanceType
			);
			clonedPosition.scaledBalance =
				position.scaledBalance.add(scaledBalanceDelta);
			return clonedPosition;
		}

		const updateDirection = tokenAmount.isNeg()
			? SpotBalanceType.BORROW
			: SpotBalanceType.DEPOSIT;

		if (tokenAmount.abs().gt(preTokenAmount.abs())) {
			clonedPosition.scaledBalance = getBalance(
				tokenAmount.abs().sub(preTokenAmount.abs()),
				market,
				updateDirection
			);
			clonedPosition.balanceType = updateDirection;
		} else {
			const scaledBalanceDelta = getBalance(
				tokenAmount,
				market,
				position.balanceType
			);

			clonedPosition.scaledBalance =
				position.scaledBalance.sub(scaledBalanceDelta);
		}
		return clonedPosition;
	}

	calculateSpotPositionFreeCollateralContribution(
		spotPosition: SpotPosition
	): BN {
		let freeCollateralContribution = ZERO;
		const now = new BN(new Date().getTime() / 1000);
		const strict = true;
		const marginCategory = 'Initial';

		const spotMarketAccount: SpotMarketAccount =
			this.driftClient.getSpotMarketAccount(spotPosition.marketIndex);

		const oraclePriceData = this.getOracleDataForSpotMarket(
			spotPosition.marketIndex
		);

		const [worstCaseTokenAmount, worstCaseQuoteTokenAmount] =
			getWorstCaseTokenAmounts(
				spotPosition,
				spotMarketAccount,
				oraclePriceData
			);

		if (worstCaseTokenAmount.gt(ZERO)) {
			const baseAssetValue = this.getSpotAssetValue(
				worstCaseTokenAmount,
				oraclePriceData,
				spotMarketAccount,
				marginCategory,
				strict,
				now
			);

			freeCollateralContribution =
				freeCollateralContribution.add(baseAssetValue);
		} else {
			const baseLiabilityValue = this.getSpotLiabilityValue(
				worstCaseTokenAmount,
				oraclePriceData,
				spotMarketAccount,
				marginCategory,
				undefined,
				strict,
				now
			).abs();

			freeCollateralContribution =
				freeCollateralContribution.sub(baseLiabilityValue);
		}

		freeCollateralContribution.add(worstCaseQuoteTokenAmount);

		return freeCollateralContribution;
	}

	calculateSpotPositionLeverageContribution(spotPosition: SpotPosition): {
		totalAssetValue: BN;
		totalLiabilityValue: BN;
	} {
		let totalAssetValue = ZERO;
		let totalLiabilityValue = ZERO;
		const now = new BN(new Date().getTime() / 1000);

		const spotMarketAccount: SpotMarketAccount =
			this.driftClient.getSpotMarketAccount(spotPosition.marketIndex);

		const oraclePriceData = this.getOracleDataForSpotMarket(
			spotPosition.marketIndex
		);

		const [worstCaseTokenAmount, worstCaseQuoteTokenAmount] =
			getWorstCaseTokenAmounts(
				spotPosition,
				spotMarketAccount,
				oraclePriceData
			);

		if (worstCaseTokenAmount.gt(ZERO)) {
			totalAssetValue = this.getSpotAssetValue(
				worstCaseTokenAmount,
				oraclePriceData,
				spotMarketAccount,
				undefined,
				false,
				now
			);
		} else {
			totalLiabilityValue = this.getSpotLiabilityValue(
				worstCaseTokenAmount,
				oraclePriceData,
				spotMarketAccount,
				undefined,
				undefined,
				false,
				now
			).abs();
		}

		if (worstCaseQuoteTokenAmount.gt(ZERO)) {
			totalAssetValue = totalAssetValue.add(worstCaseQuoteTokenAmount);
		} else {
			totalLiabilityValue = totalLiabilityValue.add(
				worstCaseQuoteTokenAmount.abs()
			);
		}

		return {
			totalAssetValue,
			totalLiabilityValue,
		};
	}

	// TODO - should this take the price impact of the trade into account for strict accuracy?

	/**
	 * Returns the leverage ratio for the account after adding (or subtracting) the given quote size to the given position
	 * @param targetMarketIndex
	 * @param: targetMarketType
	 * @param tradeQuoteAmount
	 * @param tradeSide
	 * @param includeOpenOrders
	 * @returns leverageRatio : Precision TEN_THOUSAND
	 */
	public accountLeverageRatioAfterTrade(
		targetMarketIndex: number,
		targetMarketType: MarketType,
		tradeQuoteAmount: BN,
		tradeSide: PositionDirection,
		includeOpenOrders = true
	): BN {
		const tradeIsPerp = isVariant(targetMarketType, 'perp');

		if (!tradeIsPerp) {
			// calculate new asset/liability values for base and quote market to find new account leverage
			const totalLiabilityValue = this.getTotalLiabilityValue();
			const totalAssetValue = this.getTotalAssetValue();
			const spotLiabilityValue = this.getSpotMarketLiabilityValue(
				undefined,
				undefined,
				undefined,
				includeOpenOrders
			);

			const currentQuoteAssetValue = this.getSpotMarketAssetValue(
				QUOTE_SPOT_MARKET_INDEX,
				undefined,
				includeOpenOrders
			);
			const currentQuoteLiabilityValue = this.getSpotMarketLiabilityValue(
				QUOTE_SPOT_MARKET_INDEX,
				undefined,
				undefined,
				includeOpenOrders
			);
			const currentQuoteValue = currentQuoteAssetValue.sub(
				currentQuoteLiabilityValue
			);

			const currentSpotMarketAssetValue = this.getSpotMarketAssetValue(
				targetMarketIndex,
				undefined,
				includeOpenOrders
			);
			const currentSpotMarketLiabilityValue = this.getSpotMarketLiabilityValue(
				targetMarketIndex,
				undefined,
				undefined,
				includeOpenOrders
			);
			const currentSpotMarketNetValue = currentSpotMarketAssetValue.sub(
				currentSpotMarketLiabilityValue
			);

			let assetValueToAdd = ZERO;
			let liabilityValueToAdd = ZERO;

			const newQuoteNetValue =
				tradeSide == PositionDirection.SHORT
					? currentQuoteValue.add(tradeQuoteAmount)
					: currentQuoteValue.sub(tradeQuoteAmount);
			const newQuoteAssetValue = BN.max(newQuoteNetValue, ZERO);
			const newQuoteLiabilityValue = BN.min(newQuoteNetValue, ZERO).abs();

			assetValueToAdd = assetValueToAdd.add(
				newQuoteAssetValue.sub(currentQuoteAssetValue)
			);
			liabilityValueToAdd = liabilityValueToAdd.add(
				newQuoteLiabilityValue.sub(currentQuoteLiabilityValue)
			);

			const newSpotMarketNetValue =
				tradeSide == PositionDirection.LONG
					? currentSpotMarketNetValue.add(tradeQuoteAmount)
					: currentSpotMarketNetValue.sub(tradeQuoteAmount);
			const newSpotMarketAssetValue = BN.max(newSpotMarketNetValue, ZERO);
			const newSpotMarketLiabilityValue = BN.min(
				newSpotMarketNetValue,
				ZERO
			).abs();

			assetValueToAdd = assetValueToAdd.add(
				newSpotMarketAssetValue.sub(currentSpotMarketAssetValue)
			);
			liabilityValueToAdd = liabilityValueToAdd.add(
				newSpotMarketLiabilityValue.sub(currentSpotMarketLiabilityValue)
			);

			const totalAssetValueAfterTrade = totalAssetValue.add(assetValueToAdd);
			const totalSpotLiabilityValueAfterTrade =
				spotLiabilityValue.add(liabilityValueToAdd);

			const totalLiabilityValueAfterTrade =
				totalLiabilityValue.add(liabilityValueToAdd);

			const netAssetValueAfterTrade = totalAssetValueAfterTrade.sub(
				totalSpotLiabilityValueAfterTrade
			);

			if (netAssetValueAfterTrade.eq(ZERO)) {
				return ZERO;
			}

			const newLeverage = totalLiabilityValueAfterTrade
				.mul(TEN_THOUSAND)
				.div(netAssetValueAfterTrade);

			return newLeverage;
		}

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
			SpotBalanceType.DEPOSIT
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

	public canMakeIdle(slot: BN, slotsBeforeIdle: BN): boolean {
		const userAccount = this.getUserAccount();
		if (userAccount.idle) {
			return false;
		}

		const userLastActiveSlot = userAccount.lastActiveSlot;
		const slotsSinceLastActive = slot.sub(userLastActiveSlot);
		if (slotsSinceLastActive.lt(slotsBeforeIdle)) {
			return false;
		}

		if (this.isBeingLiquidated()) {
			return false;
		}

		for (const perpPosition of userAccount.perpPositions) {
			if (!positionIsAvailable(perpPosition)) {
				return false;
			}
		}

		for (const spotPosition of userAccount.spotPositions) {
			if (
				isVariant(spotPosition.balanceType, 'borrow') &&
				spotPosition.scaledBalance.gt(ZERO)
			) {
				return false;
			}

			if (spotPosition.openOrders !== 0) {
				return false;
			}
		}

		for (const order of userAccount.orders) {
			if (!isVariant(order.status, 'init')) {
				return false;
			}
		}

		return true;
	}

	public getSafestTiers(): { perpTier: number; spotTier: number } {
		let safestPerpTier = 4;
		let safestSpotTier = 4;

		for (const perpPosition of this.getActivePerpPositions()) {
			safestPerpTier = Math.min(
				safestPerpTier,
				getPerpMarketTierNumber(
					this.driftClient.getPerpMarketAccount(perpPosition.marketIndex)
				)
			);
		}

		for (const spotPosition of this.getActiveSpotPositions()) {
			if (isVariant(spotPosition.balanceType, 'deposit')) {
				continue;
			}

			safestSpotTier = Math.min(
				safestSpotTier,
				getSpotMarketTierNumber(
					this.driftClient.getSpotMarketAccount(spotPosition.marketIndex)
				)
			);
		}

		return {
			perpTier: safestPerpTier,
			spotTier: safestSpotTier,
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
