import { Connection, PublicKey } from '@solana/web3.js';
import {
	BASE_PRECISION,
	L2Level,
	PRICE_PRECISION,
	PhoenixSubscriber,
} from '../src';
import { PROGRAM_ID } from '@ellipsis-labs/phoenix-sdk';

export async function listenToBook(): Promise<void> {
	const connection = new Connection('https://api.mainnet-beta.solana.com');

	for (const market of [
		'4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg', // SOL/USDC
		'Ew3vFDdtdGrknJAVVfraxCA37uNJtimXYPY4QjnfhFHH', // ETH/USDC
		'2sTMN9A1D1qeZLF95XQgJCUPiKe5DiV52jLfZGqMP46m', // PYTH/USDC
		'BRLLmdtPGuuFn3BU6orYw4KHaohAEptBToi3dwRUnHQZ', // JTO/USDC
	]) {
		const phoenixSubscriber = new PhoenixSubscriber({
			connection,
			programId: PROGRAM_ID,
			marketAddress: new PublicKey(market),
			accountSubscription: {
				type: 'websocket',
			},
		});

		await phoenixSubscriber.subscribe();

		const bids = phoenixSubscriber.getL2Levels('bids');
		const asks = phoenixSubscriber.getL2Levels('asks');
		let bid: L2Level | null = null;
		for (const b of bids) {
			bid = b;
			break;
		}
		let ask: L2Level | null = null;
		for (const a of asks) {
			ask = a;
			break;
		}

		console.log('market', market);
		console.log(
			(bid?.size.toNumber() || 0) / BASE_PRECISION.toNumber(),
			(bid?.price.toNumber() || 0) / PRICE_PRECISION.toNumber(),
			'@',
			(ask?.price.toNumber() || (1 << 53) - 1) / PRICE_PRECISION.toNumber(),
			(ask?.size.toNumber() || 0) / BASE_PRECISION.toNumber()
		);
		console.log();

		await phoenixSubscriber.unsubscribe();
	}
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
