import {
	PRICE_PRECISION,
	BN,
	deriveOracleAuctionParams,
	PositionDirection,
} from '../../src';
import { assert } from 'chai';

describe('Auction Tests', () => {
	it('deriveOracleAuctionParams', async () => {
		let oraclePrice = new BN(100).mul(PRICE_PRECISION);
		let auctionStartPrice = new BN(90).mul(PRICE_PRECISION);
		let auctionEndPrice = new BN(110).mul(PRICE_PRECISION);
		let limitPrice = new BN(120).mul(PRICE_PRECISION);

		let oracleOrderParams = deriveOracleAuctionParams({
			direction: PositionDirection.LONG,
			oraclePrice,
			auctionStartPrice,
			auctionEndPrice,
			limitPrice,
		});

		assert(
			oracleOrderParams.auctionStartPrice.eq(new BN(-10).mul(PRICE_PRECISION))
		);
		assert(
			oracleOrderParams.auctionEndPrice.eq(new BN(10).mul(PRICE_PRECISION))
		);
		assert(
			oracleOrderParams.oraclePriceOffset === 20 * PRICE_PRECISION.toNumber()
		);

		oracleOrderParams = deriveOracleAuctionParams({
			direction: PositionDirection.LONG,
			oraclePrice,
			auctionStartPrice: oraclePrice,
			auctionEndPrice: oraclePrice,
			limitPrice: oraclePrice,
		});

		assert(oracleOrderParams.auctionStartPrice.eq(new BN(0)));
		assert(oracleOrderParams.auctionEndPrice.eq(new BN(0)));
		assert(oracleOrderParams.oraclePriceOffset === 1);

		oraclePrice = new BN(100).mul(PRICE_PRECISION);
		auctionStartPrice = new BN(110).mul(PRICE_PRECISION);
		auctionEndPrice = new BN(90).mul(PRICE_PRECISION);
		limitPrice = new BN(80).mul(PRICE_PRECISION);

		oracleOrderParams = deriveOracleAuctionParams({
			direction: PositionDirection.SHORT,
			oraclePrice,
			auctionStartPrice,
			auctionEndPrice,
			limitPrice,
		});

		assert(
			oracleOrderParams.auctionStartPrice.eq(new BN(10).mul(PRICE_PRECISION))
		);
		assert(
			oracleOrderParams.auctionEndPrice.eq(new BN(-10).mul(PRICE_PRECISION))
		);
		assert(
			oracleOrderParams.oraclePriceOffset === -20 * PRICE_PRECISION.toNumber()
		);

		oracleOrderParams = deriveOracleAuctionParams({
			direction: PositionDirection.SHORT,
			oraclePrice,
			auctionStartPrice: oraclePrice,
			auctionEndPrice: oraclePrice,
			limitPrice: oraclePrice,
		});

		assert(oracleOrderParams.auctionStartPrice.eq(new BN(0)));
		assert(oracleOrderParams.auctionEndPrice.eq(new BN(0)));
		assert(oracleOrderParams.oraclePriceOffset === -1);
	});
});
