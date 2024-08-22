import {
	DriftClient,
	BulkAccountLoader,
} from '../../src';
import { Connection, Keypair } from '@solana/web3.js';
import { Wallet, Program } from '@coral-xyz/anchor';
import dotenv from 'dotenv';
import { assert } from 'chai';
import driftIDL from '../../src/idl/drift.json';

dotenv.config();

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
		const idl = await Program.fetchIdl(mainnetDriftClient.program.programId, mainnetDriftClient.provider);

		// anchor idl init seems to strip the metadata
		idl["metadata"] = {"address":"dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"};
		const encodedMainnetIdl = JSON.stringify(idl);

		const encodedSdkIdl = JSON.stringify(driftIDL);

		assert(encodedSdkIdl === encodedMainnetIdl);
	});
});