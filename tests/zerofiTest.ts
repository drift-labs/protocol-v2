import { assert } from 'chai';
import * as anchor from '@coral-xyz/anchor';

import { Program, BN } from '@coral-xyz/anchor';

import {
	OracleSource,
	OrderType,
	PositionDirection,
	PublicKey,
	TestClient,
} from '../sdk/src';
import { startAnchor, AddedAccount } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import {
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
} from './testHelpers';
import { Keypair } from '@solana/web3.js';
import { PRICE_PRECISION } from '../sdk/src';
import { ZERO } from '../sdk';
import fs from 'fs';
import path from 'path';
import { globSync } from 'glob';
import bs58 from 'bs58';

export const ZEROFI_PROGRAM = new PublicKey(
	'ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY'
);

interface AccountFile {
	lamports: number;
	data: number[];
	owner: number[];
	executable: boolean;
	rentEpoch: number;
}

interface ParsedAccounts {
	accounts: AddedAccount[];
	nameToKey: Map<string, PublicKey>;
}

function loadFixtureAccounts(fixturesPath: string): ParsedAccounts {
	const files = globSync(path.join(fixturesPath, '*.json'));

	const accounts: AddedAccount[] = [];
	const nameToKey = new Map<string, PublicKey>();

	const filenamePattern = /^([^-]+)-([A-Za-z0-9]{32,44})\.json$/;

	for (const file of files) {
		const basename = path.basename(file);
		const match = basename.match(filenamePattern);
		if (!match) {
			continue;
		}

		const [, name, pubkeyStr] = match;

		let pubkey: PublicKey;
		try {
			pubkey = new PublicKey(pubkeyStr);
		} catch (e) {
			console.warn(`Skipping ${file}: invalid pubkey`);
			continue;
		}

		try {
			const content = fs.readFileSync(file, 'utf8');
			const accountData = JSON.parse(content) as AccountFile;

			const account = {
				address: pubkey,
				info: {
					lamports: accountData.lamports,
					data: Uint8Array.from(accountData.data),
					owner: new PublicKey(Buffer.from(accountData.owner)),
					executable: accountData.executable,
					rentEpoch: accountData.rentEpoch,
				},
			};

			accounts.push(account);
			nameToKey.set(name, pubkey);
		} catch (e) {
			console.warn(`Error processing ${file}: ${e}`);
			continue;
		}
	}

	return { accounts, nameToKey };
}

describe('zerofi', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let fillerDriftClient: TestClient;
	const fillerKeypair = Keypair.generate();

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	const solSpotMarketIndex = 1;

	let usdcMint: PublicKey;
	let solMint: PublicKey;

	const usdcAmount = new anchor.BN(200 * 10 ** 6);

	let userUsdcAccount: PublicKey;

	let market: PublicKey;

	before(async () => {
		const { accounts: fixtureAccountList, nameToKey: fixtureAccountsByName } =
			loadFixtureAccounts('tests/fixtures/zerofi');
		console.log(fixtureAccountsByName);

		const context = await startAnchor(
			'',
			[
				{
					name: 'zerofi',
					programId: ZEROFI_PROGRAM,
				},
			],
			fixtureAccountList
		);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		// override the wallet to be the one that's shared
		const keypair = Keypair.fromSecretKey(
			bs58.decode(
				'4ruNgnB26rEiy9G1nBevajsjkeoUNzjVWkdrcFnQ8BKyrF2ZYQ21gDfFsfrZmXU4FkbCjQVAktkMCnoAQeyBYrYW'
			)
		);
		const wallet = new anchor.Wallet(keypair);
		bankrunContextWrapper.provider.wallet = wallet;

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		const solOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);

		usdcMint = fixtureAccountsByName.get('mint_quote');
		solMint = fixtureAccountsByName.get('mint_base');
		userUsdcAccount = fixtureAccountsByName.get('user_quote');
		market = fixtureAccountsByName.get('market');

		driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint);
		await initializeSolSpotMarket(driftClient, solOracle, solMint);

		const quoteSizeLot = new BN(1);
		const baseSizeLot = new BN(100);
		await driftClient.updateSpotMarketStepSizeAndTickSize(
			1,
			baseSizeLot,
			quoteSizeLot
		);

		await driftClient.updateSpotMarketOrdersEnabled(1, true);

		await driftClient.initializeUserAccountAndDepositCollateral(
			// @ts-ignore
			usdcAmount,
			userUsdcAccount
		);

		await driftClient.addUser(0);
		// @ts-ignore
		// await driftClient.deposit(solAmount, 1, userWSolAccount.publicKey);

		fillerDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(fillerKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await fillerDriftClient.subscribe();

		await bankrunContextWrapper.fundKeypair(fillerKeypair, 10 * 10 ** 9);

		await fillerDriftClient.initializeUserAccount();

		await fillerDriftClient.addUser(0);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await fillerDriftClient.unsubscribe();
	});

	it('add market', async () => {
		await driftClient.initializeZerofiFulfillmentConfig(
			solSpotMarketIndex,
			market
		);
	});

	it('fill long', async () => {
		const quoteTokenAmountBefore = driftClient.getTokenAmount(0);
		const baseTokenAmountBefore = driftClient.getTokenAmount(1);

		console.log(`quoteTokenAmountBefore ${quoteTokenAmountBefore.toString()}`);
		console.log(`baseTokenAmountBefore ${baseTokenAmountBefore.toString()}`);

		await driftClient.placeSpotOrder({
			orderType: OrderType.LIMIT,
			marketIndex: 1,
			// @ts-ignore
			baseAssetAmount: driftClient.convertToSpotPrecision(1, 1),
			direction: PositionDirection.LONG,
			price: PRICE_PRECISION.muln(101),
		});

		const fulfillmentConfig = await driftClient.getZerofiFulfillmentConfig(
			market
		);

		const userAccount = driftClient.getUserAccount();
		const order = userAccount.orders.filter(
			(order) => order.marketIndex == 1
		)[0];
		await fillerDriftClient.fillSpotOrder(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			order,
			fulfillmentConfig
		);

		await driftClient.fetchAccounts();

		const quoteTokenAmountAfter = driftClient.getTokenAmount(0);
		const baseTokenAmountAfter = driftClient.getTokenAmount(1);

		console.log(`quoteTokenAmountAfter ${quoteTokenAmountAfter.toString()}`);
		console.log(`baseTokenAmountAfter ${baseTokenAmountAfter.toString()}`);

		assert(baseTokenAmountAfter.eq(new BN(1e6)));
		// cost is 101 + 0.1% drift fee
		assert(quoteTokenAmountAfter.eq(new BN(200e6 - 101.101001e6)));
	});

	it('fill short', async () => {
		const quoteTokenAmountBefore = driftClient.getTokenAmount(0);

		await driftClient.placeSpotOrder({
			orderType: OrderType.LIMIT,
			marketIndex: 1,
			// @ts-ignore
			baseAssetAmount: driftClient.convertToSpotPrecision(1, 1),
			direction: PositionDirection.SHORT,
			price: PRICE_PRECISION.muln(99),
		});

		const fulfillmentConfig = await driftClient.getZerofiFulfillmentConfig(
			market
		);

		const userAccount = driftClient.getUserAccount();
		const order = userAccount.orders.filter(
			(order) => order.marketIndex == 1
		)[0];
		await fillerDriftClient.fillSpotOrder(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			order,
			fulfillmentConfig
		);

		await driftClient.fetchAccounts();

		const quoteTokenAmountAfter = driftClient.getTokenAmount(0);
		const baseTokenAmountAfter = driftClient.getTokenAmount(1);

		console.log(`quoteTokenAmountAfter ${quoteTokenAmountAfter.toString()}`);
		console.log(`baseTokenAmountAfter ${baseTokenAmountAfter.toString()}`);

		assert(baseTokenAmountAfter.eq(ZERO));
		// 99 - 0.1% drift fee
		assert(
			quoteTokenAmountAfter.eq(quoteTokenAmountBefore.add(new BN(98.901e6)))
		);
	});
});
