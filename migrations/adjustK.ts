import * as anchor from '@project-serum/anchor';
import { Provider } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import { Admin } from '../sdk/';

import dotenv = require('dotenv');
dotenv.config();

async function adjustK(provider: Provider) {
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
	const marketIndex = new anchor.BN(0);
	const amm =
		clearingHouse.getMarketsAccount().markets[marketIndex.toNumber()].amm;
	console.log('sqrt k', amm.sqrtK.toString());

	const newSqrtK = amm.sqrtK.mul(new anchor.BN(132)).div(new anchor.BN(100));
	await clearingHouse.updateK(newSqrtK, marketIndex);

	// amm = clearingHouse.getMarketsAccount().markets[0].amm;
	// console.log("peg", amm.pegMultiplier.toString());
	// console.log("total fee", amm.totalFee.toString());
	// console.log("cumulative fee", amm.cumulativeFee.toString());

	await clearingHouse.unsubscribe();
}

try {
	if (!process.env.ANCHOR_WALLET) {
		throw new Error('ANCHOR_WALLET must be set.');
	}
	adjustK(anchor.Provider.local('https://drift.genesysgo.net'));
} catch (e) {
	console.error(e);
}
