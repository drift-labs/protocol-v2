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
} from '../packages/sdk/src';

import {
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import {
	NATIVE_MINT,
	TOKEN_PROGRAM_ID,
	createCloseAccountInstruction,
	createTransferInstruction,
} from '@solana/spl-token';
import { DexInstructions, Market, OpenOrders } from '@project-serum/serum';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../packages/sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../packages/sdk/src/bankrun/bankrunConnection';
import { VELOCITY_PROGRAM_ID } from '../packages/sdk/src';

describe('spot swap', () => {
	const chProgram = anchor.workspace.Velocity as Program;

	let makerVelocityClient: TestClient;
	let makerWSOL: PublicKey;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	let serumMarketPublicKey: PublicKey;

	let usdcMint;
	let makerUSDC;

	let takerVelocityClient: TestClient;
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
		oracleInfos = [{ publicKey: solOracle, source: OracleSource.PYTH_LAZER }];

		makerVelocityClient = new TestClient({
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

		await makerVelocityClient.initialize(usdcMint.publicKey, true);
		await makerVelocityClient.subscribe();
		await makerVelocityClient.initializeUserAccount();

		await initializeQuoteSpotMarket(makerVelocityClient, usdcMint.publicKey);
		await initializeSolSpotMarket(makerVelocityClient, solOracle);
		await makerVelocityClient.updateSpotMarketStepSizeAndTickSize(
			1,
			new BN(100000000),
			new BN(100)
		);
		await makerVelocityClient.updateSpotAuctionDuration(0);

		[takerVelocityClient, takerWSOL, takerUSDC, takerKeypair] =
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
						source: OracleSource.PYTH_LAZER,
					},
				],
				bulkAccountLoader
			);

		await bankrunContextWrapper.fundKeypair(
			takerKeypair,
			10 * LAMPORTS_PER_SOL
		);
		await takerVelocityClient.deposit(usdcAmount, 0, takerUSDC);
	});

	after(async () => {
		await takerVelocityClient.unsubscribe();
		await makerVelocityClient.unsubscribe();
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

		await makerVelocityClient.initializeSerumFulfillmentConfig(
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
			takerVelocityClient.wallet.publicKey,
			openOrdersAccount.publicKey,
			market.programId
		);
		await takerVelocityClient.sendTransaction(
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
			await makerVelocityClient.getSerumV3FulfillmentConfig(
				serumMarketPublicKey
			);
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
		const { beginSwapIx, endSwapIx } = await takerVelocityClient.getSwapIx({
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
				owner: takerVelocityClient.wallet,
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

		const serumConfig = await takerVelocityClient.getSerumV3FulfillmentConfig(
			market.publicKey
		);
		const settleFundsIx = DexInstructions.settleFunds({
			market: market.publicKey,
			openOrders: takerOpenOrders,
			owner: takerVelocityClient.wallet.publicKey,
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

		const { txSig } = await takerVelocityClient.sendTransaction(tx);

		bankrunContextWrapper.printTxLogs(txSig);
		// await printTxLogs(connection, txSig);

		const takerSOLAmount = await takerVelocityClient.getTokenAmount(1);
		assert(takerSOLAmount.eq(new BN(1000000000)));
		const takerUSDCAmount = await takerVelocityClient.getTokenAmount(0);
		assert(takerUSDCAmount.eq(new BN(99959999)));

		// const cumulativeSpotFees =
		// 	takerVelocityClient.getUserAccount().cumulativeSpotFees;
		// assert(cumulativeSpotFees.eq(new BN(-50000)));

		const userStatsPublicKey = getUserStatsAccountPublicKey(
			new PublicKey(VELOCITY_PROGRAM_ID),
			takerVelocityClient.wallet.publicKey
		);

		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			userStatsPublicKey
		);

		const userStatsAccount = accountInfo
			? (takerVelocityClient.program.account.user.coder.accounts.decodeUnchecked(
					'userStats',
					accountInfo.data
			  ) as UserStatsAccount)
			: undefined;

		await takerVelocityClient.fetchAccounts();
		const accountInfo2 = await bankrunContextWrapper.connection.getAccountInfo(
			userStatsPublicKey
		);
		const _userStatsAccount2 = accountInfo2
			? (takerVelocityClient.program.account.user.coder.accounts.decodeUnchecked(
					'userStats',
					accountInfo2.data
			  ) as UserStatsAccount)
			: undefined;

		await takerVelocityClient.fetchAccounts();

		const accountInfo3 = await bankrunContextWrapper.connection.getAccountInfo(
			userStatsPublicKey
		);
		const _userStatsAccount3 = accountInfo3
			? (takerVelocityClient.program.account.user.coder.accounts.decodeUnchecked(
					'userStats',
					accountInfo3.data
			  ) as UserStatsAccount)
			: undefined;

		assert(userStatsAccount.takerVolume30D.eq(new BN(0)));

		const swapRecord = eventSubscriber.getEventsArray('SwapRecord')[0];
		assert(swapRecord.amountOut.eq(new BN(1000000000)));
		assert(swapRecord.outMarketIndex === 1);
		assert(swapRecord.amountIn.eq(new BN(100040000)));
		assert(swapRecord.inMarketIndex === 0);
		// assert(swapRecord.fee.eq(new BN(500000)));
		assert(swapRecord.fee.eq(new BN(0)));

		const solSpotMarket = takerVelocityClient.getSpotMarketAccount(1);

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
		const { beginSwapIx, endSwapIx } = await takerVelocityClient.getSwapIx({
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
				owner: takerVelocityClient.wallet,
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

		const serumConfig = await takerVelocityClient.getSerumV3FulfillmentConfig(
			market.publicKey
		);
		const settleFundsIx = DexInstructions.settleFunds({
			market: market.publicKey,
			openOrders: takerOpenOrders,
			owner: takerVelocityClient.wallet.publicKey,
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

		const { txSig } = await takerVelocityClient.sendTransaction(tx);

		bankrunContextWrapper.printTxLogs(txSig);

		const takerSOLAmount = await takerVelocityClient.getTokenAmount(1);
		assert(takerSOLAmount.eq(new BN(0)));
		const takerUSDCAmount = await takerVelocityClient.getTokenAmount(0);
		console.log(takerUSDCAmount.toString());
		assert(takerUSDCAmount.eq(new BN(199919999)));

		// const cumulativeSpotFees =
		// 	takerVelocityClient.getUserAccount().cumulativeSpotFees;
		// assert(cumulativeSpotFees.eq(new BN(-99980)));

		// const userStatsAccount = await fetchUserStatsAccount(
		// 	connection,
		// 	takerVelocityClient.program,
		// 	takerVelocityClient.wallet.publicKey
		// );
		// assert(userStatsAccount.fees.totalFeePaid.eq(new BN(99980)));

		const swapRecord = eventSubscriber.getEventsArray('SwapRecord')[0];
		assert(swapRecord.amountOut.eq(new BN(99960000)));
		assert(swapRecord.outMarketIndex === 0);
		assert(swapRecord.amountIn.eq(new BN(1000000000)));
		assert(swapRecord.inMarketIndex === 1);
		// assert(swapRecord.fee.eq(new BN(0)));

		// const usdcSpotMarket = takerVelocityClient.getSpotMarketAccount(0);
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
		const { beginSwapIx, endSwapIx } = await takerVelocityClient.getSwapIx({
			amountIn,
			inMarketIndex: 0,
			outMarketIndex: 1,
			outTokenAccount: takerWSOL,
			inTokenAccount: takerUSDC,
		});

		let tx = new Transaction().add(beginSwapIx);

		let failed = false;
		try {
			await takerVelocityClient.sendTransaction(tx);
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
			const txO = await takerVelocityClient.sendTransaction(tx);
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
			await takerVelocityClient.sendTransaction(tx);
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
			await takerVelocityClient.sendTransaction(tx);
		} catch (e) {
			const err = e as Error;
			if (err.toString().includes('0x1868')) {
				failed = true;
			}
		}
		assert(failed);

		// Try making end swap be signed from different user
		const { endSwapIx: invalidEndSwapIx } = await makerVelocityClient.getSwapIx(
			{
				amountIn,
				inMarketIndex: 0,
				outMarketIndex: 1,
				outTokenAccount: takerWSOL,
				inTokenAccount: takerUSDC,
			}
		);

		tx = new Transaction().add(beginSwapIx).add(invalidEndSwapIx);

		failed = false;
		try {
			await takerVelocityClient.sendTransaction(tx, [
				// @ts-ignore
				makerVelocityClient.wallet.payer,
			]);
		} catch (e) {
			const err = e as Error;
			if (err.toString().includes('0x1868')) {
				failed = true;
			}
		}
		assert(failed);
	});

	it('close non-swap token account after end_swap fails', async () => {
		const amountIn = new BN(100).mul(QUOTE_PRECISION);
		const { beginSwapIx, endSwapIx } = await takerVelocityClient.getSwapIx({
			amountIn,
			inMarketIndex: 0,
			outMarketIndex: 1,
			outTokenAccount: takerWSOL,
			inTokenAccount: takerUSDC,
		});

		// Close instruction targeting a NON-swap token account
		const randomAccount = Keypair.generate().publicKey;
		const closeIx = createCloseAccountInstruction(
			randomAccount,
			takerVelocityClient.wallet.publicKey,
			takerVelocityClient.wallet.publicKey
		);

		const tx = new Transaction().add(beginSwapIx).add(endSwapIx).add(closeIx);

		let failed = false;
		try {
			await takerVelocityClient.sendTransaction(tx);
		} catch (e) {
			const err = e as Error;
			if (err.toString().includes('0x1868')) {
				failed = true;
			}
		}
		assert(failed);
	});

	it.skip('swap and close token account after end_swap', async () => {
		// takerUSDC has 0 balance - it can be closed after endSwap
		const amountIn = new BN(100).mul(QUOTE_PRECISION);
		const { beginSwapIx, endSwapIx } = await takerVelocityClient.getSwapIx({
			amountIn,
			inMarketIndex: 0,
			outMarketIndex: 1,
			inTokenAccount: takerUSDC,
			outTokenAccount: takerWSOL,
		});

		// Simulate swap: send all USDC to maker
		const transferIn = createTransferInstruction(
			takerUSDC,
			makerUSDC.publicKey,
			takerVelocityClient.wallet.publicKey,
			amountIn.toNumber()
		);

		// Simulate swap: receive SOL from maker
		const transferOut = createTransferInstruction(
			makerWSOL,
			takerWSOL,
			makerVelocityClient.wallet.publicKey,
			LAMPORTS_PER_SOL
		);

		// Close takerUSDC after endSwap (balance will be 0)
		const closeIx = createCloseAccountInstruction(
			takerUSDC,
			takerVelocityClient.wallet.publicKey,
			takerVelocityClient.wallet.publicKey,
			undefined,
			TOKEN_PROGRAM_ID
		);

		const tx = new Transaction()
			.add(beginSwapIx)
			.add(transferIn)
			.add(transferOut)
			.add(endSwapIx)
			.add(closeIx);

		const { txSig } = await takerVelocityClient.sendTransaction(tx, [
			// @ts-ignore
			makerVelocityClient.wallet.payer,
		]);

		bankrunContextWrapper.printTxLogs(txSig);

		// Verify the token account is actually closed
		const accountInfo = await bankrunContextWrapper.connection.getAccountInfo(
			takerUSDC
		);
		assert(accountInfo === null, 'takerUSDC should be closed');
	});

	it('donate to revenue pool for a great feature!', async () => {
		const solSpotMarket = takerVelocityClient.getSpotMarketAccount(1);

		const solRevPool = getTokenAmount(
			solSpotMarket.revenuePool.scaledBalance,
			solSpotMarket,
			SpotBalanceType.DEPOSIT
		);
		assert(solRevPool.eq(ZERO));

		const charity = new BN(1);
		await takerVelocityClient.depositIntoSpotMarketRevenuePool(
			1,
			charity,
			takerWSOL
		);
		await takerVelocityClient.fetchAccounts();
		const solSpotMarketAfter = takerVelocityClient.getSpotMarketAccount(1);

		const solRevPoolAfter = getTokenAmount(
			solSpotMarketAfter.revenuePool.scaledBalance,
			solSpotMarketAfter,
			SpotBalanceType.DEPOSIT
		);
		assert(solRevPoolAfter.gt(solRevPool));
		assert(solRevPoolAfter.eq(charity));
	});
});
