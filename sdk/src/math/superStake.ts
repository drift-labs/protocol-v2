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
import { DepositRecord, SpotMarketAccount, isVariant } from '../types';
import {
	LAMPORTS_PRECISION,
	PERCENTAGE_PRECISION,
	PRICE_PRECISION,
	SPOT_MARKET_IMF_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import fetch from 'node-fetch';
import {
	calculateSizeDiscountAssetWeight,
	calculateSizePremiumLiabilityWeight,
} from '../math/margin';

import {
	calculateSpotMarketBorrowCapacity,
	calculateWithdrawLimit,
	convertToNumber,
} from '..';

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

export async function calculateSolEarned({
	user,
	depositRecords,
}: {
	user: User;
	depositRecords: DepositRecord[];
}): Promise<BN> {
	const now = Date.now() / 1000;
	const timestamps: number[] = [
		now,
		...depositRecords.map((r) => r.ts.toNumber()),
	];

	const msolRatios = new Map<number, number>();

	const getPrice = async (timestamp) => {
		const date = new Date(timestamp * 1000); // Convert Unix timestamp to milliseconds
		const swaggerApiDateTime = date.toISOString(); // Format date as swagger API date-time
		const url = `https://api.marinade.finance/msol/price_sol?time=${swaggerApiDateTime}`;
		const response = await fetch(url);
		if (response.status === 200) {
			const data = await response.json();
			msolRatios.set(timestamp, data);
		}
	};

	await Promise.all(timestamps.map(getPrice));

	let solEarned = ZERO;
	for (const record of depositRecords) {
		if (record.marketIndex === 1) {
			if (isVariant(record.direction, 'deposit')) {
				solEarned = solEarned.sub(record.amount);
			} else {
				solEarned = solEarned.add(record.amount);
			}
		} else if (record.marketIndex === 2) {
			const msolRatio = msolRatios.get(record.ts.toNumber());
			const msolRatioBN = new BN(msolRatio * LAMPORTS_PER_SOL);

			const solAmount = record.amount.mul(msolRatioBN).div(LAMPORTS_PRECISION);
			if (isVariant(record.direction, 'deposit')) {
				solEarned = solEarned.sub(solAmount);
			} else {
				solEarned = solEarned.add(solAmount);
			}
		}
	}

	const currentMSOLTokenAmount = await user.getTokenAmount(2);
	const currentSOLTokenAmount = await user.getTokenAmount(1);

	const currentMSOLRatio = msolRatios.get(now);
	const currentMSOLRatioBN = new BN(currentMSOLRatio * LAMPORTS_PER_SOL);

	solEarned = solEarned.add(
		currentMSOLTokenAmount.mul(currentMSOLRatioBN).div(LAMPORTS_PRECISION)
	);
	solEarned = solEarned.add(currentSOLTokenAmount);

	return solEarned;
}

// calculate risk reward, limits information for proposed levered stake
export function calculateProposedSuperStakeStats(
	msolTokens: BN,
	msolSpotMarket: SpotMarketAccount,
	solSpotMarket: SpotMarketAccount,
	leverage: number,
	stakeYield: number,
	msolPriceRatio: number,
	now: BN
): {
	msolTokensLevered: BN;
	solBorrowAmount: BN;
	solCapacity: BN;
	liquidationPrice: number;
} {
	const msolTokensLevered = msolTokens
		.mul(new BN(leverage * PERCENTAGE_PRECISION.toNumber()))
		.div(PERCENTAGE_PRECISION);
	const msolMaintenanceAssetWeight = calculateSizeDiscountAssetWeight(
		msolTokensLevered,
		new BN(msolSpotMarket.imfFactor),
		new BN(msolSpotMarket.maintenanceAssetWeight)
	);
	const solBorrowAmount = msolTokensLevered
		.sub(msolTokens)
		.mul(msolPriceRatio * PRICE_PRECISION.toNumber())
		.div(PRICE_PRECISION);

	const solMaintenanceLiabilityWeight = calculateSizePremiumLiabilityWeight(
		solBorrowAmount,
		new BN(solSpotMarket.imfFactor),
		new BN(solSpotMarket.maintenanceLiabilityWeight),
		SPOT_MARKET_WEIGHT_PRECISION
	);

	const capacity = BN.min(
		calculateSpotMarketBorrowCapacity(
			solSpotMarket,
			new BN(stakeYield * PERCENTAGE_PRECISION.toNumber())
		),

		calculateWithdrawLimit(solSpotMarket, now)['borrowLimit']
	);

	const liqPrice = calculateEstimatedSuperStakeLiquidationPrice(
		convertToNumber(msolTokensLevered, new BN(10 ** solSpotMarket.decimals)),
		convertToNumber(msolMaintenanceAssetWeight, SPOT_MARKET_IMF_PRECISION),
		convertToNumber(solBorrowAmount, new BN(10 ** solSpotMarket.decimals)),
		convertToNumber(solMaintenanceLiabilityWeight, SPOT_MARKET_IMF_PRECISION),
		msolPriceRatio
	);

	return {
		msolTokensLevered,
		solBorrowAmount,
		solCapacity: capacity,
		liquidationPrice: liqPrice,
	};
}

// calculate estimated liquidation price (in mSOL/SOL) based on target amounts
export function calculateEstimatedSuperStakeLiquidationPrice(
	msolDepositAmount: number,
	msolMaintenanceAssetWeight: number,
	solBorrowAmount: number,
	solMaintenanceLiabilityWeight: number,
	msolPriceRatio: number
): number {
	const liquidationDivergence =
		(solMaintenanceLiabilityWeight * solBorrowAmount) /
		(msolMaintenanceAssetWeight * msolDepositAmount * msolPriceRatio);
	const liquidationPrice = msolPriceRatio * liquidationDivergence;
	return liquidationPrice;
}
