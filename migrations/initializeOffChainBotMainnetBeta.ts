import { Program, Wallet } from '@project-serum/anchor';
import * as anchor from '@project-serum/anchor';
import { ClearingHouse } from '../sdk';
import BN from 'bn.js';
import { Keypair } from '@solana/web3.js';

import dotenv = require('dotenv');
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	Token,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
dotenv.config();

async function main() {
	const endpoint = process.env.ENDPOINT;
	const provider = anchor.Provider.local(endpoint);
	const connection = provider.connection;

	const privateKey = '';
	const depositAmount = 10000000000000;
	const botWallet = new Wallet(
		Keypair.fromSecretKey(
			Uint8Array.from(privateKey.split(',').map((val) => Number(val)))
		)
	);
	console.log(`Bot Public Key: ${botWallet.publicKey.toString()}`);

	const chProgram = anchor.workspace.ClearingHouse as Program;
	const clearingHouse = ClearingHouse.from(
		connection,
		botWallet,
		chProgram.programId
	);
	await clearingHouse.subscribe();
	console.log(`Clearing House: ${chProgram.programId.toString()}`);
	const state = clearingHouse.getStateAccount();

	const associatedTokenPublicKey = await Token.getAssociatedTokenAddress(
		ASSOCIATED_TOKEN_PROGRAM_ID,
		TOKEN_PROGRAM_ID,
		state.collateralMint,
		botWallet.publicKey
	);

	console.log("Bot's associated key:", associatedTokenPublicKey.toString());

	console.log('Initializing Bot with clearing house');
	console.log('Depositing:', depositAmount);
	await clearingHouse.initializeUserAccountAndDepositCollateral(
		new BN(depositAmount),
		associatedTokenPublicKey
	);
	console.log('Initialized Bot for devnet');

	await clearingHouse.unsubscribe();
}

main();
