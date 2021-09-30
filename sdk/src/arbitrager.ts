import {
	ClearingHouse,
	AMM_MANTISSA,
	BASE_ASSET_PRECISION,
} from './clearingHouse';
import { UserAccount } from './userAccount';
import { PythClient } from './pythClient';
import BN from 'bn.js';
import { stripMantissa } from './DataSubscriptionHelpers';
import { ZERO } from './constants/numericConstants';
import { PositionDirection } from './types';

export interface TradeToExecute {
	direction: PositionDirection;
	marketIndex: BN;
	amount: BN;
	oraclePriceWithMantissa: BN;
}

export class Arbitrager {
	private clearingHouse: ClearingHouse;
	private pythClient: PythClient;
	private userAccount: UserAccount;
	private alphas: Array<number>;

	public constructor(clearingHouse: ClearingHouse, userAccount: UserAccount) {
		if (!clearingHouse.isSubscribed) {
			throw Error('clearingHouse must be subscribed to create arbitrager');
		}
		this.clearingHouse = clearingHouse;
		this.userAccount = userAccount;
		this.pythClient = new PythClient(this.clearingHouse.connection);
		this.alphas = [0, 0, 0, 0]; //todo
	}

	public async findTradesToExecute(
		marketsTraded: Array<BN> = [],
		arbPct = new BN(250)
	): Promise<TradeToExecute[]> {
		const marketsAccount: any = await this.clearingHouse.getMarketsAccount();
		const tradesToExecute: TradeToExecute[] = [];
		for (const marketIndex in marketsAccount.markets) {
			const market = marketsAccount.markets[marketIndex];
			if (!market.initialized) {
				continue;
			}
			const marketIndexBN = new BN(marketIndex);
			if (marketsTraded.length > 0 && !marketsTraded.includes(marketIndexBN)) {
				continue;
			}
			const markPrice = stripMantissa(
				this.clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndexBN)
			);

			const oraclePriceData = await this.pythClient.getPriceData(
				market.amm.oracle
			);

			if (oraclePriceData.status.toString() != '1') {
				//agg.status = Trading (1)
				console.log(marketIndexBN, 'oracle status != Trading(1)');
				continue;
			}

			const oraclePrice = oraclePriceData.price;
			const oracleTwap = oraclePriceData.twap.value;

			const oracleConf = oraclePriceData.confidence;
			const oracleNoise = oracleConf / 5;

			let positionIdx = 0;
			let arbPos;
			// let uPnL = 0;
			let netExposure = 0;
			// const tradeEV = 0;
			let positionValue = ZERO;

			const positions = this.userAccount.userPositionsAccount.positions;
			for (const position in positions) {
				if (positions[position].marketIndex.eq(marketIndexBN)) {
					arbPos = positions[position];
					// uPnL = stripMantissa(this.clearingHouse.calculatePositionPNL(arbPos, false), USDC_PRECISION);
					netExposure = stripMantissa(
						arbPos.baseAssetAmount,
						BASE_ASSET_PRECISION
					);
					positionValue = this.userAccount.getPositionValue(positionIdx);
				}
				positionIdx += 1;
			}

			const isPositionValueLimit = positionValue.gt(
				this.userAccount.getTotalCollateral()
			); // no more than 1x leverage per market

			const oraclePriceWithMantissa = new BN(
				oraclePrice * AMM_MANTISSA.toNumber()
			);

			const nowBN = new BN((Date.now() / 1000).toFixed(0));

			const nowSOL = new BN(
				await this.clearingHouse.connection.getBlockTime(
					await this.clearingHouse.connection.getSlot()
				)
			);

			console.log('timestamp', nowBN.sub(nowSOL).toNumber());

			const lastFundingTs = market.amm.lastFundingRateTs;
			// const lastFundingRate = market.amm.lastFundingRate;

			const periodicity = market.amm.fundingPeriod;

			const nextFundingTime = lastFundingTs
				.add(periodicity)
				.sub(nowSOL)
				.toNumber();

			let goodForFundingUpdate = false;
			const closeToFundingUpdate = nextFundingTime <= 60 * 5; // last 5 minutes
			let shouldReducePosition = false;

			const oraclePrevPrice = oraclePriceData.previousPrice;
			const oracleTwac = oraclePriceData.twac.value;

			this.alphas[marketIndexBN.toNumber()] =
				0.99 * this.alphas[marketIndexBN.toNumber()] +
				(0.01 * (oraclePrice - oraclePrevPrice)) / oracleConf;
			console.log('oracle alpha:', this.alphas);

			const oracleTwapWithMantissa = new BN(
				oraclePriceData.twap.value * AMM_MANTISSA.toNumber()
			);
			const markTwapWithMantissa = market.amm.lastMarkPriceTwap;
			const estFundingPayment =
				(netExposure *
					stripMantissa(markTwapWithMantissa.sub(oracleTwapWithMantissa))) /
				24;

			if (closeToFundingUpdate) {
				// put position in good funding territory
				// let estFundingRate = await this.clearingHouse.calculateEstimatedFundingRate(
				// 												marketIndexBN,
				// 												this.pythClient,
				// 												new BN(1),
				// 												"lowerbound");

				if (
					(estFundingPayment > 0 && netExposure > 0) ||
					(estFundingPayment < 0 && netExposure < 0)
				) {
					// reduce position to lower funding payment
					shouldReducePosition = true;
				} else {
					goodForFundingUpdate = true;
				}
			}

			if (nextFundingTime <= 0) {
				// collect/avoid funding payment
				if (goodForFundingUpdate) {
					//todo check if successful?
					await this.clearingHouse.updateFundingRate(
						market.amm.oracle,
						marketIndexBN
					);
					continue;
				}
			}

			// if netExposure is correct direction
			if (
				(netExposure > 0 && markPrice < oraclePrice) ||
				(netExposure < 0 && markPrice > oraclePrice)
			) {
				const currentSpread = Math.abs(markPrice - oraclePrice);
				const currentSpreadPct = currentSpread / oraclePrice;

				console.log(currentSpread);
				if (
					(currentSpreadPct < 0.0075 ||
						currentSpread < oracleTwac ||
						currentSpread < oracleNoise) &&
					!shouldReducePosition
				) {
					console.log(
						'spread too small to arb in Market:',
						marketIndexBN.toNumber()
					);
					continue;
				}
			}

			let riskReduction = false;
			let arbPctMod;
			const randomDraw = 50 + Math.floor(Math.random() * 200);

			if (
				(markPrice >= oracleTwap &&
					markPrice < oraclePrice &&
					netExposure > 0) ||
				(markPrice <= oracleTwap && markPrice > oraclePrice && netExposure < 0)
			) {
				arbPctMod = new BN(Math.min(randomDraw / 2, 100));
			} else if (
				(markPrice > oraclePrice && netExposure > 0) ||
				(markPrice < oraclePrice && netExposure < 0)
			) {
				riskReduction = true;
				arbPctMod = new BN(1000);
			} else if (shouldReducePosition) {
				riskReduction = true;
				arbPctMod = ZERO;
			} else {
				if (randomDraw % 2) {
					continue;
				}
				arbPctMod = new BN(Math.min(randomDraw, 250));
			}

			if (isPositionValueLimit && !riskReduction) {
				console.log('hit isPositionValueLimit and not risk reducing trade');
				continue;
			}

			arbPctMod = BN.min(arbPct, arbPctMod);

			let direction: PositionDirection;
			let amount = ZERO;
			let limitPrice: BN;

			if (arbPctMod.gt(ZERO)) {
				[direction, amount, , limitPrice] =
					this.clearingHouse.calculateTargetPriceTrade(
						marketIndexBN,
						oraclePriceWithMantissa,
						arbPctMod
					);
			} else if (riskReduction) {
				const reductionSize = positionValue.div(
					new BN(Math.sqrt(Math.max(2, nextFundingTime)))
				);
				amount = reductionSize;
				direction =
					netExposure > 0 ? PositionDirection.SHORT : PositionDirection.LONG;
			}

			if (amount.eq(ZERO)) {
				continue;
			}

			// tiny buffers for limitPrice
			if (direction == PositionDirection.LONG) {
				limitPrice = new BN(limitPrice.toNumber() * 1.0001);
			} else {
				limitPrice = new BN(limitPrice.toNumber() * 0.9999);
			}

			tradesToExecute.push({
				direction,
				marketIndex: marketIndexBN,
				amount,
				oraclePriceWithMantissa: limitPrice,
			});
		}
		return tradesToExecute;
	}

	public async executeTrade(tradeToExecute: TradeToExecute) {
		// console.log(tradeToExecute);
		await this.clearingHouse.openPosition(
			(
				await this.clearingHouse.getUserAccountPublicKey()
			)[0],
			tradeToExecute.direction,
			tradeToExecute.amount,
			tradeToExecute.marketIndex,
			tradeToExecute.oraclePriceWithMantissa
		);
	}
}
