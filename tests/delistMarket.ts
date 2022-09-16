import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { PublicKey } from '@solana/web3.js';

import {
	Wallet,
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	Admin,
	ClearingHouse,
	convertToNumber,
	MARK_PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	QUOTE_PRECISION,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	initializeSolSpotMarket,
	printTxLogs,
	getFeedData,
	getOraclePriceData,
	sleep,
} from './testHelpers';
import { isVariant } from '../sdk';
import {
	Keypair,
	sendAndConfirmTransaction,
	Transaction,
} from '@solana/web3.js';

async function depositToFeePoolFromIF(
	amount: number,
	clearingHouse: Admin,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());
	const state = await clearingHouse.getStateAccount();
	const tokenIx = Token.createTransferInstruction(
		TOKEN_PROGRAM_ID,
		userUSDCAccount.publicKey,
		state.insuranceVault,
		clearingHouse.provider.wallet.publicKey,
		// usdcMint.publicKey,
		[],
		ifAmount.toNumber()
	);

	await sendAndConfirmTransaction(
		clearingHouse.provider.connection,
		new Transaction().add(tokenIx),
		// @ts-ignore
		[clearingHouse.provider.wallet.payer],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);

	// // send $50 to market from IF
	const txSig00 = await clearingHouse.withdrawFromInsuranceVaultToMarket(
		new BN(0),
		ifAmount
	);
	console.log(txSig00);
}

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

	const usdcAmount = new BN(1000 * 10 ** 6);
	const userKeypair = new Keypair();

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(10)),
			provider
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
			perpMarketIndexes: [new BN(0)],
			spotMarketIndexes: [new BN(0), new BN(1)],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await initializeSolSpotMarket(clearingHouse, solOracle);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await clearingHouse.initializeMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(43_133)
		);

		// await clearingHouse.updateMarketBaseSpread(new BN(0), 2000);
		// await clearingHouse.updateCurveUpdateIntensity(new BN(0), 100);

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
			perpMarketIndexes: [new BN(0)],
			spotMarketIndexes: [new BN(0), new BN(1)],
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
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseLoser.unsubscribe();
		await liquidatorClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('put market in big drawdown and net user positive pnl', async () => {
		await depositToFeePoolFromIF(1000, clearingHouse, userUSDCAccount);

		try {
			await clearingHouse.openPosition(
				PositionDirection.SHORT,
				BASE_PRECISION,
				new BN(0),
				new BN(0)
			);
		} catch (e) {
			console.log('clearingHouse.openPosition');

			console.error(e);
		}

		// todo
		try {
			await clearingHouseLoser.openPosition(
				PositionDirection.LONG,
				new BN(20000000),
				new BN(0),
				new BN(0)
			);
		} catch (e) {
			console.log('clearingHouseLoserc.openPosition');

			console.error(e);
		}

		const market00 = clearingHouse.getPerpMarketAccount(new BN(0));
		assert(market00.amm.feePool.balance.eq(new BN(1000000000)));

		// sol tanks 90%
		await clearingHouse.moveAmmToPrice(
			new BN(0),
			new BN(43.1337 * MARK_PRICE_PRECISION.toNumber()).div(new BN(10))
		);
		await setFeedPrice(anchor.workspace.Pyth, 43.1337 / 10, solOracle);

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

		const market0 = clearingHouse.getPerpMarketAccount(new BN(0));
		const winnerUser = clearingHouse.getUserAccount();
		const loserUser = clearingHouseLoser.getUserAccount();
		console.log(winnerUser.perpPositions[0].quoteAssetAmount.toString());
		console.log(loserUser.perpPositions[0].quoteAssetAmount.toString());

		// TODO: quoteAssetAmountShort!= sum of users
		assert(
			market0.amm.quoteAssetAmountShort.eq(
				winnerUser.perpPositions[0].quoteAssetAmount
			)
		);

		assert(
			market0.amm.quoteAssetAmountLong.eq(
				loserUser.perpPositions[0].quoteAssetAmount
			)
		);
	});

	it('put market in reduce only mode', async () => {
		const marketIndex = new BN(0);
		const slot = await connection.getSlot();
		const now = await connection.getBlockTime(slot);
		const expiryTs = new BN(now + 3);

		// await clearingHouse.moveAmmToPrice(
		// 	new BN(0),
		// 	new BN(43.1337 * MARK_PRICE_PRECISION.toNumber())
		// );

		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);
		assert(market0.expiryTs.eq(ZERO));

		await clearingHouse.updateMarketExpiry(marketIndex, expiryTs);
		await sleep(1000);
		clearingHouse.fetchAccounts();

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'reduceOnly'));
		console.log(
			'market.expiryTs == ',
			market.expiryTs.toString(),
			'(',
			expiryTs.toString(),
			')'
		);
		assert(market.expiryTs.eq(expiryTs));

		console.log('totalExchangeFee:', market.amm.totalExchangeFee.toString());
		console.log('totalFee:', market.amm.totalFee.toString());
		console.log('totalMMFee:', market.amm.totalMmFee.toString());
		console.log(
			'totalFeeMinusDistributions:',
			market.amm.totalFeeMinusDistributions.toString()
		);

		// should fail
		// try {
		// 	await clearingHouseLoser.openPosition(
		// 		PositionDirection.LONG,
		// 		new BN(10000000),
		// 		new BN(0),
		// 		new BN(0)
		// 	);
		// 	assert(false);
		// } catch (e) {
		// 	console.log(e);

		// 	if (!e.toString().search('AnchorError occurred')) {
		// 		assert(false);
		// 	}
		// 	console.log('risk increase trade failed');
		// }

		// should succeed
		// await clearingHouseLoser.openPosition(
		// 	PositionDirection.SHORT,
		// 	new BN(10000000),
		// 	new BN(0),
		// 	new BN(0)
		// );
	});

	it('put market in settlement mode', async () => {
		const marketIndex = new BN(0);
		let slot = await connection.getSlot();
		let now = await connection.getBlockTime(slot);

		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log('market0.status:', market0.status);
		while (market0.expiryTs.gte(new BN(now))) {
			console.log(market0.expiryTs.toString(), '>', now);
			await sleep(1000);
			slot = await connection.getSlot();
			now = await connection.getBlockTime(slot);
		}

		// try {
		const txSig = await clearingHouse.settleExpiredMarket(marketIndex);
		// } catch (e) {
		// 	console.error(e);
		// }
		await printTxLogs(connection, txSig);

		clearingHouse.fetchAccounts();

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'settlement'));
		console.log(
			'market.settlementPrice:',
			convertToNumber(market.settlementPrice)
		);
		console.log(
			'market.amm.lastOraclePriceTwap:',
			convertToNumber(market.amm.lastOraclePriceTwap)
		);

		const curPrice = (await getFeedData(anchor.workspace.Pyth, solOracle))
			.price;
		console.log('new oracle price:', curPrice);
		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			solOracle
		);
		assert(Math.abs(convertToNumber(oraclePriceData.price) - curPrice) < 1e-4);

		assert(market.settlementPrice.gt(ZERO));

		assert(market.amm.netBaseAssetAmount.lt(ZERO));
		assert(market.amm.lastOraclePriceTwap.lt(market.settlementPrice));
		assert(market.settlementPrice.eq(new BN(287558000001)));
	});

	it('settle expired market position', async () => {
		const marketIndex = new BN(0);
		const loserUser0 = clearingHouseLoser.getUserAccount();
		assert(loserUser0.perpPositions[0].baseAssetAmount.gt(new BN(0)));
		assert(loserUser0.perpPositions[0].quoteAssetAmount.lt(new BN(0)));
		console.log(loserUser0.perpPositions[0]);

		const txSig = await clearingHouseLoser.settleExpiredPosition(
			await clearingHouseLoser.getUserAccountPublicKey(),
			clearingHouseLoser.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig);

		try {
			await clearingHouse.settlePNL(
				await clearingHouse.getUserAccountPublicKey(),
				clearingHouse.getUserAccount(),
				marketIndex
			);
		} catch (e) {
			// if (!e.toString().search('AnchorError occurred')) {
			// 	assert(false);
			// }
			console.log('Cannot settle pnl under current market status');
		}

		// const settleRecord = eventSubscriber.getEventsArray('SettlePnlRecord')[0];
		// console.log(settleRecord);

		await clearingHouseLoser.fetchAccounts();
		const loserUser = clearingHouseLoser.getUserAccount();
		// console.log(loserUser.perpPositions[0]);
		assert(loserUser.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		assert(loserUser.perpPositions[0].quoteAssetAmount.eq(new BN(0)));
		const marketAfter0 = clearingHouse.getPerpMarketAccount(marketIndex);

		const finalPnlResultMin0 = new BN(999978435 - 1090);
		console.log(marketAfter0.pnlPool.balance.toString());
		assert(marketAfter0.pnlPool.balance.gt(finalPnlResultMin0));
		assert(marketAfter0.pnlPool.balance.lt(new BN(999978435 + 1000)));

		const txSig2 = await clearingHouse.settleExpiredPosition(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig2);
		await clearingHouse.fetchAccounts();
		const winnerUser = clearingHouse.getUserAccount();
		// console.log(winnerUser.perpPositions[0]);
		assert(winnerUser.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		// assert(winnerUser.perpPositions[0].quoteAssetAmount.gt(new BN(0))); // todo they lose money too after fees

		// await clearingHouse.settlePNL(
		// 	await clearingHouseLoser.getUserAccountPublicKey(),
		// 	clearingHouseLoser.getUserAccount(),
		// 	marketIndex
		// );

		const marketAfter = clearingHouse.getPerpMarketAccount(marketIndex);

		const finalPnlResultMin = new BN(985673294 - 1090);
		console.log('pnlPool:', marketAfter.pnlPool.balance.toString());
		assert(marketAfter.pnlPool.balance.gt(finalPnlResultMin));
		assert(marketAfter.pnlPool.balance.lt(new BN(986673294)));

		console.log('feePool:', marketAfter.amm.feePool.balance.toString());
		console.log(
			'totalExchangeFee:',
			marketAfter.amm.totalExchangeFee.toString()
		);
		assert(marketAfter.amm.feePool.balance.eq(new BN(21566)));
	});
});
