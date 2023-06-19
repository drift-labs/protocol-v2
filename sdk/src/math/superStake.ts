import {
	AddressLookupTableAccount,
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
}: {
	amount: BN;
	jupiterClient: JupiterClient;
	driftClient: DriftClient;
}): Promise<{
	ixs: TransactionInstruction[];
	lookupTables: AddressLookupTableAccount[];
	method: 'jupiter' | 'marinade';
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
		};
	} else {
		const { ixs, lookupTables } = await driftClient.getJupiterSwapIx({
			inMarketIndex: 1,
			outMarketIndex: 2,
			route: bestRoute,
			jupiterClient,
			amount,
		});
		return {
			method: 'jupiter',
			ixs,
			lookupTables,
		};
	}
}
