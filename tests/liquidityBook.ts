import { BN } from '@project-serum/anchor';
import {
	MARK_PRICE_PRECISION,
	Market,
	calculateMarkPrice,
	calculateTargetPriceTrade,
} from '../sdk/src';

/**
 * liquidityBook
 * show snapshot of liquidity, similar to traditional orderbook
 * @param market
 * @param N number of bids/asks
 * @param incrementSize grouping of liquidity by pct price move
 * @returns
 */
export function liquidityBook(market: Market, N = 5, incrementSize = 0.1) {
	const defaultSlippageBN = new BN(
		incrementSize * MARK_PRICE_PRECISION.toNumber()
	);
	const baseAssetPriceWithMantissa = calculateMarkPrice(market);
	const bidsPrice = [];
	const bidsCumSize = [];
	const asksPrice = [];
	const asksCumSize = [];

	for (let i = 1; i <= N; i++) {
		const targetPriceDefaultSlippage = baseAssetPriceWithMantissa
			.mul(MARK_PRICE_PRECISION.add(defaultSlippageBN.mul(new BN(i))))
			.div(MARK_PRICE_PRECISION);
		const [_direction, liquidity, entryPrice] = calculateTargetPriceTrade(
			market,
			BN.max(targetPriceDefaultSlippage, new BN(1))
		);
		asksPrice.push(entryPrice);
		asksCumSize.push(liquidity);

		const targetPriceDefaultSlippageBid = baseAssetPriceWithMantissa
			.mul(MARK_PRICE_PRECISION.sub(defaultSlippageBN.mul(new BN(i))))
			.div(MARK_PRICE_PRECISION);
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
