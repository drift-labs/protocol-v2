import { Program, Wallet } from '@project-serum/anchor';
import * as anchor from '@project-serum/anchor';
import { MockUSDCFaucet } from '../sdk/src';
import { ClearingHouse, Network } from '../sdk';
import BN from 'bn.js';
import { Keypair } from '@solana/web3.js';

import dotenv = require('dotenv');
dotenv.config();

async function main() {
	const endpoint = process.env.ENDPOINT;
	const provider = anchor.Provider.local(endpoint);
	const connection = provider.connection;

	const botWallet = new Wallet(
		Keypair.fromSecretKey(
			Uint8Array.from(
				process.env.OFF_CHAIN_BOT_PRIVATE_KEY.split(',').map((val) =>
					Number(val)
				)
			)
		)
	);
	console.log(`Bot Public Key: ${botWallet.publicKey.toString()}`);

	console.log('Requesting airdrop to bot');
	//await connection.getBalance(botWallet.publicKey);

	const chProgram = anchor.workspace.ClearingHouse as Program;
	const clearingHouse = new ClearingHouse(
		connection,
		Network.LOCAL,
		botWallet,
		chProgram.programId
	);
	await clearingHouse.subscribe();
	console.log(`Clearing House: ${chProgram.programId.toString()}`);

	const mockUsdcFaucetProgram = anchor.workspace.MockUsdcFaucet as Program;
	const mockUsdcFaucet = new MockUSDCFaucet(
		connection,
		Network.LOCAL,
		botWallet,
		mockUsdcFaucetProgram.programId
	);
	console.log(
		`Mock USDC Faucet: ${mockUsdcFaucetProgram.programId.toString()}`
	);

	const associatedTokenPublicKey =
		await mockUsdcFaucet.getAssosciatedMockUSDMintAddress({
			userPubKey: botWallet.publicKey,
		});
	console.log("Bot's associated key:", associatedTokenPublicKey.toString());

	console.log('Initializing Bot for devnet');
	await clearingHouse.initializeUserAccountForDevnet(
		mockUsdcFaucet,
		new BN(10 ** 13) // $10M
	);
	console.log('Initialized Bot for devnet');

	await clearingHouse.unsubscribe();
}

main();
