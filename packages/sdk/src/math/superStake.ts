import {
	AddressLookupTableAccount,
	LAMPORTS_PER_SOL,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import { JupiterClient, QuoteResponse } from '../jupiter/jupiterClient';
import { VelocityClient } from '../velocityClient';
import { getMarinadeFinanceProgram, getMarinadeMSolPrice } from '../marinade';
import { BN } from '../isomorphic/anchor';
import { User } from '../user';
import { DepositRecord, isVariant } from '../types';
import { LAMPORTS_PRECISION, ZERO } from '../constants/numericConstants';
import fetch from 'node-fetch';
import { checkSameDate } from './utils';

/** Response shape of SolBlaze's `bsol/stats` endpoint (bSOL conversion ratio + APY breakdown). */
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

/** Response shape of SolBlaze's Velocity-specific lending emissions endpoint. */
export type BSOL_EMISSIONS_API_RESPONSE = {
	success: boolean;
	emissions?: {
		lend: number;
	};
};

/**
 * Fetches bSOL conversion/APY stats from SolBlaze's public API.
 *
 * @return {Promise<Response>} The raw `fetch` response; caller must check `.status` and parse
 *   JSON as `BSOL_STATS_API_RESPONSE`
 */
export async function fetchBSolMetrics() {
	return await fetch('https://stake.solblaze.org/api/v1/stats');
}

/**
 * Fetches bSOL lending-emissions data specific to Velocity from SolBlaze's public API.
 *
 * @return {Promise<Response>} The raw `fetch` response; caller must check `.status` and parse
 *   JSON as `BSOL_EMISSIONS_API_RESPONSE`
 */
export async function fetchBSolVelocityEmissions() {
	return await fetch('https://stake.solblaze.org/api/v1/velocity_emissions');
}

/**
 * Dispatches to the correct "super-stake" (deposit SOL, swap to an LST, deposit the LST as
 * leveraged collateral) instruction builder for a given LST spot market, routing by the SDK's
 * hardcoded market-index constants: `2` (mSOL) uses Marinade-or-Jupiter (`findBestMSolSuperStakeIxs`),
 * `6` (JitoSOL) and `8` (a generic LST, e.g. bSOL) both use Jupiter-only routing.
 *
 * @param {object} params
 * @param {number} params.marketIndex - The LST spot market index; must be `2`, `6`, or `8`
 * @param {BN} params.amount - SOL amount to stake, `LAMPORTS_PRECISION` (1e9)
 * @param {JupiterClient} params.jupiterClient - Jupiter aggregator client for swap routing
 * @param {VelocityClient} params.velocityClient - Velocity client (for market accounts + instruction building)
 * @param {PublicKey} [params.userAccountPublicKey] - The target sub-account; defaults to the
 *   client's active sub-account if omitted
 * @param {number} [params.price] - Pre-fetched mSOL/SOL price (market index 2 only); fetched from
 *   Marinade if omitted
 * @param {boolean} [params.forceMarinade] - Force the direct Marinade stake path over a Jupiter
 *   swap even if Jupiter would be cheaper (market index 2 only)
 * @param {boolean} [params.onlyDirectRoutes] - Restrict Jupiter routing to direct swaps only
 * @param {QuoteResponse} [params.jupiterQuote] - A pre-fetched Jupiter quote to reuse instead of
 *   fetching a fresh one
 * @return {Promise<{ ixs: TransactionInstruction[]; lookupTables: AddressLookupTableAccount[];
 *   method: 'jupiter' | 'marinade'; price?: number }>} The instructions to submit, any address
 *   lookup tables they require, which routing method was chosen, and (market index 2 only) the
 *   price used for the routing decision
 * @throws {Error} If `marketIndex` is not one of the supported LST markets
 */
export async function findBestSuperStakeIxs({
	marketIndex,
	amount,
	jupiterClient,
	velocityClient,
	userAccountPublicKey,
	price,
	forceMarinade,
	onlyDirectRoutes,
	jupiterQuote,
}: {
	marketIndex: number;
	amount: BN;
	jupiterClient: JupiterClient;
	velocityClient: VelocityClient;
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
			velocityClient,
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
			velocityClient,
			userAccountPublicKey,
			onlyDirectRoutes,
			jupiterQuote,
		});
	} else if (marketIndex === 8) {
		return findBestLstSuperStakeIxs({
			amount,
			lstMint: velocityClient.getSpotMarketAccountOrThrow(8).mint,
			lstMarketIndex: 8,
			jupiterClient,
			velocityClient,
			userAccountPublicKey,
			onlyDirectRoutes,
			jupiterQuote,
		});
	} else {
		throw new Error(`Unsupported superstake market index: ${marketIndex}`);
	}
}

/**
 * Chooses between staking SOL directly with Marinade (mint mSOL 1:1 at the protocol rate) or
 * swapping SOL for mSOL via Jupiter, whichever is cheaper for the user, then returns the
 * resulting deposit instructions. Marinade is chosen when its price is lower than (i.e. gives
 * more mSOL per SOL than) the best Jupiter quote, when `forceMarinade` is set, or when a Jupiter
 * quote couldn't be obtained.
 *
 * @param {object} params
 * @param {BN} params.amount - SOL amount to stake, `LAMPORTS_PRECISION` (1e9)
 * @param {JupiterClient} params.jupiterClient - Jupiter aggregator client
 * @param {VelocityClient} params.velocityClient - Velocity client
 * @param {number} [params.price] - Pre-fetched mSOL/SOL Marinade rate; fetched live if omitted
 * @param {PublicKey} [params.userAccountPublicKey] - The target sub-account
 * @param {boolean} [params.forceMarinade] - Force the Marinade path regardless of Jupiter pricing
 * @param {boolean} [params.onlyDirectRoutes] - Restrict Jupiter routing to direct swaps only
 * @param {QuoteResponse} [params.jupiterQuote] - A pre-fetched Jupiter quote to reuse
 * @return {Promise<{ ixs: TransactionInstruction[]; lookupTables: AddressLookupTableAccount[];
 *   method: 'jupiter' | 'marinade'; price: number }>} The chosen route's instructions, required
 *   lookup tables, the method used, and the mSOL/SOL price used for the decision
 */
export async function findBestMSolSuperStakeIxs({
	amount,
	jupiterClient,
	velocityClient,
	userAccountPublicKey,
	price,
	forceMarinade,
	onlyDirectRoutes,
	jupiterQuote,
}: {
	amount: BN;
	jupiterClient: JupiterClient;
	velocityClient: VelocityClient;
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
		const marinadeProgram = getMarinadeFinanceProgram(velocityClient.provider);
		price = await getMarinadeMSolPrice(marinadeProgram);
	}

	const solSpotMarketAccount = velocityClient.getSpotMarketAccountOrThrow(1);
	const mSolSpotMarketAccount = velocityClient.getSpotMarketAccountOrThrow(2);

	let jupiterPrice: number | undefined;
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

			jupiterPrice = +fetchedQuote.outAmount / +fetchedQuote.inAmount;

			quote = fetchedQuote;
		} catch (e) {
			console.error('Error getting jupiter price', e);
		}
	}

	if (!jupiterPrice || price <= jupiterPrice || forceMarinade) {
		const ixs = await velocityClient.getStakeForMSOLIx({
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
		const { ixs, lookupTables } = await velocityClient.getJupiterSwapIxV6({
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

/**
 * Builds instructions to super-stake into JitoSOL (spot market index `6`) by swapping SOL for
 * JitoSOL via Jupiter. Thin wrapper around `findBestLstSuperStakeIxs`.
 *
 * @param {object} params
 * @param {BN} params.amount - SOL amount to stake, `LAMPORTS_PRECISION` (1e9)
 * @param {JupiterClient} params.jupiterClient - Jupiter aggregator client
 * @param {VelocityClient} params.velocityClient - Velocity client
 * @param {PublicKey} [params.userAccountPublicKey] - The target sub-account
 * @param {boolean} [params.onlyDirectRoutes] - Restrict Jupiter routing to direct swaps only
 * @param {QuoteResponse} [params.jupiterQuote] - A pre-fetched Jupiter quote to reuse
 * @return {Promise<{ ixs: TransactionInstruction[]; lookupTables: AddressLookupTableAccount[];
 *   method: 'jupiter' | 'marinade'; price?: number }>} Always resolves with `method: 'jupiter'`
 */
export async function findBestJitoSolSuperStakeIxs({
	amount,
	jupiterClient,
	velocityClient,
	userAccountPublicKey,
	onlyDirectRoutes,
	jupiterQuote,
}: {
	amount: BN;
	jupiterClient: JupiterClient;
	velocityClient: VelocityClient;
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
		velocityClient,
		userAccountPublicKey,
		onlyDirectRoutes,
		lstMint: velocityClient.getSpotMarketAccountOrThrow(6).mint,
		lstMarketIndex: 6,
		jupiterQuote,
	});
}

/**
 * Builds instructions to super-stake into an arbitrary LST via a Jupiter swap from SOL. Unlike
 * `findBestMSolSuperStakeIxs`, this does not compare against a direct-stake rate with the LST's
 * own protocol — it always routes through Jupiter.
 *
 * @param {object} params
 * @param {BN} params.amount - SOL amount to stake, `LAMPORTS_PRECISION` (1e9)
 * @param {PublicKey} params.lstMint - The target LST's mint (unused directly here; kept for
 *   caller symmetry with `lstMarketIndex`)
 * @param {number} params.lstMarketIndex - The target LST's spot market index
 * @param {JupiterClient} params.jupiterClient - Jupiter aggregator client
 * @param {VelocityClient} params.velocityClient - Velocity client
 * @param {PublicKey} [params.userAccountPublicKey] - The target sub-account
 * @param {boolean} [params.onlyDirectRoutes] - Restrict Jupiter routing to direct swaps only
 * @param {QuoteResponse} [params.jupiterQuote] - A pre-fetched Jupiter quote to reuse
 * @return {Promise<{ ixs: TransactionInstruction[]; lookupTables: AddressLookupTableAccount[];
 *   method: 'jupiter' | 'marinade' }>} Always resolves with `method: 'jupiter'`
 */
export async function findBestLstSuperStakeIxs({
	amount,
	jupiterClient,
	velocityClient,
	userAccountPublicKey,
	onlyDirectRoutes,
	lstMarketIndex,
	jupiterQuote,
}: {
	amount: BN;
	lstMint: PublicKey;
	lstMarketIndex: number;
	jupiterClient: JupiterClient;
	velocityClient: VelocityClient;
	userAccountPublicKey?: PublicKey;
	onlyDirectRoutes?: boolean;
	jupiterQuote?: QuoteResponse;
}): Promise<{
	ixs: TransactionInstruction[];
	lookupTables: AddressLookupTableAccount[];
	method: 'jupiter' | 'marinade';
}> {
	const { ixs, lookupTables } = await velocityClient.getJupiterSwapIxV6({
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

/** Response shape of Jito's `stake_pool_stats` endpoint: daily TVL, jitoSOL supply, and APY series. */
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

/**
 * Fetches daily jitoSOL TVL/supply/APY stats for the trailing 30 days from Jito's public API.
 *
 * @return {Promise<JITO_SOL_METRICS_ENDPOINT_RESPONSE>} The parsed JSON response
 */
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

/**
 * Estimates net SOL earned (or lost) from super-staking a given LST market over the user's full
 * deposit history, by converting every historical SOL and LST deposit/withdrawal record to a SOL
 * value at the LST/SOL ratio effective at that record's timestamp, then adding back the current
 * SOL-value of the user's present SOL and LST balances. Requires third-party price history APIs
 * per LST (Marinade for mSOL, Jito's stake pool stats for JitoSOL, SolBlaze's current-only rate
 * for bSOL — bSOL therefore uses one flat ratio for all historical records, not a true history).
 *
 * @param {object} params
 * @param {number} params.marketIndex - The LST spot market index (`2` mSOL, `6` JitoSOL, `8` bSOL)
 * @param {User} params.user - The user account to read current SOL/LST balances from
 * @param {DepositRecord[]} params.depositRecords - The user's historical deposit/withdraw records
 *   across the SOL market (index `1`) and the LST market
 * @return {Promise<BN>} Estimated net SOL earned, `LAMPORTS_PRECISION` (1e9); can be negative
 * @throws {Error} If an LST/SOL ratio can't be resolved for a record's timestamp (or for "now")
 */
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

	const getMsolPrice = async (timestamp: number) => {
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
		const jitoSolRatios = await getJitoSolHistoricalPriceMap(timestamps);
		if (jitoSolRatios) {
			lstRatios = jitoSolRatios;
		}
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
			if (lstRatio === undefined) {
				throw new Error(
					`Missing LST/SOL ratio for deposit record at timestamp ${record.ts.toNumber()}`
				);
			}
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
	if (currentLstRatio === undefined) {
		throw new Error(`Missing current LST/SOL ratio for timestamp ${now}`);
	}
	const currentLstRatioBN = new BN(currentLstRatio * LAMPORTS_PER_SOL);

	solEarned = solEarned.add(
		currentLstTokenAmount.mul(currentLstRatioBN).div(LAMPORTS_PRECISION)
	);

	const currentSOLTokenAmount = await user.getTokenAmount(1);
	solEarned = solEarned.add(currentSOLTokenAmount);

	return solEarned;
}

/**
 * Estimates the LST/SOL price at which a super-staked (leveraged LST-collateral, SOL-borrow)
 * position would hit maintenance margin and become liquidatable: the price where
 * `lstMaintenanceAssetWeight * lstDepositAmount * price === solMaintenanceLiabilityWeight * solBorrowAmount`.
 * All inputs are plain (unscaled) numbers, not `BN` — weights are expected as fractions (e.g.
 * `0.8` for 80%, i.e. already divided by `SPOT_MARKET_WEIGHT_PRECISION`), and this is a
 * float-precision estimate for UI display, not a program-exact calculation.
 *
 * @param {number} lstDepositAmount - LST collateral amount, in whole LST tokens
 * @param {number} lstMaintenanceAssetWeight - The LST market's maintenance asset weight, as a fraction
 * @param {number} solBorrowAmount - SOL borrow amount, in whole SOL
 * @param {number} solMaintenanceLiabilityWeight - The SOL market's maintenance liability weight, as a fraction
 * @param {number} lstPriceRatio - Current LST/SOL price ratio
 * @return {number} Estimated liquidation LST/SOL price
 */
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
