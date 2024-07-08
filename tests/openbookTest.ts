import { assert } from 'chai';
import * as anchor from '@coral-xyz/anchor';

import { Program, Idl } from '@coral-xyz/anchor';

import { OracleSource, PublicKey, TestClient, User } from '../sdk/src';
import openbookIDL from '../sdk/src/idl/openbook.json';
import { startAnchor } from 'solana-bankrun';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { createOpenOrdersAccount, OPENBOOK, placeOrder } from './openbookHelpers';
import { initializeQuoteSpotMarket, initializeSolSpotMarket, mockOracleNoProgram, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import { createBidsAsksEventHeap, createMarket } from './openbookHelpers';
import { Keypair } from '@solana/web3.js';

describe('openbook v2', () => {
    const chProgram = anchor.workspace.Drift as Program;
    const openbookProgram = new Program(openbookIDL as Idl, OPENBOOK);

	let driftClient: TestClient;
	let driftClientUser: User;

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

    let marketAuthority: PublicKey;
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

        const solOracle = await mockOracleNoProgram(bankrunContextWrapper, 155, -3, 28988326);
        usdcMint = await mockUSDCMint(bankrunContextWrapper);
        wSolMint = await mockUSDCMint(bankrunContextWrapper);

        userUsdcAccount = await mockUserUSDCAccount(
            usdcMint,
            // @ts-ignore
            usdcAmount,
            bankrunContextWrapper
        );
        userWSolAccount = await mockUserUSDCAccount(
            wSolMint,
            // @ts-ignore
            solAmount,
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

        [marketAuthority, marketBaseVault, marketQuoteVault] = await createMarket(bankrunContextWrapper, openbookProgram, market, wSolMint.publicKey, usdcMint.publicKey, bids.publicKey, asks.publicKey, eventHeap.publicKey);

        [openOrdersIndexer, openOrdersAccount] = await createOpenOrdersAccount(bankrunContextWrapper, openbookProgram, market.publicKey);

        await driftClient.initialize(usdcMint.publicKey, true);
        await driftClient.subscribe();

        await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
        await initializeSolSpotMarket(driftClient, solOracle, wSolMint.publicKey);

        await driftClient.initializeUserAccountAndDepositCollateral(
            // @ts-ignore
            usdcAmount,
            userUsdcAccount.publicKey,
        );
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
    }); 

    after(async () => {
        await driftClient.unsubscribe();
    });

    it("add market", async () => {
        await driftClient.initializeOpenbookV2FulfillmentConfig(
            solSpotMarketIndex,
            market.publicKey,
        );
    });

    it("works", async () => {
    //     await placeOrder(
    //         bankrunContextWrapper,
    //         openbookProgram,

    //     )
    });
});