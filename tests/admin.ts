import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { assert } from 'chai';
import { startAnchor } from "solana-bankrun";
import {
    BN,
    ExchangeStatus,
    OracleGuardRails,
    OracleSource,
    TestClient,
} from '../sdk/src';

import { decodeName, DEFAULT_MARKET_NAME } from '../sdk/src/userName';

import {
    initializeQuoteSpotMarket,
    mockOracleNoProgram,
    mockUSDCMint,
} from './testHelpers';
import { PublicKey } from '@solana/web3.js';
import { BankrunContextWrapper } from '../sdk/src/bankrunConnection';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';

describe('admin', () => {
    const chProgram = anchor.workspace.Drift as Program;

    let bulkAccountLoader: TestBulkAccountLoader;

    let driftClient: TestClient;

    let usdcMint;

    before(async () => {
        const context = await startAnchor("", [], []);

		const bankrunContextWrapper = new BankrunContextWrapper(context);
		
        bulkAccountLoader = new TestBulkAccountLoader(bankrunContextWrapper.connection, 'processed', 1);

        usdcMint = await mockUSDCMint(bankrunContextWrapper);

        driftClient = new TestClient({
            connection: bankrunContextWrapper.connection.toConnection(), // ugh.
            wallet: bankrunContextWrapper.provider.wallet,
            programID: chProgram.programId,
            opts: {
                commitment: 'confirmed',
            },
            activeSubAccountId: 0,
            perpMarketIndexes: [0],
            spotMarketIndexes: [0],
            subAccountIds: [],
            accountSubscription: {
                type: 'polling',
                accountLoader: bulkAccountLoader,
            },
        });

        await driftClient.initialize(usdcMint.publicKey, true);
        await driftClient.subscribe();
        await driftClient.initializeUserAccount(0);
        await driftClient.fetchAccounts();

        await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
        await driftClient.updatePerpAuctionDuration(new BN(0));
        await driftClient.fetchAccounts();

        const periodicity = new BN(60 * 60); // 1 HOUR

        const solUsd = await mockOracleNoProgram(bankrunContextWrapper, 1);
        await driftClient.initializePerpMarket(
            0,
            solUsd,
            new BN(1000),
            new BN(1000),
            periodicity
        );
    });

    it('checks market name', async () => {
        const market = driftClient.getPerpMarketAccount(0);
        const name = decodeName(market.name);
        assert(name == DEFAULT_MARKET_NAME);

        const newName = 'Glory t0 the DAmm';
        await driftClient.updatePerpMarketName(0, newName);

        await driftClient.fetchAccounts();
        const newMarket = driftClient.getPerpMarketAccount(0);
        assert(decodeName(newMarket.name) == newName, `market name does not match \n actual: ${decodeName(newMarket.name)} \n expected: ${newName}`);
    });

    it('Update lp cooldown time', async () => {
        await driftClient.updateLpCooldownTime(new BN(420));
        await driftClient.fetchAccounts();
        assert(driftClient.getStateAccount().lpCooldownTime.eq(new BN(420)), `lp cooldown time does not match \n actual: ${driftClient.getStateAccount().lpCooldownTime} \n expected: ${new BN(420)}`);
    });

    it('Update Amm Jit', async () => {
        await driftClient.fetchAccounts();
        assert(driftClient.getPerpMarketAccount(0).amm.ammJitIntensity == 0, `amm jit intensity does not match \n actual: ${driftClient.getPerpMarketAccount(0).amm.ammJitIntensity} \n expected: 0`);

        await driftClient.updateAmmJitIntensity(0, 100);
        await driftClient.fetchAccounts();
        assert(driftClient.getPerpMarketAccount(0).amm.ammJitIntensity == 100, `amm jit intensity does not match \n actual: ${driftClient.getPerpMarketAccount(0).amm.ammJitIntensity} \n expected: 100`);

        await driftClient.updateAmmJitIntensity(0, 50);
        await driftClient.fetchAccounts();
        assert(driftClient.getPerpMarketAccount(0).amm.ammJitIntensity == 50, `amm jit intensity does not match \n actual: ${driftClient.getPerpMarketAccount(0).amm.ammJitIntensity} \n expected: 50`);
    });

    it('Update Margin Ratio', async () => {
        const marginRatioInitial = 3000;
        const marginRatioMaintenance = 1000;

        await driftClient.updatePerpMarketMarginRatio(
            0,
            marginRatioInitial,
            marginRatioMaintenance
        );

        await driftClient.fetchAccounts();
        const market = driftClient.getPerpMarketAccount(0);

        assert(market.marginRatioInitial === marginRatioInitial, `margin ratio initial does not match \n actual: ${market.marginRatioInitial} \n expected: ${marginRatioInitial}`);
        assert(market.marginRatioMaintenance === marginRatioMaintenance, `margin ratio maintenance does not match \n actual: ${market.marginRatioMaintenance} \n expected: ${marginRatioMaintenance}`);
    });

    it('Update perp fee structure', async () => {
        const newFeeStructure = driftClient.getStateAccount().perpFeeStructure;
        newFeeStructure.flatFillerFee = new BN(0);

        await driftClient.updatePerpFeeStructure(newFeeStructure);

        await driftClient.fetchAccounts();
        const state = driftClient.getStateAccount();

        assert(
            JSON.stringify(newFeeStructure) === JSON.stringify(state.perpFeeStructure),
            `fee structure does not match \n actual: ${JSON.stringify(state.perpFeeStructure)} \n expected: ${JSON.stringify(newFeeStructure)}`
        );
    });

    it('Update spot fee structure', async () => {
        const newFeeStructure = driftClient.getStateAccount().spotFeeStructure;
        newFeeStructure.flatFillerFee = new BN(1);

        await driftClient.updateSpotFeeStructure(newFeeStructure);

        await driftClient.fetchAccounts();
        const state = driftClient.getStateAccount();

        assert(
            JSON.stringify(newFeeStructure) === JSON.stringify(state.spotFeeStructure),
            `fee structure does not match \n actual: ${JSON.stringify(state.spotFeeStructure)} \n expected: ${JSON.stringify(newFeeStructure)}`
        );
    });

    it('Update oracle guard rails', async () => {
        const oracleGuardRails: OracleGuardRails = {
            priceDivergence: {
                markOraclePercentDivergence: new BN(1000000),
                oracleTwap5MinPercentDivergence: new BN(1000000),
            },
            validity: {
                slotsBeforeStaleForAmm: new BN(1),
                slotsBeforeStaleForMargin: new BN(1),
                confidenceIntervalMaxSize: new BN(1),
                tooVolatileRatio: new BN(1),
            },
        };

        await driftClient.updateOracleGuardRails(oracleGuardRails);

        await driftClient.fetchAccounts();
        const state = driftClient.getStateAccount();

        assert(
            JSON.stringify(oracleGuardRails) ===
                JSON.stringify(state.oracleGuardRails),
            `oracle guard rails does not match \n actual: ${JSON.stringify(state.oracleGuardRails)} \n expected: ${JSON.stringify(oracleGuardRails)}`
        );
    });

    it('Update protocol mint', async () => {
        const mint = new PublicKey('2fvh6hkCYfpNqke9N48x6HcrW92uZVU3QSiXZX4A5L27');

        await driftClient.updateDiscountMint(mint);

        await driftClient.fetchAccounts();
        const state = driftClient.getStateAccount();

        assert(state.discountMint.equals(mint), `discount mint does not match \n actual: ${state.discountMint} \n expected: ${mint}`);
    });

    // it('Update max deposit', async () => {
    //  const maxDeposit = new BN(10);

    //  await driftClient.updateMaxDeposit(maxDeposit);

    //  await driftClient.fetchAccounts();
    //  const state = driftClient.getStateAccount();

    //  assert(state.maxDeposit.eq(maxDeposit));
    // });

    it('Update market oracle', async () => {
        const newOracle = PublicKey.default;
        const newOracleSource = OracleSource.QUOTE_ASSET;

        await driftClient.updatePerpMarketOracle(0, newOracle, newOracleSource);

        await driftClient.fetchAccounts();
        const market = driftClient.getPerpMarketAccount(0);
        assert(market.amm.oracle.equals(PublicKey.default), `oracle does not match \n actual: ${market.amm.oracle} \n expected: ${PublicKey.default}`);
        assert(
            JSON.stringify(market.amm.oracleSource) ===
                JSON.stringify(newOracleSource),
            `oracle source does not match \n actual: ${JSON.stringify(market.amm.oracleSource)} \n expected: ${JSON.stringify(newOracleSource)}`
        );
    });

    it('Update market base asset step size', async () => {
        const stepSize = new BN(2);
        const tickSize = new BN(2);

        await driftClient.updatePerpMarketStepSizeAndTickSize(
            0,
            stepSize,
            tickSize
        );

        await driftClient.fetchAccounts();
        const market = driftClient.getPerpMarketAccount(0);
        assert(market.amm.orderStepSize.eq(stepSize), `step size does not match \n actual: ${market.amm.orderStepSize} \n expected: ${stepSize}`);
        assert(market.amm.orderTickSize.eq(tickSize), `tick size does not match \n actual: ${market.amm.orderTickSize} \n expected: ${tickSize}`);
    });

    it('Pause liq', async () => {
        await driftClient.updateExchangeStatus(ExchangeStatus.LIQ_PAUSED);
        await driftClient.fetchAccounts();
        const state = driftClient.getStateAccount();
        assert(state.exchangeStatus === ExchangeStatus.LIQ_PAUSED, `exchange status does not match \n actual: ${state.exchangeStatus} \n expected: ${ExchangeStatus.LIQ_PAUSED}`);

        console.log('paused liq!');
        // unpause
        await driftClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
        await driftClient.fetchAccounts();
        const state2 = driftClient.getStateAccount();
        assert(state2.exchangeStatus === ExchangeStatus.ACTIVE, `exchange status does not match \n actual: ${state2.exchangeStatus} \n expected: ${ExchangeStatus.ACTIVE}`);
        console.log('unpaused liq!');
    });

    it('Pause amm', async () => {
        await driftClient.updateExchangeStatus(ExchangeStatus.AMM_PAUSED);
        await driftClient.fetchAccounts();
        const state = driftClient.getStateAccount();
        assert(state.exchangeStatus === ExchangeStatus.AMM_PAUSED, `exchange status does not match \n actual: ${state.exchangeStatus} \n expected: ${ExchangeStatus.AMM_PAUSED}`);

        console.log('paused amm!');
        // unpause
        await driftClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
        await driftClient.fetchAccounts();
        const state2 = driftClient.getStateAccount();
        assert(state2.exchangeStatus === ExchangeStatus.ACTIVE, `exchange status does not match \n actual: ${state2.exchangeStatus} \n expected: ${ExchangeStatus.ACTIVE}`);
        console.log('unpaused amm!');
    });

    it('Pause funding', async () => {
        await driftClient.updateExchangeStatus(ExchangeStatus.FUNDING_PAUSED);
        await driftClient.fetchAccounts();
        const state = driftClient.getStateAccount();
        assert(state.exchangeStatus === ExchangeStatus.FUNDING_PAUSED, `exchange status does not match \n actual: ${state.exchangeStatus} \n expected: ${ExchangeStatus.FUNDING_PAUSED}`);

        console.log('paused funding!');
        // unpause
        await driftClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
        await driftClient.fetchAccounts();
        const state2 = driftClient.getStateAccount();
        assert(state2.exchangeStatus === ExchangeStatus.ACTIVE, `exchange status does not match \n actual: ${state2.exchangeStatus} \n expected: ${ExchangeStatus.ACTIVE}`);
        console.log('unpaused funding!');
    });

    it('Pause deposts and withdraws', async () => {
        await driftClient.updateExchangeStatus(
            ExchangeStatus.DEPOSIT_PAUSED | ExchangeStatus.WITHDRAW_PAUSED
        );
        await driftClient.fetchAccounts();
        const state = driftClient.getStateAccount();
        assert(
            state.exchangeStatus ===
                (ExchangeStatus.DEPOSIT_PAUSED | ExchangeStatus.WITHDRAW_PAUSED),
            `exchange status does not match \n actual: ${state.exchangeStatus} \n expected: ${ExchangeStatus.DEPOSIT_PAUSED | ExchangeStatus.WITHDRAW_PAUSED}`
        );

        console.log('paused deposits and withdraw!');
        // unpause
        await driftClient.updateExchangeStatus(ExchangeStatus.ACTIVE);
        await driftClient.fetchAccounts();
        const state2 = driftClient.getStateAccount();
        assert(state2.exchangeStatus === ExchangeStatus.ACTIVE, `exchange status does not match \n actual: ${state2.exchangeStatus} \n expected: ${ExchangeStatus.ACTIVE}`);
        console.log('unpaused deposits and withdraws!');
    });

    it('Update admin', async () => {
        const newAdminKey = PublicKey.default;

        await driftClient.updateAdmin(newAdminKey);

        await driftClient.fetchAccounts();
        const state = driftClient.getStateAccount();

        assert(state.admin.equals(newAdminKey), `admin does not match \n actual: ${state.admin} \n expected: ${newAdminKey}`);
    });

 
});