import { Program } from '@project-serum/anchor';
import * as anchor from '@project-serum/anchor';
import { MockUSDCFaucet } from '../sdk/src';
import { ClearingHouse, PositionDirection } from '../sdk';
import BN from 'bn.js';

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

	const mockUsdcFaucetProgram = anchor.workspace.MockUsdcFaucet as Program;
	const mockUsdcFaucet = new MockUSDCFaucet(
		connection,
		provider.wallet,
		mockUsdcFaucetProgram.programId
	);
	console.log(
		`Mock USDC Faucet: ${mockUsdcFaucetProgram.programId.toString()}`
	);

	console.log('Initializing User Account for devnet');
	await clearingHouse.initializeUserAccountForDevnet(
		mockUsdcFaucet,
		new BN(10 ** 10)
	);
	console.log('Initialized User Account for devnet');

	console.log('Opening positions');
	await clearingHouse.openPosition(
		PositionDirection.LONG,
		new BN(10 ** 6),
		new BN(0)
	);
	console.log('Position Opened');

	await clearingHouse.unsubscribe();
}

main();
