import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';

import { Program } from '@coral-xyz/anchor';

import {
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	Transaction,
} from '@solana/web3.js';

import {
	BN,
	TestClient,
	EventSubscriber,
	OracleSource,
	OracleInfo,
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
import {
	TOKEN_2022_PROGRAM_ID,
	TOKEN_PROGRAM_ID,
	createTransferInstruction,
} from '@solana/spl-token';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { DRIFT_PROGRAM_ID } from '../sdk/lib';

describe('spot swap 22', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let makerDriftClient: TestClient;
	let makerWSOL: PublicKey;
	let eventSubscriber: EventSubscriber;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

	let solOracle: PublicKey;

	let usdcMint;
	let makerUSDC;

	let takerDriftClient: TestClient;
	let takerWSOL: PublicKey;
	let takerUSDC: PublicKey;

	const usdcAmount = new BN(200 * 10 ** 6);
	const solAmount = new BN(2 * 10 ** 9);

	let marketIndexes: number[];
	let spotMarketIndexes: number[];
	let oracleInfos: OracleInfo[];

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

		usdcMint = await mockUSDCMint(bankrunContextWrapper, TOKEN_2022_PROGRAM_ID);
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

	it('swap usdc for sol', async () => {
		const amountIn = new BN(200).mul(QUOTE_PRECISION);
		const { beginSwapIx, endSwapIx } = await takerDriftClient.getSwapIx({
			amountIn: amountIn,
			inMarketIndex: 0,
			outMarketIndex: 1,
			inTokenAccount: takerUSDC,
			outTokenAccount: takerWSOL,
		});

		const transferIn = createTransferInstruction(
			takerUSDC,
			makerUSDC.publicKey,
			takerDriftClient.wallet.publicKey,
			new BN(100).mul(QUOTE_PRECISION).toNumber(),
			undefined,
			TOKEN_2022_PROGRAM_ID
		);

		const transferOut = createTransferInstruction(
			makerWSOL,
			takerWSOL,
			makerDriftClient.wallet.publicKey,
			LAMPORTS_PER_SOL,
			undefined,
			TOKEN_PROGRAM_ID
		);

		const tx = new Transaction()
			.add(beginSwapIx)
			.add(transferIn)
			.add(transferOut)
			.add(endSwapIx);

		// @ts-ignore
		const { txSig } = await takerDriftClient.sendTransaction(tx, [
			makerDriftClient.wallet.payer,
		]);

		bankrunContextWrapper.printTxLogs(txSig);

		const takerSOLAmount = await takerDriftClient.getTokenAmount(1);
		assert(takerSOLAmount.eq(new BN(1000000000)));
		const takerUSDCAmount = await takerDriftClient.getTokenAmount(0);
		assert(takerUSDCAmount.eq(new BN(99999999)));

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

		assert(userStatsAccount.takerVolume30D.eq(new BN(0)));

		const swapRecord = eventSubscriber.getEventsArray('SwapRecord')[0];
		assert(swapRecord.amountOut.eq(new BN(1000000000)));
		assert(swapRecord.outMarketIndex === 1);
		assert(swapRecord.amountIn.eq(new BN(100000000)));
		assert(swapRecord.inMarketIndex === 0);
		assert(swapRecord.fee.eq(new BN(0)));

		const solSpotMarket = takerDriftClient.getSpotMarketAccount(1);

		assert(solSpotMarket.totalSwapFee.eq(new BN(0)));
	});

	it('swap usdc for sol', async () => {
		const amountIn = new BN(1).mul(new BN(LAMPORTS_PER_SOL));
		const { beginSwapIx, endSwapIx } = await takerDriftClient.getSwapIx({
			amountIn: amountIn,
			inMarketIndex: 1,
			outMarketIndex: 0,
			inTokenAccount: takerWSOL,
			outTokenAccount: takerUSDC,
		});

		const transferIn = createTransferInstruction(
			takerWSOL,
			makerWSOL,
			takerDriftClient.wallet.publicKey,
			LAMPORTS_PER_SOL,
			undefined,
			TOKEN_PROGRAM_ID
		);

		const transferOut = createTransferInstruction(
			makerUSDC.publicKey,
			takerUSDC,
			makerDriftClient.wallet.publicKey,
			new BN(100).mul(QUOTE_PRECISION).toNumber(),
			undefined,
			TOKEN_2022_PROGRAM_ID
		);

		const tx = new Transaction()
			.add(beginSwapIx)
			.add(transferIn)
			.add(transferOut)
			.add(endSwapIx);

		// @ts-ignore
		const { txSig } = await takerDriftClient.sendTransaction(tx, [
			makerDriftClient.wallet.payer,
		]);

		bankrunContextWrapper.printTxLogs(txSig);

		const takerSOLAmount = await takerDriftClient.getTokenAmount(1);
		assert(takerSOLAmount.eq(new BN(0)));
		const takerUSDCAmount = await takerDriftClient.getTokenAmount(0);
		console.log(takerUSDCAmount.toString());
		assert(takerUSDCAmount.eq(new BN(199999999)));

		const swapRecord = eventSubscriber.getEventsArray('SwapRecord')[0];
		assert(swapRecord.amountOut.eq(new BN(100000000)));
		assert(swapRecord.outMarketIndex === 0);
		assert(swapRecord.amountIn.eq(new BN(1000000000)));
		assert(swapRecord.inMarketIndex === 1);
	});
});
