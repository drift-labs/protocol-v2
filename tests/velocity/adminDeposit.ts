import * as anchor from '@coral-xyz/anchor';
import { expect } from 'chai';

import { Program, Wallet } from '@coral-xyz/anchor';

import { Keypair } from '@solana/web3.js';

import {
	BN,
	TestClient,
	getTokenAmount,
	getSignedTokenAmount,
} from '../../packages/sdk/src';

import {
	createFundedKeyPair,
	initializeQuoteSpotMarket,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../../packages/sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
dotenv.config();

describe('admin deposit', () => {
	const chProgram = anchor.workspace.Velocity as Program;
	let bankrunContextWrapper: BankrunContextWrapper;
	let bulkAccountLoader: TestBulkAccountLoader;

	let adminVelocityClient: TestClient;
	let adminUSDCAccount: Keypair;

	let userKeyPair: Keypair;
	let userVelocityClient: TestClient;

	let userKeyPair2: Keypair;
	let userVelocityClient2: TestClient;
	let user2USDCAccount: Keypair;

	let usdcMint;
	const usdcAmount = new BN(100 * 10 ** 6);

	before(async () => {
		const context = await startAnchor('', [], []);

		// @ts-ignore
		bankrunContextWrapper = new BankrunContextWrapper(context);

		userKeyPair = await createFundedKeyPair(bankrunContextWrapper);
		userKeyPair2 = await createFundedKeyPair(bankrunContextWrapper);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		adminUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		user2USDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			userKeyPair2.publicKey
		);

		adminVelocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
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
		await adminVelocityClient.initialize(usdcMint.publicKey, true);
		await adminVelocityClient.subscribe();
		await initializeQuoteSpotMarket(adminVelocityClient, usdcMint.publicKey);
		// await adminVelocityClient.initializeUserAccountAndDepositCollateral(
		// 	QUOTE_PRECISION,
		// 	adminUSDCAccount.publicKey
		// );
		await adminVelocityClient.initializeUserAccount(0, 'admin subacc 0');

		userVelocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(userKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await userVelocityClient.subscribe();
		await userVelocityClient.initializeUserAccount(0, 'user account 0');

		userKeyPair2 = await createFundedKeyPair(bankrunContextWrapper);
		userVelocityClient2 = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(userKeyPair2),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes: [0],
			subAccountIds: [],
			oracleInfos: [],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await userVelocityClient2.subscribe();
	});

	after(async () => {
		await adminVelocityClient.unsubscribe();
		await userVelocityClient.unsubscribe();
	});

	it('admin can deposit into user', async () => {
		const userAccount = await userVelocityClient.getUserAccountPublicKey(0);
		console.log('user userAccount', userAccount.toBase58());

		const state = adminVelocityClient.getStateAccount().coldAdmin.toBase58();
		expect(state).to.be.equal(adminVelocityClient.wallet.publicKey.toBase58());

		// user has 0 balance
		let spotPos = userVelocityClient.getSpotPosition(0);
		let spotMarket = userVelocityClient.getSpotMarketAccount(0);
		const userSpotBalBefore = getSignedTokenAmount(
			getTokenAmount(spotPos.scaledBalance, spotMarket, spotPos.balanceType),
			spotPos.balanceType
		);
		expect(userSpotBalBefore.toString()).to.be.equal('0');

		// admin deposits into user
		await adminVelocityClient.adminDeposit(
			0,
			usdcAmount,
			userAccount,
			adminUSDCAccount.publicKey
		);

		await adminVelocityClient.fetchAccounts();
		await userVelocityClient.fetchAccounts();

		// check user got the deposit
		spotPos = userVelocityClient.getSpotPosition(0);
		spotMarket = userVelocityClient.getSpotMarketAccount(0);
		const userSpotBalAfter = getSignedTokenAmount(
			getTokenAmount(spotPos.scaledBalance, spotMarket, spotPos.balanceType),
			spotPos.balanceType
		);
		const spotBalDiff = userSpotBalAfter.sub(userSpotBalBefore);
		expect(spotBalDiff.toString()).to.be.equal(usdcAmount.toString());
	});

	it('user2 cannot deposit into user', async () => {
		const state = adminVelocityClient.getStateAccount().coldAdmin.toBase58();
		expect(state).to.not.be.equal(
			userVelocityClient2.wallet.publicKey.toBase58()
		);

		// user has 0 balance
		let spotPos = userVelocityClient.getSpotPosition(0);
		let spotMarket = userVelocityClient.getSpotMarketAccount(0);
		const userSpotBalBefore = getSignedTokenAmount(
			getTokenAmount(spotPos.scaledBalance, spotMarket, spotPos.balanceType),
			spotPos.balanceType
		);

		// user2 attempts to deposit into user
		try {
			await userVelocityClient2.adminDeposit(
				0,
				usdcAmount,
				await userVelocityClient.getUserAccountPublicKey(0),
				user2USDCAccount.publicKey
			);
			expect.fail('should not allow non-admin to call adminDeposit');
		} catch (e) {
			expect(e.message as string).to.contain('0x7d3');
		}

		await adminVelocityClient.fetchAccounts();
		await userVelocityClient.fetchAccounts();

		// check user did not get the deposit
		spotPos = userVelocityClient.getSpotPosition(0);
		spotMarket = userVelocityClient.getSpotMarketAccount(0);
		const userSpotBalAfter = getSignedTokenAmount(
			getTokenAmount(spotPos.scaledBalance, spotMarket, spotPos.balanceType),
			spotPos.balanceType
		);
		const spotBalDiff = userSpotBalAfter.sub(userSpotBalBefore);
		expect(spotBalDiff.toString()).to.be.equal('0');
	});
});
