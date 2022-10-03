import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Wallet,
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	AdminClient,
	DriftClient,
	convertToNumber,
	PRICE_PRECISION,
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
import { Keypair } from '@solana/web3.js';

async function depositToFeePoolFromIF(
	amount: number,
	driftClient: AdminClient,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());
	// const state = await driftClient.getStateAccount();
	// const tokenIx = Token.createTransferInstruction(
	// 	TOKEN_PROGRAM_ID,
	// 	userUSDCAccount.publicKey,
	// 	state.insuranceVault,
	// 	driftClient.provider.wallet.publicKey,
	// 	// usdcMint.publicKey,
	// 	[],
	// 	ifAmount.toNumber()
	// );
	//
	// await sendAndConfirmTransaction(
	// 	driftClient.provider.connection,
	// 	new Transaction().add(tokenIx),
	// 	// @ts-ignore
	// 	[driftClient.provider.wallet.payer],
	// 	{
	// 		skipPreflight: false,
	// 		commitment: 'recent',
	// 		preflightCommitment: 'recent',
	// 	}
	// );

	console.log(userUSDCAccount.publicKey.toString());
	// // send $50 to market from IF
	const txSig00 = await driftClient.depositIntoMarketFeePool(
		0,
		ifAmount,
		userUSDCAccount.publicKey
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
	const driftProgram = anchor.workspace.Drift as Program;

	let driftClient: AdminClient;
	const eventSubscriber = new EventSubscriber(connection, driftProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;
	let userUSDCAccount2;

	let driftClientLoser: DriftClient;

	let liquidatorDriftClient: DriftClient;
	let liquidatorDriftClientWSOLAccount: PublicKey;

	let solOracle: PublicKey;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
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

		driftClient = new AdminClient({
			connection,
			wallet: provider.wallet,
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await driftClient.initializeMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(43_133_000)
		);

		// await driftClient.updateMarketBaseSpread(new BN(0), 2000);
		// await driftClient.updateCurveUpdateIntensity(new BN(0), 100);

		await driftClient.initializeUserAccountAndDepositCollateral(
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
		driftClientLoser = new AdminClient({
			connection,
			wallet: new Wallet(userKeypair),
			programID: driftProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});
		await driftClientLoser.subscribe();
		await driftClientLoser.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount2.publicKey
		);

		// [, whaleAccountPublicKey] =
		// await whaleDriftClient.initializeUserAccountAndDepositCollateral(
		//     usdcAmountWhale,
		//     whaleUSDCAccount.publicKey
		// );

		// whaleUser = new DriftUser({
		//     driftClient: whaleDriftClient,
		//     userAccountPublicKey: await whaleDriftClient.getUserAccountPublicKey(),
		// });

		// await whaleUser.subscribe();
	});

	after(async () => {
		await driftClient.unsubscribe();
		await driftClientLoser.unsubscribe();
		await liquidatorDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('put market in big drawdown and net user positive pnl', async () => {
		await depositToFeePoolFromIF(1000, driftClient, userUSDCAccount);

		try {
			await driftClient.openPosition(
				PositionDirection.SHORT,
				BASE_PRECISION,
				0,
				new BN(0)
			);
		} catch (e) {
			console.log('driftClient.openPosition');

			console.error(e);
		}

		// todo
		try {
			await driftClientLoser.openPosition(
				PositionDirection.LONG,
				new BN(2000),
				0
			);
		} catch (e) {
			console.log('driftClientLoserc.openPosition');

			console.error(e);
		}

		const market00 = driftClient.getPerpMarketAccount(0);
		assert(market00.amm.feePool.balance.eq(new BN(1000000000000)));

		// sol tanks 90%
		await driftClient.moveAmmToPrice(
			0,
			new BN(43.1337 * PRICE_PRECISION.toNumber()).div(new BN(10))
		);
		await setFeedPrice(anchor.workspace.Pyth, 43.1337 / 10, solOracle);

		const solAmount = new BN(1 * 10 ** 9);
		[liquidatorDriftClient, liquidatorDriftClientWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				driftProgram,
				solAmount,
				usdcAmount,
				[0],
				[0, 1],
				[
					{
						publicKey: solOracle,
						source: OracleSource.PYTH,
					},
				]
			);
		await liquidatorDriftClient.subscribe();

		const bankIndex = 1;
		await liquidatorDriftClient.deposit(
			solAmount,
			bankIndex,
			liquidatorDriftClientWSOLAccount
		);

		const market0 = driftClient.getPerpMarketAccount(0);
		const winnerUser = driftClient.getUserAccount();
		const loserUser = driftClientLoser.getUserAccount();
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
		const marketIndex = 0;
		const slot = await connection.getSlot();
		const now = await connection.getBlockTime(slot);
		const expiryTs = new BN(now + 3);

		// await driftClient.moveAmmToPrice(
		// 	new BN(0),
		// 	new BN(43.1337 * PRICE_PRECISION.toNumber())
		// );

		const market0 = driftClient.getPerpMarketAccount(marketIndex);
		assert(market0.expiryTs.eq(ZERO));

		await driftClient.updateMarketExpiry(marketIndex, expiryTs);
		await sleep(1000);
		driftClient.fetchAccounts();

		const market = driftClient.getPerpMarketAccount(marketIndex);
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
		// 	await driftClientLoser.openPosition(
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
		// await driftClientLoser.openPosition(
		// 	PositionDirection.SHORT,
		// 	new BN(10000000),
		// 	new BN(0),
		// 	new BN(0)
		// );
	});

	it('put market in settlement mode', async () => {
		const marketIndex = 0;
		let slot = await connection.getSlot();
		let now = await connection.getBlockTime(slot);

		const market0 = driftClient.getPerpMarketAccount(marketIndex);
		console.log('market0.status:', market0.status);
		while (market0.expiryTs.gte(new BN(now))) {
			console.log(market0.expiryTs.toString(), '>', now);
			await sleep(1000);
			slot = await connection.getSlot();
			now = await connection.getBlockTime(slot);
		}

		// try {
		const txSig = await driftClient.settleExpiredMarket(marketIndex);
		// } catch (e) {
		// 	console.error(e);
		// }
		await printTxLogs(connection, txSig);

		driftClient.fetchAccounts();

		const market = driftClient.getPerpMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'settlement'));
		console.log(
			'market.settlementPrice:',
			convertToNumber(market.settlementPrice)
		);
		console.log(
			'market.amm.historicalOracleData.lastOraclePriceTwap:',
			convertToNumber(market.amm.historicalOracleData.lastOraclePriceTwap)
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
		assert(
			market.amm.historicalOracleData.lastOraclePriceTwap.lt(
				market.settlementPrice
			)
		);
		assert(market.settlementPrice.eq(new BN(28755801)));
	});

	it('settle expired market position', async () => {
		const marketIndex = 0;
		const loserUser0 = driftClientLoser.getUserAccount();
		assert(loserUser0.perpPositions[0].baseAssetAmount.gt(new BN(0)));
		assert(loserUser0.perpPositions[0].quoteAssetAmount.lt(new BN(0)));
		console.log(loserUser0.perpPositions[0]);

		const txSig = await driftClientLoser.settleExpiredPosition(
			await driftClientLoser.getUserAccountPublicKey(),
			driftClientLoser.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig);

		try {
			await driftClient.settlePNL(
				await driftClient.getUserAccountPublicKey(),
				driftClient.getUserAccount(),
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

		await driftClientLoser.fetchAccounts();
		const loserUser = driftClientLoser.getUserAccount();
		// console.log(loserUser.perpPositions[0]);
		assert(loserUser.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		assert(loserUser.perpPositions[0].quoteAssetAmount.eq(new BN(0)));
		const marketAfter0 = driftClient.getPerpMarketAccount(marketIndex);

		const finalPnlResultMin0 = new BN(999978435 - 1090);
		console.log(marketAfter0.pnlPool.balance.toString());
		assert(marketAfter0.pnlPool.balance.gt(finalPnlResultMin0));
		assert(marketAfter0.pnlPool.balance.lt(new BN(999978435000 + 1000000)));

		const txSig2 = await driftClient.settleExpiredPosition(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig2);
		await driftClient.fetchAccounts();
		const winnerUser = driftClient.getUserAccount();
		// console.log(winnerUser.perpPositions[0]);
		assert(winnerUser.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		// assert(winnerUser.perpPositions[0].quoteAssetAmount.gt(new BN(0))); // todo they lose money too after fees

		// await driftClient.settlePNL(
		// 	await driftClientLoser.getUserAccountPublicKey(),
		// 	driftClientLoser.getUserAccount(),
		// 	marketIndex
		// );

		const marketAfter = driftClient.getPerpMarketAccount(marketIndex);

		const finalPnlResultMin = new BN(985673294 - 1090);
		console.log('pnlPool:', marketAfter.pnlPool.balance.toString());
		assert(marketAfter.pnlPool.balance.gt(finalPnlResultMin));
		assert(marketAfter.pnlPool.balance.lt(new BN(986673294000)));

		console.log('feePool:', marketAfter.amm.feePool.balance.toString());
		console.log(
			'totalExchangeFee:',
			marketAfter.amm.totalExchangeFee.toString()
		);
		assert(marketAfter.amm.feePool.balance.eq(new BN(21566000)));
	});
});
