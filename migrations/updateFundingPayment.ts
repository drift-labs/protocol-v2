import { Program } from '@project-serum/anchor';
import * as anchor from '@project-serum/anchor';
import { ClearingHouse, Network, PythClient } from '../sdk';
import BN from 'bn.js';

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

	const marketsAccountData = clearingHouse.getMarketsAccount();
	const marketIndex = new BN(0);
	await clearingHouse.updateFundingRate(
		marketsAccountData.markets[marketIndex.toNumber()].amm.oracle,
		marketIndex
	);

	const pythClient = new PythClient(connection);
	const priceData = await pythClient.getPriceData(
		marketsAccountData.markets[0].amm.oracle
	);
	console.log(`Market ${marketIndex.toNumber()} price: ${priceData.price}`);

	console.log(`Updated funding payment for market 0`);
	await clearingHouse.unsubscribe();
}

main();
