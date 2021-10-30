import * as anchor from '@project-serum/anchor';
import { Provider } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import { Admin } from '../sdk/';

import dotenv = require('dotenv');
dotenv.config();

async function depositToMarketFromInsuranceFund(provider: Provider) {
	const connection = provider.connection;
	const clearingHouseProgramId = new PublicKey(
		'dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN'
	);
	const clearingHouse = Admin.from(
		connection,
		provider.wallet,
		clearingHouseProgramId
	);
	await clearingHouse.subscribe();

	const amount = new anchor.BN(99999900);
	const market = new anchor.BN(0);
	const tx = await clearingHouse.withdrawFromInsuranceVaultToMarket(
		market,
		amount
	);

	console.log(tx);

	await clearingHouse.unsubscribe();
}

try {
	if (!process.env.ANCHOR_WALLET) {
		throw new Error('ANCHOR_WALLET must be set.');
	}
	depositToMarketFromInsuranceFund(
		anchor.Provider.local('https://drift.genesysgo.net')
	);
} catch (e) {
	console.error(e);
}
