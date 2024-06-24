import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { BASE_PRECISION, BN, OracleSource } from '../sdk';

import { Program } from '@coral-xyz/anchor';

import {
	Keypair,
	PublicKey,
	SystemProgram,
	Transaction,
} from '@solana/web3.js';
import {
	MINT_SIZE,
	TOKEN_PROGRAM_ID,
	createAssociatedTokenAccountIdempotentInstruction,
	createInitializeMint2Instruction,
	createMintToInstruction,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { TestClient, PRICE_PRECISION } from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

describe('whitelist', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

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
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		const solUsd = await mockOracleNoProgram(bankrunContextWrapper, 1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			subAccountIds: [],
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

		const keypair = Keypair.generate();
		const transaction = new Transaction().add(
			SystemProgram.createAccount({
				fromPubkey: bankrunContextWrapper.provider.wallet.publicKey,
				newAccountPubkey: keypair.publicKey,
				space: MINT_SIZE,
				lamports: 10_000_000_000,
				programId: TOKEN_PROGRAM_ID,
			}),
			createInitializeMint2Instruction(
				keypair.publicKey,
				0,
				bankrunContextWrapper.provider.wallet.publicKey,
				bankrunContextWrapper.provider.wallet.publicKey,
				TOKEN_PROGRAM_ID
			)
		);

		await bankrunContextWrapper.sendTransaction(transaction, [keypair]);

		whitelistMint = keypair.publicKey;
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
		const whitelistMintAta = getAssociatedTokenAddressSync(
			whitelistMint,
			bankrunContextWrapper.provider.wallet.publicKey
		);
		const ix = createAssociatedTokenAccountIdempotentInstruction(
			bankrunContextWrapper.context.payer.publicKey,
			whitelistMintAta,
			bankrunContextWrapper.provider.wallet.publicKey,
			whitelistMint
		);
		const mintToIx = createMintToInstruction(
			whitelistMint,
			whitelistMintAta,
			bankrunContextWrapper.provider.wallet.publicKey,
			1
		);
		await bankrunContextWrapper.sendTransaction(
			new Transaction().add(ix, mintToIx)
		);

		[, userAccountPublicKey] =
			await driftClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const user: any = await driftClient.program.account.user.fetch(
			userAccountPublicKey
		);

		assert.ok(
			user.authority.equals(bankrunContextWrapper.provider.wallet.publicKey)
		);
	});

	it('disable whitelist mint', async () => {
		await driftClient.updateWhitelistMint(PublicKey.default);
		const state = driftClient.getStateAccount();
		console.assert(state.whitelistMint.equals(PublicKey.default));
	});
});
