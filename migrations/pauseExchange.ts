import * as anchor from '@project-serum/anchor';
import { Provider } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import { ClearingHouse } from '../sdk/';

import dotenv = require('dotenv');
dotenv.config();

async function deployDevnet(provider: Provider) {
    const connection = provider.connection;
    const clearingHouseProgramId = new PublicKey("");
    const clearingHouse = new ClearingHouse(
        connection,
        provider.wallet,
        clearingHouseProgramId
    );
    await clearingHouse.subscribe();
    const pauseExchange = true;
    await clearingHouse.updateExchangePaused(pauseExchange);
    await clearingHouse.unsubscribe();
}

try {
    if (!process.env.ANCHOR_WALLET) {
        throw new Error('ANCHOR_WALLET must be set.');
    }
    deployDevnet(
        anchor.Provider.local('https://drift.genesysgo.net')
    );
} catch (e) {
    console.error(e);
}