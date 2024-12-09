import { OpenbookV2Subscriber, PRICE_PRECISION } from '../../src';
import { Connection, PublicKey } from '@solana/web3.js';

describe('openbook v2 subscriber', function () {
	this.timeout(100_000);

	it('works', async function () {
		if (!process.env.MAINNET_RPC_ENDPOINT) {
			return;
		}

		const connection = new Connection(
			process.env.MAINNET_RPC_ENDPOINT as string
		);
		const solUsdc = new PublicKey(
			'AFgkED1FUVfBe2trPUDqSqK9QKd4stJrfzq5q1RwAFTa'
		);
		const openbook = new PublicKey(
			'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb'
		);

		const openbookV2Subscriber = new OpenbookV2Subscriber({
			connection,
			programId: openbook,
			marketAddress: solUsdc,
			accountSubscription: {
				type: 'websocket',
			},
		});

		await openbookV2Subscriber.subscribe();

		// wait for updates
		await new Promise((resolve) => setTimeout(resolve, 5_000));

		const basePrecision = Math.ceil(
			1 / openbookV2Subscriber.market.baseNativeFactor.toNumber()
		);

		console.log('Bids');
		for (const bid of openbookV2Subscriber.getL2Bids()) {
			console.log('Price: ', bid.price.toNumber() / PRICE_PRECISION.toNumber());
			console.log('Size: ', bid.size.toNumber() / basePrecision);
			console.log('Source: ', bid.sources);
		}

		console.log('Asks');
		for (const ask of openbookV2Subscriber.getL2Asks()) {
			console.log('Price: ', ask.price.toNumber() / PRICE_PRECISION.toNumber());
			console.log('Size: ', ask.size.toNumber() / basePrecision);
			console.log('Source: ', ask.sources);
		}

		const bestBid = await openbookV2Subscriber.getBestBid();
		console.log('Best bid:', bestBid.toNumber());

		const bestAsk = await openbookV2Subscriber.getBestAsk();
		console.log('Best ask:', bestAsk.toNumber());

		await openbookV2Subscriber.unsubscribe();
	});
});
