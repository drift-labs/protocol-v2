import * as anchor from '@project-serum/anchor';
import { Provider } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import { Admin } from '../sdk/';

import dotenv = require('dotenv');
dotenv.config();

async function main(provider: Provider) {
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

	console.log(clearingHouse.getStateAccount().discountMint.toString());

	// const newDiscountMint = new PublicKey("EGfR6MbHk3P5kksmWjZG8sxY3GNnK7TBvCLYXEoNvB7G");
	// await clearingHouse.updateDiscountMint(newDiscountMint);

	await clearingHouse.unsubscribe();
}

try {
	if (!process.env.ANCHOR_WALLET) {
		throw new Error('ANCHOR_WALLET must be set.');
	}
	main(anchor.Provider.local('https://drift.genesysgo.net'));
} catch (e) {
	console.error(e);
}
