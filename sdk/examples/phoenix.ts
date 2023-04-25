import { Connection, PublicKey } from '@solana/web3.js';
import { PRICE_PRECISION, PhoenixSubscriber } from '../src';
import { PROGRAM_ID } from '@ellipsis-labs/phoenix-sdk';

export async function listenToBook(): Promise<void> {
	const connection = new Connection('https://api.mainnet-beta.solana.com');

	const phoenixSubscriber = new PhoenixSubscriber({
		connection,
		programId: PROGRAM_ID,
		marketAddress: new PublicKey(
			'4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg'
		),
		accountSubscription: {
			type: 'websocket',
		},
	});

	await phoenixSubscriber.subscribe();

	for (let i = 0; i < 10; i++) {
		const bid = phoenixSubscriber.getBestBid().toNumber() / PRICE_PRECISION;
		const ask = phoenixSubscriber.getBestAsk().toNumber() / PRICE_PRECISION;
		console.log(`iter ${i}:`, bid.toFixed(3), '@', ask.toFixed(3));
		await new Promise((r) => setTimeout(r, 2000));
	}

	await phoenixSubscriber.unsubscribe();
}

(async function () {
	try {
		await listenToBook();
	} catch (err) {
		console.log('Error: ', err);
		process.exit(1);
	}

	process.exit(0);
})();
