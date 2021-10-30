import { Program } from '@project-serum/anchor';
import * as anchor from '@project-serum/anchor';
import { ClearingHouse, ClearingHouseUser } from '../sdk';

import dotenv = require('dotenv');
dotenv.config();

async function main() {
	const endpoint = process.env.ENDPOINT;
	const provider = anchor.Provider.local(endpoint);
	const connection = provider.connection;
	console.log('Endpoint:', endpoint);

	const chProgram = anchor.workspace.ClearingHouse as Program;
	const clearingHouse = ClearingHouse.from(
		connection,
		provider.wallet,
		chProgram.programId
	);
	await clearingHouse.subscribe();
	console.log(`Clearing House: ${chProgram.programId.toString()}`);

	const userAccount = ClearingHouseUser.from(
		clearingHouse,
		provider.wallet.publicKey
	);
	await userAccount.subscribe();

	await clearingHouse.settleFundingPayment(
		await userAccount.getUserAccountPublicKey(),
		userAccount.getUserAccount().positions
	);

	await clearingHouse.unsubscribe();
	await userAccount.unsubscribe();
}

main();
