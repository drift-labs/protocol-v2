import * as anchor from '@project-serum/anchor';
import { Provider } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import { ClearingHouse } from '../sdk/';

import dotenv = require('dotenv');
dotenv.config();

async function scratch(provider: Provider) {
    const connection = provider.connection;
    const clearingHouseProgramId = new PublicKey("dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN");
    const clearingHouse = new ClearingHouse(
        connection,
        provider.wallet,
        clearingHouseProgramId
    );
    await clearingHouse.subscribe();
    const curveHistory = clearingHouse.getCurveHistory();
    console.log(curveHistory);
    for (let i = 1; i < 7; i++) {
        console.log(curveHistory.curveRecords[i].
    }

    await clearingHouse.unsubscribe();
}

try {
    if (!process.env.ANCHOR_WALLET) {
        throw new Error('ANCHOR_WALLET must be set.');
    }
    scratch(
        anchor.Provider.local('https://drift.genesysgo.net')
    );
} catch (e) {
    console.error(e);
}