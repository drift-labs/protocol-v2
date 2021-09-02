import { Program } from '@project-serum/anchor';
import * as anchor from '@project-serum/anchor';
import { ClearingHouse, Network, UserAccount } from '../sdk';

import dotenv = require('dotenv');
dotenv.config();

async function main() {
	const endpoint = process.env.ENDPOINT;
	const provider = anchor.Provider.local(endpoint);
	const connection = provider.connection;
	console.log('Endpoint:', endpoint);

	const chProgram = anchor.workspace.ClearingHouse as Program;
	const clearingHouse = new ClearingHouse(
		connection,
		Network.LOCAL,
		provider.wallet,
		chProgram.programId
	);
	await clearingHouse.subscribe();
	console.log(`Clearing House: ${chProgram.programId.toString()}`);

	const userAccount = new UserAccount(clearingHouse, provider.wallet.publicKey);
	await userAccount.subscribe();

	await clearingHouse.settleFundingPayment(
		await userAccount.getPublicKey(),
		userAccount.userAccountData.positions
	);

	await clearingHouse.unsubscribe();
	await userAccount.unsubscribe();
}

main();
