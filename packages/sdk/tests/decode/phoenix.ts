import { MarketData, deserializeMarketData } from '@ellipsis-labs/phoenix-sdk';
import { fastDecode } from '../../src/decode/phoenix';
import { Connection, PublicKey } from '@solana/web3.js';
import assert from 'assert';

describe('custom phoenix decode', function () {
	this.timeout(100_000);

	it('decodes quickly', async function () {
		const connection = new Connection('https://api.mainnet-beta.solana.com');

		const val = await connection.getAccountInfo(
			new PublicKey('4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg')
		);

		const numIterations = 100;

		let regularDecoded: MarketData;
		const regularStart = performance.now();
		for (let i = 0; i < numIterations; i++) {
			regularDecoded = deserializeMarketData(val!.data);
		}
		const regularEnd = performance.now();

		let fastDecoded: MarketData;
		const fastStart = performance.now();
		for (let i = 0; i < numIterations; i++) {
			fastDecoded = fastDecode(val!.data);
		}
		const fastEnd = performance.now();

		console.log(`Regular: ${regularEnd - regularStart} ms`);
		console.log(
			`Regular avg: ${(regularEnd - regularStart) / numIterations} ms`
		);

		console.log(`Fast: ${fastEnd - fastStart} ms`);
		console.log(`Fast avg: ${(fastEnd - fastStart) / numIterations} ms`);

		// @ts-ignore
		assert(deepEqual(fastDecoded.bids, regularDecoded.bids));
		// @ts-ignore
		assert(deepEqual(regularDecoded.asks, fastDecoded.asks));
	});
});

function deepEqual(obj1: any, obj2: any) {
	if (obj1 === obj2) return true;

	if (
		obj1 == null ||
		obj2 == null ||
		typeof obj1 !== 'object' ||
		typeof obj2 !== 'object'
	) {
		return false;
	}

	const keys1 = Object.keys(obj1);
	const keys2 = Object.keys(obj2);

	if (keys1.length !== keys2.length) return false;

	for (const key of keys1) {
		if (!keys2.includes(key) || !deepEqual(obj1[key], obj2[key])) {
			return false;
		}
	}

	return true;
}
