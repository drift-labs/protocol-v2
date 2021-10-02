import {
	ClearingHouse,
	AMM_MANTISSA,
	BASE_ASSET_PRECISION,
	USDC_PRECISION,
} from './clearingHouse';
import { UserAccount } from './userAccount';
import { PythClient } from './pythClient';
import BN from 'bn.js';
import { stripMantissa } from './DataSubscriptionHelpers';
import { ZERO } from './constants/numericConstants';
import { PositionDirection } from './types';
// import { BinanceClient, Trade } from 'ccxws';
// import { Connection, PublicKey } from '@solana/web3.js';

export interface TradeToExecute {
	direction: PositionDirection;
	marketIndex: BN;
	amount: BN;
	oraclePriceWithMantissa: BN;
}

export const DEVNET_ORACLES = {
	SOL: 'J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix',
	BTC: 'HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J',
	ETH: 'EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9xvYBMZPie1Vw',
	COPE: 'BAXDJUXtz6P5ARhHH1aPwgv4WENzHwzyhmLYK4daFwiM',
};
export const MAINNET_ORACLES = {
	SOL: 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG',
	BTC: 'GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU',
	ETH: 'JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB',
	COPE: '9xYBiDWYsh2fHzpsz3aaCnNHCKWBNtfEDLtU6kS4aFD9',
};

// const mainnetConnection = new Connection('https://api.mainnet-beta.solana.com');

export const VWAP = (trades): number => {
	const [valueSum, weightSum] = trades.reduce(
		([valueSum, weightSum], trade) => [
			valueSum + parseFloat(trade.price) * parseFloat(trade.amount),
			weightSum + parseFloat(trade.amount),
		],
		[0, 0]
	);
	return valueSum / weightSum;
};

export class Arbitrager {
	private clearingHouse: ClearingHouse;
	private pythClient: PythClient;
	private userAccount: UserAccount;
	private alphas: Array<number>;
	// private binance: BinanceClient;
	// private btrades: Array<Trade>;

	public constructor(clearingHouse: ClearingHouse, userAccount: UserAccount) {
		if (!clearingHouse.isSubscribed) {
			throw Error('clearingHouse must be subscribed to create arbitrager');
		}
		this.clearingHouse = clearingHouse;
		this.userAccount = userAccount;

		this.pythClient = new PythClient(this.clearingHouse.connection);

		this.alphas = [0, 0, 0, 0]; //todo

		// // todo this outside of main sdk. pass api key?
		// this.btrades = []; //todo
		// this.binance = new BinanceClient();
		// // market could be from CCXT or genearted by the user
		// const binanceMarket = {
		// 	id: 'BTCUSDC', // remote_id used by the exchange
		// 	base: 'BTC', // standardized base symbol for Bitcoin
		// 	quote: 'USDC', // standardized quote symbol for Tether
		// };
		// // handle trade events
		// this.binance.on('trade', (trade) => this.btrades.push(trade));
		// this.binance.subscribeTrades(binanceMarket);
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

			//todo
			// const indextoMarketName = {
			// 	0: 'SOL',
			// 	1: 'BTC',
			// 	2: 'ETH',
			// 	3: 'COPE',
			// };

			const oraclePricePubkey = market.amm.oracle;
			// const oracleMarketName = indextoMarketName[marketIndexBN.toNumber()];
			// const oracleMainnetPricePubkey = new PublicKey(
			// 	MAINNET_ORACLES[oracleMarketName]
			// );

			const oraclePriceData = await this.pythClient.getPriceData(
				oraclePricePubkey
			);

			// const nowBN = new BN((Date.now() / 1000).toFixed(0));
			const nowSlot = await this.clearingHouse.connection.getSlot();
			const nowSOL = new BN(
				await this.clearingHouse.connection.getBlockTime(nowSlot)
			);

			const oracleLastValidSlot = oraclePriceData.validSlot;
			const oracleDelay = (nowSlot - Number(oracleLastValidSlot)) * 0.4; // estimate in seconds (assume 400ms each block)
			if (oracleDelay > 30) {
				// console.log(
				// 	'Market',
				// 	marketIndex,
				// 	'oracle delay > 30 seconds:',
				// 	oracleDelay
				// );
				continue;
			}
			if (oraclePriceData.status.toString() !== '1') {
				//agg.status = Trading (1)
				// console.log(marketIndexBN, 'oracle status != Trading(1)');
				continue;
			}

			const oraclePrice = oraclePriceData.price;
			const oracleTwap = oraclePriceData.twap.value;

			const oracleConf = oraclePriceData.confidence;
			const oracleNoise = oracleConf / 5;

			let positionIdx = 0;
			let arbPos;
			let uPnL = 0;
			let netExposure = 0;
			let tradeEV = 0;
			let positionValue = ZERO;

			const positions = this.userAccount.userPositionsAccount?.positions;
			for (const position in positions) {
				if (positions[position].marketIndex.eq(marketIndexBN)) {
					arbPos = positions[position];
					uPnL = stripMantissa(
						this.clearingHouse.calculatePositionPNL(arbPos, false),
						USDC_PRECISION
					);
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
			); // don't continue higher after exceeding 1x leverage in a particular market

			const oraclePriceWithMantissa = new BN(
				oraclePrice * AMM_MANTISSA.toNumber()
			);

			// console.log('timestamp', nowBN.sub(nowSOL).toNumber());

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
			const oraclePrevConf = oraclePriceData.previousConfidence;

			const oracleTwac = oraclePriceData.twac.value;

			const prevToNextMarketAlpha =
				(oraclePrice - oraclePrevPrice) / (oracleConf + oraclePrevConf);
			const currentMarketAlpha = this.alphas[marketIndexBN.toNumber()];
			const newMarketAlpha =
				prevToNextMarketAlpha *
					(currentMarketAlpha !== 0 ? currentMarketAlpha : 1) *
					0.01 +
				currentMarketAlpha * 0.99;
			this.alphas[marketIndexBN.toNumber()] = newMarketAlpha;

			// console.log('Market', marketIndex, 'oracle alpha:', newMarketAlpha);

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
					tradeEV += Math.abs(estFundingPayment);
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
			const currentSpread = Math.abs(markPrice - oraclePrice);
			const currentSpreadPct = currentSpread / oraclePrice;

			// if netExposure is correct direction
			if (
				(netExposure > 0 && markPrice < oraclePrice) ||
				(netExposure < 0 && markPrice > oraclePrice)
			) {
				if (
					(currentSpreadPct < 0.0005 ||
						currentSpread < oracleTwac / 5 ||
						currentSpread < oracleNoise) &&
					!shouldReducePosition &&
					currentSpreadPct < 0.03
				) {
					// console.log(
					// 	'spread too small to arb in Market:',
					// 	marketIndexBN.toNumber(),
					// 	currentSpreadPct,
					// 	currentSpread,
					// 	oracleTwac,
					// 	oracleNoise
					// );
					continue;
				}
			} else if (uPnL > 0) {
				// take profit if market is wack
				shouldReducePosition = true;
			}

			let riskReduction = false;
			let arbPctMod;

			// avoid deterministic behavior, draw from range: [5%, 25%)
			const randomDraw = 50 + Math.floor(Math.random() * 200);

			if (shouldReducePosition) {
				riskReduction = true;
				arbPctMod = ZERO;
			} else if (
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
				// markPrice is wrong in our favor, time to be aggressive in risk reduction
				riskReduction = true;
				arbPctMod = new BN(1000);
			} else {
				// catch all for non-critical arb trade

				// randomly do or dont to juke front runners
				if (randomDraw % 2) {
					continue;
				}
				arbPctMod = new BN(Math.min(randomDraw, 250));
			}

			if (isPositionValueLimit && !riskReduction) {
				// console.log('hit isPositionValueLimit and not risk reducing trade');
				continue;
			}

			arbPctMod = BN.min(arbPct, arbPctMod);

			let direction: PositionDirection;
			let amount = ZERO;
			let limitPrice: BN;

			if (arbPctMod.gt(ZERO)) {
				// use expected entryPrice as limit given this change:
				// https://github.com/drift-labs/protocol-v1/commit/a82f08deb2202efe73e48d0f84f981c9443fde67
				[direction, amount, limitPrice] =
					this.clearingHouse.calculateTargetPriceTrade(
						marketIndexBN,
						oraclePriceWithMantissa,
						arbPctMod
					);
			} else if (riskReduction) {
				const reductionDenom = Math.sqrt(Math.max(2, nextFundingTime));

				if (uPnL > 0) {
					// only count profit taking for now...
					tradeEV += uPnL / reductionDenom;
				}

				const reductionSize = BN.max(
					USDC_PRECISION,
					positionValue.div(new BN(reductionDenom))
				);
				amount = BN.min(positionValue, reductionSize);
				direction =
					netExposure > 0 ? PositionDirection.SHORT : PositionDirection.LONG;

				limitPrice = this.clearingHouse.calculatePriceImpact(
					direction,
					amount,
					marketIndexBN,
					'entryPrice'
				);
			}

			// skip trades < 1 USDC
			const expectedFee = stripMantissa(amount.abs(), USDC_PRECISION) * 0.0005;
			if (amount.abs().lt(USDC_PRECISION)) {
				// console.log('trade amount < $1');
				continue;
			}

			const limitPriceNumber = stripMantissa(limitPrice);
			const postTradeSpread = Math.min(
				0,
				Math.abs(limitPriceNumber - oraclePrice)
			);

			const baseAssetAmountToAcquire = stripMantissa(
				this.clearingHouse.calculatePriceImpact(
					direction,
					amount,
					marketIndexBN,
					'acquiredBaseAssetAmount'
				),
				BASE_ASSET_PRECISION
			);

			const newNetExposure = netExposure + baseAssetAmountToAcquire;
			tradeEV += Math.abs(postTradeSpread * newNetExposure);
			// console.log('post trade info:', postTradeSpread, newNetExposure);

			// todo have tradeEV determine whether trade worth doing
			// first pass has $100 buffer...
			if (expectedFee > tradeEV + 100 && !riskReduction) {
				// console.log('expectedFee', expectedFee, ' > tradeEV:', tradeEV);
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
				oraclePriceWithMantissa: limitPrice, //todo
			});
		}
		return tradesToExecute;
	}

	public async executeTrade(tradeToExecute: TradeToExecute) {
		console.log(tradeToExecute);
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
