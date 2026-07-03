import * as _ from 'lodash';
import {
	BN,
	ZERO,
	PRICE_PRECISION,
	calculateMarketMarginRatio,
	calculateUnrealizedAssetWeight,
	calculateAssetWeight,
	calculateLiabilityWeight,
} from '../../src';
import { mockPerpMarkets, mockSpotMarkets } from '../dlob/helpers';
import { assert } from '../../src/assert/assert';

// The MarginCategory type declares 'Fill', but calculateMarketMarginRatio used to
// throw on it and calculateUnrealizedAssetWeight returned undefined. Both now mirror
// PerpMarket::get_margin_ratio / get_unrealized_asset_weight (perp_market.rs).
describe("MarginCategory 'Fill' parity", () => {
	it('calculateMarketMarginRatio uses (initial + maintenance) / 2 for Fill', () => {
		const market = _.cloneDeep(mockPerpMarkets[0]);
		market.marginRatioInitial = 1000;
		market.marginRatioMaintenance = 500;
		market.imfFactor = 0; // no size premium, so ratio == default

		const initial = calculateMarketMarginRatio(market, ZERO, 'Initial');
		const maintenance = calculateMarketMarginRatio(market, ZERO, 'Maintenance');
		const fill = calculateMarketMarginRatio(market, ZERO, 'Fill');

		assert(initial === 1000, `expected initial 1000, got ${initial}`);
		assert(maintenance === 500, `expected maintenance 500, got ${maintenance}`);
		// (1000 + 500) / 2 = 750
		assert(fill === 750, `expected fill 750, got ${fill}`);
	});

	it('calculateMarketMarginRatio Fill uses integer division (floor)', () => {
		const market = _.cloneDeep(mockPerpMarkets[0]);
		market.marginRatioInitial = 1001;
		market.marginRatioMaintenance = 500;
		market.imfFactor = 0;

		// (1001 + 500) / 2 = 750.5 -> floored to 750, matching u32 division
		const fill = calculateMarketMarginRatio(market, ZERO, 'Fill');
		assert(fill === 750, `expected floored fill 750, got ${fill}`);
	});

	it('calculateUnrealizedAssetWeight weights Fill identically to Initial', () => {
		const market = _.cloneDeep(mockPerpMarkets[0]);
		const quoteSpot = _.cloneDeep(mockSpotMarkets[0]);
		market.unrealizedPnlInitialAssetWeight = 8000;
		market.unrealizedPnlMaintenanceAssetWeight = 10000;
		market.unrealizedPnlMaxImbalance = ZERO; // no imbalance discount
		market.unrealizedPnlImfFactor = 0; // no size discount

		const unrealizedPnl = new BN(100).mul(PRICE_PRECISION);
		const oraclePriceData = { price: new BN(100).mul(PRICE_PRECISION) };

		const initial = calculateUnrealizedAssetWeight(
			market,
			quoteSpot,
			unrealizedPnl,
			'Initial',
			oraclePriceData
		);
		const fill = calculateUnrealizedAssetWeight(
			market,
			quoteSpot,
			unrealizedPnl,
			'Fill',
			oraclePriceData
		);
		const maintenance = calculateUnrealizedAssetWeight(
			market,
			quoteSpot,
			unrealizedPnl,
			'Maintenance',
			oraclePriceData
		);

		assert(fill.eq(initial), `expected Fill weight == Initial weight`);
		assert(fill.eq(new BN(8000)), `expected Fill weight 8000, got ${fill}`);
		assert(
			maintenance.eq(new BN(10000)),
			`expected Maintenance weight 10000, got ${maintenance}`
		);
	});

	it('spot calculateAssetWeight Fill = (scaledInitial + maintenance) / 2', () => {
		const spotMarket = _.cloneDeep(mockSpotMarkets[0]);
		spotMarket.imfFactor = 0; // no size discount
		spotMarket.scaleInitialAssetWeightStart = ZERO; // scaledInitial == initial
		spotMarket.initialAssetWeight = 8000;
		spotMarket.maintenanceAssetWeight = 9000;

		const balance = new BN(1);
		const oraclePrice = new BN(100).mul(PRICE_PRECISION);

		const initial = calculateAssetWeight(
			balance,
			oraclePrice,
			spotMarket,
			'Initial'
		);
		const maintenance = calculateAssetWeight(
			balance,
			oraclePrice,
			spotMarket,
			'Maintenance'
		);
		const fill = calculateAssetWeight(balance, oraclePrice, spotMarket, 'Fill');

		assert(initial.eq(new BN(8000)), `expected initial 8000, got ${initial}`);
		assert(
			maintenance.eq(new BN(9000)),
			`expected maintenance 9000, got ${maintenance}`
		);
		// (8000 + 9000) / 2 = 8500
		assert(fill.eq(new BN(8500)), `expected fill 8500, got ${fill}`);
	});

	it('spot calculateLiabilityWeight Fill = (initial + maintenance) / 2', () => {
		const spotMarket = _.cloneDeep(mockSpotMarkets[0]);
		spotMarket.imfFactor = 0; // no size premium
		spotMarket.initialLiabilityWeight = 12000;
		spotMarket.maintenanceLiabilityWeight = 11000;

		const size = new BN(1);

		const initial = calculateLiabilityWeight(size, spotMarket, 'Initial');
		const maintenance = calculateLiabilityWeight(
			size,
			spotMarket,
			'Maintenance'
		);
		const fill = calculateLiabilityWeight(size, spotMarket, 'Fill');

		assert(initial.eq(new BN(12000)), `expected initial 12000, got ${initial}`);
		assert(
			maintenance.eq(new BN(11000)),
			`expected maintenance 11000, got ${maintenance}`
		);
		// (12000 + 11000) / 2 = 11500
		assert(fill.eq(new BN(11500)), `expected fill 11500, got ${fill}`);
	});
});
