import { assert } from 'chai';
import { PythLazerSubscriber } from '../../src';
import { PythLazerClient } from '@pythnetwork/pyth-lazer-sdk';

/**
 * Fake PythLazerClient that records every addMessageListener/send call so we can
 * assert the subscriber registers exactly one global listener regardless of how
 * many feed chunks it subscribes to, and that the single listener correctly
 * routes messages for every subscription.
 */
class FakeClient {
	listeners: Array<(m: any) => void> = [];
	sends: any[] = [];
	shutdownCount = 0;

	addMessageListener(handler: (m: any) => void) {
		this.listeners.push(handler);
	}
	// subscribe() is the outgoing-frame path the subscriber uses (registers the
	// request in the pool so it is replayed on reconnect); record it like send().
	subscribe(request: any) {
		this.sends.push(request);
	}
	send(request: any) {
		this.sends.push(request);
	}
	shutdown() {
		this.shutdownCount++;
	}
	// deliver a message to all registered listeners, exactly like the real
	// websocket-pool dedupeHandler (Promise.all over messageListeners).
	deliver(message: any) {
		for (const l of this.listeners) {
			l(message);
		}
	}
}

function jsonStreamUpdate(
	subscriptionId: number,
	solanaData: string,
	feeds: Array<{ priceFeedId: number; price: string; exponent: string }>
) {
	return {
		type: 'json',
		value: {
			type: 'streamUpdated',
			subscriptionId,
			solana: { data: solanaData },
			parsed: { priceFeeds: feeds },
		},
	};
}

describe('PythLazerSubscriber single-listener invariant', () => {
	let fake: FakeClient;
	let originalCreate: any;
	let originalFetch: any;
	let subs: PythLazerSubscriber[];

	beforeEach(() => {
		fake = new FakeClient();
		subs = [];
		// Stub the static factory so subscribe() gets our fake client.
		originalCreate = (PythLazerClient as any).create;
		(PythLazerClient as any).create = async () => fake;
		// Stub fetch so fetchSymbolsIfNeeded() fails closed -> empty cache -> no
		// feed filtering. Keeps the test hermetic (no network).
		originalFetch = (global as any).fetch;
		(global as any).fetch = async () => {
			throw new Error('no network in test');
		};
	});

	afterEach(async () => {
		// Always tear down so the resubscribe watchdog timer never leaks — even
		// when an assertion above threw before the test's own unsubscribe().
		for (const s of subs) {
			await s.unsubscribe();
		}
		(PythLazerClient as any).create = originalCreate;
		(global as any).fetch = originalFetch;
	});

	// Track every subscriber so afterEach can clear its timer.
	const track = (s: PythLazerSubscriber) => {
		subs.push(s);
		return s;
	};

	it('registers exactly one listener across multiple chunks and routes every subscription', async () => {
		// Two subscription chunks.
		const sub = track(
			new PythLazerSubscriber(
				['wss://example'],
				'token',
				[{ priceFeedIds: [1, 2] }, { priceFeedIds: [3] }],
				'mainnet-beta',
				60_000 // large resub timeout so the watchdog never fires mid-test
			)
		);

		await sub.subscribe();

		// Invariant: ONE listener, regardless of chunk count. (Pre-fix this was 2.)
		assert.equal(
			fake.listeners.length,
			1,
			`expected exactly 1 global listener, got ${fake.listeners.length}`
		);

		// One send() per chunk, with the expected subscriptionId + feed ids.
		assert.equal(fake.sends.length, 2);
		assert.deepEqual(fake.sends[0].priceFeedIds, [1, 2]);
		assert.equal(fake.sends[0].subscriptionId, 1);
		assert.deepEqual(fake.sends[1].priceFeedIds, [3]);
		assert.equal(fake.sends[1].subscriptionId, 2);

		// The single listener must handle messages for BOTH subscriptions.
		fake.deliver(
			jsonStreamUpdate(1, 'deadbeef01', [
				{ priceFeedId: 1, price: '100', exponent: '-2' },
				{ priceFeedId: 2, price: '200', exponent: '-2' },
			])
		);
		fake.deliver(
			jsonStreamUpdate(2, 'deadbeef02', [
				{ priceFeedId: 3, price: '300', exponent: '-2' },
			])
		);

		// Chunk-level solana blob routing (keyed by subscriptionId -> feed-hash).
		assert.equal(await sub.getLatestPriceMessage([1, 2]), 'deadbeef01');
		assert.equal(await sub.getLatestPriceMessage([3]), 'deadbeef02');

		// Parsed per-feed prices: price * 10^exponent.
		assert.equal(sub.feedIdToPrice.get(1), 1.0);
		assert.equal(sub.feedIdToPrice.get(2), 2.0);
		assert.equal(sub.feedIdToPrice.get(3), 3.0);

		await sub.unsubscribe();
		assert.equal(fake.shutdownCount, 1);
	});

	it('does not multiply processing per chunk (idempotent, single write path)', async () => {
		const sub = track(
			new PythLazerSubscriber(
				['wss://example'],
				'token',
				[
					{ priceFeedIds: [10] },
					{ priceFeedIds: [11] },
					{ priceFeedIds: [12] },
				],
				'mainnet-beta',
				60_000
			)
		);
		await sub.subscribe();
		assert.equal(fake.listeners.length, 1);

		// Count how many times the parsed-price write path runs for one message.
		// A single listener => feedIdToPrice.set runs exactly once for this feed.
		// (Pre-fix: one listener per chunk = 3x for the same message.)
		let writes = 0;
		const feedMap = sub.feedIdToPrice;
		const trackedSet = feedMap.set.bind(feedMap);
		(feedMap as any).set = (k: number, v: number) => {
			writes++;
			return trackedSet(k, v);
		};

		fake.deliver(
			jsonStreamUpdate(1, 'aa', [
				{ priceFeedId: 10, price: '5', exponent: '0' },
			])
		);

		delete (feedMap as any).set;
		assert.equal(writes, 1, `expected 1 price write, got ${writes}`);

		await sub.unsubscribe();
	});
});
