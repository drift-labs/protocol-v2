import { ClearingHouse, AMM_MANTISSA } from './clearingHouse';
import { PythClient } from './pythClient';
import BN from 'bn.js';
import { ZERO } from './constants/numericConstants';
import {PositionDirection} from "./types";

export interface TradeToExecute {
	direction: PositionDirection;
	marketIndex: BN;
	amount: BN;
	oraclePriceWithMantissa: BN;
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

	public async findTradesToExecute(marketsTraded: Array<BN>=[], arbPct=new BN(250)) : Promise<TradeToExecute[]> {
		const marketsAccount: any = await this.clearingHouse.getMarketsAccount();
		const tradesToExecute : TradeToExecute[] = [];
		for (const marketIndex in marketsAccount.markets) {
			const market = marketsAccount.markets[marketIndex];
			if (!market.initialized) {
				continue;
			}
			const marketIndexBN = new BN(marketIndex);
			if(marketsTraded.length > 0 && !marketsTraded.includes(marketIndexBN)){
				continue;
			}
			const oraclePriceData = await this.pythClient.getPriceData(
				market.amm.oracle
			);
			
			const oraclePriceDataT = oraclePriceData.price;

			const oraclePriceWithMantissa = new BN(
				oraclePriceDataT * AMM_MANTISSA.toNumber()
			);

			const [direction, amount, , ] = 
			this.clearingHouse.calculateTargetPriceTrade(
				marketIndexBN,
				oraclePriceWithMantissa,
				arbPct
			);

			let oraclePriceWithMantissaWithBuffer: BN;
			
			if (direction == PositionDirection.LONG) {
				oraclePriceWithMantissaWithBuffer = new BN(
				oraclePriceDataT * (AMM_MANTISSA.toNumber() + AMM_MANTISSA.toNumber()/1000)
				);
			} else{
				oraclePriceWithMantissaWithBuffer = new BN(
					oraclePriceDataT * (AMM_MANTISSA.toNumber() - AMM_MANTISSA.toNumber()/1000)
				);
			}

			if (amount.eq(ZERO)) {
				continue;
			}

			tradesToExecute.push({
				direction,
				marketIndex: marketIndexBN,
				amount,
				oraclePriceWithMantissa: oraclePriceWithMantissaWithBuffer,
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
			tradeToExecute.oraclePriceWithMantissa
		);
	}
}
