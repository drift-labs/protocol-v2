import * as anchor from '@project-serum/anchor';
import BN from 'bn.js';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {AMM_MANTISSA, ClearingHouse, MAX_LEVERAGE, PositionDirection} from '../sdk/src';


import {
    mockOracle,
    mockUSDCMint,
    mockUserUSDCAccount,
} from '../utils/mockAccounts';
import {setFeedPrice} from "../utils/mockPythUtils";

describe('max positions', () => {
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

    const maxPositions = 5;

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

        for (let i  = 0; i < maxPositions; i++) {
            const oracle = await mockOracle(1);
            const periodicity = new BN(0);

            await clearingHouse.initializeMarket(
                new BN(i),
                oracle,
                ammInitialBaseAssetReserve,
                ammInitialQuoteAssetReserve,
                periodicity
            );
        }

        [, userAccountPublicKey] =
            await clearingHouse.initializeUserAccountAndDepositCollateral(
                usdcAmount,
                userUSDCAccount.publicKey
            );
    });

    after(async () => {
        await clearingHouse.unsubscribe();
    });

    it('open max positions', async () => {
        const usdcPerPosition = usdcAmount.mul(new BN(5)).div(new BN(maxPositions)).mul(new BN(99)).div(new BN(100));
        for (let i  = 0; i < maxPositions; i++) {
            await clearingHouse.openPosition(
                userAccountPublicKey,
                PositionDirection.LONG,
                usdcPerPosition,
                new BN(i),
                new BN(0),
            );
        }
    });

    it('partial liquidate', async () => {
        const markets = clearingHouse.getMarketsAccount();
        for (let i  = 0; i < maxPositions; i++) {
            const oracle = markets.markets[i].amm.oracle;
            await setFeedPrice(anchor.workspace.Pyth, 0.9, oracle);
            await clearingHouse.updateFundingRate(
                oracle,
                new BN(i)
            );
            await clearingHouse.moveAmmPrice(
                ammInitialBaseAssetReserve.mul(new BN(118)),
                ammInitialQuoteAssetReserve.mul(new BN(100)),
                new BN(i)
            );
        }

        await clearingHouse.liquidate(
            userAccountPublicKey
        );
    });

    it('liquidate', async () => {
        const markets = clearingHouse.getMarketsAccount();
        for (let i  = 0; i < maxPositions; i++) {
            const oracle = markets.markets[i].amm.oracle;
            await setFeedPrice(anchor.workspace.Pyth, 0.5, oracle);
            await clearingHouse.moveAmmPrice(
                ammInitialBaseAssetReserve.mul(new BN(2)),
                ammInitialQuoteAssetReserve,
                new BN(i)
            );
        }

        await clearingHouse.liquidate(
            userAccountPublicKey
        );
    });
});
