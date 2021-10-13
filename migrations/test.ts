import * as anchor from '@project-serum/anchor';
import { Program, Provider } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { ClearingHouse, PythClient } from '../sdk/';
import { AMM_MANTISSA, PEG_SCALAR } from '../sdk/src';

import dotenv = require('dotenv');
dotenv.config();
async function deployDevnet(provider: Provider) {
    const connection = provider.connection;
    const rentForOneByte = await connection.getMinimumBalanceForRentExemption(1);
    console.log(rentForOneByte);
    // const clearingHouse = new ClearingHouse(
    //     connection,
    //     provider.wallet,
    //     new PublicKey("Ctz1am97xu4xsZkRJAEJ6B4Dc1yopDnDpVLcUWq2ZZTp")
    // );
    //
    // await clearingHouse.subscribe();
    //
    // // const userAccountPublicKey = await clearingHouse.initializeUserAccount();
    // const pubKey = (await clearingHouse.getUserAccountPublicKey())[0];
    // console.log(pubKey.toString());
    //
    // console.log("clearing house state", (await clearingHouse.getStatePublicKey()).toString());
    //
    // await clearingHouse.unsubscribe();
}

try {
    if (!process.env.ANCHOR_WALLET) {
        throw new Error('ANCHOR_WALLET must be set.');
    }
    deployDevnet(
        anchor.Provider.local('https://psytrbhymqlkfrhudd.dev.genesysgo.net:8899/')
    );
} catch (e) {
    console.error(e);
}
