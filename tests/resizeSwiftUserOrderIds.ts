import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	BN,
	PRICE_PRECISION,
	TestClient,
	User,
	Wallet,
	EventSubscriber,
	OracleSource,
	getSignedMsgUserAccountPublicKey,
} from '../packages/sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	sleep,
} from './testHelpers';
import { PEG_PRECISION } from '../packages/sdk/src';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../packages/sdk/src/bankrun/bankrunConnection';
import dotenv from 'dotenv';
dotenv.config();

describe('place and make signedMsg order', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let makerVelocityClient: TestClient;
	let makerVelocityClientUser: User;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	let usdcMint;
	let userUSDCAccount;

	const usdcAmount = new BN(100 * 10 ** 6);

	let solUsd;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		const context = await startAnchor('', [], []);

		// @ts-ignore
		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			// @ts-ignore
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 32.821);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH_LAZER }];

		makerVelocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await makerVelocityClient.initialize(usdcMint.publicKey, true);
		await makerVelocityClient.subscribe();
		await initializeQuoteSpotMarket(makerVelocityClient, usdcMint.publicKey);

		const periodicity = new BN(0);
		await makerVelocityClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(33 * PEG_PRECISION.toNumber())
		);

		await makerVelocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		makerVelocityClientUser = new User({
			velocityClient: makerVelocityClient,
			userAccountPublicKey: await makerVelocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await makerVelocityClientUser.subscribe();
	});

	after(async () => {
		await makerVelocityClient.unsubscribe();
		await makerVelocityClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('increase size of signedMsg user orders', async () => {
		const [takerVelocityClient, takerVelocityClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerVelocityClientUser.fetchAccounts();

		await takerVelocityClient.resizeSignedMsgUserOrders(
			takerVelocityClientUser.getUserAccount().authority,
			100
		);

		const signedMsgUserOrdersAccountPublicKey =
			getSignedMsgUserAccountPublicKey(
				takerVelocityClient.program.programId,
				takerVelocityClientUser.getUserAccount().authority
			);
		const signedMsgUserOrders =
			(await takerVelocityClient.program.account.signedMsgUserOrders.fetch(
				signedMsgUserOrdersAccountPublicKey
			)) as any;

		assert.equal(signedMsgUserOrders.signedMsgOrderData.length, 100);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('fails to decrease size if authority != payer', async () => {
		const [takerVelocityClient, takerVelocityClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerVelocityClientUser.fetchAccounts();

		const signedMsgUserOrdersAccountPublicKey =
			getSignedMsgUserAccountPublicKey(
				takerVelocityClient.program.programId,
				takerVelocityClientUser.getUserAccount().authority
			);

		try {
			await makerVelocityClient.resizeSignedMsgUserOrders(
				takerVelocityClientUser.getUserAccount().authority,
				4
			);
			assert.fail('Expected an error');
		} catch (error) {
			assert.include(error.toString(), '0x18a9');
		}

		const signedMsgUserOrders =
			(await takerVelocityClient.program.account.signedMsgUserOrders.fetch(
				signedMsgUserOrdersAccountPublicKey
			)) as any;

		assert.equal(signedMsgUserOrders.signedMsgOrderData.length, 32);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('allows decrease size if authority is delegate', async () => {
		const [takerVelocityClient, takerVelocityClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerVelocityClientUser.fetchAccounts();

		await takerVelocityClient.updateUserDelegate(
			makerVelocityClient.wallet.publicKey
		);

		const signedMsgUserOrdersAccountPublicKey =
			getSignedMsgUserAccountPublicKey(
				takerVelocityClient.program.programId,
				takerVelocityClientUser.getUserAccount().authority
			);

		await makerVelocityClient.resizeSignedMsgUserOrders(
			takerVelocityClientUser.getUserAccount().authority,
			4
		);

		const signedMsgUserOrders =
			(await takerVelocityClient.program.account.signedMsgUserOrders.fetch(
				signedMsgUserOrdersAccountPublicKey
			)) as any;

		assert.equal(signedMsgUserOrders.signedMsgOrderData.length, 4);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});

	it('decrease size of signedMsg user orders', async () => {
		const [takerVelocityClient, takerVelocityClientUser] =
			await initializeNewTakerClientAndUser(
				bankrunContextWrapper,
				chProgram,
				usdcMint,
				usdcAmount,
				marketIndexes,
				spotMarketIndexes,
				oracleInfos,
				bulkAccountLoader
			);
		await takerVelocityClientUser.fetchAccounts();

		await takerVelocityClient.resizeSignedMsgUserOrders(
			takerVelocityClientUser.getUserAccount().authority,
			4
		);

		const signedMsgUserOrdersAccountPublicKey =
			getSignedMsgUserAccountPublicKey(
				takerVelocityClient.program.programId,
				takerVelocityClientUser.getUserAccount().authority
			);
		const signedMsgUserOrders =
			(await takerVelocityClient.program.account.signedMsgUserOrders.fetch(
				signedMsgUserOrdersAccountPublicKey
			)) as any;

		assert.equal(signedMsgUserOrders.signedMsgOrderData.length, 4);

		await takerVelocityClientUser.unsubscribe();
		await takerVelocityClient.unsubscribe();
	});
});

async function initializeNewTakerClientAndUser(
	bankrunContextWrapper: BankrunContextWrapper,
	chProgram: Program,
	usdcMint: Keypair,
	usdcAmount: BN,
	marketIndexes: number[],
	spotMarketIndexes: number[],
	oracleInfos: { publicKey: PublicKey; source: OracleSource }[],
	bulkAccountLoader: TestBulkAccountLoader
): Promise<[TestClient, User]> {
	const keypair = new Keypair();
	await bankrunContextWrapper.fundKeypair(keypair, 10 ** 9);
	await sleep(1000);
	const wallet = new Wallet(keypair);
	const userUSDCAccount = await mockUserUSDCAccount(
		usdcMint,
		usdcAmount,
		bankrunContextWrapper,
		keypair.publicKey
	);
	const takerVelocityClient = new TestClient({
		connection: bankrunContextWrapper.connection.toConnection(),
		wallet,
		programID: chProgram.programId,
		opts: {
			commitment: 'confirmed',
		},
		activeSubAccountId: 0,
		perpMarketIndexes: marketIndexes,
		spotMarketIndexes: spotMarketIndexes,
		subAccountIds: [],
		oracleInfos,
		userStats: true,
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});
	await takerVelocityClient.subscribe();
	await takerVelocityClient.initializeUserAccountAndDepositCollateral(
		usdcAmount,
		userUSDCAccount.publicKey
	);
	const takerVelocityClientUser = new User({
		velocityClient: takerVelocityClient,
		userAccountPublicKey: await takerVelocityClient.getUserAccountPublicKey(),
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});
	await takerVelocityClientUser.subscribe();
	await takerVelocityClient.initializeSignedMsgUserOrders(
		takerVelocityClientUser.getUserAccount().authority,
		32
	);
	return [takerVelocityClient, takerVelocityClientUser];
}
