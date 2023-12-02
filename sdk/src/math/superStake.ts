import {
	AddressLookupTableAccount,
	LAMPORTS_PER_SOL,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import { JupiterClient } from '../jupiter/jupiterClient';
import { DriftClient } from '../driftClient';
import { getMarinadeFinanceProgram, getMarinadeMSolPrice } from '../marinade';
import { BN } from '@coral-xyz/anchor';
import { User } from '../user';
import { DepositRecord, isVariant } from '../types';
import { LAMPORTS_PRECISION, ZERO } from '../constants/numericConstants';
import fetch from 'node-fetch';
import { checkSameDate } from './utils';

export type BSOL_STATS_API_RESPONSE = {
	success: boolean;
	stats?: {
		conversion: {
			bsol_to_sol: number;
			sol_to_bsol: number;
		},
		apy: {
			base: number;
			blze: number;
			total: number;
			lending: number;
			liquidity: number;
		}
	}
};

export type BSOL_EMISSIONS_API_RESPONSE = {
	success: boolean;
	emissions?: {
		lend: number;
	}
};

export async function fetchBSolMetrics() {
	return await fetch('https://stake.solblaze.org/api/v1/stats');
}

export async function fetchBSolDriftEmissions() {
	return await fetch('https://stake.solblaze.org/api/v1/drift_emissions');
}

export async function findBestSuperStakeIxs({
	marketIndex,
	amount,
	jupiterClient,
	driftClient,
	userAccountPublicKey,
	price,
	forceMarinade,
	onlyDirectRoutes,
}: {
	marketIndex: number;
	amount: BN;
	jupiterClient: JupiterClient;
	driftClient: DriftClient;
	price?: number;
	userAccountPublicKey?: PublicKey;
	forceMarinade?: boolean;
	onlyDirectRoutes?: boolean;
}): Promise<{
	ixs: TransactionInstruction[];
	lookupTables: AddressLookupTableAccount[];
	method: 'jupiter' | 'marinade';
	price: number;
}> {
	if (marketIndex === 2) {
		return findBestMSolSuperStakeIxs({
			amount,
			jupiterClient,
			driftClient,
			userAccountPublicKey,
			price,
			forceMarinade,
			onlyDirectRoutes,
		});
	} else if (marketIndex === 6) {
		return findBestJitoSolSuperStakeIxs({
			amount,
			jupiterClient,
			driftClient,
			userAccountPublicKey,
			onlyDirectRoutes,
		});
	} else if (marketIndex === 8) {
		return findBestLstSuperStakeIxs({
			amount,
			lstMint: driftClient.getSpotMarketAccount(8).mint,
			jupiterClient,
			driftClient,
			userAccountPublicKey,
			onlyDirectRoutes,
		});
	} else {
		throw new Error(`Unsupported superstake market index: ${marketIndex}`);
	}
}

export async function findBestMSolSuperStakeIxs({
	amount,
	jupiterClient,
	driftClient,
	userAccountPublicKey,
	price,
	forceMarinade,
	onlyDirectRoutes,
}: {
	amount: BN;
	jupiterClient: JupiterClient;
	driftClient: DriftClient;
	price?: number;
	userAccountPublicKey?: PublicKey;
	forceMarinade?: boolean;
	onlyDirectRoutes?: boolean;
}): Promise<{
	ixs: TransactionInstruction[];
	lookupTables: AddressLookupTableAccount[];
	method: 'jupiter' | 'marinade';
	price: number;
}> {
	if (!price) {
		const marinadeProgram = getMarinadeFinanceProgram(driftClient.provider);
		price = await getMarinadeMSolPrice(marinadeProgram);
	}

	const solMint = driftClient.getSpotMarketAccount(1).mint;
	const mSOLMint = driftClient.getSpotMarketAccount(2).mint;

	let jupiterPrice;
	let bestRoute;
	try {
		const jupiterRoutes = await jupiterClient.getRoutes({
			inputMint: solMint,
			outputMint: mSOLMint,
			amount,
			onlyDirectRoutes,
		});

		bestRoute = jupiterRoutes[0];
		jupiterPrice = bestRoute.inAmount / bestRoute.outAmount;
	} catch (e) {
		console.error('Error getting jupiter price', e);
	}

	if (!jupiterPrice || price <= jupiterPrice || forceMarinade) {
		const ixs = await driftClient.getStakeForMSOLIx({
			amount,
			userAccountPublicKey,
		});
		return {
			method: 'marinade',
			ixs,
			lookupTables: [],
			price: price,
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

export async function findBestJitoSolSuperStakeIxs({
	amount,
	jupiterClient,
	driftClient,
	userAccountPublicKey,
	onlyDirectRoutes,
}: {
	amount: BN;
	jupiterClient: JupiterClient;
	driftClient: DriftClient;
	userAccountPublicKey?: PublicKey;
	onlyDirectRoutes?: boolean;
}): Promise<{
	ixs: TransactionInstruction[];
	lookupTables: AddressLookupTableAccount[];
	method: 'jupiter' | 'marinade';
	price: number;
}> {
	return await findBestLstSuperStakeIxs({
		amount,
		jupiterClient,
		driftClient,
		userAccountPublicKey,
		onlyDirectRoutes,
		lstMint: driftClient.getSpotMarketAccount(6).mint,
	});
}

/**
 * Finds best Jupiter Swap instructions for a generic lstMint
 * 
 * Without doing any extra steps like checking if you can get a better rate by staking directly with that LST platform
 */
export async function findBestLstSuperStakeIxs({
	amount,
	lstMint,
	jupiterClient,
	driftClient,
	userAccountPublicKey,
	onlyDirectRoutes,
}: {
	amount: BN;
	lstMint: PublicKey;
	jupiterClient: JupiterClient;
	driftClient: DriftClient;
	userAccountPublicKey?: PublicKey;
	onlyDirectRoutes?: boolean;
}): Promise<{
	ixs: TransactionInstruction[];
	lookupTables: AddressLookupTableAccount[];
	method: 'jupiter' | 'marinade';
	price: number;
}> {
	const solMint = driftClient.getSpotMarketAccount(1).mint;

	let jupiterPrice;
	let bestRoute;
	try {
		const jupiterRoutes = await jupiterClient.getRoutes({
			inputMint: solMint,
			outputMint: lstMint,
			amount,
			onlyDirectRoutes,
		});

		bestRoute = jupiterRoutes[0];
		jupiterPrice = bestRoute.inAmount / bestRoute.outAmount;
	} catch (e) {
		console.error('Error getting jupiter price', e);
		throw e;
	}

	const { ixs, lookupTables } = await driftClient.getJupiterSwapIx({
		inMarketIndex: 1,
		outMarketIndex: 6,
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

export type JITO_SOL_METRICS_ENDPOINT_RESPONSE = {
	data: {
		getStakePoolStats: {
			tvl: {
				// TVL in SOL, BN
				data: number;
				date: string;
			}[];
			supply: {
				// jitoSOL supply
				data: number;
				date: string;
			}[];
			apy: {
				data: number;
				date: string;
			}[];
		};
	};
};

const JITO_SOL_START_DATE = '2022-10-31T00:00:00Z';

export async function fetchJitoSolMetrics() {
	const res = await fetch('https://kobe.mainnet.jito.network/', {
		body: JSON.stringify({
			operationName: 'QueryRoot',
			variables: {
				request: {
					bucketType: 'DAILY',
					rangeFilter: {
						start: JITO_SOL_START_DATE,
						end: new Date().toISOString(),
					},
					sortBy: {
						order: 'ASC',
						field: 'BLOCK_TIME',
					},
				},
			},
			query: `
						query QueryRoot($request: GetStakePoolStatsRequest!) {
								getStakePoolStats(req: $request) {
										tvl {
												data
												date
										}
										apy {
												data
												date
										}
										supply {
												data
												date
										}
								}
						}
				`,
		}),
		method: 'POST',
	});

	const data: JITO_SOL_METRICS_ENDPOINT_RESPONSE = await res.json();

	return data;
}

const getJitoSolHistoricalPriceMap = async (timestamps: number[]) => {
	try {
		const data = await fetchJitoSolMetrics();
		const jitoSolHistoricalPriceMap = new Map<number, number>();
		const jitoSolHistoricalPriceInSol = [];

		for (let i = 0; i < data.data.getStakePoolStats.supply.length; i++) {
			const priceInSol =
				data.data.getStakePoolStats.tvl[i].data /
				10 ** 9 /
				data.data.getStakePoolStats.supply[i].data;
			jitoSolHistoricalPriceInSol.push({
				price: priceInSol,
				ts: data.data.getStakePoolStats.tvl[i].date,
			});
		}

		for (const timestamp of timestamps) {
			const date = new Date(timestamp * 1000);
			const dateString = date.toISOString();

			const price = jitoSolHistoricalPriceInSol.find((p) =>
				checkSameDate(p.ts, dateString)
			);

			if (price) {
				jitoSolHistoricalPriceMap.set(timestamp, price.price);
			}
		}

		return jitoSolHistoricalPriceMap;
	} catch (err) {
		console.error(err);
		return undefined;
	}
};

export async function calculateSolEarned({
	marketIndex,
	user,
	depositRecords,
}: {
	marketIndex: number;
	user: User;
	depositRecords: DepositRecord[];
}): Promise<BN> {
	const now = Date.now() / 1000;
	const timestamps: number[] = [
		now,
		...depositRecords.map((r) => r.ts.toNumber()),
	];

	let lstRatios = new Map<number, number>();

	const getMsolPrice = async (timestamp) => {
		const date = new Date(timestamp * 1000); // Convert Unix timestamp to milliseconds
		const swaggerApiDateTime = date.toISOString(); // Format date as swagger API date-time
		const url = `https://api.marinade.finance/msol/price_sol?time=${swaggerApiDateTime}`;
		const response = await fetch(url);
		if (response.status === 200) {
			const data = await response.json();
			lstRatios.set(timestamp, data);
		}
	};
	

	const getBSolPrice = async (timestamps: number[]) => {
		// Currently there's only one bSOL price, no timestamped data
		// So just use the same price for every timestamp for now
		const response = await fetchBSolMetrics();
		if (response.status === 200) {
			const data = await response.json() as BSOL_STATS_API_RESPONSE;
			const bSolRatio = data?.stats?.conversion?.bsol_to_sol;
			if (bSolRatio) {
				timestamps.forEach((timestamp) => lstRatios.set(timestamp, bSolRatio));
			}
		}
	};

	// This block kind of assumes the record are all from the same market
	// Otherwise the following code that checks the record.marketIndex would break
	if (marketIndex === 2) {
		await Promise.all(timestamps.map(getMsolPrice));
	} else if (marketIndex === 6) {
		lstRatios = await getJitoSolHistoricalPriceMap(timestamps);
	} else if (marketIndex === 8) {
		await getBSolPrice(timestamps);
	}

	let solEarned = ZERO;
	for (const record of depositRecords) {
		if (record.marketIndex === 1) {
			if (isVariant(record.direction, 'deposit')) {
				solEarned = solEarned.sub(record.amount);
			} else {
				solEarned = solEarned.add(record.amount);
			}
		} else if (record.marketIndex === 2 || record.marketIndex === 6 || record.marketIndex === 8) {
			const lstRatio = lstRatios.get(record.ts.toNumber());
			const lstRatioBN = new BN(lstRatio * LAMPORTS_PER_SOL);

			const solAmount = record.amount
				.mul(lstRatioBN)
				.div(LAMPORTS_PRECISION);
			if (isVariant(record.direction, 'deposit')) {
				solEarned = solEarned.sub(solAmount);
			} else {
				solEarned = solEarned.add(solAmount);
			}
		}
	}

	const currentLstTokenAmount = await user.getTokenAmount(marketIndex);
	const currentLstRatio = lstRatios.get(now);
	const currentLstRatioBN = new BN(currentLstRatio * LAMPORTS_PER_SOL);

	solEarned = solEarned.add(
		currentLstTokenAmount.mul(currentLstRatioBN).div(LAMPORTS_PRECISION)
	);

	const currentSOLTokenAmount = await user.getTokenAmount(1);
	solEarned = solEarned.add(currentSOLTokenAmount);

	return solEarned;
}

// calculate estimated liquidation price (in LST/SOL) based on target amounts
export function calculateEstimatedSuperStakeLiquidationPrice(
	lstDepositAmount: number,
	lstMaintenanceAssetWeight: number,
	solBorrowAmount: number,
	solMaintenanceLiabilityWeight: number,
	lstPriceRatio: number
): number {
	const liquidationDivergence =
		(solMaintenanceLiabilityWeight * solBorrowAmount) /
		(lstMaintenanceAssetWeight * lstDepositAmount * lstPriceRatio);
	const liquidationPrice = lstPriceRatio * liquidationDivergence;
	return liquidationPrice;
}
