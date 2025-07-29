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
	getSerumSignerPublicKey,
	QUOTE_PRECISION,
	unstakeSharesToAmount,
	getIfRebalanceConfigPublicKey,
	IfRebalanceConfigAccount,
	getTokenAmount,
	SpotBalanceType,
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
import { TestBulkAccountLoader } from '../sdk/src/accounts/bulkAccountLoader/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';

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
	let makerUSDC: Keypair;

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

		await makerDriftClient.depositIntoSpotMarketRevenuePool(
			0,
			usdcAmount,
			makerUSDC.publicKey
		);

		await makerDriftClient.fetchAccounts();

		console.log(await makerDriftClient.getSpotMarketAccount(0));

		await makerDriftClient.updateSpotMarketRevenueSettlePeriod(0, new BN(1));

		await makerDriftClient.updateSpotMarketIfFactor(0, new BN(0), new BN(1));

		await bankrunContextWrapper.moveTimeForward(2);

		await makerDriftClient.settleRevenueToInsuranceFund(0);

		const { sharesTokenAmount, protocolShares } =
			await getIfSharesAndVaultBalance(0);

		assert(sharesTokenAmount.eq(new BN(200000000)));
		assert(protocolShares.eq(new BN(200000000)));

		await makerDriftClient.initializeIfRebalanceConfig({
			inMarketIndex: 0,
			outMarketIndex: 1,
			totalInAmount: new BN(200000000),
			epochMaxInAmount: new BN(200000000),
			epochDuration: new BN(1000),
			maxSlippageBps: 100,
			swapMode: 0,
			status: 0,
		});

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
		await makerDriftClient.unsubscribe();
		await takerDriftClient.unsubscribe();
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

	const getIfSharesAndVaultBalance = async (marketIndex: number) => {
		const ifVaultBalance = (
			await bankrunContextWrapper.connection.getTokenAccount(
				makerDriftClient.getSpotMarketAccount(marketIndex).insuranceFund.vault
			)
		).amount;

		const protocolShares =
			makerDriftClient.getSpotMarketAccount(marketIndex).insuranceFund
				.totalShares;

		const sharesTokenAmount = unstakeSharesToAmount(
			new BN(protocolShares),
			new BN(protocolShares),
			new BN(ifVaultBalance.toString())
		);

		return { sharesTokenAmount, protocolShares };
	};

	it('swap usdc for sol', async () => {
		await makerDriftClient.updateAdmin(takerDriftClient.wallet.publicKey);

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

		const signerKeypairs = signers.map((signer) => {
			return Keypair.fromSecretKey(signer.secretKey);
		});

		await bankrunContextWrapper.sendTransaction(transaction, signerKeypairs);

		const amountIn = new BN(200).mul(QUOTE_PRECISION);
		const { beginSwapIx, endSwapIx } =
			await takerDriftClient.getInsuranceFundSwapIx({
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

		const {
			sharesTokenAmount: usdcSharesTokenAmount,
			protocolShares: usdcProtocolShares,
		} = await getIfSharesAndVaultBalance(0);
		assert(usdcSharesTokenAmount.eq(new BN(99960000))); // 200 - 100.4
		assert(usdcProtocolShares.eq(new BN(99960000)));

		const {
			sharesTokenAmount: solSharesTokenAmount,
			protocolShares: solProtocolShares,
		} = await getIfSharesAndVaultBalance(1);
		assert(solSharesTokenAmount.eq(new BN(1000000000)));
		assert(solProtocolShares.eq(new BN(1000000000)));

		const rebalanceConfigKey = await getIfRebalanceConfigPublicKey(
			makerDriftClient.program.programId,
			0,
			1
		);

		const rebalanceConfig =
			(await takerDriftClient.program.account.ifRebalanceConfig.fetch(
				rebalanceConfigKey
			)) as IfRebalanceConfigAccount;

		console.log(rebalanceConfig);
		assert(rebalanceConfig.totalInAmount.eq(new BN(200000000)));
		assert(rebalanceConfig.currentInAmount.eq(new BN(100040000)));
		assert(rebalanceConfig.currentOutAmount.eq(new BN(1000000000)));
		assert(rebalanceConfig.epochInAmount.eq(new BN(100040000)));

		const swapRecord = eventSubscriber.getEventsArray(
			'InsuranceFundSwapRecord'
		)[0];

		assert(swapRecord.inIfTotalSharesBefore.eq(new BN(200000000)));
		assert(swapRecord.outIfTotalSharesBefore.eq(new BN(0)));
		assert(swapRecord.inIfUserSharesBefore.eq(new BN(0)));
		assert(swapRecord.outIfUserSharesBefore.eq(new BN(0)));
		assert(swapRecord.inIfTotalSharesAfter.eq(new BN(99960000)));
		assert(swapRecord.outIfTotalSharesAfter.eq(new BN(1000000000)));
		assert(swapRecord.inIfUserSharesAfter.eq(new BN(0)));
		assert(swapRecord.outIfUserSharesAfter.eq(new BN(0)));
		assert(swapRecord.inAmount.eq(new BN(100040000)));
		assert(swapRecord.outAmount.eq(new BN(1000000000)));
		assert(swapRecord.outOraclePrice.eq(new BN(100000000)));
		assert(swapRecord.outOraclePriceTwap.eq(new BN(100000000)));
		assert(swapRecord.inVaultAmountBefore.eq(new BN(200000000)));
		assert(swapRecord.outVaultAmountBefore.eq(new BN(0)));
		assert(swapRecord.inFundVaultAmountAfter.eq(new BN(99960000)));
		assert(swapRecord.outFundVaultAmountAfter.eq(new BN(1000000000)));
		assert(swapRecord.inMarketIndex === 0);
		assert(swapRecord.outMarketIndex === 1);

		await takerDriftClient.transferProtocolIfSharesToRevenuePool(
			1,
			0,
			new BN(1000000000)
		);

		const transferRecord = eventSubscriber.getEventsArray(
			'TransferProtocolIfSharesToRevenuePoolRecord'
		)[0];

		assert(transferRecord.amount.eq(new BN(1000000000)));
		assert(transferRecord.shares.eq(new BN(1000000000)));
		assert(transferRecord.ifVaultAmountBefore.eq(new BN(1000000000)));
		assert(transferRecord.protocolSharesBefore.eq(new BN(1000000000)));

		const revenuePoolVaultAmount = (
			await bankrunContextWrapper.connection.getTokenAccount(
				makerDriftClient.getSpotMarketAccount(1).vault
			)
		).amount;

		assert(revenuePoolVaultAmount.toString() === '1000000000');

		const revenuePoolBalance = await takerDriftClient.getSpotMarketAccount(1)
			.revenuePool.scaledBalance;

		const revenuePoolTokenAmount = getTokenAmount(
			revenuePoolBalance,
			takerDriftClient.getSpotMarketAccount(1),
			SpotBalanceType.DEPOSIT
		);

		assert(revenuePoolTokenAmount.toString() === '1000000000');

		const rebalanceConfigAfter =
			(await takerDriftClient.program.account.ifRebalanceConfig.fetch(
				rebalanceConfigKey
			)) as IfRebalanceConfigAccount;

		assert(
			rebalanceConfigAfter.currentOutAmountTransferred.eq(new BN(1000000000))
		);
	});
});
