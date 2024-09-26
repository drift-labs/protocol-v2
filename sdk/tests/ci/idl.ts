import { DriftClient, BulkAccountLoader } from '../../src';
import { Connection, Keypair } from '@solana/web3.js';
import { Wallet, Program } from '@coral-xyz/anchor';
import dotenv from 'dotenv';
import { assert } from 'chai';
import sdkIdl from '../../src/idl/drift.json';

dotenv.config();

const IDL_KEYS_TO_CHECK = [
	'instructions',
	'accounts',
	'types',
	'events',
	'errors',
];

describe('Verify IDL', function () {
	this.timeout(100_000);
	const MAINNET_RPC_ENDPOINT = process.env.MAINNET_RPC_ENDPOINT;

	// avoid breaking pre-commit
	if (MAINNET_RPC_ENDPOINT === undefined) {
		return;
	}

	const wallet = new Wallet(Keypair.generate());

	const mainnetConnection = new Connection(MAINNET_RPC_ENDPOINT);

	const mainnetBulkAccountLoader = new BulkAccountLoader(
		mainnetConnection,
		'processed',
		1
	);

	const mainnetDriftClient = new DriftClient({
		connection: mainnetConnection,
		wallet,
		env: 'mainnet-beta',
		accountSubscription: {
			type: 'polling',
			accountLoader: mainnetBulkAccountLoader,
		},
	});

	it('verify idl', async () => {
		const onChainIdl = await Program.fetchIdl(
			mainnetDriftClient.program.programId,
			mainnetDriftClient.provider
		);

		if (onChainIdl === null) {
			throw new Error(
				`onChainIdl for ${mainnetDriftClient.program.programId.toBase58()} null`
			);
		}

		// anchor idl init seems to strip the metadata
		onChainIdl['metadata'] = {
			address: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',
		};
		onChainIdl['version'] = '';
		sdkIdl['version'] = '';

		const encodedMainnetIdl = JSON.stringify(onChainIdl);
		const encodedSdkIdl = JSON.stringify(sdkIdl);

		try {
			assert(
				encodedSdkIdl === encodedMainnetIdl,
				'on-chain IDL does not match SDK IDL'
			);
		} catch (error) {
			const diff = {};
			for (const key of IDL_KEYS_TO_CHECK) {
				const onChainItems = onChainIdl[key];
				const sdkItems = sdkIdl[key];
				for (
					let i = 0;
					i < Math.max(onChainItems.length, sdkItems.length);
					i++
				) {
					let onChainItem = null;
					let sdkItem = null;
					if (i < onChainItems.length) {
						onChainItem = onChainItems[i];
					}
					if (i < sdkItems.length) {
						sdkItem = sdkItems[i];
					}
					if (JSON.stringify(onChainItem) !== JSON.stringify(sdkItem)) {
						diff[`${key}[${i}]`] = { onChainIdl: onChainItem, sdkIdl: sdkItem };
					}
				}
			}
			console.error('IDL Difference:', JSON.stringify(diff, null, 2));
			throw error;
		}
	});
});
