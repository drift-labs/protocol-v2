import { BN } from '@coral-xyz/anchor';
import {
	PRICE_PRECISION,
	PerpMarketAccount,
	calculateReservePrice,
	calculateTargetPriceTrade,
	ZERO,
} from '../sdk/src';

/**
 * liquidityBook
 * show snapshot of liquidity, similar to traditional orderbook
 * @param market
 * @param N number of bids/asks
 * @param incrementSize grouping of liquidity by pct price move
 * @returns
 */
export function liquidityBook(
	market: PerpMarketAccount,
	N = 5,
	incrementSize = 0.1
) {
	const defaultSlippageBN = new BN(incrementSize * PRICE_PRECISION.toNumber());
	const baseAssetPriceWithMantissa = calculateReservePrice(market);
	const bidsPrice = [];
	const bidsCumSize = [];
	const asksPrice = [];
	const asksCumSize = [];

	for (let i = 1; i <= N; i++) {
		const targetPriceDefaultSlippage = baseAssetPriceWithMantissa
			.mul(PRICE_PRECISION.add(defaultSlippageBN.mul(new BN(i))))
			.div(PRICE_PRECISION);
		const [_direction, liquidity, entryPrice] = calculateTargetPriceTrade(
			market,
			BN.max(targetPriceDefaultSlippage, new BN(1))
		);

		console.log(liquidity.toString());
		if (liquidity.gt(ZERO)) {
			asksPrice.push(entryPrice);
			asksCumSize.push(liquidity);
		}

		const targetPriceDefaultSlippageBid = baseAssetPriceWithMantissa
			.mul(PRICE_PRECISION.sub(defaultSlippageBN.mul(new BN(i))))
			.div(PRICE_PRECISION);
		const [_directionBid, liquidityBid, entryPriceBid] =
			calculateTargetPriceTrade(
				market,
				BN.max(targetPriceDefaultSlippageBid, new BN(1))
			);

		if (liquidityBid.gt(ZERO)) {
			bidsPrice.push(entryPriceBid);
			bidsCumSize.push(liquidityBid);
		}
	}

	return [bidsPrice, bidsCumSize, asksPrice, asksCumSize];
}
