import * as anchor from '@coral-xyz/anchor';

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
	PERCENTAGE_PRECISION,
} from '../sdk/src';

import {
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracleNoProgram,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPriceNoProgram,
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
	let makerUSDC;

	let takerDriftClient: TestClient;
	let takerWSOL: PublicKey;
	let takerUSDC: PublicKey;
	let takerOpenOrders: PublicKey;

	const usdcAmount = new BN(200 * 10 ** 6).muln(10);
	const solAmount = new BN(10 * 10 ** 9).muln(10);

	const takerUsdcDepositAmount = new BN(10 ** 6).muln(200);
	const takerSolDepositAmount = new BN(10 ** 9).muln(2);
	const makerUsdcDepositAmount = new BN(10 ** 6).muln(200);
	const makerSolWithdrawAmount = new BN(10 ** 9).muln(1);

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

		const oracleGuardrails = await makerDriftClient.getStateAccount()
			.oracleGuardRails;
		oracleGuardrails.validity.tooVolatileRatio = new BN(10000);
		oracleGuardrails.priceDivergence.oracleTwap5MinPercentDivergence = new BN(
			100
		).mul(PERCENTAGE_PRECISION);

		await makerDriftClient.updateOracleGuardRails(oracleGuardrails);

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
		await takerDriftClient.deposit(takerUsdcDepositAmount, 0, takerUSDC);

		await takerDriftClient.deposit(takerSolDepositAmount, 1, takerWSOL);

		await makerDriftClient.deposit(
			makerUsdcDepositAmount,
			0,
			makerUSDC.publicKey
		);

		await makerDriftClient.withdraw(makerSolWithdrawAmount, 1, makerWSOL);

		await setFeedPriceNoProgram(bankrunContextWrapper, 200, solOracle);
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
				price: 199,
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

		const amountIn = makerUsdcDepositAmount;
		const { beginSwapIx, endSwapIx } =
			await takerDriftClient.getLiquidateSpotWithSwapIx({
				swapAmount: amountIn,
				assetMarketIndex: 0,
				liabilityMarketIndex: 1,
				assetTokenAccount: takerUSDC,
				liabilityTokenAccount: takerWSOL,
				userAccount: makerDriftClient.getUserAccount(),
				userAccountPublicKey: await makerDriftClient.getUserAccountPublicKey(),
				userStatsAccountPublicKey:
					makerDriftClient.getUserStatsAccountPublicKey(),
			});

		// @ts-ignore
		const serumBidIx = await market.makePlaceOrderInstruction(
			bankrunContextWrapper.connection.toConnection(),
			{
				// @ts-ignore
				owner: takerDriftClient.wallet,
				payer: takerUSDC,
				side: 'buy',
				price: 199,
				size: 1, // larger than maker orders so that entire maker order is taken
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

		await takerDriftClient.sendTransaction(tx);

		await makerDriftClient.fetchAccounts();

		console.log(
			'maker is being liquidated',
			makerDriftClient.getUser().isBeingLiquidated(),
			makerDriftClient.getUserAccount().status
		);
	});
});
