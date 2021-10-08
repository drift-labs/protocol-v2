import * as anchor from '@project-serum/anchor';
import {Program} from '@project-serum/anchor';
import BN from 'bn.js';
import { assert } from 'chai';

import {
    ClearingHouse, FeeStructure,
} from '../sdk/src';

import {
    mockUSDCMint,
} from '../utils/mockAccounts';
import {PublicKey} from "@solana/web3.js";

describe('admin', () => {
    const provider = anchor.Provider.local();
    const connection = provider.connection;
    anchor.setProvider(provider);
    const chProgram = anchor.workspace.ClearingHouse as Program;

    let clearingHouse: ClearingHouse;

    let usdcMint;

    before(async () => {
        usdcMint = await mockUSDCMint(provider);

        clearingHouse = new ClearingHouse(
            connection,
            provider.wallet,
            chProgram.programId
        );

        await clearingHouse.initialize(
            usdcMint.publicKey,
            false
        );
        await clearingHouse.subscribe();
    });

    it('Update Margin Ratio', async () => {
        const marginRatioInitial = new BN (1);
        const marginRatioPartial = new BN (1);
        const marginRatioMaintenance = new BN (1);

        await clearingHouse.updateMarginRatio(marginRatioInitial, marginRatioPartial, marginRatioMaintenance);

        const state = clearingHouse.getState();

        assert(state.marginRatioInitial.eq(marginRatioInitial));
        assert(state.marginRatioPartial.eq(marginRatioPartial));
        assert(state.marginRatioMaintenance.eq(marginRatioMaintenance));
    });

    it('Update Partial Liquidation Close Percentages', async () => {
        const numerator = new BN (1);
        const denominator = new BN (10);

        await clearingHouse.updatePartialLiquidationClosePercentage(numerator, denominator);

        const state = clearingHouse.getState();

        assert(state.partialLiquidationClosePercentageNumerator.eq(numerator));
        assert(state.partialLiquidationClosePercentageDenominator.eq(denominator));
    });

    it('Update Partial Liquidation Penalty Percentages', async () => {
        const numerator = new BN (1);
        const denominator = new BN (10);

        await clearingHouse.updatePartialLiquidationPenaltyPercentage(numerator, denominator);

        const state = clearingHouse.getState();

        assert(state.partialLiquidationPenaltyPercentageNumerator.eq(numerator));
        assert(state.partialLiquidationPenaltyPercentageDenominator.eq(denominator));
    });

    it('Update Full Liquidation Penalty Percentages', async () => {
        const numerator = new BN (1);
        const denominator = new BN (10);

        await clearingHouse.updateFullLiquidationPenaltyPercentage(numerator, denominator);

        const state = clearingHouse.getState();

        assert(state.fullLiquidationPenaltyPercentageNumerator.eq(numerator));
        assert(state.fullLiquidationPenaltyPercentageDenominator.eq(denominator));
    });

    it('Update Partial Liquidation Share Denominator', async () => {
        const denominator = new BN (10);

        await clearingHouse.updatePartialLiquidationShareDenominator(denominator);

        const state = clearingHouse.getState();

        assert(state.partialLiquidationLiquidatorShareDenominator.eq(denominator));
    });

    it('Update Full Liquidation Share Denominator', async () => {
        const denominator = new BN (10);

        await clearingHouse.updateFullLiquidationShareDenominator(denominator);

        const state = clearingHouse.getState();

        assert(state.fullLiquidationLiquidatorShareDenominator.eq(denominator));
    });

    it('Update fee', async () => {
        const newFeeStructure : FeeStructure = {
            feeNumerator: new BN(10),
            feeDenominator: new BN(10),
            driftTokenRebate: {
                firstTier: {
                    minimumBalance: new BN(1),
                    rebateNumerator: new BN(1),
                    rebateDenominator: new BN(1),
                },
                secondTier: {
                    minimumBalance: new BN(1),
                    rebateNumerator: new BN(1),
                    rebateDenominator: new BN(1),
                },
                thirdTier: {
                    minimumBalance: new BN(1),
                    rebateNumerator: new BN(1),
                    rebateDenominator: new BN(1),
                },
                fourthTier: {
                    minimumBalance: new BN(1),
                    rebateNumerator: new BN(1),
                    rebateDenominator: new BN(1),
                },
            }
        };

        await clearingHouse.updateFee(newFeeStructure);

        const state = clearingHouse.getState();

        assert(JSON.stringify(newFeeStructure) === JSON.stringify(state.feeStructure));
    });

    it('Update protocol mint', async () => {
        const mint = new PublicKey("2fvh6hkCYfpNqke9N48x6HcrW92uZVU3QSiXZX4A5L27");

        await clearingHouse.updateDriftMint(mint);

        const state = clearingHouse.getState();

        assert(state.driftMint.equals(mint));
    });

    it('Update admin', async () => {
        const admin = PublicKey.default;

        await clearingHouse.updateAdmin(admin);

        const state = clearingHouse.getState();

        assert(state.admin.equals(admin));
    });

    after(async () => {
        await clearingHouse.unsubscribe();
    });


});