import { Wallet } from '@project-serum/anchor';
import * as anchor from '@project-serum/anchor';
import { ClearingHouse } from '../sdk';
import BN from 'bn.js';
import {Keypair, PublicKey} from '@solana/web3.js';

import dotenv = require('dotenv');
import {ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID} from "@solana/spl-token";
dotenv.config();

async function main() {
    const provider = anchor.Provider.local("https://drift.genesysgo.net");
    const connection = provider.connection;

    const privateKey = "";
    const depositAmount = 3000000000;
    const botWallet = new Wallet(
        Keypair.fromSecretKey(
            Uint8Array.from(
                privateKey.split(',').map((val) =>
                    Number(val)
                )
            )
        )
    );
    console.log(`Bot Public Key: ${botWallet.publicKey.toString()}`);

    const clearingHousePk = new PublicKey("damm6x5ddj4JZKzpFN9y2jgtnHY3xryBUoQfjFuL5qo");
    const clearingHouse = new ClearingHouse(
        connection,
        botWallet,
        clearingHousePk
    );
    await clearingHouse.subscribe();
    const state = clearingHouse.getState();

    const associatedTokenPublicKey = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        state.collateralMint,
        botWallet.publicKey
    );

    console.log("Bot's associated key:", associatedTokenPublicKey.toString());

    const userPublicKey = (await clearingHouse.getUserAccountPublicKey())[0];
    await clearingHouse.depositCollateral(
        userPublicKey,
        new BN(depositAmount),
        associatedTokenPublicKey
    );

    await clearingHouse.unsubscribe();
}

main();