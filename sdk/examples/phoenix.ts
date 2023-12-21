import { Connection, PublicKey } from '@solana/web3.js';
import { BASE_PRECISION, PRICE_PRECISION, PhoenixSubscriber } from '../src';
import { PROGRAM_ID } from '@ellipsis-labs/phoenix-sdk';

export async function listenToBook(): Promise<void> {
	const connection = new Connection('https://api.mainnet-beta.solana.com');

	const phoenixSubscriber = new PhoenixSubscriber({
		connection,
		programId: PROGRAM_ID,
		marketAddress: new PublicKey(
			'Ew3vFDdtdGrknJAVVfraxCA37uNJtimXYPY4QjnfhFHH'
		),
		accountSubscription: {
			type: 'websocket',
		},
	});

	await phoenixSubscriber.subscribe();

	for (let i = 0; i < 10; i++) {
		const bids = phoenixSubscriber.getL2Levels("bids");
		const asks = phoenixSubscriber.getL2Levels("asks");
		console.log("bids");
		for (const bid of bids) {
			console.log(bid.price.toNumber() / PRICE_PRECISION.toNumber(), bid.size.toNumber() / BASE_PRECISION.toNumber());
		}
		console.log("asks");
		for (const ask of asks) {
			console.log(ask.price.toNumber() / PRICE_PRECISION.toNumber(), ask.size.toNumber() / BASE_PRECISION.toNumber());
		}
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
