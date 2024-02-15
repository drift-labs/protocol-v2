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
	ContractTier,
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
	operation: PerpOperation | SpotOperation
): boolean {
	return (pausedOperations & operation) > 0;
}

export function isAmmDrawdownPause(market: PerpMarketAccount): boolean {
	let quoteDrawdownLimitBreached: boolean;

	switch (market.contractTier) {
		case ContractTier.A:
			quoteDrawdownLimitBreached = market.amm.netRevenueSinceLastFunding.lte(
				DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT.muln(2000)
			);
			break;
		case ContractTier.B:
			quoteDrawdownLimitBreached = market.amm.netRevenueSinceLastFunding.lte(
				DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT.muln(2000)
			);
			break;
		case ContractTier.C:
			quoteDrawdownLimitBreached = market.amm.netRevenueSinceLastFunding.lte(
				DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT.muln(200)
			);
			break;
		default:
			quoteDrawdownLimitBreached = market.amm.netRevenueSinceLastFunding.lte(
				DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT.muln(200)
			);
	}

	if (quoteDrawdownLimitBreached) {
		const percentDrawdown = market.amm.netRevenueSinceLastFunding
			.mul(PERCENTAGE_PRECISION)
			.div(BN.max(market.amm.totalFeeMinusDistributions, ONE));

		let percentDrawdownLimitBreached: boolean;

		switch (market.contractTier) {
			case ContractTier.A:
				percentDrawdownLimitBreached = percentDrawdown.lte(
					PERCENTAGE_PRECISION.divn(33).mul(new BN(-1))
				);
				break;
			case ContractTier.B:
				percentDrawdownLimitBreached = percentDrawdown.lte(
					PERCENTAGE_PRECISION.divn(25).mul(new BN(-1))
				);
				break;
			case ContractTier.C:
				percentDrawdownLimitBreached = percentDrawdown.lte(
					PERCENTAGE_PRECISION.divn(20).mul(new BN(-1))
				);
				break;
			default:
				percentDrawdownLimitBreached = percentDrawdown.lte(
					PERCENTAGE_PRECISION.divn(10).mul(new BN(-1))
				);
		}

		if (percentDrawdownLimitBreached) {
			return true;
		}
	}

	return false;
}
