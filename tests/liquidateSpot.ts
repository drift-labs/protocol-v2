import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	TestClient,
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
} from '../packages/sdk/src';

import {
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeSolSpotMarket,
	sleep,
	setFeedPriceNoProgram,
} from './testHelpers';
import { PERCENTAGE_PRECISION } from '../packages/sdk';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../packages/sdk/src/bankrun/bankrunConnection';

describe('liquidate spot', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let velocityClient: TestClient;
	let eventSubscriber: EventSubscriber;
	let bankrunContextWrapper: BankrunContextWrapper;

	let bulkAccountLoader: TestBulkAccountLoader;

	let usdcMint;
	let userUSDCAccount;
	let userWSOLAccount;

	let liquidatorVelocityClient: TestClient;
	let liquidatorVelocityClientWSOLAccount: PublicKey;

	let solOracle: PublicKey;

	const usdcAmount = new BN(100 * 10 ** 6);

	let _throwaway: PublicKey;

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
		userWSOLAccount = await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			// @ts-ignore
			bankrunContextWrapper.provider.wallet,
			ZERO
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		solOracle = await mockOracleNoProgram(
			bankrunContextWrapper,
			100,
			-7,
			undefined,
			10000
		);

		velocityClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH_LAZER,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await velocityClient.initialize(usdcMint.publicKey, true);
		await velocityClient.subscribe();

		await velocityClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(velocityClient, usdcMint.publicKey);
		await initializeSolSpotMarket(velocityClient, solOracle);

		const oracleGuardrails = await velocityClient.getStateAccount()
			.oracleGuardRails;
		oracleGuardrails.priceDivergence.oracleTwap5MinPercentDivergence = new BN(
			100
		).mul(PERCENTAGE_PRECISION);
		await velocityClient.updateOracleGuardRails(oracleGuardrails);

		await velocityClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const solAmount = new BN(1 * 10 ** 9);
		[
			liquidatorVelocityClient,
			liquidatorVelocityClientWSOLAccount,
			_throwaway,
		] = await createUserWithUSDCAndWSOLAccount(
			bankrunContextWrapper,
			usdcMint,
			chProgram,
			solAmount,
			usdcAmount,
			[],
			[0, 1],
			[
				{
					publicKey: solOracle,
					source: OracleSource.PYTH_LAZER,
				},
			],
			bulkAccountLoader
		);

		const marketIndex = 1;

		await liquidatorVelocityClient.deposit(
			solAmount,
			marketIndex,
			liquidatorVelocityClientWSOLAccount
		);
		const solBorrow = new BN(5 * 10 ** 8);
		await velocityClient.withdraw(solBorrow, 1, userWSOLAccount);
	});

	after(async () => {
		await velocityClient.unsubscribe();
		await liquidatorVelocityClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		const user = new User({
			velocityClient: velocityClient,
			userAccountPublicKey: await velocityClient.getUserAccountPublicKey(),
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await user.subscribe();
		await velocityClient.fetchAccounts();
		const healthBefore100 = user.getHealth();
		console.log('healthBefore100:', healthBefore100);
		assert(healthBefore100 == 45);

		console.log(
			'spotLiquidationPrice:',
			convertToNumber(
				user.spotLiquidationPrice(user.getSpotPosition(1).marketIndex)
			)
		);

		await setFeedPriceNoProgram(bankrunContextWrapper, 179, solOracle, 10000);
		await sleep(1000);

		await velocityClient.fetchAccounts();
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

		await setFeedPriceNoProgram(
			bankrunContextWrapper,
			179 + convertToNumber(mtc.sub(mmr), QUOTE_PRECISION) * (2 / 1.1 - 0.001),
			solOracle,
			10000
		);
		await sleep(1000);

		await velocityClient.fetchAccounts();
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

		await setFeedPriceNoProgram(bankrunContextWrapper, 190, solOracle, 10000);
		await sleep(1000);

		const spotMarketBefore = velocityClient.getSpotMarketAccount(0);
		const spotMarket1Before = velocityClient.getSpotMarketAccount(1);
		await velocityClient.fetchAccounts();
		await user.fetchAccounts();

		const healthAfter = user.getHealth();
		console.log('healthAfter:', healthAfter);
		assert(healthAfter == 0);
		await user.unsubscribe();

		const txSig = await liquidatorVelocityClient.liquidateSpot(
			await velocityClient.getUserAccountPublicKey(),
			velocityClient.getUserAccount(),
			0,
			1,
			new BN(6 * 10 ** 8)
		);

		const computeUnits =
			bankrunContextWrapper.connection.findComputeUnitConsumption(txSig);
		console.log('compute units', computeUnits);
		bankrunContextWrapper.connection.printTxLogs(txSig);

		// assert(!velocityClient.getUserAccount().isBeingLiquidated); // out of liq territory
		assert(velocityClient.getUserAccount().status === 0);

		assert(velocityClient.getUserAccount().nextLiquidationId === 2);
		assert(
			isVariant(
				velocityClient.getUserAccount().spotPositions[0].balanceType,
				'deposit'
			)
		);
		assert(
			velocityClient.getUserAccount().spotPositions[0].scaledBalance.gt(ZERO)
		);
		// assert(
		// 	velocityClient.getUserAccount().spotPositions[1].scaledBalance.gt(new BN(2))
		// );
		// assert(
		// 	isVariant(
		// 		velocityClient.getUserAccount().spotPositions[0].balanceType,
		// 		'borrow'
		// 	)
		// );
		console.log(
			velocityClient.getUserAccount().spotPositions[0].scaledBalance.toString()
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
		assert(liquidationRecord.liquidateSpot.ifFee.eq(new BN(0)));

		await velocityClient.fetchAccounts();
		const spotMarket = velocityClient.getSpotMarketAccount(0);
		const spotMarket1 = velocityClient.getSpotMarketAccount(1);

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
		assert(netBalanceBefore.sub(netBalanceAfter).lte(new BN(1245)));
	});
});
