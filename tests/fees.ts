import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import { AMM_MANTISSA, ClearingHouse, PositionDirection } from '../sdk/src';

import Markets from '../sdk/src/constants/markets';

import {
    mockOracle,
    mockUSDCMint,
    mockUserUSDCAccount,
} from '../utils/mockAccounts';
import {AccountInfo, Token, TOKEN_PROGRAM_ID} from "@solana/spl-token";

describe('fees', () => {
    const provider = anchor.Provider.local();
    const connection = provider.connection;
    anchor.setProvider(provider);
    const chProgram = anchor.workspace.ClearingHouse as Program;

    let clearingHouse: ClearingHouse;

    let userAccountPublicKey: PublicKey;

    let usdcMint;
    let userUSDCAccount;

    // ammInvariant == k == x * y
    const mantissaSqrtScale = new BN(Math.sqrt(AMM_MANTISSA.toNumber()));
    const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
        mantissaSqrtScale
    );
    const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
        mantissaSqrtScale
    );

    const usdcAmount = new BN(10 * 10 ** 6);

    let driftMint: Token;
    let driftTokenAccount: AccountInfo;

    before(async () => {
        usdcMint = await mockUSDCMint(provider);
        userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

        clearingHouse = new ClearingHouse(
            connection,
            provider.wallet,
            chProgram.programId
        );
        await clearingHouse.initialize(usdcMint.publicKey, true);
        await clearingHouse.subscribe();

        const solUsd = await mockOracle(1);
        const periodicity = new BN(60 * 60); // 1 HOUR

        await clearingHouse.initializeMarket(
            Markets[0].marketIndex,
            solUsd,
            ammInitialBaseAssetReserve,
            ammInitialQuoteAssetReserve,
            periodicity
        );

        [, userAccountPublicKey] =
            await clearingHouse.initializeUserAccountAndDepositCollateral(
                usdcAmount,
                userUSDCAccount.publicKey
            );

        driftMint = await Token.createMint(
            connection,
            // @ts-ignore
            provider.wallet.payer,
            provider.wallet.publicKey,
            provider.wallet.publicKey,
            6,
            TOKEN_PROGRAM_ID
        );

        await clearingHouse.updateDriftMint(driftMint.publicKey);

        driftTokenAccount =
            await driftMint.getOrCreateAssociatedAccountInfo(
                provider.wallet.publicKey
            );
    });

    after(async () => {
        await clearingHouse.unsubscribe();
    });

    it('Trade no rebate', async () => {
        const marketIndex = new BN(0);
        await clearingHouse.openPosition(
            userAccountPublicKey,
            PositionDirection.LONG,
            usdcAmount,
            marketIndex,
            new BN(0),
            driftTokenAccount.address
        );

        const user: any = await clearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );

        assert(user.collateral.eq(new BN(9999500)));
        assert(user.totalFeePaid.eq(new BN(500)));
    });

    it('Trade fourth tier rebate', async () => {
        await driftMint.mintTo(
            driftTokenAccount.address,
            // @ts-ignore
            provider.wallet.payer,
            [],
            1000 * 10**6
        );

        const marketIndex = new BN(0);
        await clearingHouse.openPosition(
            userAccountPublicKey,
            PositionDirection.LONG,
            usdcAmount,
            marketIndex,
            new BN(0),
            driftTokenAccount.address
        );

        const user: any = await clearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );

        assert(user.collateral.eq(new BN(9999025)));
        assert(user.totalFeePaid.eq(new BN(975)));
    });

    it('Trade third tier rebate', async () => {
        await driftMint.mintTo(
            driftTokenAccount.address,
            // @ts-ignore
            provider.wallet.payer,
            [],
            10000 * 10**6
        );

        const marketIndex = new BN(0);
        await clearingHouse.openPosition(
            userAccountPublicKey,
            PositionDirection.LONG,
            usdcAmount,
            marketIndex,
            new BN(0),
            driftTokenAccount.address
        );

        const user: any = await clearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );

        assert(user.collateral.eq(new BN(9998575)));
        assert(user.totalFeePaid.eq(new BN(1425)));
    });

    it('Trade second tier rebate', async () => {
        await driftMint.mintTo(
            driftTokenAccount.address,
            // @ts-ignore
            provider.wallet.payer,
            [],
            100000 * 10**6
        );

        const marketIndex = new BN(0);
        await clearingHouse.openPosition(
            userAccountPublicKey,
            PositionDirection.LONG,
            usdcAmount,
            marketIndex,
            new BN(0),
            driftTokenAccount.address
        );

        const user: any = await clearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );

        assert(user.collateral.eq(new BN(9998150)));
        assert(user.totalFeePaid.eq(new BN(1850)));
    });

    it('Trade first tier rebate', async () => {
        await driftMint.mintTo(
            driftTokenAccount.address,
            // @ts-ignore
            provider.wallet.payer,
            [],
            1000000 * 10**6
        );

        const marketIndex = new BN(0);
        await clearingHouse.openPosition(
            userAccountPublicKey,
            PositionDirection.LONG,
            usdcAmount,
            marketIndex,
            new BN(0),
            driftTokenAccount.address
        );

        const user: any = await clearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );

        assert(user.collateral.eq(new BN(9997750)));
        assert(user.totalFeePaid.eq(new BN(2250)));
    });
});
