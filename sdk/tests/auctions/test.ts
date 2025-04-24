import {
	PRICE_PRECISION,
	BN,
	deriveOracleAuctionParams,
	PositionDirection,
	PerpMarketAccount,
	getTriggerAuctionStartPrice,
	ContractTier,
} from '../../src';
import { assert } from 'chai';
import { mockPerpMarkets } from '../dlob/helpers';
import * as _ from 'lodash';

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


	it('testTriggerAuctionStartPriceEstimate', async () => {
		const myMockPerpMarkets = _.cloneDeep(mockPerpMarkets);

		const mockMarket1: PerpMarketAccount = myMockPerpMarkets[0];

		const oraclePrice = new BN(150_000_000) // $150 
		const result = getTriggerAuctionStartPrice(
		  mockMarket1,
		  PositionDirection.LONG,
		  oraclePrice,
		)
	
		assert(result.eq(new BN(150_075_000))); // add 7.5 cents

		const mockMarket2: PerpMarketAccount = myMockPerpMarkets[0];
		mockMarket2.contractTier = ContractTier.SPECULATIVE;

		const oraclePrice2 = new BN(10_000_000); // $10
		let result2 = getTriggerAuctionStartPrice(
		  mockMarket2,
		  PositionDirection.LONG,
		  oraclePrice2,
		)
	
		// startBuffer add 3.5 cents
		assert(result2.eq(new BN(10_035_000)));

		result2 = getTriggerAuctionStartPrice(
			mockMarket2,
			PositionDirection.SHORT,
			oraclePrice2,
		  )
	  
		  // startBuffer subs 3.5 cents
		  assert(result2.eq(new BN(9_965_000)));
	});
});
