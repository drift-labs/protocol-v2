import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	Account,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	Transaction,
} from '@solana/web3.js';
import { listMarket, makePlaceOrderTransaction, SERUM } from './serumHelper';

import {
	BN,
	TestClient,
	EventSubscriber,
	OracleSource,
	OracleInfo,
	getTokenAmount,
	SpotBalanceType,
	ZERO,
	getSerumSignerPublicKey,
	QUOTE_PRECISION,
	UserStatsAccount,
	getUserStatsAccountPublicKey,
} from '../sdk/src';

import {
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { NATIVE_MINT } from '@solana/spl-token';
import { DexInstructions, Market, OpenOrders } from '@project-serum/serum';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';
import { DRIFT_PROGRAM_ID } from '../sdk/lib';

describe('spot swap', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let makerDriftClient: TestClient;
	let makerWSOL: PublicKey;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

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

	let openOrdersAccount: PublicKey;

	let takerKeypair: Keypair;

	before(async () => {
		const context = await startAnchor(
			'',
			[
				{
					name: 'serum_dex',
					programId: new PublicKey(
						'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'
					),
				},
			],
			[]
		);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		eventSubscriber = new EventSubscriber(
			bankrunContextWrapper.connection.toConnection(),
			chProgram
		);

		await eventSubscriber.subscribe();

		usdcMint = await mockUSDCMint(bankrunContextWrapper);
		makerUSDC = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			bankrunContextWrapper
		);
		makerWSOL = await createWSolTokenAccountForUser(
			bankrunContextWrapper,
			// @ts-ignore
			bankrunContextWrapper.provider.wallet,
			solAmount
		);

		solOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);

		marketIndexes = [];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH }];

		makerDriftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			subAccountIds: [],
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

		[takerDriftClient, takerWSOL, takerUSDC, takerKeypair] =
			await createUserWithUSDCAndWSOLAccount(
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
						source: OracleSource.PYTH,
					},
				],
				bulkAccountLoader
			);

		await bankrunContextWrapper.fundKeypair(
			takerKeypair,
			10 * LAMPORTS_PER_SOL
		);
		await takerDriftClient.deposit(usdcAmount, 0, takerUSDC);
	});

	after(async () => {
		await takerDriftClient.unsubscribe();
		await makerDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Add Serum Market', async () => {
		serumMarketPublicKey = await listMarket({
			context: bankrunContextWrapper,
			wallet: bankrunContextWrapper.provider.wallet,
			baseMint: NATIVE_MINT,
			quoteMint: usdcMint.publicKey,
			baseLotSize: 100000000,
			quoteLotSize: 100,
			dexProgramId: SERUM,
			feeRateBps: 0,
		});

		console.log('\n\n\n\n\n here \n\n\n\n\n');

		await Market.load(
			bankrunContextWrapper.connection.toConnection(),
			serumMarketPublicKey,
			{ commitment: 'confirmed' },
			SERUM
		);

		console.log('\n\n\n\n\n here \n\n\n\n\n');

		await makerDriftClient.initializeSerumFulfillmentConfig(
			solSpotMarketIndex,
			serumMarketPublicKey,
			SERUM
		);

		console.log('\n\n\n\n\n here \n\n\n\n\n');

		const market = await Market.load(
			bankrunContextWrapper.connection.toConnection(),
			serumMarketPublicKey,
			{ commitment: 'recent' },
			SERUM
		);

		console.log('\n\n\n\n\n here \n\n\n\n\n');

		const openOrdersAccount = new Account();
		const createOpenOrdersIx = await OpenOrders.makeCreateAccountTransaction(
			bankrunContextWrapper.connection.toConnection(),
			market.address,
			takerDriftClient.wallet.publicKey,
			openOrdersAccount.publicKey,
			market.programId
		);
		await takerDriftClient.sendTransaction(
			new Transaction().add(createOpenOrdersIx),
			[openOrdersAccount]
		);

		console.log('\n\n\n\n\n here \n\n\n\n\n');

		takerOpenOrders = openOrdersAccount.publicKey;
	});

	const crankMarkets = async () => {
		const openOrdersAccounts = [];

		const market = await Market.load(
			bankrunContextWrapper.connection.toConnection(),
			serumMarketPublicKey,
			{ commitment: 'processed' },
			SERUM
		);

		openOrdersAccounts.push(openOrdersAccount);

		const serumFulfillmentConfigAccount =
			await makerDriftClient.getSerumV3FulfillmentConfig(serumMarketPublicKey);
		openOrdersAccounts.push(serumFulfillmentConfigAccount.serumOpenOrders);

		const consumeEventsIx = await market.makeConsumeEventsInstruction(
			openOrdersAccounts,
			10
		);

		const consumeEventsTx = new Transaction().add(consumeEventsIx);
		await bankrunContextWrapper.sendTransaction(consumeEventsTx);
		// await provider.sendAndConfirm(consumeEventsTx, []);

		// Open orders need to be sorted correctly but not sure how to do it in js, so will run this
		// ix sorted in both direction
		const consumeEventsIx2 = await market.makeConsumeEventsInstruction(
			openOrdersAccounts.reverse(),
			10
		);

		const consumeEventsTx2 = new Transaction().add(consumeEventsIx2);
		await bankrunContextWrapper.sendTransaction(consumeEventsTx2);
		// await provider.sendAndConfirm(consumeEventsTx2, []);
	};

	it('swap usdc for sol', async () => {
		const market = await Market.load(
			bankrunContextWrapper.connection.toConnection(),
			serumMarketPublicKey,
			{ commitment: 'recent' },
			SERUM
		);

		// place ask to sell 1 sol for 100 usdc
		// @ts-ignore
		const { transaction, signers } = await makePlaceOrderTransaction(
			bankrunContextWrapper.connection.toConnection(),
			market,
			{
				// @ts-ignore
				owner: bankrunContextWrapper.provider.wallet,
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

		openOrdersAccount = signers[0].publicKey;

		const signerKeypairs = signers.map((signer) => {
			return Keypair.fromSecretKey(signer.secretKey);
		});

		await bankrunContextWrapper.sendTransaction(transaction, signerKeypairs);

		const amountIn = new BN(200).mul(QUOTE_PRECISION);
		const { beginSwapIx, endSwapIx } = await takerDriftClient.getSwapIx({
			amountIn: amountIn,
			inMarketIndex: 0,
			outMarketIndex: 1,
			inTokenAccount: takerUSDC,
			outTokenAccount: takerWSOL,
		});

		// @ts-ignore
		const serumBidIx = await market.makePlaceOrderInstruction(
			bankrunContextWrapper.connection.toConnection(),
			{
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
			}
		);

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

		bankrunContextWrapper.printTxLogs(txSig);
		// await printTxLogs(connection, txSig);

		const takerSOLAmount = await takerDriftClient.getTokenAmount(1);
		assert(takerSOLAmount.eq(new BN(1000000000)));
		const takerUSDCAmount = await takerDriftClient.getTokenAmount(0);
		assert(takerUSDCAmount.eq(new BN(99959999)));

		// const cumulativeSpotFees =
		// 	takerDriftClient.getUserAccount().cumulativeSpotFees;
		// assert(cumulativeSpotFees.eq(new BN(-50000)));

		const userStatsPublicKey = getUserStatsAccountPublicKey(
			new PublicKey(DRIFT_PROGRAM_ID),
			takerDriftClient.wallet.publicKey
		);

		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			userStatsPublicKey
		);

		const userStatsAccount = accountInfo
			? (takerDriftClient.program.account.user.coder.accounts.decodeUnchecked(
					'UserStats',
					accountInfo.data
			  ) as UserStatsAccount)
			: undefined;

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
			bankrunContextWrapper.connection.toConnection(),
			serumMarketPublicKey,
			{ commitment: 'recent' },
			SERUM
		);

		// place ask to sell 1 sol for 100 usdc
		// @ts-ignore
		const { transaction, signers } = await makePlaceOrderTransaction(
			bankrunContextWrapper.connection.toConnection(),
			market,
			{
				// @ts-ignore
				owner: bankrunContextWrapper.provider.wallet,
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

		const signerKeypairs = signers.map((signer) => {
			return Keypair.fromSecretKey(signer.secretKey);
		});

		await bankrunContextWrapper.sendTransaction(transaction, signerKeypairs);

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
		const serumAskIx = await market.makePlaceOrderInstruction(
			bankrunContextWrapper.connection.toConnection(),
			{
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
			}
		);

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

		bankrunContextWrapper.printTxLogs(txSig);

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
			const err = e as Error;
			if (err.toString().includes('0x1868')) {
				failed = true;
			}
		}
		assert(failed);

		tx = new Transaction().add(endSwapIx);

		failed = false;
		try {
			const txO = await takerDriftClient.sendTransaction(tx);
			const txL = await bankrunContextWrapper.connection.getTransaction(
				txO.txSig,
				{
					commitment: 'confirmed',
				}
			);
			console.log('tx logs', txL.meta.logMessages);
		} catch (e) {
			const err = e as Error;
			if (err.toString().includes('0x1868')) {
				failed = true;
			}
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
			const err = e as Error;
			if (err.toString().includes('0x1868')) {
				failed = true;
			}
		}
		assert(failed);

		tx = new Transaction().add(beginSwapIx).add(beginSwapIx).add(endSwapIx);

		failed = false;
		try {
			await takerDriftClient.sendTransaction(tx);
		} catch (e) {
			const err = e as Error;
			if (err.toString().includes('0x1868')) {
				failed = true;
			}
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
			const err = e as Error;
			if (err.toString().includes('0x1868')) {
				failed = true;
			}
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
