import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { BASE_PRECISION, BN, BulkAccountLoader, OracleSource } from '../sdk';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';
import {
	createMint,
	getOrCreateAssociatedTokenAccount,
	mintTo,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { TestClient, PRICE_PRECISION } from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';

describe('whitelist', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let driftClient: TestClient;

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(
		5 * BASE_PRECISION.toNumber()
	).mul(mantissaSqrtScale);
	const ammInitialBaseAssetReserve = new anchor.BN(
		5 * BASE_PRECISION.toNumber()
	).mul(mantissaSqrtScale);

	const usdcAmount = new BN(10 * 10 ** 6);

	let whitelistMint: PublicKey;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

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

		await driftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		whitelistMint = await createMint(
			connection,
			// @ts-ignore
			provider.wallet.payer,
			provider.wallet.publicKey,
			provider.wallet.publicKey,
			0
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('Assert whitelist mint null', async () => {
		const state = driftClient.getStateAccount();
		assert(state.whitelistMint.equals(PublicKey.default));
	});

	it('enable whitelist mint', async () => {
		await driftClient.updateWhitelistMint(whitelistMint);
		const state = driftClient.getStateAccount();
		console.assert(state.whitelistMint.equals(whitelistMint));
	});

	it('block initialize user', async () => {
		try {
			[, userAccountPublicKey] =
				await driftClient.initializeUserAccountAndDepositCollateral(
					usdcAmount,
					userUSDCAccount.publicKey
				);
		} catch (e) {
			console.log(e);
			return;
		}
		assert(false);
	});

	it('successful initialize user', async () => {
		const associatedAccountInfo = await getOrCreateAssociatedTokenAccount(
			connection,
			// @ts-ignore
			provider.wallet.payer,
			whitelistMint,
			provider.wallet.publicKey
		);
		await mintTo(
			connection,
			// @ts-ignore
			provider.wallet.payer,
			whitelistMint,
			associatedAccountInfo.address,
			// @ts-ignore
			provider.wallet.payer,
			1
		);
		[, userAccountPublicKey] =
			await driftClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const user: any = await driftClient.program.account.user.fetch(
			userAccountPublicKey
		);

		assert.ok(user.authority.equals(provider.wallet.publicKey));
	});

	it('disable whitelist mint', async () => {
		await driftClient.updateWhitelistMint(PublicKey.default);
		const state = driftClient.getStateAccount();
		console.assert(state.whitelistMint.equals(PublicKey.default));
	});
});
