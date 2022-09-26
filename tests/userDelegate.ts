import * as anchor from '@project-serum/anchor';

import { Program } from '@project-serum/anchor';

import {
	QUOTE_SPOT_MARKET_INDEX,
	Admin,
	BN,
	EventSubscriber,
	PRICE_PRECISION,
} from '../sdk/src';

import {
	createFundedKeyPair,
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { assert } from 'chai';
import { ClearingHouse, OracleSource, PositionDirection, Wallet } from '../sdk';
import { Keypair } from '@solana/web3.js';

describe('user delegate', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;

	const usdcAmount = new BN(10 * 10 ** 6);

	let delegateKeyPair: Keypair;
	let delegateClearingHouse: ClearingHouse;
	let delegateUsdcAccount: Keypair;

	const marketIndexes = [new BN(0)];
	const spotMarketIndexes = [new BN(0)];

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
		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
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

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR
		await clearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		const userId = 0;
		const name = 'CRISP';
		await clearingHouse.initializeUserAccount(userId, name);

		delegateKeyPair = await createFundedKeyPair(connection);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
		await delegateClearingHouse.unsubscribe();
	});

	it('Update delegate', async () => {
		await clearingHouse.updateUserDelegate(delegateKeyPair.publicKey);

		await clearingHouse.fetchAccounts();
		assert(
			clearingHouse.getUserAccount().delegate.equals(delegateKeyPair.publicKey)
		);

		const delegateUserAccount = (
			await clearingHouse.getUserAccountsForDelegate(delegateKeyPair.publicKey)
		)[0];
		assert(delegateUserAccount.delegate.equals(delegateKeyPair.publicKey));

		delegateClearingHouse = new ClearingHouse({
			connection,
			wallet: new Wallet(delegateKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
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
		await delegateClearingHouse.subscribe();
	});

	it('Deposit', async () => {
		delegateUsdcAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			delegateKeyPair.publicKey
		);

		await delegateClearingHouse.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			delegateUsdcAccount.publicKey
		);

		assert(delegateClearingHouse.getQuoteAssetTokenAmount().eq(usdcAmount));
	});

	it('Withdraw', async () => {
		let caughtError = false;
		try {
			await delegateClearingHouse.withdraw(
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
		await delegateClearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			new BN(0)
		);
	});
});
