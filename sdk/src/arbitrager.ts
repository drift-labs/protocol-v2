import { ClearingHouse, AMM_MANTISSA } from './clearingHouse';
import { PythClient } from './pythClient';
import BN from 'bn.js';
import { ZERO } from './constants/numericConstants';
import {PositionDirection} from "./types";
import { assert } from './assert/assert';

export interface TradeToExecute {
	direction: PositionDirection;
	marketIndex: BN;
	amount: BN;
	limitPrice: BN;
}

export class Arbitrager {
	private clearingHouse: ClearingHouse;
	private pythClient: PythClient;

	public constructor(clearingHouse: ClearingHouse) {
		if (!clearingHouse.isSubscribed) {
			throw Error('clearingHouse must be subscribed to create arbitrager');
		}
		this.clearingHouse = clearingHouse;
		this.pythClient = new PythClient(this.clearingHouse.connection);
	}

	public async findTradesToExecute(marketsTraded: Array<BN>=[], arbPct: BN=new BN(1000)) : Promise<TradeToExecute[]> {
		const marketsAccount: any = await this.clearingHouse.getMarketsAccount();
		const tradesToExecute : TradeToExecute[] = [];
		for (const marketIndex in marketsAccount.markets) {
			const market = marketsAccount.markets[marketIndex];
			if (!market.initialized) {
				continue;
			}
			const marketIndexBN = new BN(marketIndex);

			if (marketsTraded!=[] && !marketsTraded.includes(marketIndexBN)){
				continue;
			}

			assert(false);

			const oraclePriceData = await this.pythClient.getPriceData(
				market.amm.oracle
			);
			
			const oraclePriceDataT = oraclePriceData.price;

			const oraclePriceWithMantissa = new BN(
				oraclePriceDataT * AMM_MANTISSA.toNumber()
			);

			const [direction, amount, expectedEntryPrice, expectedTargetPrice] = 
			this.clearingHouse.calculateTargetPriceTrade(
				marketIndexBN,
				oraclePriceWithMantissa,
				arbPct
			);

			let targetPriceWithBuffer: BN;
			
			if (direction == PositionDirection.LONG) {
				targetPriceWithBuffer = new BN(
					expectedTargetPrice.toNumber() * (1 + .0001)
				);
			} else{
				targetPriceWithBuffer = new BN(
					expectedTargetPrice.toNumber() * (1 - .0001)
				);
			}

			if (amount.eq(ZERO)) {
				continue;
			}

			tradesToExecute.push({
				direction,
				marketIndex: marketIndexBN,
				amount,
				limitPrice: targetPriceWithBuffer,
			});
		}
		return tradesToExecute;
	}

	public async executeTrade(tradeToExecute: TradeToExecute) {
		await this.clearingHouse.openPosition(
			(
				await this.clearingHouse.getUserAccountPublicKey()
			)[0],
			tradeToExecute.direction,
			tradeToExecute.amount,
			tradeToExecute.marketIndex,
			tradeToExecute.limitPrice
		);
	}
}
