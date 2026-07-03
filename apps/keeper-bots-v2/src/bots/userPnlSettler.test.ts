import { expect } from 'chai';
import { BN, QUOTE_PRECISION, ZERO } from '@velocity-exchange/sdk';

import { UserPnlSettlerBot } from './userPnlSettler';

const HEALTHY_MARKET = 1;
const DEAD_MARKET = 2; // oracle unavailable, e.g. a stale devnet test market

// A negative-PnL perp position. baseAssetAmount == 0 keeps the SDK's
// calculateClaimablePnl on its trivial path (returns quoteAssetAmount), so the
// bot's real settlement logic runs without needing a full AMM/oracle fixture.
function negativePosition(marketIndex: number) {
	return {
		marketIndex,
		baseAssetAmount: ZERO,
		quoteAssetAmount: new BN(-50).mul(QUOTE_PRECISION), // -$50 unsettled
		lpShares: ZERO,
	};
}

function fakeUser(positions: ReturnType<typeof negativePosition>[]) {
	return {
		getUserAccountOrThrow: () => ({ poolId: 0 }),
		getActivePerpPositions: () => positions,
		getUserAccountPublicKey: () => ({ toBase58: () => 'FakeUserPubkey' }),
	};
}

// Minimal UserPnlSettlerBot with just the fields findLargestNegativePnlUsersToSettle
// touches. Built via Object.create to skip the heavy constructor (which spins up
// BlockhashSubscriber/UserMap/RevenueShareEscrowMap).
function makeBot(opts: {
	users: ReturnType<typeof fakeUser>[];
	deadMarkets: Set<number>;
	oracleCalls: { count: number };
}): UserPnlSettlerBot {
	const bot = Object.create(UserPnlSettlerBot.prototype) as any;

	bot.marketIndexes = [];
	bot.minPnlToSettle = new BN(-10).mul(QUOTE_PRECISION); // settle if |pnl| >= $10
	bot.missingOracleWarned = new Set<number>();

	bot.userMap = {
		size: () => opts.users.length,
		values: () => opts.users[Symbol.iterator](),
	};

	bot.velocityClient = {
		getPerpMarketAccount: (_idx: number) => ({ pausedOperations: 0 }),
		getSpotMarketAccount: (_idx: number) => ({}),
		getOracleDataForPerpMarket: (idx: number) => {
			opts.oracleCalls.count++;
			if (opts.deadMarkets.has(idx)) {
				// Mirrors VelocityClient.getOracleDataForPerpMarket when the oracle
				// has no price data.
				throw new Error(`No oracle price data for perp market ${idx}`);
			}
			return { price: new BN(100).mul(QUOTE_PRECISION) };
		},
	};

	return bot as UserPnlSettlerBot;
}

describe('UserPnlSettlerBot missing-oracle resilience', () => {
	it('skips a market whose oracle is missing and still settles the healthy market', async () => {
		const oracleCalls = { count: 0 };
		// Dead market is listed first so the old code would throw before ever
		// reaching the healthy market.
		const user = fakeUser([
			negativePosition(DEAD_MARKET),
			negativePosition(HEALTHY_MARKET),
		]);
		const bot = makeBot({
			users: [user],
			deadMarkets: new Set([DEAD_MARKET]),
			oracleCalls,
		});

		const result = await (bot as any).findLargestNegativePnlUsersToSettle(
			Date.now() / 1000
		);

		// Healthy market still produced a settle candidate...
		expect(result.has(HEALTHY_MARKET)).to.be.true;
		expect(result.get(HEALTHY_MARKET)).to.have.length(1);
		expect(result.get(HEALTHY_MARKET)[0].pnl).to.equal(-50);

		// ...while the dead-oracle market was skipped, not settled or thrown on.
		expect(result.has(DEAD_MARKET)).to.be.false;

		// The dead market's oracle was actually queried (proving we hit the throw
		// path) and recorded so it's only warned about once.
		expect(oracleCalls.count).to.be.greaterThan(0);
		expect((bot as any).missingOracleWarned.has(DEAD_MARKET)).to.be.true;
	});

	it('getOracleDataForPerpMarketSafe swallows the throw and returns undefined', () => {
		const oracleCalls = { count: 0 };
		const bot = makeBot({
			users: [],
			deadMarkets: new Set([DEAD_MARKET]),
			oracleCalls,
		});

		// Healthy market returns data; dead market returns undefined instead of throwing.
		expect((bot as any).getOracleDataForPerpMarketSafe(HEALTHY_MARKET)).to.not
			.be.undefined;
		expect((bot as any).getOracleDataForPerpMarketSafe(DEAD_MARKET)).to.be
			.undefined;

		// Warns/records only once even across repeated calls.
		(bot as any).getOracleDataForPerpMarketSafe(DEAD_MARKET);
		expect((bot as any).missingOracleWarned.size).to.equal(1);
	});
});
