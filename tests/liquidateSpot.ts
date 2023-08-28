import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	TestClient,
	findComputeUnitConsumption,
	BN,
	OracleSource,
	ZERO,
	EventSubscriber,
	PRICE_PRECISION,
	getTokenAmount,
	SpotBalanceType,
	isVariant,
	User,
	QUOTE_PRECISION,
	convertToNumber,
	LIQUIDATION_PCT_PRECISION,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeSolSpotMarket,
	sleep,
} from './testHelpers';
import { BulkAccountLoader } from '../sdk';

describe('liquidate spot', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let usdcMint;
	let userUSDCAccount;
	let userWSOLAccount;

	let liquidatorDriftClient: TestClient;
	let liquidatorDriftClientWSOLAccount: PublicKey;

	let solOracle: PublicKey;

	const usdcAmount = new BN(100 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);
		userWSOLAccount = await createWSolTokenAccountForUser(
			provider,
			// @ts-ignore
			provider.wallet,
			ZERO
		);

		solOracle = await mockOracle(100);

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const solAmount = new BN(1 * 10 ** 9);
		[liquidatorDriftClient, liquidatorDriftClientWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[],
				[0, 1],
				[
					{
						publicKey: solOracle,
						source: OracleSource.PYTH,
					},
				],
				bulkAccountLoader
			);

		const marketIndex = 1;
		await liquidatorDriftClient.deposit(
			solAmount,
			marketIndex,
			liquidatorDriftClientWSOLAccount
		);
		const solBorrow = new BN(5 * 10 ** 8);
		await driftClient.withdraw(solBorrow, 1, userWSOLAccount);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await liquidatorDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		const user = new User({
			driftClient: driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await user.subscribe();
		await driftClient.fetchAccounts();
		const healthBefore100 = user.getHealth();
		console.log('healthBefore100:', healthBefore100);
		assert(healthBefore100 == 45);

		console.log(
			'spotLiquidationPrice:',
			convertToNumber(
				user.spotLiquidationPrice(user.getSpotPosition(1).marketIndex)
			)
		);

		await setFeedPrice(anchor.workspace.Pyth, 179, solOracle);
		await sleep(1000);

		await driftClient.fetchAccounts();
		await user.fetchAccounts();
		const healthBefore179 = user.getHealth();
		console.log('healthBefore179:', healthBefore179);
		assert(healthBefore179 == 2);
		console.log(
			'spotLiquidationPrice:',
			convertToNumber(
				user.spotLiquidationPrice(user.getSpotPosition(1).marketIndex)
			)
		);

		let mtc = user.getTotalCollateral('Maintenance');
		let mmr = user.getMaintenanceMarginRequirement();
		console.log(
			'$',
			convertToNumber(mtc.sub(mmr), QUOTE_PRECISION),
			'away from liq'
		);

		await setFeedPrice(
			anchor.workspace.Pyth,
			179 + convertToNumber(mtc.sub(mmr), QUOTE_PRECISION) * (2 / 1.1 - 0.001),
			solOracle
		);
		await sleep(1000);

		await driftClient.fetchAccounts();
		await user.fetchAccounts();

		mtc = user.getTotalCollateral('Maintenance');
		mmr = user.getMaintenanceMarginRequirement();
		console.log(
			'$',
			convertToNumber(mtc.sub(mmr), QUOTE_PRECISION),
			'away from liq'
		);

		const healthBefore181 = user.getHealth();
		console.log('healthBefore181:', healthBefore181);
		assert(healthBefore181 == 0);
		console.log(
			'spotLiquidationPrice:',
			convertToNumber(
				user.spotLiquidationPrice(user.getSpotPosition(1).marketIndex),
				PRICE_PRECISION
			)
		);

		await setFeedPrice(anchor.workspace.Pyth, 190, solOracle);
		await sleep(1000);

		const spotMarketBefore = driftClient.getSpotMarketAccount(0);
		const spotMarket1Before = driftClient.getSpotMarketAccount(1);
		await driftClient.fetchAccounts();
		await user.fetchAccounts();

		const healthAfter = user.getHealth();
		console.log('healthAfter:', healthAfter);
		assert(healthAfter == 0);
		await user.unsubscribe();

		const txSig = await liquidatorDriftClient.liquidateSpot(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			1,
			new BN(6 * 10 ** 8)
		);

		const computeUnits = await findComputeUnitConsumption(
			driftClient.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		// assert(!driftClient.getUserAccount().isBeingLiquidated); // out of liq territory
		assert(!isVariant(driftClient.getUserAccount().status, 'beingLiquidated'));

		assert(driftClient.getUserAccount().nextLiquidationId === 2);
		assert(
			isVariant(
				driftClient.getUserAccount().spotPositions[0].balanceType,
				'deposit'
			)
		);
		assert(
			driftClient.getUserAccount().spotPositions[0].scaledBalance.gt(ZERO)
		);
		// assert(
		// 	driftClient.getUserAccount().spotPositions[1].scaledBalance.gt(new BN(2))
		// );
		// assert(
		// 	isVariant(
		// 		driftClient.getUserAccount().spotPositions[0].balanceType,
		// 		'borrow'
		// 	)
		// );
		console.log(
			driftClient.getUserAccount().spotPositions[0].scaledBalance.toString()
		);

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(liquidationRecord.liquidationId === 1);
		assert(isVariant(liquidationRecord.liquidationType, 'liquidateSpot'));
		assert(liquidationRecord.liquidateSpot.assetPrice.eq(PRICE_PRECISION));
		assert(liquidationRecord.liquidateSpot.assetMarketIndex === 0);
		console.log(
			'asset transfer',
			liquidationRecord.liquidateSpot.assetTransfer.toString()
		);

		// todo, why?
		console.log(liquidationRecord.liquidateSpot.assetTransfer.toString());
		assert(
			liquidationRecord.liquidateSpot.liabilityPrice.eq(
				new BN(190).mul(PRICE_PRECISION)
			)
		);
		assert(liquidationRecord.liquidateSpot.liabilityMarketIndex === 1);
		console.log(
			'liability transfer',
			liquidationRecord.liquidateSpot.liabilityTransfer.toString()
		);

		// if fee costs 1/100th of liability transfer
		assert(
			liquidationRecord.liquidateSpot.ifFee.eq(
				liquidationRecord.liquidateSpot.liabilityTransfer.div(new BN(100))
			)
		);

		await driftClient.fetchAccounts();
		const spotMarket = driftClient.getSpotMarketAccount(0);
		const spotMarket1 = driftClient.getSpotMarketAccount(1);

		console.log(
			'usdc borrows in spotMarket:',
			getTokenAmount(
				spotMarketBefore.borrowBalance,
				spotMarketBefore,
				SpotBalanceType.BORROW
			).toString(),
			'->',
			getTokenAmount(
				spotMarket.borrowBalance,
				spotMarket,
				SpotBalanceType.BORROW
			).toString()
		);

		console.log(
			'usdc deposits in spotMarket:',
			getTokenAmount(
				spotMarketBefore.depositBalance,
				spotMarketBefore,
				SpotBalanceType.DEPOSIT
			).toString(),
			'->',
			getTokenAmount(
				spotMarket.depositBalance,
				spotMarket,
				SpotBalanceType.DEPOSIT
			).toString()
		);

		console.log(
			'sol borrows in spotMarket:',
			getTokenAmount(
				spotMarket1Before.borrowBalance,
				spotMarket1Before,
				SpotBalanceType.BORROW
			).toString(),
			'->',
			getTokenAmount(
				spotMarket1.borrowBalance,
				spotMarket1,
				SpotBalanceType.BORROW
			).toString()
		);

		console.log(
			'sol deposits in spotMarket:',
			getTokenAmount(
				spotMarket1Before.depositBalance,
				spotMarket1Before,
				SpotBalanceType.DEPOSIT
			).toString(),
			'->',
			getTokenAmount(
				spotMarket1.depositBalance,
				spotMarket1,
				SpotBalanceType.DEPOSIT
			).toString()
		);

		const netBalanceBefore = spotMarket1Before.depositBalance.sub(
			spotMarket1Before.borrowBalance
		);
		const netBalanceAfter = spotMarket1.depositBalance.sub(
			spotMarket1.borrowBalance
		);

		console.log(
			'netBalance:',
			netBalanceBefore.toString(),
			'->',
			netBalanceAfter.toString()
		);
		assert(netBalanceBefore.sub(netBalanceAfter).lte(new BN(1000)));
	});
});
