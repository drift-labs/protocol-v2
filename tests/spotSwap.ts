import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	Account,
	LAMPORTS_PER_SOL,
	PublicKey,
	Transaction,
} from '@solana/web3.js';
const serumHelper = require('./serumHelper');

import {
	BN,
	TestClient,
	EventSubscriber,
	OracleSource,
	OracleInfo,
	getTokenAmount,
	SpotBalanceType,
	ZERO,
	BulkAccountLoader,
	fetchUserStatsAccount,
	getSerumSignerPublicKey,
	QUOTE_PRECISION,
} from '../sdk/src';

import {
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
} from './testHelpers';
import { NATIVE_MINT } from '@solana/spl-token';
import { DexInstructions, Market, OpenOrders } from '@project-serum/serum';
describe('spot swap', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		skipPreflight: false,
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let makerDriftClient: TestClient;
	let makerWSOL: PublicKey;

	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let solOracle: PublicKey;

	let serumMarketPublicKey: PublicKey;

	let usdcMint;
	let makerUSDC;

	let takerDriftClient: TestClient;
	let takerWSOL: PublicKey;
	let takerUSDC: PublicKey;
	let takerOpenOrders: PublicKey;

	const usdcAmount = new BN(200 * 10 ** 6);
	const solAmount = new BN(2 * 10 ** 9);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

	const solSpotMarketIndex = 1;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		makerUSDC = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);
		makerWSOL = await createWSolTokenAccountForUser(
			provider,
			// @ts-ignore
			provider.wallet,
			solAmount
		);

		solOracle = await mockOracle(100);

		marketIndexes = [];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		makerDriftClient = new TestClient({
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
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await makerDriftClient.initialize(usdcMint.publicKey, true);
		await makerDriftClient.subscribe();
		await makerDriftClient.initializeUserAccount();

		await initializeQuoteSpotMarket(makerDriftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(makerDriftClient, solOracle);
		await makerDriftClient.updateSpotMarketStepSizeAndTickSize(
			1,
			new BN(100000000),
			new BN(100)
		);
		await makerDriftClient.updateSpotAuctionDuration(0);

		[takerDriftClient, takerWSOL, takerUSDC] =
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

		await takerDriftClient.deposit(usdcAmount, 0, takerUSDC);
	});

	after(async () => {
		await takerDriftClient.unsubscribe();
		await makerDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Add Serum Market', async () => {
		serumMarketPublicKey = await serumHelper.listMarket({
			connection,
			wallet: provider.wallet,
			baseMint: NATIVE_MINT,
			quoteMint: usdcMint.publicKey,
			baseLotSize: 100000000,
			quoteLotSize: 100,
			dexProgramId: serumHelper.DEX_PID,
			feeRateBps: 0,
		});

		await Market.load(
			provider.connection,
			serumMarketPublicKey,
			{ commitment: 'confirmed' },
			serumHelper.DEX_PID
		);

		await makerDriftClient.initializeSerumFulfillmentConfig(
			solSpotMarketIndex,
			serumMarketPublicKey,
			serumHelper.DEX_PID
		);

		const market = await Market.load(
			provider.connection,
			serumMarketPublicKey,
			{ commitment: 'recent' },
			serumHelper.DEX_PID
		);

		const openOrdersAccount = new Account();
		const createOpenOrdersIx = await OpenOrders.makeCreateAccountTransaction(
			connection,
			market.address,
			takerDriftClient.wallet.publicKey,
			openOrdersAccount.publicKey,
			market.programId
		);
		await takerDriftClient.sendTransaction(
			new Transaction().add(createOpenOrdersIx),
			[openOrdersAccount]
		);

		takerOpenOrders = openOrdersAccount.publicKey;
	});
	const crankMarkets = async () => {
		const openOrderAccounts = [];

		const market = await Market.load(
			provider.connection,
			serumMarketPublicKey,
			{ commitment: 'recent' },
			serumHelper.DEX_PID
		);
		const makerOpenOrders = (
			await market.findOpenOrdersAccountsForOwner(
				connection,
				provider.wallet.publicKey
			)
		)[0];
		openOrderAccounts.push(makerOpenOrders.publicKey);

		const serumFulfillmentConfigAccount =
			await makerDriftClient.getSerumV3FulfillmentConfig(serumMarketPublicKey);
		openOrderAccounts.push(serumFulfillmentConfigAccount.serumOpenOrders);

		const consumeEventsIx = await market.makeConsumeEventsInstruction(
			openOrderAccounts,
			10
		);

		const consumeEventsTx = new Transaction().add(consumeEventsIx);
		await provider.sendAndConfirm(consumeEventsTx, []);

		// Open orders need to be sorted correctly but not sure how to do it in js, so will run this
		// ix sorted in both direction
		const consumeEventsIx2 = await market.makeConsumeEventsInstruction(
			openOrderAccounts.reverse(),
			10
		);

		const consumeEventsTx2 = new Transaction().add(consumeEventsIx2);
		await provider.sendAndConfirm(consumeEventsTx2, []);
	};

	it('swap usdc for sol', async () => {
		const market = await Market.load(
			provider.connection,
			serumMarketPublicKey,
			{ commitment: 'recent' },
			serumHelper.DEX_PID
		);

		// place ask to sell 1 sol for 100 usdc
		// @ts-ignore
		const { transaction, signers } = await market.makePlaceOrderTransaction(
			provider.connection,
			{
				// @ts-ignore
				owner: provider.wallet,
				payer: makerWSOL,
				side: 'sell',
				price: 100,
				size: 1,
				orderType: 'postOnly',
				clientId: undefined, // todo?
				openOrdersAddressKey: undefined,
				openOrdersAccount: undefined,
				feeDiscountPubkey: null,
				selfTradeBehavior: 'abortTransaction',
			}
		);

		await provider.sendAndConfirm(transaction, signers);

		const amountIn = new BN(200).mul(QUOTE_PRECISION);
		const { beginSwapIx, endSwapIx } = await takerDriftClient.getSwapIx({
			amountIn: amountIn,
			inMarketIndex: 0,
			outMarketIndex: 1,
			inTokenAccount: takerUSDC,
			outTokenAccount: takerWSOL,
		});

		// @ts-ignore
		const serumBidIx = await market.makePlaceOrderInstruction(connection, {
			// @ts-ignore
			owner: takerDriftClient.wallet,
			payer: takerUSDC,
			side: 'buy',
			price: 100,
			size: 2, // larger than maker orders so that entire maker order is taken
			orderType: 'ioc',
			clientId: new BN(1), // todo?
			openOrdersAddressKey: takerOpenOrders,
			feeDiscountPubkey: null,
			selfTradeBehavior: 'abortTransaction',
		});

		const serumConfig = await takerDriftClient.getSerumV3FulfillmentConfig(
			market.publicKey
		);
		const settleFundsIx = DexInstructions.settleFunds({
			market: market.publicKey,
			openOrders: takerOpenOrders,
			owner: takerDriftClient.wallet.publicKey,
			// @ts-ignore
			baseVault: serumConfig.serumBaseVault,
			// @ts-ignore
			quoteVault: serumConfig.serumQuoteVault,
			baseWallet: takerWSOL,
			quoteWallet: takerUSDC,
			vaultSigner: getSerumSignerPublicKey(
				market.programId,
				market.publicKey,
				serumConfig.serumSignerNonce
			),
			programId: market.programId,
		});

		const tx = new Transaction()
			.add(beginSwapIx)
			.add(serumBidIx)
			.add(settleFundsIx)
			.add(endSwapIx);

		const { txSig } = await takerDriftClient.sendTransaction(tx);

		await printTxLogs(connection, txSig);

		const takerSOLAmount = await takerDriftClient.getTokenAmount(1);
		assert(takerSOLAmount.eq(new BN(1000000000)));
		const takerUSDCAmount = await takerDriftClient.getTokenAmount(0);
		assert(takerUSDCAmount.eq(new BN(99959999)));

		// const cumulativeSpotFees =
		// 	takerDriftClient.getUserAccount().cumulativeSpotFees;
		// assert(cumulativeSpotFees.eq(new BN(-50000)));

		const userStatsAccount = await fetchUserStatsAccount(
			connection,
			takerDriftClient.program,
			takerDriftClient.wallet.publicKey
		);
		// assert(userStatsAccount.fees.totalFeePaid.eq(new BN(50000)));
		assert(userStatsAccount.takerVolume30D.eq(new BN(0)));

		const swapRecord = eventSubscriber.getEventsArray('SwapRecord')[0];
		assert(swapRecord.amountOut.eq(new BN(1000000000)));
		assert(swapRecord.outMarketIndex === 1);
		assert(swapRecord.amountIn.eq(new BN(100040000)));
		assert(swapRecord.inMarketIndex === 0);
		// assert(swapRecord.fee.eq(new BN(500000)));
		assert(swapRecord.fee.eq(new BN(0)));

		const solSpotMarket = takerDriftClient.getSpotMarketAccount(1);

		// assert(solSpotMarket.totalSwapFee.eq(new BN(500000)));
		assert(solSpotMarket.totalSwapFee.eq(new BN(0)));

		// const solRevPool = getTokenAmount(
		// 	solSpotMarket.revenuePool.scaledBalance,
		// 	solSpotMarket,
		// 	SpotBalanceType.DEPOSIT
		// );
		// assert(solRevPool.eq(new BN(500000)));

		await crankMarkets();
	});

	it('swap usdc for sol', async () => {
		const market = await Market.load(
			provider.connection,
			serumMarketPublicKey,
			{ commitment: 'recent' },
			serumHelper.DEX_PID
		);

		// place ask to sell 1 sol for 100 usdc
		// @ts-ignore
		const { transaction, signers } = await market.makePlaceOrderTransaction(
			provider.connection,
			{
				// @ts-ignore
				owner: provider.wallet,
				payer: makerUSDC.publicKey,
				side: 'buy',
				price: 100,
				size: 1,
				orderType: 'postOnly',
				clientId: undefined, // todo?
				openOrdersAddressKey: undefined,
				openOrdersAccount: undefined,
				feeDiscountPubkey: null,
				selfTradeBehavior: 'abortTransaction',
			}
		);

		await provider.sendAndConfirm(transaction, signers);

		const amountIn = new BN(1).mul(new BN(LAMPORTS_PER_SOL));
		// .mul(new BN(1999))
		// .div(new BN(2000)); // .9995 SOL
		const { beginSwapIx, endSwapIx } = await takerDriftClient.getSwapIx({
			amountIn: amountIn,
			inMarketIndex: 1,
			outMarketIndex: 0,
			inTokenAccount: takerWSOL,
			outTokenAccount: takerUSDC,
		});

		// @ts-ignore
		const serumAskIx = await market.makePlaceOrderInstruction(connection, {
			// @ts-ignore
			owner: takerDriftClient.wallet,
			payer: takerWSOL,
			side: 'sell',
			price: 100,
			size: 1,
			orderType: 'limit',
			clientId: undefined, // todo?
			openOrdersAddressKey: takerOpenOrders,
			feeDiscountPubkey: null,
			selfTradeBehavior: 'abortTransaction',
		});

		const serumConfig = await takerDriftClient.getSerumV3FulfillmentConfig(
			market.publicKey
		);
		const settleFundsIx = DexInstructions.settleFunds({
			market: market.publicKey,
			openOrders: takerOpenOrders,
			owner: takerDriftClient.wallet.publicKey,
			// @ts-ignore
			baseVault: serumConfig.serumBaseVault,
			// @ts-ignore
			quoteVault: serumConfig.serumQuoteVault,
			baseWallet: takerWSOL,
			quoteWallet: takerUSDC,
			vaultSigner: getSerumSignerPublicKey(
				market.programId,
				market.publicKey,
				serumConfig.serumSignerNonce
			),
			programId: market.programId,
		});

		const tx = new Transaction()
			.add(beginSwapIx)
			.add(serumAskIx)
			.add(settleFundsIx)
			.add(endSwapIx);

		const { txSig } = await takerDriftClient.sendTransaction(tx);

		await printTxLogs(connection, txSig);

		const takerSOLAmount = await takerDriftClient.getTokenAmount(1);
		assert(takerSOLAmount.eq(new BN(0)));
		const takerUSDCAmount = await takerDriftClient.getTokenAmount(0);
		console.log(takerUSDCAmount.toString());
		assert(takerUSDCAmount.eq(new BN(199919999)));

		// const cumulativeSpotFees =
		// 	takerDriftClient.getUserAccount().cumulativeSpotFees;
		// assert(cumulativeSpotFees.eq(new BN(-99980)));

		// const userStatsAccount = await fetchUserStatsAccount(
		// 	connection,
		// 	takerDriftClient.program,
		// 	takerDriftClient.wallet.publicKey
		// );
		// assert(userStatsAccount.fees.totalFeePaid.eq(new BN(99980)));

		const swapRecord = eventSubscriber.getEventsArray('SwapRecord')[0];
		assert(swapRecord.amountOut.eq(new BN(99960000)));
		assert(swapRecord.outMarketIndex === 0);
		assert(swapRecord.amountIn.eq(new BN(1000000000)));
		assert(swapRecord.inMarketIndex === 1);
		// assert(swapRecord.fee.eq(new BN(0)));

		// const usdcSpotMarket = takerDriftClient.getSpotMarketAccount(0);
		//
		// assert(usdcSpotMarket.totalSwapFee.eq(new BN(49980)));
		//
		// const usdcRevPool = getTokenAmount(
		// 	usdcSpotMarket.revenuePool.scaledBalance,
		// 	usdcSpotMarket,
		// 	SpotBalanceType.DEPOSIT
		// );
		// assert(usdcRevPool.eq(new BN(49980)));

		await crankMarkets();
	});

	it('invalid swaps', async () => {
		const amountIn = new BN(100).mul(QUOTE_PRECISION);
		const { beginSwapIx, endSwapIx } = await takerDriftClient.getSwapIx({
			amountIn,
			inMarketIndex: 0,
			outMarketIndex: 1,
			outTokenAccount: takerWSOL,
			inTokenAccount: takerUSDC,
		});

		let tx = new Transaction().add(beginSwapIx);

		let failed = false;
		try {
			await takerDriftClient.sendTransaction(tx);
		} catch (e) {
			// check if the e.logs contains the substring test
			e.logs.forEach((log: any) => {
				if (log.includes('found no SwapEnd instruction in transaction')) {
					failed = true;
				}
			});
		}
		assert(failed);

		tx = new Transaction().add(endSwapIx);

		failed = false;
		try {
			const txO = await takerDriftClient.sendTransaction(tx);
			const txL = await connection.getTransaction(txO.txSig, {
				commitment: 'confirmed',
			});
			console.log('tx logs', txL.meta.logMessages);
		} catch (e) {
			// check if the e.logs contains the substring test
			e.logs.forEach((log: any) => {
				if (
					log.includes('the in_spot_market must have a flash loan amount set')
				) {
					failed = true;
				}
			});
		}
		assert(failed);

		tx = new Transaction()
			.add(beginSwapIx)
			.add(beginSwapIx)
			.add(endSwapIx)
			.add(endSwapIx);

		failed = false;
		try {
			await takerDriftClient.sendTransaction(tx);
		} catch (e) {
			// check if the e.logs contains the substring test
			e.logs.forEach((log: any) => {
				if (log.includes('last drift ix must be end of swap')) {
					failed = true;
				}
			});
		}
		assert(failed);

		tx = new Transaction().add(beginSwapIx).add(beginSwapIx).add(endSwapIx);

		failed = false;
		try {
			await takerDriftClient.sendTransaction(tx);
		} catch (e) {
			// check if the e.logs contains the substring test
			e.logs.forEach((log: any) => {
				if (log.includes('last drift ix must be end of swap')) {
					failed = true;
				}
			});
		}
		assert(failed);

		// Try making end swap be signed from different user
		const { endSwapIx: invalidEndSwapIx } = await makerDriftClient.getSwapIx({
			amountIn,
			inMarketIndex: 0,
			outMarketIndex: 1,
			outTokenAccount: takerWSOL,
			inTokenAccount: takerUSDC,
		});

		tx = new Transaction().add(beginSwapIx).add(invalidEndSwapIx);

		failed = false;
		try {
			await takerDriftClient.sendTransaction(tx, [
				// @ts-ignore
				makerDriftClient.wallet.payer,
			]);
		} catch (e) {
			// check if the e.logs contains the substring test
			e.logs.forEach((log: any) => {
				if (log.includes('the user passed to SwapBegin and End must match')) {
					failed = true;
				}
			});
		}
		assert(failed);
	});

	it('donate to revenue pool for a great feature!', async () => {
		const solSpotMarket = takerDriftClient.getSpotMarketAccount(1);

		const solRevPool = getTokenAmount(
			solSpotMarket.revenuePool.scaledBalance,
			solSpotMarket,
			SpotBalanceType.DEPOSIT
		);
		assert(solRevPool.eq(ZERO));

		const charity = new BN(1);
		await takerDriftClient.depositIntoSpotMarketRevenuePool(
			1,
			charity,
			takerWSOL
		);
		await takerDriftClient.fetchAccounts();
		const solSpotMarketAfter = takerDriftClient.getSpotMarketAccount(1);

		const solRevPoolAfter = getTokenAmount(
			solSpotMarketAfter.revenuePool.scaledBalance,
			solSpotMarketAfter,
			SpotBalanceType.DEPOSIT
		);
		assert(solRevPoolAfter.gt(solRevPool));
		assert(solRevPoolAfter.eq(charity));
	});
});
