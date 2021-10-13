import {
	ClearingHouse,
	AMM_MANTISSA,
	BASE_ASSET_PRECISION,
	USDC_PRECISION,
} from './clearingHouse';
import { UserAccount } from './userAccount';
import { PythClient } from './pythClient';
import BN from 'bn.js';
import {
	stripMantissa,
	stripBaseAssetPrecision,
} from './DataSubscriptionHelpers';
import { ZERO } from './constants/numericConstants';
import Markets from './constants/markets';
import { PositionDirection } from './types';
import { Trade } from 'ccxws';
import { Connection, PublicKey } from '@solana/web3.js';
import { PriceData } from '@pythnetwork/client';
import { ftx } from 'ccxt';

export interface TradeToExecute {
	direction: PositionDirection;
	marketIndex: BN;
	amount: BN;
	oraclePriceWithMantissa: BN;
}

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
	private prevMarketNetExposureExBot: Array<number>;
	private connectionOverride: Connection;
	private ftxClient: ftx;
	private exchangeTrades: Array<Trade>;
	private useExternal: boolean;

	public constructor(
		clearingHouse: ClearingHouse,
		userAccount: UserAccount,
		connectionOverride?: Connection,
		useExternal?: boolean
	) {
		if (!clearingHouse.isSubscribed) {
			throw Error('clearingHouse must be subscribed to create arbitrager');
		}
		this.clearingHouse = clearingHouse;
		this.userAccount = userAccount;
		this.connectionOverride = connectionOverride;

		if (connectionOverride !== undefined) {
			this.pythClient = new PythClient(connectionOverride);
		} else {
			this.pythClient = new PythClient(this.clearingHouse.connection);
		}
		this.alphas = [0, 0, 0, 0]; //todo
		this.prevMarketNetExposureExBot = [0, 0, 0, 0]; //todo

		// todo this outside of main sdk. pass api key?
		this.exchangeTrades = []; //todo
		this.useExternal = useExternal;
		this.ftxClient = new ftx();
	}

	public async getWeightedOBprice(symbol: string): Promise<number> {
		const orderbook = await this.ftxClient.fetchOrderBook(symbol);
		let bidsum = 0;
		let bidvolumesum = 0;
		let asksum = 0;
		let askvolumesum = 0;

		for (let i = 0; i < orderbook['bids'].length; i++) {
			bidsum += orderbook['bids'][i][0] * orderbook['bids'][i][1];
			bidvolumesum += orderbook['bids'][i][1];

			asksum += orderbook['asks'][i][0] * orderbook['asks'][i][1];
			askvolumesum += orderbook['asks'][i][1];
		}

		const weightedOBprice = (bidsum + asksum) / (bidvolumesum + askvolumesum);
		console.log('Weighted Average Orderbook Price', weightedOBprice);
		return weightedOBprice;
	}

	public async getRecentTradeAvg(symbol: string): Promise<any> {
		const limit = 10;
		const recentTrades = await this.ftxClient.fetchTrades(symbol, limit);
		let pricesum = 0; 
		let volumesum = 0; 
		for (let i=0; i<recentTrades.length; i++) {
			// console.log(recentTrades[i]);
			// console.log(recentTrades[i].timestamp);
			const amount =  recentTrades[i]['amount'];
			const price =  recentTrades[i]['price'];
			if(price && amount){
				pricesum += price * amount;
				volumesum += amount;
			}
		}
		
		const weightedAvg = pricesum / volumesum;
		console.log('Weighted Average Price of', limit, 'Trades', weightedAvg);
		return weightedAvg;
	}

	public async findTradesToExecute(
		marketsTraded: Array<BN> = [],
		arbPct = new BN(250)
	): Promise<TradeToExecute[]> {
		const marketsAccount: any = await this.clearingHouse.getMarketsAccount();
		const tradesToExecute: TradeToExecute[] = [];
		const MAX_TRADE_AMOUNT = new BN(100000).mul(USDC_PRECISION);

		for (const marketIndex in Markets) {
			// LOAD MARKET + DATA
			let marketIndexBN;
			let marketIndexNum;
			let marketJSON;
			let market;

			let markPrice: number;
			let oraclePricePubkey: PublicKey;
			let marketNetExposure: number;
			let blockTimeConnection;
			let prevMarketNetExposureExBot;
			let arbPctMod;

			const loadMarket = () => {
				let isValidMarket = true;

				marketIndexBN = new BN(marketIndex);
				marketIndexNum = marketIndexBN.toNumber();

				// const vwapI = VWAP(this.exchangeTrades);
				// if(this.exchangeTrades.length > 0){
				// 	this.exchangeTrades = [];
				// }

				marketJSON = Markets[marketIndex];
				const marketJSON2 = Markets.find(
					(market) => market.marketIndex.toNumber() === marketIndexBN.toNumber()
				);

				market = marketsAccount.markets[marketIndex];

				if (marketJSON !== marketJSON2) {
					throw Error('Market JSON assumptions incorrect');
					isValidMarket = false;
				}
				if (!market.initialized) {
					isValidMarket = false;
				} else if (
					marketsTraded.length > 0 &&
					!marketsTraded.includes(marketIndexBN)
				) {
					isValidMarket = false;
				}

				return isValidMarket;
			};

			const loadMarketData = () => {
				markPrice = stripMantissa(
					this.clearingHouse.calculateBaseAssetPriceWithMantissa(marketIndexBN)
				);

				const devnetOracle = marketJSON.devnetPythOracle;
				const mainnetOracle = marketJSON.mainnetPythOracle;

				marketNetExposure = stripBaseAssetPrecision(market.baseAssetAmount);

				prevMarketNetExposureExBot =
					this.prevMarketNetExposureExBot[marketIndexBN.toNumber()];
				this.prevMarketNetExposureExBot[marketIndexBN.toNumber()] =
					prevMarketNetExposureExBot;

				oraclePricePubkey = market.amm.oracle;

				if (oraclePricePubkey.toString() !== devnetOracle) {
					throw Error('wrong oracle assumptions');
				}

				blockTimeConnection = this.clearingHouse.connection;

				if (this.connectionOverride) {
					// console.log('using connectionOverride');
					oraclePricePubkey = new PublicKey(mainnetOracle);
					blockTimeConnection = this.connectionOverride;
				}
			};

			let oraclePriceData: PriceData;
			let oraclePrice;
			let oracleTwac;

			let oracleBid;
			let oracleAsk;

			let oracleTarget: number;
			let orcaleTwapTarget: number;
			let oracleTargetWithMantissa: BN;

			let nowSOL: BN;

			let positionIdx = 0;
			let arbPos;
			let uPnL = 0;
			let marketNetExposureExBot = marketNetExposure;
			let netExposure = 0;
			let tradeEV = 0;
			let positionValue = ZERO;
			let deltaNetExposureExBot = 0;

			let isPositionValueLimit = false;

			const getOracleData = async (oraclePricePubkey) => {
				oraclePriceData = await this.pythClient.getPriceData(oraclePricePubkey);

				// const nowBN = new BN((Date.now() / 1000).toFixed(0));

				const nowSlot = await blockTimeConnection.getSlot();
				nowSOL = new BN(await blockTimeConnection.getBlockTime(nowSlot));

				const oracleLastValidSlot = oraclePriceData.validSlot;
				const oracleDelay = (nowSlot - Number(oracleLastValidSlot)) * 0.4; // estimate in seconds (assume 400ms each block)

				if (oracleDelay > 30) {
					console.log(
						'Market',
						marketIndex,
						'oracle delay > 30 seconds:',
						oracleDelay
					);
					return false;
				}

				if (oraclePriceData.status.toString() !== '1') {
					//agg.status = Trading (1)
					console.log(marketIndexBN, 'oracle status != Trading(1)');
					return false;
				}

				oraclePrice = oraclePriceData.price;
				oracleTwac = oraclePriceData.twac.value;
				
				// const oracelConfLatest = oraclePriceData.priceComponents[0].latest.confidence;
				const oracleConfs = [oraclePriceData.previousConfidence, oraclePriceData.confidence, oracleTwac];
				function median(numbers) {
					const sorted = numbers.slice().sort((a, b) => a - b);
					const middle = Math.floor(sorted.length / 2);
				
					if (sorted.length % 2 === 0) {
						return (sorted[middle - 1] + sorted[middle]) / 2;
					}
				
					return sorted[middle];
				}

				const oracleConfReg = median(oracleConfs)

				oracleBid = oraclePriceData.price - oracleConfReg;
				oracleAsk = oraclePriceData.price + oracleConfReg;

				return true;
			};

			const getNetExposure = async () => {
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
						marketNetExposureExBot -= netExposure;
						deltaNetExposureExBot =
							prevMarketNetExposureExBot - marketNetExposureExBot;
						positionValue = this.userAccount.getPositionValue(positionIdx);
					}
					positionIdx += 1;
				}

				const maxPostionValuePerMarket = this.userAccount
					.getTotalCollateral()
					.div(new BN(Markets.length / 2));

				const positionValueNum = stripMantissa(positionValue, USDC_PRECISION);
				const maxPositionValueNum = stripMantissa(
					maxPostionValuePerMarket,
					USDC_PRECISION
				);
				console.log(
					'assert position limit: ',
					positionValueNum,
					'<',
					maxPositionValueNum
				);

				if(netExposure > 0){
					oracleTarget = oracleBid;
					orcaleTwapTarget = oraclePriceData.twap.value - oracleTwac;
				} else if(netExposure < 0){
					oracleTarget = oracleAsk;
					orcaleTwapTarget = oraclePriceData.twap.value + oracleTwac;
				} else{
					if(currentSpread < 0){ 
						// mark > oracle
						oracleTarget = oracleBid;
						orcaleTwapTarget = oraclePriceData.twap.value - oracleTwac;
					} else{
						oracleTarget = oracleAsk;
						orcaleTwapTarget = oraclePriceData.twap.value + oracleTwac;
					}
				}

				oracleTargetWithMantissa = new BN(oracleTarget * AMM_MANTISSA.toNumber());

				// don't continue higher after exceeding .5x isolated leverage in a particular market
				return positionValueNum > maxPositionValueNum;
			};

			const marketValid = loadMarket();
			if (!marketValid) {
				console.error('Market', marketIndexNum, 'Invalid');
				continue;
			} else {
				console.log('Arbing Market', marketIndexNum);
			}

			loadMarketData();

			let goodForFundingUpdate = false;
			let shouldReducePosition = false;
			let nextFundingTime;

			let riskReduction = false;
			let direction: PositionDirection;
			let limitPrice: BN;
			let amount = ZERO;

			let skipTrade = false;
			let currentSpread;
			let currentSpreadPct;

			const eyeFundingPayment = async () => {
				// console.log('timestamp', nowBN.sub(nowSOL).toNumber());

				const lastFundingTs = market.amm.lastFundingRateTs;
				// const lastFundingRate = market.amm.lastFundingRate;

				const periodicity = market.amm.fundingPeriod;

				nextFundingTime = lastFundingTs.add(periodicity).sub(nowSOL).toNumber();

				console.log(
					'NEXT FUNDING TIME IN Market',
					marketIndexNum,
					':',
					nextFundingTime
				);

				const prevToNextMarketAlpha =
					(oraclePriceData.price - oraclePriceData.previousPrice) /
					(oraclePriceData.confidence + oraclePriceData.previousConfidence);

				const currentMarketAlpha = this.alphas[marketIndexNum];
				const newMarketAlpha =
					prevToNextMarketAlpha *
						(currentMarketAlpha !== 0 ? currentMarketAlpha : 1) *
						0.01 +
					currentMarketAlpha * 0.99;
				this.alphas[marketIndexNum] = newMarketAlpha;

				// console.log('Market', marketIndex, 'oracle alpha:', newMarketAlpha);

				const oracleTwapWithMantissa = new BN(
					oraclePriceData.twap.value * AMM_MANTISSA.toNumber()
				);
				const markTwapWithMantissa = market.amm.lastMarkPriceTwap;
				const estFundingPayment =
					(Math.abs(netExposure) *
						stripMantissa(markTwapWithMantissa.sub(oracleTwapWithMantissa))) /
					24;

				const closeToFundingUpdate = nextFundingTime <= 60 * 5; // last 5 minutes

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
					}
				}
			};

			const examineMarketSpread = () => {
				currentSpread = Math.abs(markPrice - oracleTarget);
				currentSpreadPct = currentSpread / oracleTarget;

				// if netExposure is correct direction
				if (
					(netExposure > 0 && markPrice < oracleTarget) ||
					(netExposure < 0 && markPrice > oracleTarget)
				) {
					if (
						!shouldReducePosition &&
						currentSpreadPct < 0.0005
					) {
						console.log(
							'spread too small to arb in Market:',
							marketIndexNum,
							currentSpreadPct,
							currentSpread,
							oracleTwac,
							oraclePriceData.confidence
						);
						skipTrade = true;
					}
				} else if (uPnL > 0) {
					// take profit if market is wack
					shouldReducePosition = true;
				}
			};

			const decideArbAmount = () => {
				// avoid deterministic behavior, draw from range: [5%, 25%)
				const randomDraw = 50 + Math.floor(Math.random() * 200);
				if (
					(markPrice > oracleTarget && netExposure > 0) ||
					(markPrice < oracleTarget && netExposure < 0)
				) {
					// markPrice is wrong in our favor, time to be aggressive in risk reduction
					riskReduction = true;
					arbPctMod = new BN(1000);
				} else if (shouldReducePosition || isPositionValueLimit) {
					riskReduction = true;
					arbPctMod = ZERO;
				} else if (
					(markPrice >= orcaleTwapTarget &&
						markPrice < oracleTarget &&
						netExposure > 0) ||
					(markPrice <= orcaleTwapTarget &&
						markPrice > oracleTarget &&
						netExposure < 0)
				) {
					arbPctMod = new BN(Math.min(randomDraw / 2, 100));
				} else {
					// catch all for non-critical arb trade

					// randomly do or dont to juke front runners
					if (randomDraw % 2) {
						console.log('skipping trade randomly', randomDraw);
					}
					arbPctMod = new BN(Math.min(randomDraw, 250));
				}

				arbPctMod = BN.min(arbPct, arbPctMod);
			};

			const constructTrade = async (targetPrice: BN) => {
				if (arbPctMod.gt(ZERO)) {
					// use expected entryPrice as limit given this change:
					// https://github.com/drift-labs/protocol-v1/commit/a82f08deb2202efe73e48d0f84f981c9443fde67
					[direction, amount, limitPrice] =
						this.clearingHouse.calculateTargetPriceTrade(
							marketIndexBN,
							targetPrice,
							arbPctMod
						);
				} else if (riskReduction) {
					console.log('ATTEMPT RISK REDUCTION');

					// max reduction of 1% in a single interval
					const reductionDenom = Math.max(
						100,
						Math.sqrt(Math.max(1, nextFundingTime))
					);

					if (uPnL > 0) {
						// only count profit taking for now...
						tradeEV += uPnL / reductionDenom;
					}

					const reductionSize = BN.max(
						USDC_PRECISION,
						positionValue.div(new BN(reductionDenom))
					);
					amount = BN.min(positionValue, reductionSize);

					if (netExposure == 0) {
						console.log('Market', marketIndexNum, 'no exposure to reduce');
					}
					direction =
						netExposure > 0 ? PositionDirection.SHORT : PositionDirection.LONG;

					limitPrice = this.clearingHouse.calculatePriceImpact(
						direction,
						amount,
						marketIndexBN,
						'entryPrice'
					);

					let entrySpread = stripMantissa(
						limitPrice.sub(targetPrice)
					);

					while (
						Math.abs(entrySpread) > currentSpread * 1.01 &&
						amount.gt(USDC_PRECISION)
					) {
						amount = amount.div(new BN(2));

						limitPrice = this.clearingHouse.calculatePriceImpact(
							direction,
							amount,
							marketIndexBN,
							'entryPrice'
						);

						entrySpread = stripMantissa(
							limitPrice.sub(targetPrice)
						);
					}
				}
			};

			const resizeTrade = async () => {
				let skipTrade = false;
				// skip trades < 1 USDC
				const expectedFee =
					stripMantissa(amount.abs(), USDC_PRECISION) * 0.0005;
				if (amount.abs().lt(USDC_PRECISION.mul(new BN(1)))) {
					console.log('trade amount < $1');

					skipTrade = true;
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
					console.log('expectedFee', expectedFee, ' > tradeEV:', tradeEV);
					skipTrade = true;
				}

				if (amount.gt(MAX_TRADE_AMOUNT) && !riskReduction) {
					amount = MAX_TRADE_AMOUNT;
				}

				// reduce trade size if it gives pnl to most recent competitor trade done
				if (
					(deltaNetExposureExBot > 0 && direction == PositionDirection.LONG) ||
					(deltaNetExposureExBot < 0 && direction == PositionDirection.SHORT)
				) {
					amount = amount.div(new BN(2));
				}

				return skipTrade;
			};

			const addLimitPriceBuffer = () => {
				// tiny buffers for limitPrice
				if (direction == PositionDirection.LONG) {
					console.log('GOING LONG');
					limitPrice = new BN(limitPrice.toNumber() * 1.001);
				} else {
					console.log('GOING SHORT');
					limitPrice = new BN(limitPrice.toNumber() * 0.999);
				}
			};

			const checkExternalExchange = async () => {
				const symbol = marketJSON.baseAssetSymbol;
				let symbolPerp = symbol + '-PERP';
				if (symbol == 'COPE') {
					symbolPerp = symbol + '/USD';
				}

				const wgtOBPrice = await this.getWeightedOBprice(symbolPerp);
				const wgtTradePrice = await this.getRecentTradeAvg(symbolPerp);

				console.log(wgtOBPrice, wgtTradePrice); //todo on trade price nan

				return wgtOBPrice;
			};

			const oracleValid = await getOracleData(oraclePricePubkey);
			if (!oracleValid) {
				// todo: use external source price to trade
				console.log('invalid oracle');
				// continue;
			}
			isPositionValueLimit = await getNetExposure();
			await eyeFundingPayment();
			examineMarketSpread();
			decideArbAmount();

			if (isPositionValueLimit && !riskReduction) {
				console.log('hit isPositionValueLimit and not risk reducing trade');
				continue;
			}

			if (this.useExternal) {
				const ftxPrice = await checkExternalExchange();
				const ftxPriceWithMantissa = new BN(ftxPrice * AMM_MANTISSA.toNumber());
				console.log(ftxPrice);
				constructTrade(ftxPriceWithMantissa);
			} else {
				constructTrade(oracleTargetWithMantissa);
			}

			skipTrade = await resizeTrade();

			if (skipTrade) {
				console.log('SKIPPING TRADE DUE TO RESIZE CHECK');
				continue;
			}
			addLimitPriceBuffer();

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
