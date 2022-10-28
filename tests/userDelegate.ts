import * as anchor from '@project-serum/anchor';

import { Program } from '@project-serum/anchor';

import {
	QUOTE_SPOT_MARKET_INDEX,
	AdminClient,
	BN,
	EventSubscriber,
	PRICE_PRECISION,
	DriftClient,
	OracleSource,
	PositionDirection,
	Wallet,
	MarketStatus,
} from '../sdk/src';

import {
	createFundedKeyPair,
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { assert } from 'chai';
import { Keypair } from '@solana/web3.js';

describe('user delegate', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: AdminClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;

	const usdcAmount = new BN(10 * 10 ** 6);

	let delegateKeyPair: Keypair;
	let delegateDriftClient: DriftClient;
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
		usdcMint = await mockUSDCMint(provider);

		solUsd = await mockOracle(1);
		driftClient = new AdminClient({
			connection,
			wallet: provider.wallet,
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
			userStats: true,
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR
		await driftClient.initializePerpMarket(
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);
		await driftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		const subAccountId = 0;
		const name = 'CRISP';
		await driftClient.initializeUserAccount(subAccountId, name);

		delegateKeyPair = await createFundedKeyPair(connection);
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

		const delegateUserAccount = (
			await driftClient.getUserAccountsForDelegate(delegateKeyPair.publicKey)
		)[0];
		assert(delegateUserAccount.delegate.equals(delegateKeyPair.publicKey));

		delegateDriftClient = new DriftClient({
			connection,
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
			authority: provider.wallet.publicKey,
		});
		await delegateDriftClient.subscribe();
	});

	it('Deposit', async () => {
		delegateUsdcAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
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
