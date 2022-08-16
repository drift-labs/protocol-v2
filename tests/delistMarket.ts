import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';
import { Keypair } from '@solana/web3.js';

import {
	Wallet,
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	Admin,
	ClearingHouse,
	findComputeUnitConsumption,
	MARK_PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteAssetBank,
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeSolAssetBank,
} from './testHelpers';
import { isVariant } from '../sdk';

describe('delist market', () => {
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
	let userUSDCAccount2;
	let userWSOLAccount;

	let clearingHouseLoser: ClearingHouse;

	let liquidatorClearingHouse: ClearingHouse;
	let liquidatorClearingHouseWSOLAccount: PublicKey;

	let solOracle: PublicKey;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);
	const userKeypair = new Keypair();

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);
		userWSOLAccount = await createWSolTokenAccountForUser(
			provider,
			// @ts-ignore
			provider.wallet,
			ZERO
		);

		solOracle = await mockOracle(43.1337);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
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
		await initializeSolAssetBank(clearingHouse, solOracle);
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		const periodicity = new BN(0);

		await clearingHouse.initializeMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		userUSDCAccount2 = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		clearingHouseLoser = new Admin({
			connection,
			wallet: new Wallet(userKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0), new BN(1)],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});
		await clearingHouseLoser.subscribe();
		await clearingHouseLoser.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount2.publicKey
		);

		// [, whaleAccountPublicKey] =
		// await whaleClearingHouse.initializeUserAccountAndDepositCollateral(
		//     usdcAmountWhale,
		//     whaleUSDCAccount.publicKey
		// );

		// whaleUser = new ClearingHouseUser({
		//     clearingHouse: whaleClearingHouse,
		//     userAccountPublicKey: await whaleClearingHouse.getUserAccountPublicKey(),
		// });

		// await whaleUser.subscribe();

		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION,
			new BN(0),
			new BN(0)
		);

		// todo
		await clearingHouseLoser.openPosition(
			PositionDirection.LONG,
			new BN(10000000),
			new BN(0),
			new BN(0)
		);

		// sol tanks 90%
		await clearingHouse.moveAmmToPrice(
			new BN(0),
			new BN(43.1337 * MARK_PRICE_PRECISION.toNumber()).div(new BN(10))
		);

		const solAmount = new BN(1 * 10 ** 9);
		[liquidatorClearingHouse, liquidatorClearingHouseWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[new BN(0)],
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
		// const solBorrow = new BN(5 * 10 ** 8);
		// await clearingHouse.withdraw(solBorrow, new BN(1), userWSOLAccount);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		// await liquidatorClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('put market in reduce only mode', async () => {
		const marketIndex = new BN(0);
		const slot = await connection.getSlot();
		const now = await connection.getBlockTime(slot);
		const expiryTs = new BN(now + 100);

		const market0 = clearingHouse.getMarketAccount(marketIndex);
		assert(market0.expiryTs.eq(ZERO));

		await clearingHouse.updateMarketExpiry(marketIndex, expiryTs);

		clearingHouse.fetchAccounts();

		const market = clearingHouse.getMarketAccount(marketIndex);
		assert(market.expiryTs.eq(expiryTs));
	});
});
