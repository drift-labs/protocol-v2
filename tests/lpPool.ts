import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { AccountInfo, Keypair, PublicKey } from '@solana/web3.js';

import {
	BN,
	TestClient,
	QUOTE_PRECISION,
	UserStatsAccount,
	parseLogs,
	getLpPoolPublicKey,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
dotenv.config();

describe('LP Pool', () => {
	const program = anchor.workspace.Drift as Program;
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;

	let adminClient: TestClient;
	let usdcMint;
	const usdcAmount = new BN(100 * 10 ** 6);

	const lpPoolName = 'test pool 1';
	const tokenName = 'test pool token';
	const tokenSymbol = 'DLP-1';
	const tokenUri = 'https://token.token.token.gov';
	const tokenDecimals = 6;
	const lpPoolKey = getLpPoolPublicKey(program.programId, lpPoolName);

	before(async () => {
		const context = await startAnchor('', [], []);

		// @ts-ignore
		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		const keypair = new Keypair();
		await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		adminClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: program.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			subAccountIds: [],
			perpMarketIndexes: [],
			spotMarketIndexes: [0],
			oracleInfos: [],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await adminClient.initialize(usdcMint.publicKey, true);
		await adminClient.subscribe();
		await initializeQuoteSpotMarket(adminClient, usdcMint.publicKey);


        const tx = await adminClient.initializeLpPool(
			lpPoolName,
			tokenName,
			tokenSymbol,
			tokenUri,
			tokenDecimals,
			new BN(100_000_000).mul(QUOTE_PRECISION)
		)
		await printTxLogs(bankrunContextWrapper.connection.toConnection(), tx);
	});

	after(async () => {
		await adminClient.unsubscribe();
	});

	it('can create a new LP Pool', async () => {
		// check LpPool created
		const lpPool = await adminClient.program.account.lpPool.fetch(lpPoolKey);
		console.log(lpPool);

		// check mint created with correct token params
	});
});