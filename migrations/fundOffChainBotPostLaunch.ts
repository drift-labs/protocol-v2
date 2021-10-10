import { Wallet } from '@project-serum/anchor';
import BN from 'bn.js';
import { ClearingHouse } from '../sdk';
import { MockUSDCFaucet } from '../sdk/src';

import dotenv = require('dotenv');
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
dotenv.config();

async function main() {
	const endpoint = process.env.ENDPOINT;
	const connection = new Connection(endpoint);

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
	// await connection.getBalance(botWallet.publicKey);

	const chProgram = null; // anchor.workspace.ClearingHouse as Program;
	// const chProgram = process.env.CLEARING_HOUSE_PROGRAM_ID;
	let chProgramId;
	if (!chProgram) {
		chProgramId = new PublicKey(process.env.CLEARING_HOUSE_PROGRAM_ID);
	} else {
		chProgramId = chProgram.programId;
	}

	const clearingHouse = new ClearingHouse(connection, botWallet, chProgramId);
	await clearingHouse.subscribe();
	console.log(`Clearing House: ${chProgramId.toString()}`);

	const mockUsdcFaucetProgram = null; //anchor.workspace.MockUsdcFaucet as Program;
	let mockUsdcFaucetProgramId;
	if (!chProgram) {
		mockUsdcFaucetProgramId = new PublicKey(
			process.env.MOCK_USDC_FAUCET_ADDRESS
		);
	} else {
		mockUsdcFaucetProgramId = mockUsdcFaucetProgram.programId;
	}

	const mockUsdcFaucet = new MockUSDCFaucet(
		connection,
		botWallet,
		mockUsdcFaucetProgramId
	);
	console.log(`Mock USDC Faucet: ${mockUsdcFaucetProgramId.toString()}`);

	const associatedTokenPublicKey =
		await mockUsdcFaucet.getAssosciatedMockUSDMintAddress({
			userPubKey: botWallet.publicKey,
		});
	console.log("Bot's associated key:", associatedTokenPublicKey.toString());

	const botClearingHousePublicKey = (
		await clearingHouse.getUserAccountPublicKey(botWallet.publicKey)
	)[0];

	const mintAmount = new BN('1000000000000000000');
	console.log(`Minting to bot ${mintAmount.toString()} USDC`);
	await mockUsdcFaucet.mintToUser(associatedTokenPublicKey, mintAmount);

	console.log("Depositing bot's USDC with ClearingHouse");
	await clearingHouse.depositCollateral(
		botClearingHousePublicKey,
		mintAmount,
		associatedTokenPublicKey
	);
	console.log("Deposited bot's USDC with ClearingHouse");
	await clearingHouse.unsubscribe();
}

main();
