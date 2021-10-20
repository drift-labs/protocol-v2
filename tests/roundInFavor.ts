import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import {Program, Wallet} from '@project-serum/anchor';

import {Keypair} from '@solana/web3.js';

import {ClearingHouse, PositionDirection} from '../sdk/src';

import Markets from '../sdk/src/constants/markets';

import {
    mockOracle,
    mockUSDCMint, mockUserUSDCAccount,
} from '../utils/mockAccounts';
import { FeeStructure } from '../sdk';

describe('round in favor', () => {
    const provider = anchor.Provider.local();
    const connection = provider.connection;
    anchor.setProvider(provider);
    const chProgram = anchor.workspace.ClearingHouse as Program;

    let usdcMint;

    let primaryClearingHouse: ClearingHouse;

    // ammInvariant == k == x * y
    const ammInitialQuoteAssetReserve = new anchor.BN(17 * 10 ** 13);
    const ammInitialBaseAssetReserve = new anchor.BN(17 * 10 ** 13);

    const usdcAmount = new BN(9999 * 10 ** 3);

    before(async () => {
        usdcMint = await mockUSDCMint(provider);

        primaryClearingHouse = new ClearingHouse(
            connection,
            provider.wallet,
            chProgram.programId
        );
        await primaryClearingHouse.initialize(usdcMint.publicKey, true);
        await primaryClearingHouse.subscribe();

        const solUsd = await mockOracle(63000);
        const periodicity = new BN(60 * 60); // 1 HOUR

        await primaryClearingHouse.initializeMarket(
            Markets[0].marketIndex,
            solUsd,
            ammInitialBaseAssetReserve,
            ammInitialQuoteAssetReserve,
            periodicity,
            new BN(63000000)
        );

        const newFeeStructure: FeeStructure = {
            feeNumerator: new BN(0),
            feeDenominator: new BN(1),
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
            },
            referralRebate: {
                referrerRewardNumerator: new BN(1),
                referrerRewardDenominator: new BN(1),
                refereeRebateNumerator: new BN(1),
                refereeRebateDenominator: new BN(1),
            },
        };

        await primaryClearingHouse.updateFee(newFeeStructure);
    });

    after(async () => {
        await primaryClearingHouse.unsubscribe();
    });

    it('short', async () => {
        const keypair = new Keypair();
        await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
        const wallet = new Wallet(keypair);
        const userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider, keypair.publicKey);
        const clearingHouse = new ClearingHouse(
            connection,
            wallet,
            chProgram.programId
        );
        await clearingHouse.subscribe();
        const [, userAccountPublicKey] =
            await clearingHouse.initializeUserAccountAndDepositCollateral(
                usdcAmount,
                userUSDCAccount.publicKey
            );

        const marketIndex = new BN(0);
        await clearingHouse.openPosition(
            userAccountPublicKey,
            PositionDirection.SHORT,
            usdcAmount.mul(new BN(5)),
            marketIndex,
            new BN(0),
        );

        let user: any = await primaryClearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );
        assert(user.collateral.eq(new BN(9999000)));

        await clearingHouse.closePosition(
            userAccountPublicKey,
            marketIndex,
        );

        user = await primaryClearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );

        assert(user.collateral.eq(new BN(9972000)));
    });

    it('long', async () => {
        const keypair = new Keypair();
        await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
        const wallet = new Wallet(keypair);
        const userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider, keypair.publicKey);
        const clearingHouse = new ClearingHouse(
            connection,
            wallet,
            chProgram.programId
        );
        await clearingHouse.subscribe();

        const [, userAccountPublicKey] =
            await clearingHouse.initializeUserAccountAndDepositCollateral(
                usdcAmount,
                userUSDCAccount.publicKey
            );

        const marketIndex = new BN(0);
        await clearingHouse.openPosition(
            userAccountPublicKey,
            PositionDirection.LONG,
            usdcAmount.mul(new BN(5)),
            marketIndex,
            new BN(0),
        );

        let user: any = await primaryClearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );
        assert(user.collateral.eq(new BN(9999000)));

        await clearingHouse.closePosition(
            userAccountPublicKey,
            marketIndex,
        );

        user = await primaryClearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );

        assert(user.collateral.eq(new BN(9963000)));
    });
});
