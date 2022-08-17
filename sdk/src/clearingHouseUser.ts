import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import { ClearingHouse } from './clearingHouse';
import {
	isVariant,
	MarginCategory,
	Order,
	UserAccount,
	UserPosition,
	UserStatsAccount,
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
	BANK_WEIGHT_PRECISION,
	BANK_BALANCE_PRECISION_EXP,
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
	calculateUnsettledAssetWeight,
	calculateMarketMarginRatio,
	PositionDirection,
	calculateTradeSlippage,
	BN,
	BankAccount,
	fetchUserStatsAccount,
} from '.';
import {
	getTokenAmount,
	calculateAssetWeight,
	calculateLiabilityWeight,
} from './math/bankBalance';
import {
	calculateMarginBaseAssetValue,
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

	public async getUserStatsAccount(): Promise<UserStatsAccount> {
		return await fetchUserStatsAccount(
			this.clearingHouse.connection,
			this.clearingHouse.program,
			this.getUserAccount().authority
		);
	}

	/**
	 * Gets the user's current position for a given market. If the user has no position returns undefined
	 * @param marketIndex
	 * @returns userPosition
	 */
	public getUserPosition(marketIndex: BN): UserPosition | undefined {
		return this.getUserAccount().positions.find((position) =>
			position.marketIndex.eq(marketIndex)
		);
	}

	public getEmptyPosition(marketIndex: BN): UserPosition {
		return {
			baseAssetAmount: ZERO,
			lastCumulativeFundingRate: ZERO,
			marketIndex,
			quoteAssetAmount: ZERO,
			quoteEntryAmount: ZERO,
			openOrders: ZERO,
			openBids: ZERO,
			openAsks: ZERO,
			lpShares: ZERO,
			lastFeePerLp: ZERO,
			lastNetBaseAssetAmountPerLp: ZERO,
			lastNetQuoteAssetAmountPerLp: ZERO,
		};
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
	 * @returns : userPosition
	 */
	public getSettledLPPosition(marketIndex: BN): [UserPosition, BN] {
		const position = this.getUserPosition(marketIndex);
		const market = this.clearingHouse.getMarketAccount(position.marketIndex);
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

		const remainder = deltaBaa
			.abs()
			.mod(market.amm.baseAssetAmountStepSize)
			.mul(sign(deltaBaa));
		const _standardizedBaa = deltaBaa.sub(remainder);

		let remainderBaa;
		if (_standardizedBaa.abs().gte(market.amm.baseAssetAmountStepSize)) {
			remainderBaa = remainder;
		} else {
			remainderBaa = deltaBaa;
		}
		const standardizedBaa = deltaBaa.sub(remainderBaa);

		const reaminderPerLP = remainderBaa.mul(AMM_RESERVE_PRECISION).div(nShares);

		position.baseAssetAmount = position.baseAssetAmount.add(standardizedBaa);
		position.quoteAssetAmount = position.quoteAssetAmount.add(deltaQaa);

		position.lastNetBaseAssetAmountPerLp =
			market.amm.marketPositionPerLp.baseAssetAmount.sub(reaminderPerLP);

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
			pnl = position.quoteEntryAmount.sub(newQuoteEntry);
		} else {
			newQuoteEntry = deltaQaa.sub(
				deltaQaa.mul(position.baseAssetAmount.abs()).div(deltaBaa.abs())
			);
			pnl = position.quoteEntryAmount.add(deltaQaa.sub(newQuoteEntry));
		}
		position.quoteEntryAmount = newQuoteEntry;

		if (position.baseAssetAmount.gt(ZERO)) {
			position.lastCumulativeFundingRate = market.amm.cumulativeFundingRateLong;
		} else if (position.baseAssetAmount.lt(ZERO)) {
			position.lastCumulativeFundingRate =
				market.amm.cumulativeFundingRateShort;
		} else {
			position.lastCumulativeFundingRate = ZERO;
		}

		return [position, pnl];
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
		const postionMarginRequirement = this.getUserAccount().positions.reduce(
			(marginRequirement, marketPosition) => {
				const market = this.clearingHouse.getMarketAccount(
					marketPosition.marketIndex
				);
				const worstCaseBaseAssetAmount =
					calculateWorstCaseBaseAssetAmount(marketPosition);

				const worstCaseAssetValue = worstCaseBaseAssetAmount
					.abs()
					.mul(this.getOracleDataForMarket(market.marketIndex).price)
					.div(AMM_TO_QUOTE_PRECISION_RATIO.mul(MARK_PRICE_PRECISION));

				const marketMarginRatio = new BN(
					calculateMarketMarginRatio(
						market,
						worstCaseBaseAssetAmount.abs(),
						'Initial'
					)
				);
				return marginRequirement.add(
					worstCaseAssetValue.mul(marketMarginRatio).div(MARGIN_PRECISION)
				);
			},
			ZERO
		);

		const bankMarginRequirement = this.getBankLiabilityValue(
			undefined,
			'Initial'
		);

		return bankMarginRequirement.add(postionMarginRequirement);
	}

	/**
	 * @returns The maintenance margin requirement in USDC. : QUOTE_PRECISION
	 */
	public getMaintenanceMarginRequirement(): BN {
		return this.getUserAccount()
			.positions.reduce((marginRequirement, marketPosition) => {
				const market = this.clearingHouse.getMarketAccount(
					marketPosition.marketIndex
				);
				const worstCaseBaseAssetAmount =
					calculateWorstCaseBaseAssetAmount(marketPosition);

				const worstCaseAssetValue = worstCaseBaseAssetAmount
					.abs()
					.mul(this.getOracleDataForMarket(market.marketIndex).price)
					.div(AMM_TO_QUOTE_PRECISION_RATIO.mul(MARK_PRICE_PRECISION));

				return marginRequirement.add(
					worstCaseAssetValue
						.mul(
							new BN(
								calculateMarketMarginRatio(
									market,
									worstCaseBaseAssetAmount.abs(),
									'Maintenance'
								)
							)
						)
						.div(MARGIN_PRECISION)
				);
			}, ZERO)
			.add(this.getBankLiabilityValue(undefined, 'Maintenance'));
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
			.positions.filter((pos) =>
				marketIndex ? pos.marketIndex === marketIndex : true
			)
			.reduce((pnl, marketPosition) => {
				const market = this.clearingHouse.getMarketAccount(
					marketPosition.marketIndex
				);
				let pnl0 = calculatePositionPNL(
					market,
					marketPosition,
					withFunding,
					this.getOracleDataForMarket(market.marketIndex)
				);

				if (withWeightMarginCategory !== undefined) {
					if (pnl0.gt(ZERO)) {
						pnl0 = pnl0
							.mul(
								calculateUnsettledAssetWeight(
									market,
									pnl0,
									withWeightMarginCategory
								)
							)
							.div(new BN(BANK_WEIGHT_PRECISION));
					}
				}

				return pnl.add(pnl0);
			}, ZERO);
	}

	/**
	 * calculates unrealized funding payment pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getUnrealizedFundingPNL(marketIndex?: BN): BN {
		return this.getUserAccount()
			.positions.filter((pos) =>
				marketIndex ? pos.marketIndex === marketIndex : true
			)
			.reduce((pnl, marketPosition) => {
				const market = this.clearingHouse.getMarketAccount(
					marketPosition.marketIndex
				);
				return pnl.add(calculatePositionFundingPNL(market, marketPosition));
			}, ZERO);
	}

	public getBankLiabilityValue(
		bankIndex?: BN,
		withWeightMarginCategory?: MarginCategory
	): BN {
		return this.getUserAccount().bankBalances.reduce(
			(totalLiabilityValue, bankBalance) => {
				if (
					bankBalance.balance.eq(ZERO) ||
					isVariant(bankBalance.balanceType, 'deposit') ||
					(bankIndex !== undefined && !bankBalance.bankIndex.eq(bankIndex))
				) {
					return totalLiabilityValue;
				}

				// Todo this needs to account for whether it's based on initial or maintenance requirements
				const bankAccount: BankAccount = this.clearingHouse.getBankAccount(
					bankBalance.bankIndex
				);

				const tokenAmount = getTokenAmount(
					bankBalance.balance,
					bankAccount,
					bankBalance.balanceType
				);

				let liabilityValue = tokenAmount
					.mul(this.getOracleDataForBank(bankAccount.bankIndex).price)
					.div(MARK_PRICE_PRECISION)
					.div(
						new BN(10).pow(
							new BN(bankAccount.decimals).sub(BANK_BALANCE_PRECISION_EXP)
						)
					);

				if (withWeightMarginCategory !== undefined) {
					const weight = calculateLiabilityWeight(
						tokenAmount,
						bankAccount,
						withWeightMarginCategory
					);
					liabilityValue = liabilityValue
						.mul(weight)
						.div(BANK_WEIGHT_PRECISION);
				}

				return totalLiabilityValue.add(liabilityValue);
			},
			ZERO
		);
	}

	public getBankAssetValue(
		bankIndex?: BN,
		withWeightMarginCategory?: MarginCategory
	): BN {
		return this.getUserAccount().bankBalances.reduce(
			(totalAssetValue, bankBalance) => {
				if (
					bankBalance.balance.eq(ZERO) ||
					isVariant(bankBalance.balanceType, 'borrow') ||
					(bankIndex !== undefined && !bankBalance.bankIndex.eq(bankIndex))
				) {
					return totalAssetValue;
				}

				// Todo this needs to account for whether it's based on initial or maintenance requirements
				const bankAccount: BankAccount = this.clearingHouse.getBankAccount(
					bankBalance.bankIndex
				);

				const tokenAmount = getTokenAmount(
					bankBalance.balance,
					bankAccount,
					bankBalance.balanceType
				);

				let assetValue = tokenAmount
					.mul(this.getOracleDataForBank(bankAccount.bankIndex).price)
					.div(MARK_PRICE_PRECISION)
					.div(
						new BN(10).pow(
							new BN(bankAccount.decimals).sub(BANK_BALANCE_PRECISION_EXP)
						)
					);
				if (withWeightMarginCategory !== undefined) {
					const weight = calculateAssetWeight(
						tokenAmount,
						bankAccount,
						withWeightMarginCategory
					);
					assetValue = assetValue.mul(weight).div(BANK_WEIGHT_PRECISION);
				}

				return totalAssetValue.add(assetValue);
			},
			ZERO
		);
	}

	public getNetBankValue(withWeightMarginCategory?: MarginCategory): BN {
		return this.getBankAssetValue(undefined, withWeightMarginCategory).sub(
			this.getBankLiabilityValue(undefined, withWeightMarginCategory)
		);
	}

	/**
	 * calculates TotalCollateral: collateral + unrealized pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getTotalCollateral(marginCategory: MarginCategory = 'Initial'): BN {
		return this.getUserAccount()
			.bankBalances.reduce((totalAssetValue, bankBalance) => {
				if (
					bankBalance.balance.eq(ZERO) ||
					isVariant(bankBalance.balanceType, 'borrow')
				) {
					return totalAssetValue;
				}

				// Todo this needs to account for whether it's based on initial or maintenance requirements
				const bankAccount: BankAccount = this.clearingHouse.getBankAccount(
					bankBalance.bankIndex
				);

				const tokenAmount = getTokenAmount(
					bankBalance.balance,
					bankAccount,
					bankBalance.balanceType
				);

				const weight = calculateAssetWeight(
					tokenAmount,
					bankAccount,
					marginCategory
				);

				return totalAssetValue.add(
					tokenAmount
						.mul(this.getOracleDataForBank(bankAccount.bankIndex).price)
						.mul(weight)
						.div(BANK_WEIGHT_PRECISION)
						.div(MARK_PRICE_PRECISION)
						// Adjust for decimals of bank account
						.div(
							new BN(10).pow(
								new BN(bankAccount.decimals).sub(BANK_BALANCE_PRECISION_EXP)
							)
						)
				);
			}, ZERO)
			.add(this.getUnrealizedPNL(true, undefined, marginCategory));
	}

	/**
	 * calculates sum of position value across all positions in margin system
	 * @returns : Precision QUOTE_PRECISION
	 */
	getTotalPositionValue(): BN {
		return this.getUserAccount().positions.reduce(
			(positionValue, marketPosition) => {
				const market = this.clearingHouse.getMarketAccount(
					marketPosition.marketIndex
				);
				const posVal = calculateMarginBaseAssetValue(
					market,
					marketPosition,
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
		const market = this.clearingHouse.getMarketAccount(
			userPosition.marketIndex
		);
		return calculateMarginBaseAssetValue(market, userPosition, oraclePriceData);
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
	 * calculates average exit price (optionally for closing up to 100% of position)
	 * @returns : Precision MARK_PRICE_PRECISION
	 */
	public getPositionEstimatedExitPriceAndPnl(
		position: UserPosition,
		amountToClose?: BN,
		useAMMClose = false
	): [BN, BN] {
		const market = this.clearingHouse.getMarketAccount(position.marketIndex);

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
			} as UserPosition;
		}

		let baseAssetValue: BN;

		if (useAMMClose) {
			baseAssetValue = calculateBaseAssetValue(
				market,
				position,
				oraclePriceData
			);
		} else {
			baseAssetValue = calculateMarginBaseAssetValue(
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
		const market = this.clearingHouse.getMarketAccount(marketIndex);

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

	public canBeLiquidated(): [boolean, BN] {
		const totalCollateral = this.getTotalCollateral();
		const partialMaintenanceRequirement =
			this.getMaintenanceMarginRequirement();
		const marginRatio = this.getMarginRatio();
		const canLiquidate = totalCollateral.lt(partialMaintenanceRequirement);
		return [canLiquidate, marginRatio];
	}

	/**
	 * Checks if any user position cumulative funding differs from respective market cumulative funding
	 * @returns
	 */
	public needsToSettleFundingPayment(): boolean {
		for (const userPosition of this.getUserAccount().positions) {
			if (userPosition.baseAssetAmount.eq(ZERO)) {
				continue;
			}

			const market = this.clearingHouse.getMarketAccount(
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
	 * @param marketPosition
	 * @param positionBaseSizeChange // change in position size to calculate liquidation price for : Precision 10^13
	 * @param partial
	 * @returns Precision : MARK_PRICE_PRECISION
	 */
	public liquidationPrice(
		marketPosition: Pick<UserPosition, 'marketIndex'>,
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
			quoteAssetAmount: new BN(0),
			lastCumulativeFundingRate: ZERO,
			quoteEntryAmount: new BN(0),
			openOrders: new BN(0),
			openBids: new BN(0),
			openAsks: new BN(0),
			lpShares: ZERO,
			lastFeePerLp: ZERO,
			lastNetBaseAssetAmountPerLp: ZERO,
			lastNetQuoteAssetAmountPerLp: ZERO,
		};

		if (proposedBaseAssetAmount.eq(ZERO)) return new BN(-1);

		const market = this.clearingHouse.getMarketAccount(
			proposedMarketPosition.marketIndex
		);

		const proposedMarketPositionValue = calculateMarginBaseAssetValue(
			market,
			proposedMarketPosition,
			this.getOracleDataForMarket(market.marketIndex)
		);

		// total position value after trade
		const totalPositionValueAfterTrade =
			totalPositionValueExcludingTargetMarket.add(proposedMarketPositionValue);

		const marginRequirementExcludingTargetMarket =
			this.getUserAccount().positions.reduce(
				(totalMarginRequirement, position) => {
					if (!position.marketIndex.eq(marketPosition.marketIndex)) {
						const market = this.clearingHouse.getMarketAccount(
							position.marketIndex
						);
						const positionValue = calculateMarginBaseAssetValue(
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
			proposedMarketPosition.baseAssetAmount.abs().gt(ZERO)
		) {
			return new BN(-1);
		}

		const marginRequirementAfterTrade =
			marginRequirementExcludingTargetMarket.add(
				proposedMarketPositionValue
					.mul(
						new BN(
							calculateMarketMarginRatio(
								market,
								proposedMarketPosition.baseAssetAmount.abs(),
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
			proposedMarketPosition.marketIndex,
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
				this.clearingHouse.getMarketAccount(marketPosition.marketIndex),
				this.getOracleDataForMarket(marketPosition.marketIndex)
			);
		} else {
			const direction = positionBaseSizeChange.gt(ZERO)
				? PositionDirection.LONG
				: PositionDirection.SHORT;
			markPriceAfterTrade = calculateTradeSlippage(
				direction,
				positionBaseSizeChange.abs(),
				this.clearingHouse.getMarketAccount(marketPosition.marketIndex),
				'base',
				this.getOracleDataForMarket(marketPosition.marketIndex)
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
				const market = this.clearingHouse.getMarketAccount(targetMarketIndex);
				const marketPositionValue = this.getPositionValue(
					targetMarketIndex,
					oracleData
				);
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

		const oracleData = this.getOracleDataForMarket(marketToIgnore);

		let currentMarketPositionValueUSDC = ZERO;
		if (currentMarketPosition) {
			currentMarketPositionValueUSDC = this.getPositionValue(
				marketToIgnore,
				oracleData
			);
		}

		return this.getTotalPositionValue().sub(currentMarketPositionValueUSDC);
	}

	private getOracleDataForMarket(marketIndex: BN): OraclePriceData {
		const oracleKey =
			this.clearingHouse.getMarketAccount(marketIndex).amm.oracle;
		const oracleData =
			this.clearingHouse.getOraclePriceDataAndSlot(oracleKey).data;

		return oracleData;
	}
	private getOracleDataForBank(bankIndex: BN): OraclePriceData {
		const oracleKey = this.clearingHouse.getBankAccount(bankIndex).oracle;

		const oracleData =
			this.clearingHouse.getOraclePriceDataAndSlot(oracleKey).data;

		return oracleData;
	}
}
