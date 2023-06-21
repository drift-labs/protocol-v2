import {
	AddressLookupTableAccount,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import { JupiterClient } from '../jupiter/jupiterClient';
import { DriftClient } from '../driftClient';
import { getMarinadeFinanceProgram, getMarinadeMSolPrice } from '../marinade';
import { BN } from '@coral-xyz/anchor';

export async function findBestSuperStakeIxs({
	amount,
	jupiterClient,
	driftClient,
	userAccountPublicKey,
}: {
	amount: BN;
	jupiterClient: JupiterClient;
	driftClient: DriftClient;
	userAccountPublicKey?: PublicKey;
}): Promise<{
	ixs: TransactionInstruction[];
	lookupTables: AddressLookupTableAccount[];
	method: 'jupiter' | 'marinade';
	price: number;
}> {
	const marinadeProgram = getMarinadeFinanceProgram(driftClient.provider);
	const marinadePrice = await getMarinadeMSolPrice(marinadeProgram);

	const solMint = driftClient.getSpotMarketAccount(1).mint;
	const mSOLMint = driftClient.getSpotMarketAccount(2).mint;
	const jupiterRoutes = await jupiterClient.getRoutes({
		inputMint: solMint,
		outputMint: mSOLMint,
		amount,
	});

	const bestRoute = jupiterRoutes[0];
	const jupiterPrice = bestRoute.inAmount / bestRoute.outAmount;

	if (marinadePrice <= jupiterPrice) {
		const ixs = await driftClient.getStakeForMSOLIx({ amount });
		return {
			method: 'marinade',
			ixs,
			lookupTables: [],
			price: marinadePrice,
		};
	} else {
		const { ixs, lookupTables } = await driftClient.getJupiterSwapIx({
			inMarketIndex: 1,
			outMarketIndex: 2,
			route: bestRoute,
			jupiterClient,
			amount,
			userAccountPublicKey,
		});
		return {
			method: 'jupiter',
			ixs,
			lookupTables,
			price: jupiterPrice,
		};
	}
}
