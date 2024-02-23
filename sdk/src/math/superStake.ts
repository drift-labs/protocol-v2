import {
	AddressLookupTableAccount,
	LAMPORTS_PER_SOL,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import { JupiterClient, QuoteResponse } from '../jupiter/jupiterClient';
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
		};
		apy: {
			base: number;
			blze: number;
			total: number;
			lending: number;
			liquidity: number;
		};
	};
};

export type BSOL_EMISSIONS_API_RESPONSE = {
	success: boolean;
	emissions?: {
		lend: number;
	};
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
	jupiterQuote,
}: {
	marketIndex: number;
	amount: BN;
	jupiterClient: JupiterClient;
	driftClient: DriftClient;
	price?: number;
	userAccountPublicKey?: PublicKey;
	forceMarinade?: boolean;
	onlyDirectRoutes?: boolean;
	jupiterQuote?: QuoteResponse;
}): Promise<{
	ixs: TransactionInstruction[];
	lookupTables: AddressLookupTableAccount[];
	method: 'jupiter' | 'marinade';
	price?: number;
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
			jupiterQuote,
		});
	} else if (marketIndex === 6) {
		return findBestJitoSolSuperStakeIxs({
			amount,
			jupiterClient,
			driftClient,
			userAccountPublicKey,
			onlyDirectRoutes,
			jupiterQuote,
		});
	} else if (marketIndex === 8) {
		return findBestLstSuperStakeIxs({
			amount,
			lstMint: driftClient.getSpotMarketAccount(8).mint,
			lstMarketIndex: 8,
			jupiterClient,
			driftClient,
			userAccountPublicKey,
			onlyDirectRoutes,
			jupiterQuote,
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
	jupiterQuote,
}: {
	amount: BN;
	jupiterClient: JupiterClient;
	driftClient: DriftClient;
	price?: number;
	userAccountPublicKey?: PublicKey;
	forceMarinade?: boolean;
	onlyDirectRoutes?: boolean;
	jupiterQuote?: QuoteResponse;
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

	const solSpotMarketAccount = driftClient.getSpotMarketAccount(1);
	const mSolSpotMarketAccount = driftClient.getSpotMarketAccount(2);

	let jupiterPrice: number;
	let quote = jupiterQuote;
	if (!jupiterQuote) {
		try {
			const fetchedQuote = await jupiterClient.getQuote({
				inputMint: solSpotMarketAccount.mint,
				outputMint: mSolSpotMarketAccount.mint,
				amount,
				slippageBps: 1000,
				onlyDirectRoutes,
			});

			jupiterPrice = +quote.outAmount / +quote.inAmount;

			quote = fetchedQuote;
		} catch (e) {
			console.error('Error getting jupiter price', e);
		}
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
		const { ixs, lookupTables } = await driftClient.getJupiterSwapIxV6({
			inMarketIndex: 1,
			outMarketIndex: 2,
			jupiterClient,
			amount,
			userAccountPublicKey,
			onlyDirectRoutes,
			quote,
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
	jupiterQuote,
}: {
	amount: BN;
	jupiterClient: JupiterClient;
	driftClient: DriftClient;
	userAccountPublicKey?: PublicKey;
	onlyDirectRoutes?: boolean;
	jupiterQuote?: QuoteResponse;
}): Promise<{
	ixs: TransactionInstruction[];
	lookupTables: AddressLookupTableAccount[];
	method: 'jupiter' | 'marinade';
	price?: number;
}> {
	return await findBestLstSuperStakeIxs({
		amount,
		jupiterClient,
		driftClient,
		userAccountPublicKey,
		onlyDirectRoutes,
		lstMint: driftClient.getSpotMarketAccount(6).mint,
		lstMarketIndex: 6,
		jupiterQuote,
	});
}

/**
 * Finds best Jupiter Swap instructions for a generic lstMint
 *
 * Without doing any extra steps like checking if you can get a better rate by staking directly with that LST platform
 */
export async function findBestLstSuperStakeIxs({
	amount,
	jupiterClient,
	driftClient,
	userAccountPublicKey,
	onlyDirectRoutes,
	lstMarketIndex,
	jupiterQuote,
}: {
	amount: BN;
	lstMint: PublicKey;
	lstMarketIndex: number;
	jupiterClient: JupiterClient;
	driftClient: DriftClient;
	userAccountPublicKey?: PublicKey;
	onlyDirectRoutes?: boolean;
	jupiterQuote?: QuoteResponse;
}): Promise<{
	ixs: TransactionInstruction[];
	lookupTables: AddressLookupTableAccount[];
	method: 'jupiter' | 'marinade';
}> {
	const { ixs, lookupTables } = await driftClient.getJupiterSwapIxV6({
		inMarketIndex: 1,
		outMarketIndex: lstMarketIndex,
		jupiterClient,
		amount,
		userAccountPublicKey,
		onlyDirectRoutes,
		quote: jupiterQuote,
	});
	return {
		method: 'jupiter',
		ixs,
		lookupTables,
		// price: jupiterPrice,
	};
}

export type JITO_SOL_METRICS_ENDPOINT_RESPONSE = {
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

/**
 * Removes hours, minutes, seconds from a date, and returns the ISO string value (with milliseconds trimmed from the output (required by Jito API))
 * @param inDate
 * @returns
 */
const getNormalizedDateString = (inDate: Date) => {
	const date = new Date(inDate.getTime());
	date.setUTCHours(0, 0, 0, 0);
	return date.toISOString().slice(0, 19) + 'Z';
};

const get30DAgo = () => {
	const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	return date;
};

export async function fetchJitoSolMetrics() {
	const res = await fetch(
		'https://kobe.mainnet.jito.network/api/v1/stake_pool_stats',
		{
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				bucket_type: 'Daily',
				range_filter: {
					start: getNormalizedDateString(get30DAgo()),
					end: getNormalizedDateString(new Date()),
				},
				sort_by: {
					order: 'Asc',
					field: 'BlockTime',
				},
			}),
			method: 'POST',
		}
	);

	const data: JITO_SOL_METRICS_ENDPOINT_RESPONSE = await res.json();

	return data;
}

export type MSOL_METRICS_ENDPOINT_RESPONSE = {
	total_active_balance: number;
	available_reserve_balance: number;
	emergency_cooling_down: number;
	tvl_sol: number;
	msol_directed_stake_sol: number;
	msol_directed_stake_msol: number;
	mnde_total_supply: number;
	mnde_circulating_supply: number;
	validators_count: number;
	stake_accounts: number;
	staking_sol_cap: number;
	m_sol_price: number;
	avg_staking_apy: number;
	msol_price_apy_14d: number;
	msol_price_apy_30d: number;
	msol_price_apy_90d: number;
	msol_price_apy_365d: number;
	reserve_pda: number;
	treasury_m_sol_amount: number;
	m_sol_mint_supply: number;
	m_sol_supply_state: number;
	liq_pool_sol: number;
	liq_pool_m_sol: number;
	liq_pool_value: number;
	liq_pool_token_supply: number;
	liq_pool_token_price: number;
	liq_pool_target: number;
	liq_pool_min_fee: number;
	liq_pool_max_fee: number;
	liq_pool_current_fee: number;
	liq_pool_treasury_cut: number;
	liq_pool_cap: number;
	total_cooling_down: number;
	last_stake_delta_epoch: number;
	circulating_ticket_count: number;
	circulating_ticket_balance: number;
	reward_fee_bp: number;
	lido_staking: number;
	lido_st_sol_price: number;
	lido_stsol_price_apy_14d: number;
	lido_stsol_price_apy_30d: number;
	lido_stsol_price_apy_90d: number;
	lido_stsol_price_apy_365d: number;
	stake_delta: number;
	bot_balance: number;
	treasury_farm_claim_mnde_balance: number;
	last_3_epochs_avg_duration_hs: number;
	mnde_votes_validators: number;
};

export const fetchMSolMetrics = async () => {
	const res = await fetch('https://api2.marinade.finance/metrics_json');
	const data: MSOL_METRICS_ENDPOINT_RESPONSE = await res.json();
	return data;
};

const getJitoSolHistoricalPriceMap = async (timestamps: number[]) => {
	try {
		const data = await fetchJitoSolMetrics();
		const jitoSolHistoricalPriceMap = new Map<number, number>();
		const jitoSolHistoricalPriceInSol = [];

		for (let i = 0; i < data.supply.length; i++) {
			const priceInSol = data.tvl[i].data / 10 ** 9 / data.supply[i].data;
			jitoSolHistoricalPriceInSol.push({
				price: priceInSol,
				ts: data.tvl[i].date,
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
		...depositRecords
			.filter((r) => r.marketIndex === marketIndex)
			.map((r) => r.ts.toNumber()),
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
			const data = (await response.json()) as BSOL_STATS_API_RESPONSE;
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
		} else if (
			record.marketIndex === 2 ||
			record.marketIndex === 6 ||
			record.marketIndex === 8
		) {
			const lstRatio = lstRatios.get(record.ts.toNumber());
			const lstRatioBN = new BN(lstRatio * LAMPORTS_PER_SOL);

			const solAmount = record.amount.mul(lstRatioBN).div(LAMPORTS_PRECISION);
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
