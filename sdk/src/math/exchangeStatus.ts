import {
	DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT,
	PERCENTAGE_PRECISION,
	ONE,
} from '../constants/numericConstants';
import {
	ExchangeStatus,
	PerpMarketAccount,
	PerpOperation,
	SpotMarketAccount,
	SpotOperation,
	StateAccount,
	isVariant,
	InsuranceFundOperation,
} from '../types';
import { BN } from '@coral-xyz/anchor';

export function exchangePaused(state: StateAccount): boolean {
	return state.exchangeStatus !== ExchangeStatus.ACTIVE;
}

export function fillPaused(
	state: StateAccount,
	market: PerpMarketAccount | SpotMarketAccount
): boolean {
	if (
		(state.exchangeStatus & ExchangeStatus.FILL_PAUSED) ===
		ExchangeStatus.FILL_PAUSED
	) {
		return true;
	}

	if (market.hasOwnProperty('amm')) {
		return isOperationPaused(market.pausedOperations, PerpOperation.FILL);
	} else {
		return isOperationPaused(market.pausedOperations, SpotOperation.FILL);
	}
}

export function ammPaused(
	state: StateAccount,
	market: PerpMarketAccount | SpotMarketAccount
): boolean {
	if (
		(state.exchangeStatus & ExchangeStatus.AMM_PAUSED) ===
		ExchangeStatus.AMM_PAUSED
	) {
		return true;
	}

	if (market.hasOwnProperty('amm')) {
		const operationPaused = isOperationPaused(
			market.pausedOperations,
			PerpOperation.AMM_FILL
		);
		if (operationPaused) {
			return true;
		}
		if (isAmmDrawdownPause(market as PerpMarketAccount)) {
			return true;
		}
	}

	return false;
}

export function isOperationPaused(
	pausedOperations: number,
	operation: PerpOperation | SpotOperation | InsuranceFundOperation
): boolean {
	return (pausedOperations & operation) > 0;
}

export function isAmmDrawdownPause(market: PerpMarketAccount): boolean {
	let quoteDrawdownLimitBreached: boolean;

	if (
		isVariant(market.contractTier, 'a') ||
		isVariant(market.contractTier, 'b')
	) {
		quoteDrawdownLimitBreached = market.amm.netRevenueSinceLastFunding.lte(
			DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT.muln(400)
		);
	} else {
		quoteDrawdownLimitBreached = market.amm.netRevenueSinceLastFunding.lte(
			DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT.muln(200)
		);
	}

	if (quoteDrawdownLimitBreached) {
		const percentDrawdown = market.amm.netRevenueSinceLastFunding
			.mul(PERCENTAGE_PRECISION)
			.div(BN.max(market.amm.totalFeeMinusDistributions, ONE));

		let percentDrawdownLimitBreached: boolean;

		if (isVariant(market.contractTier, 'a')) {
			percentDrawdownLimitBreached = percentDrawdown.lte(
				PERCENTAGE_PRECISION.divn(50).neg()
			);
		} else if (isVariant(market.contractTier, 'b')) {
			percentDrawdownLimitBreached = percentDrawdown.lte(
				PERCENTAGE_PRECISION.divn(33).neg()
			);
		} else if (isVariant(market.contractTier, 'c')) {
			percentDrawdownLimitBreached = percentDrawdown.lte(
				PERCENTAGE_PRECISION.divn(25).neg()
			);
		} else {
			percentDrawdownLimitBreached = percentDrawdown.lte(
				PERCENTAGE_PRECISION.divn(20).neg()
			);
		}

		if (percentDrawdownLimitBreached) {
			return true;
		}
	}

	return false;
}
