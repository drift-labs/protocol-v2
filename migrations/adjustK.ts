import * as anchor from '@project-serum/anchor';
import { Provider } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import { ClearingHouse } from '../sdk/';

import dotenv = require('dotenv');
dotenv.config();

async function adjustK(provider: Provider) {
    const connection = provider.connection;
    const clearingHouseProgramId = new PublicKey("damm6x5ddj4JZKzpFN9y2jgtnHY3xryBUoQfjFuL5qo");
    const clearingHouse = new ClearingHouse(
        connection,
        provider.wallet,
        clearingHouseProgramId
    );
    await clearingHouse.subscribe();
    const marketIndex = new anchor.BN(0);
    let amm = clearingHouse.getMarketsAccount().markets[marketIndex.toNumber()].amm;
    console.log("sqrt k", amm.sqrtK.toString());

    const newSqrtK = amm.sqrtK.div(new anchor.BN(2));
    await clearingHouse.updateK(newSqrtK, marketIndex);

    // amm = clearingHouse.getMarketsAccount().markets[0].amm;
    // console.log("peg", amm.pegMultiplier.toString());
    // console.log("total fee", amm.totalFee.toString());
    // console.log("cumulative fee", amm.cumulativeFee.toString());

    await clearingHouse.unsubscribe();
}

try {
    if (!process.env.ANCHOR_WALLET) {
        throw new Error('ANCHOR_WALLET must be set.');
    }
    adjustK(
        anchor.Provider.local('https://drift.genesysgo.net')
    );
} catch (e) {
    console.error(e);
}