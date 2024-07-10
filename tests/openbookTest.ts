import { expect } from 'chai';
import * as anchor from '@coral-xyz/anchor';

import { Program, Idl } from '@coral-xyz/anchor';

import { OracleSource, OrderType, PositionDirection, PublicKey, TestClient } from '../sdk/src';
import openbookIDL from '../sdk/src/idl/openbook.json';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { createOpenOrdersAccount, OPENBOOK, OrderType as ObOrderType, placeOrder, SelfTradeBehavior, Side } from './openbookHelpers';
import { initializeQuoteSpotMarket, initializeSolSpotMarket, mockOracleNoProgram, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import { createBidsAsksEventHeap, createMarket } from './openbookHelpers';
import { Keypair } from '@solana/web3.js';

describe('openbook v2', () => {
    const chProgram = anchor.workspace.Drift as Program;
    const openbookProgram = new Program(openbookIDL as Idl, OPENBOOK);

	let driftClient: TestClient;

    let fillerDriftClient: TestClient;
    const fillerKeypair = Keypair.generate();

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;

    const solSpotMarketIndex = 1;

    const bids = Keypair.generate();
    const asks = Keypair.generate();
    const eventHeap = Keypair.generate();
    const market = Keypair.generate();
    let usdcMint: Keypair;
    let wSolMint: Keypair;

    const usdcAmount = new anchor.BN(1_000 * 10 ** 6);
    const solAmount = new anchor.BN(1_000 * 10 ** 9);

    let userUsdcAccount: Keypair;
    let userWSolAccount: Keypair;

    let _marketAuthority: PublicKey;
    let marketBaseVault: PublicKey;
    let marketQuoteVault: PublicKey;

    let openOrdersAccount: PublicKey;
    let openOrdersIndexer: PublicKey;

    before(async () => {
        const context = await startAnchor('', [
            {
                name: "openbook",
                programId: OPENBOOK,
            }
        ], []);

		bankrunContextWrapper = new BankrunContextWrapper(context);

		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

        const solOracle = await mockOracleNoProgram(bankrunContextWrapper, 100);
        usdcMint = await mockUSDCMint(bankrunContextWrapper);
        wSolMint = await mockUSDCMint(bankrunContextWrapper);

        userUsdcAccount = await mockUserUSDCAccount(
            usdcMint,
            // @ts-ignore
            usdcAmount.muln(2),
            bankrunContextWrapper
        );
        userWSolAccount = await mockUserUSDCAccount(
            wSolMint,
            // @ts-ignore
            solAmount.muln(2),
            bankrunContextWrapper
        );
        
        driftClient = new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

        await createBidsAsksEventHeap(bankrunContextWrapper, bids, asks, eventHeap);

        [_marketAuthority, marketBaseVault, marketQuoteVault] = await createMarket(bankrunContextWrapper, openbookProgram, market, wSolMint.publicKey, usdcMint.publicKey, bids.publicKey, asks.publicKey, eventHeap.publicKey);

        [openOrdersIndexer, openOrdersAccount] = await createOpenOrdersAccount(bankrunContextWrapper, openbookProgram, market.publicKey);

        await driftClient.initialize(usdcMint.publicKey, true);
        await driftClient.subscribe();

        await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
        await initializeSolSpotMarket(driftClient, solOracle, wSolMint.publicKey);

        await driftClient.updateSpotMarketOrdersEnabled(0, true);
        await driftClient.updateSpotMarketOrdersEnabled(1, true);

        await driftClient.initializeUserAccountAndDepositCollateral(
            // @ts-ignore
            usdcAmount,
            userUsdcAccount.publicKey,
        );

        await driftClient.addUser(0);
        // @ts-ignore
        await driftClient.deposit(solAmount, 1, userWSolAccount.publicKey);

        fillerDriftClient =  new TestClient({
			connection: bankrunContextWrapper.connection.toConnection(),
			wallet: new anchor.Wallet(fillerKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			subAccountIds: [],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: true,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

        await fillerDriftClient.subscribe();

        await bankrunContextWrapper.fundKeypair(fillerKeypair, 10 * 10 ** 9);

        await fillerDriftClient.initializeUserAccount();

        await fillerDriftClient.addUser(0);

    }); 

    after(async () => {
        await driftClient.unsubscribe();
        await fillerDriftClient.unsubscribe();
    });

    it("add market", async () => {
        await driftClient.initializeOpenbookV2FulfillmentConfig(
            solSpotMarketIndex,
            market.publicKey,
        );
        const userAccountAfter = driftClient.getUserAccount();

        const quoteSpotPosition = userAccountAfter.spotPositions.filter(position => position.marketIndex == 0)[0];
        const baseSpotPosition = userAccountAfter.spotPositions.filter(position => position.marketIndex == 1)[0];

        console.log(`quoteSpotPosition.scaledBalance: ${quoteSpotPosition.scaledBalance}`);
        console.log(`baseSpotPosition.scaledBalance: ${baseSpotPosition.scaledBalance}`);
    });

    it("fill long", async () => {
        await placeOrder(
            bankrunContextWrapper,
            openbookProgram,
            openOrdersAccount,
            openOrdersIndexer,
            market.publicKey,
            bids.publicKey,
            asks.publicKey,
            eventHeap.publicKey,
            marketBaseVault,
            userWSolAccount.publicKey,
            {
                side: Side.ASK,
                priceLots: new anchor.BN(100),
                maxBaseLots: new anchor.BN(1_000_000),
                maxQuoteLotsIncludingFees: new anchor.BN(100_040_000),
                clientOrderId: new anchor.BN(0),
                orderType: ObOrderType.LIMIT,
                expiryTimestamp: new anchor.BN(0),
                selfTradeBehavior: SelfTradeBehavior.DECREMENT_TAKE,
                limit: new anchor.BN(10)
            }
        );

        await driftClient.placeSpotOrder({
            orderType: OrderType.MARKET,
            marketIndex: 1,
            // @ts-ignore
            baseAssetAmount: driftClient.convertToSpotPrecision(1, 0.1),
            direction: PositionDirection.LONG,
        });

        const fulfillmentConfig = await driftClient.getOpenbookV2FulfillmentConfig(market.publicKey);

        const userAccount = driftClient.getUserAccount();
        const order = userAccount.orders.filter(order => order.marketIndex == 1)[0];
        await fillerDriftClient.fillSpotOrder(
            await driftClient.getUserAccountPublicKey(),
            driftClient.getUserAccount(),
            order,
            fulfillmentConfig
        );

        await driftClient.fetchAccounts();

        const userAccountAfter = driftClient.getUserAccount();

        const quoteSpotPosition = userAccountAfter.spotPositions.filter(position => position.marketIndex == 0)[0];
        const baseSpotPosition = userAccountAfter.spotPositions.filter(position => position.marketIndex == 1)[0];

        console.log(`quoteSpotPosition.scaledBalance: ${quoteSpotPosition.scaledBalance}`);
        console.log(`baseSpotPosition.scaledBalance: ${baseSpotPosition.scaledBalance}`);

        // expect(quoteSpotPosition.scaledBalance).to.be.approximately(usdcAmount.toNumber() - (100 * 10 ** 6), usdcAmount.toNumber() * 0.025);
        // expect(baseSpotPosition.scaledBalance).to.be.approximately(solAmount.toNumber() + (1 * 10 ** 9), solAmount.toNumber() * 0.025);
    });

    it("fill short", async () => {
        await placeOrder(
            bankrunContextWrapper,
            openbookProgram,
            openOrdersAccount,
            openOrdersIndexer,
            market.publicKey,
            bids.publicKey,
            asks.publicKey,
            eventHeap.publicKey,
            marketQuoteVault,
            userUsdcAccount.publicKey,
            {
                side: Side.BID,
                priceLots: new anchor.BN(100),
                maxBaseLots: new anchor.BN(1_00_000),
                maxQuoteLotsIncludingFees: new anchor.BN(10_040_000),
                clientOrderId: new anchor.BN(0),
                orderType: ObOrderType.LIMIT,
                expiryTimestamp: new anchor.BN(0),
                selfTradeBehavior: SelfTradeBehavior.DECREMENT_TAKE,
                limit: new anchor.BN(10)
            }
        );

        await driftClient.placeSpotOrder({
            orderType: OrderType.MARKET,
            marketIndex: 1,
            // @ts-ignore
            baseAssetAmount: driftClient.convertToSpotPrecision(1, 0.1),
            direction: PositionDirection.SHORT,
        });

        const fulfillmentConfig = await driftClient.getOpenbookV2FulfillmentConfig(market.publicKey);

        const userAccount = driftClient.getUserAccount();
        const order = userAccount.orders.filter(order => order.marketIndex == 1)[0];
        await fillerDriftClient.fillSpotOrder(
            await driftClient.getUserAccountPublicKey(),
            driftClient.getUserAccount(),
            order,
            fulfillmentConfig
        );

        await driftClient.fetchAccounts();

        const userAccountAfter = driftClient.getUserAccount();

        const quoteSpotPosition = userAccountAfter.spotPositions.filter(position => position.marketIndex == 0)[0];
        const baseSpotPosition = userAccountAfter.spotPositions.filter(position => position.marketIndex == 1)[0];

        console.log(`quoteSpotPosition.scaledBalance: ${quoteSpotPosition.scaledBalance}`);
        console.log(`baseSpotPosition.scaledBalance: ${baseSpotPosition.scaledBalance}`);

        // expect(quoteSpotPosition.scaledBalance.toNumber()).to.be.approximately(usdcAmount.toNumber(), usdcAmount.toNumber() * 0.025);
        // expect(baseSpotPosition.scaledBalance.toNumber()).to.be.approximately(solAmount.toNumber(), solAmount.toNumber() * 0.025);
    }); 
});
