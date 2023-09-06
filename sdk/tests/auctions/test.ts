import {PRICE_PRECISION, BN, deriveOracleAuctionParams} from "../../src";
import {assert} from "chai";

describe('Auction Tests', () => {

	it('deriveOracleAuctionParams', async () => {
		let oraclePrice = new BN(100).mul(PRICE_PRECISION);
		let auctionStartPrice = new BN(90).mul(PRICE_PRECISION);
		let auctionEndPrice = new BN(110).mul(PRICE_PRECISION);
		let limitPrice = new BN(120).mul(PRICE_PRECISION);

		let oracleOrderParams = deriveOracleAuctionParams({
			oraclePrice,
			auctionStartPrice,
			auctionEndPrice,
			limitPrice,
		});

		assert(oracleOrderParams.auctionStartPrice.eq(new BN(-10).mul(PRICE_PRECISION)));
		assert(oracleOrderParams.auctionEndPrice.eq(new BN(10).mul(PRICE_PRECISION)));
		assert(oracleOrderParams.limitPrice.eq(new BN(20).mul(PRICE_PRECISION)));

		oraclePrice = new BN(100).mul(PRICE_PRECISION);
		auctionStartPrice = new BN(110).mul(PRICE_PRECISION);
		auctionEndPrice = new BN(90).mul(PRICE_PRECISION);
		limitPrice = new BN(80).mul(PRICE_PRECISION);

		oracleOrderParams = deriveOracleAuctionParams({
			oraclePrice,
			auctionStartPrice,
			auctionEndPrice,
			limitPrice,
		});

		assert(oracleOrderParams.auctionStartPrice.eq(new BN(10).mul(PRICE_PRECISION)));
		assert(oracleOrderParams.auctionEndPrice.eq(new BN(-10).mul(PRICE_PRECISION)));
		assert(oracleOrderParams.limitPrice.eq(new BN(-20).mul(PRICE_PRECISION)));
	});
});