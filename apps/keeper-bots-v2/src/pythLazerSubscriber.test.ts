import assert from 'assert';
import * as axios from 'axios';
import { PythLazerClient } from '@pythnetwork/pyth-lazer-sdk';
import { PythLazerSubscriber } from './pythLazerSubscriber';

// Regression guard for the "Skipping lazer price update. next_timestamp is
// None" failure: the velocity program's PostPythLazerOracleUpdate handler only
// applies an oracle update when the Lazer payload carries a
// `feedUpdateTimestamp` property. If the subscription omits it, every posted
// update is silently skipped on-chain. `price` must also stay first because the
// program requires `properties[0] == Price`.
const REQUIRED_PROPERTY = 'feedUpdateTimestamp';

describe('PythLazerSubscriber subscription properties', () => {
	it('WS subscribe requests feedUpdateTimestamp, with price first', async () => {
		const sentRequests: any[] = [];
		const fakeClient = {
			addMessageListener: (_fn: unknown) => {},
			send: (request: any) => sentRequests.push(request),
			shutdown: () => {},
		};

		const originalCreate = (PythLazerClient as any).create;
		(PythLazerClient as any).create = async () => fakeClient;
		try {
			const subscriber = new PythLazerSubscriber(
				['ws://localhost'],
				'test-token',
				[{ priceFeedIds: [6], channel: 'fixed_rate@200ms' }],
				'devnet'
			);
			await subscriber.subscribe();
			await subscriber.unsubscribe();
		} finally {
			(PythLazerClient as any).create = originalCreate;
		}

		assert.ok(sentRequests.length > 0, 'expected a subscribe request');
		for (const request of sentRequests) {
			assert.ok(
				request.properties.includes(REQUIRED_PROPERTY),
				`WS subscribe must request ${REQUIRED_PROPERTY}`
			);
			assert.strictEqual(
				request.properties[0],
				'price',
				'price must be the first property (program requires properties[0] == Price)'
			);
		}
	});

	it('HTTP fetch requests feedUpdateTimestamp, with price first', async () => {
		const subscriber = new PythLazerSubscriber(
			['ws://localhost'],
			'test-token',
			[{ priceFeedIds: [6] }],
			'devnet'
		);

		const capturedBodies: any[] = [];
		const originalPost = (axios.default as any).post;
		(axios.default as any).post = async (_url: string, body: any) => {
			capturedBodies.push(body);
			return { status: 200, data: { solana: { data: 'deadbeef' } } };
		};
		try {
			await subscriber.fetchLatestPriceMessage('http://lazer', [6]);
		} finally {
			(axios.default as any).post = originalPost;
		}

		assert.ok(capturedBodies.length > 0, 'expected an HTTP request');
		assert.ok(
			capturedBodies[0].properties.includes(REQUIRED_PROPERTY),
			`HTTP fetch must request ${REQUIRED_PROPERTY}`
		);
		assert.strictEqual(
			capturedBodies[0].properties[0],
			'price',
			'price must be the first property (program requires properties[0] == Price)'
		);
	});
});
