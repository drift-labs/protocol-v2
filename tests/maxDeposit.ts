import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { TestClient, QUOTE_PRECISION, BN, OracleSource } from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { BulkAccountLoader } from '../sdk';

describe('max deposit', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let usdcMint;
	let userUSDCAccount;

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

		const solUsd = await mockOracle(1);

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('update max deposit', async () => {
		await driftClient.updateSpotMarketMaxTokenDeposits(0, QUOTE_PRECISION);
		const market = driftClient.getSpotMarketAccount(0);
		console.assert(market.maxTokenDeposits.eq(QUOTE_PRECISION));
	});

	it('block deposit', async () => {
		try {
			await driftClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
		} catch (e) {
			return;
		}
		assert(false);
	});
});
