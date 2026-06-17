import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { BASE_PRECISION, BN, OracleSource } from '../packages/sdk';

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

import { TestClient, PRICE_PRECISION } from '../packages/sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../packages/sdk/src/bankrun/bankrunConnection';

describe('whitelist', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let velocityClient: TestClient;

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

		velocityClient = new TestClient({
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
			oracleInfos: [{ publicKey: solUsd, source: OracleSource.PYTH_LAZER }],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();
		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);

		await velocityClient.initializePerpMarket(
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
		await velocityClient.unsubscribe();
	});

	it('Assert whitelist mint null', async () => {
		const state = velocityClient.getStateAccount();
		assert(state.whitelistMint.equals(PublicKey.default));
	});

	it('enable whitelist mint', async () => {
		await velocityClient.updateWhitelistMint(whitelistMint);
		const state = velocityClient.getStateAccount();
		console.assert(state.whitelistMint.equals(whitelistMint));
	});

	it('block initialize user', async () => {
		try {
			[, userAccountPublicKey] =
				await velocityClient.initializeUserAccountAndDepositCollateral(
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
			await velocityClient.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const user: any = await velocityClient.program.account.user.fetch(
			userAccountPublicKey
		);

		assert.ok(
			user.authority.equals(bankrunContextWrapper.provider.wallet.publicKey)
		);
	});

	it('disable whitelist mint', async () => {
		await velocityClient.updateWhitelistMint(PublicKey.default);
		const state = velocityClient.getStateAccount();
		console.assert(state.whitelistMint.equals(PublicKey.default));
	});
});
