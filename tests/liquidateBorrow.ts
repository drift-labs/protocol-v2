import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	BANK_RATE_PRECISION,
	BANK_WEIGHT_PRECISION,
	ClearingHouse,
	EventSubscriber,
	findComputeUnitConsumption,
	BN,
	OracleSource,
	ZERO,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteAssetBank,
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
} from './testHelpers';
import { NATIVE_MINT } from '@solana/spl-token';

describe('liquidate borrow', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;
	let userWSOLAccount;

	let liquidatorClearingHouse: ClearingHouse;
	let liquidatorClearingHouseWSOLAccount: PublicKey;

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

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [],
			bankIndexes: [new BN(0), new BN(1)],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);

		const optimalUtilization = BANK_RATE_PRECISION.div(new BN(2)); // 50% utilization
		const optimalRate = BANK_RATE_PRECISION.mul(new BN(20)); // 2000% APR
		const maxRate = BANK_RATE_PRECISION.mul(new BN(50)); // 5000% APR
		const initialAssetWeight = BANK_WEIGHT_PRECISION.mul(new BN(8)).div(
			new BN(10)
		);
		const maintenanceAssetWeight = BANK_WEIGHT_PRECISION.mul(new BN(9)).div(
			new BN(10)
		);
		const initialLiabilityWeight = BANK_WEIGHT_PRECISION.mul(new BN(12)).div(
			new BN(10)
		);
		const maintenanceLiabilityWeight = BANK_WEIGHT_PRECISION.mul(
			new BN(11)
		).div(new BN(10));
		await clearingHouse.initializeBank(
			NATIVE_MINT,
			optimalUtilization,
			optimalRate,
			maxRate,
			solOracle,
			OracleSource.QUOTE_ASSET,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight
		);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const solAmount = new BN(1 * 10 ** 9);
		[liquidatorClearingHouse, liquidatorClearingHouseWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[],
				[new BN(0), new BN(1)],
				[
					{
						publicKey: solOracle,
						source: OracleSource.PYTH,
					},
				]
			);
		await liquidatorClearingHouse.subscribe();

		const bankIndex = new BN(1);
		await liquidatorClearingHouse.deposit(
			solAmount,
			bankIndex,
			liquidatorClearingHouseWSOLAccount
		);
		const solBorrow = new BN(5 * 10 ** 8);
		await clearingHouse.withdraw(solBorrow, new BN(1), userWSOLAccount);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('liquidate', async () => {
		await setFeedPrice(anchor.workspace.Pyth, 200, solOracle);

		const txSig = await liquidatorClearingHouse.liquidateBorrow(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0),
			new BN(1),
			new BN(6 * 10 ** 8)
		);

		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
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

		assert(!clearingHouse.getUserAccount().beingLiquidated);
		assert(clearingHouse.getUserAccount().bankBalances[0].balance.eq(ZERO));
		assert(
			clearingHouse.getUserAccount().bankBalances[1].balance.eq(new BN(2))
		);
	});
});
