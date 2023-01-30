import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	AdminClient,
	BN,
	DriftClient,
	User,
	Wallet,
	EventSubscriber,
	MarketStatus,
	OracleSource,
	PEG_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
	getTokenAmount,
	SpotBalanceType,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	createUserWithUSDCAndWSOLAccount,
	setFeedPrice,
	sleep,
} from './testHelpers';

describe('dust position', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let fillerDriftClient: AdminClient;
	let fillerDriftClientUser: User;

	let liquidatorDriftClient: DriftClient;
	let liquidatorDriftClientUser: User;
	let liquidatorDriftClientWSOLAccount: PublicKey;

	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(100000000 * 10 ** 6); //100M

	let solUsd;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(32.821);

		marketIndexes = [0];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		fillerDriftClient = new AdminClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await fillerDriftClient.initialize(usdcMint.publicKey, true);
		await fillerDriftClient.subscribe();
		await initializeQuoteSpotMarket(fillerDriftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(fillerDriftClient, solUsd);

		await fillerDriftClient.updatePerpAuctionDuration(new BN(0));

		const solAmount = new BN(100000 * 10 ** 9); // 100k
		[liquidatorDriftClient, liquidatorDriftClientWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[0],
				[0, 1],
				[
					{
						publicKey: solUsd,
						source: OracleSource.PYTH,
					},
				]
			);

		const marketIndex = 1;
		await liquidatorDriftClient.fetchAccounts();

		await liquidatorDriftClient.deposit(
			new BN(1),
			marketIndex,
			liquidatorDriftClientWSOLAccount
		);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerDriftClient.initializePerpMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(20132.821 * PEG_PRECISION.toNumber())
		);
		await fillerDriftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await fillerDriftClient.updatePerpMarketBaseSpread(0, 500);

		await fillerDriftClient.initializeUserAccountAndDepositCollateral(
			new BN(1),
			userUSDCAccount.publicKey
		);

		fillerDriftClientUser = new User({
			driftClient: fillerDriftClient,
			userAccountPublicKey: await fillerDriftClient.getUserAccountPublicKey(),
		});
		await fillerDriftClientUser.subscribe();
	});

	beforeEach(async () => {
		await fillerDriftClient.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPrice(anchor.workspace.Pyth, 20132.821, solUsd);
	});

	after(async () => {
		await fillerDriftClient.unsubscribe();
		await fillerDriftClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('1e-6 usdc', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		await sleep(1000);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const driftClient = new DriftClient({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
			userStats: true,
		});
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			new BN(1),
			userUSDCAccount.publicKey
		);
		const driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await driftClientUser.subscribe();

		const spotMarketUSDCBefore = driftClient.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);
		console.log(spotMarketUSDCBefore);
		assert(spotMarketUSDCBefore.depositBalance.eq(new BN(2000))); // 1e6 -> 1e9

		const fc = driftClientUser.getFreeCollateral();
		const tc = driftClientUser.getTotalCollateral();
		const wl2 = driftClientUser.getWithdrawalLimit(
			QUOTE_SPOT_MARKET_INDEX,
			true
		);
		const maxBorrowLimit = driftClientUser.getWithdrawalLimit(
			QUOTE_SPOT_MARKET_INDEX
		);

		console.log(
			fc.toString(),
			tc.toString(),
			wl2.toString(),
			maxBorrowLimit.toString()
		);

		assert(fc.eq(new BN(1)));
		assert(tc.eq(new BN(1)));
		assert(wl2.eq(new BN(1)));
		assert(maxBorrowLimit.eq(new BN(0)));

		await driftClient.withdraw(new BN(1), 0, userUSDCAccount.publicKey, true);
		await driftClient.fetchAccounts();
		const spotMarketUSDCAfter = driftClient.getSpotMarketAccount(
			QUOTE_SPOT_MARKET_INDEX
		);
		assert(spotMarketUSDCAfter.depositBalance.eq(new BN(1000))); // only filler dust

		liquidatorDriftClientUser = new User({
			driftClient: liquidatorDriftClient,
			userAccountPublicKey:
				await liquidatorDriftClient.getUserAccountPublicKey(),
		});
		await liquidatorDriftClientUser.subscribe();

		await driftClient.fetchAccounts();

		const spotMarketSOLBefore = liquidatorDriftClient.getSpotMarketAccount(1);
		console.log(
			'spotMarketSOLBefore.depositBalance:',
			spotMarketSOLBefore.depositBalance.toString()
		);
		assert(spotMarketSOLBefore.depositBalance.eq(new BN(1))); //1e9

		const solTokens = getTokenAmount(
			spotMarketSOLBefore.depositBalance,
			spotMarketSOLBefore,
			SpotBalanceType.DEPOSIT
		);
		assert(solTokens.eq(new BN(1)));

		const spotPosition = liquidatorDriftClientUser.getSpotPosition(1);
		assert(spotPosition.scaledBalance.eq(new BN(1)));

		const tokenAmount = getTokenAmount(
			spotPosition.scaledBalance,
			spotMarketSOLBefore,
			spotPosition.balanceType
		);
		assert(tokenAmount.eq(new BN(1)));
		const oraclePriceData = liquidatorDriftClient.getOracleDataForSpotMarket(
			spotPosition.marketIndex
		);
		console.log(oraclePriceData);

		assert(oraclePriceData.price.eq(new BN(20132821000)));

		const assetValue1 = liquidatorDriftClientUser.getSpotAssetValue(
			tokenAmount,
			oraclePriceData,
			spotMarketSOLBefore,
			undefined
		);

		const assetValue2 = liquidatorDriftClientUser.getSpotAssetValue(
			tokenAmount,
			oraclePriceData,
			spotMarketSOLBefore,
			'Initial'
		);

		const assetValue3 = liquidatorDriftClientUser.getSpotAssetValue(
			tokenAmount,
			oraclePriceData,
			spotMarketSOLBefore,
			'Maintenance'
		);

		const expectedValue = oraclePriceData.price.div(new BN(10 ** 9));

		console.log(
			'assetValues:',
			assetValue1.toString(),
			assetValue2.toString(),
			assetValue3.toString(),
			expectedValue.toString()
		);

		assert(assetValue1.eq(expectedValue));
		assert(assetValue2.eq(new BN(16)));
		assert(assetValue3.eq(new BN(18)));

		const fc1 = liquidatorDriftClientUser.getFreeCollateral();
		const tc1 = liquidatorDriftClientUser.getTotalCollateral();
		const wl22 = liquidatorDriftClientUser.getWithdrawalLimit(1, true);
		const maxBorrowLimit2 = liquidatorDriftClientUser.getWithdrawalLimit(1);

		console.log(
			'free collat',
			fc1.toString(),
			tc1.toString(),
			wl22.toString(),
			maxBorrowLimit2.toString()
		);
		assert(fc1.eq(new BN(16)));
		assert(tc1.eq(new BN(16)));
		assert(wl22.eq(new BN(1)));
		assert(maxBorrowLimit2.eq(new BN(0)));

		// tiny price now
		await setFeedPrice(anchor.workspace.Pyth, 0.021, solUsd);
		const fc2 = liquidatorDriftClientUser.getFreeCollateral();
		const tc2 = liquidatorDriftClientUser.getTotalCollateral();
		const wl23 = liquidatorDriftClientUser.getWithdrawalLimit(1, true);
		const maxBorrowLimit3 = liquidatorDriftClientUser.getWithdrawalLimit(1);

		console.log(
			'free collat',
			fc2.toString(),
			tc2.toString(),
			wl23.toString(),
			maxBorrowLimit3.toString()
		);
		assert(fc2.eq(new BN(0)));
		assert(tc2.eq(new BN(0)));
		assert(wl23.eq(new BN(1)));
		assert(maxBorrowLimit3.eq(new BN(0)));

		await liquidatorDriftClient.withdraw(
			new BN(1),
			1,
			liquidatorDriftClientWSOLAccount,
			true
		);
		await driftClient.fetchAccounts();
		const spotMarketSOLAfter = driftClient.getSpotMarketAccount(1);
		assert(spotMarketSOLAfter.depositBalance.eq(new BN(0)));

		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
	});
});
