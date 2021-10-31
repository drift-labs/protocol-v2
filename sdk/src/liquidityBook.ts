import { BN } from '@project-serum/anchor';
import { AMM_MANTISSA } from './clearingHouse';
import { Market } from './types';
import { calculateTargetPriceTrade } from './math/trade';
import { calculateBaseAssetPriceWithMantissa } from './math/market';

/**
 * liquidityBook
 * show snapshot of liquidity, similar to traditional orderbook
 * @param market
 * @param N number of bids/asks
 * @param incrementSize grouping of liquidity by pct price move
 * @returns
 */
export function liquidityBook(market: Market, N = 5, incrementSize = 0.1) {
	const defaultSlippageBN = new BN(incrementSize * AMM_MANTISSA.toNumber());
	const baseAssetPriceWithMantissa =
		calculateBaseAssetPriceWithMantissa(market);
	const bidsPrice = [];
	const bidsCumSize = [];
	const asksPrice = [];
	const asksCumSize = [];

	for (let i = 1; i <= N; i++) {
		const targetPriceDefaultSlippage = baseAssetPriceWithMantissa
			.mul(AMM_MANTISSA.add(defaultSlippageBN.mul(new BN(i))))
			.div(AMM_MANTISSA);
		const [_direction, liquidity, entryPrice] = calculateTargetPriceTrade(
			market,
			BN.max(targetPriceDefaultSlippage, new BN(1))
		);
		asksPrice.push(entryPrice);
		asksCumSize.push(liquidity);

		const targetPriceDefaultSlippageBid = baseAssetPriceWithMantissa
			.mul(AMM_MANTISSA.sub(defaultSlippageBN.mul(new BN(i))))
			.div(AMM_MANTISSA);
		const [_directionBid, liquidityBid, entryPriceBid] =
			calculateTargetPriceTrade(
				market,
				BN.max(targetPriceDefaultSlippageBid, new BN(1))
			);
		bidsPrice.push(entryPriceBid);
		bidsCumSize.push(liquidityBid);
	}

	return [bidsPrice, bidsCumSize, asksPrice, asksCumSize];
}
