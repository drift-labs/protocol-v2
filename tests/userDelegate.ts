import * as anchor from '@coral-xyz/anchor';

import { Program } from '@coral-xyz/anchor';

import {
	QUOTE_SPOT_MARKET_INDEX,
	TestClient,
	BN,
	EventSubscriber,
	PRICE_PRECISION,
	OracleSource,
	PositionDirection,
	Wallet,
	MarketStatus,
} from '../sdk/src';

import {
	createFundedKeyPair,
	initializeQuoteSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { assert } from 'chai';
import { Keypair } from '@solana/web3.js';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';

describe('user delegate', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let usdcMint;

	const usdcAmount = new BN(10 * 10 ** 6);

	let delegateKeyPair: Keypair;
	let delegateDriftClient: TestClient;
	let delegateUsdcAccount: Keypair;

	const marketIndexes = [0];
	const spotMarketIndexes = [0];

	let solUsd;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	before(async () => {
		const context = await startAnchor('', [], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		solUsd = await mockOracleNoProgram(bankrunContextWrapper, 1);
		driftClient = new TestClient({
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
			oracleInfos: [
				{
					source: OracleSource.PYTH,
					publicKey: solUsd,
				},
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR
		await driftClient.initializePerpMarket(
			0,
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);
		await driftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		const subAccountId = 0;
		const name = 'CRISP';
		await driftClient.initializeUserAccount(subAccountId, name);

		delegateKeyPair = await createFundedKeyPair(bankrunContextWrapper);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
		await delegateDriftClient.unsubscribe();
	});

	it('Update delegate', async () => {
		await driftClient.updateUserDelegate(delegateKeyPair.publicKey);

		await driftClient.fetchAccounts();
		assert(
			driftClient.getUserAccount().delegate.equals(delegateKeyPair.publicKey)
		);

		delegateDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new Wallet(delegateKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos: [
				{
					source: OracleSource.PYTH,
					publicKey: solUsd,
				},
			],
			authority: bankrunContextWrapper.provider.wallet.publicKey,
			authoritySubAccountMap: new Map().set(
				bankrunContextWrapper.provider.wallet.publicKey,
				[0]
			),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await delegateDriftClient.subscribe();
	});

	it('Deposit', async () => {
		delegateUsdcAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper,
			delegateKeyPair.publicKey
		);

		await delegateDriftClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			delegateUsdcAccount.publicKey
		);

		assert(delegateDriftClient.getQuoteAssetTokenAmount().eq(usdcAmount));
	});

	it('Withdraw', async () => {
		let caughtError = false;
		try {
			await delegateDriftClient.withdraw(
				usdcAmount,
				QUOTE_SPOT_MARKET_INDEX,
				delegateUsdcAccount.publicKey
			);
		} catch (e) {
			caughtError = true;
		}
		assert(caughtError);
	});

	it('Open position', async () => {
		await delegateDriftClient.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			0
		);
	});
});
