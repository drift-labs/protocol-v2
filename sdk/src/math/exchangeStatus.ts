import {
	ExchangeStatus,
	isOneOfVariant,
	PerpMarketAccount,
	PerpOperation,
	SpotMarketAccount,
	SpotOperation,
	StateAccount,
} from '../types';

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
		return isOperationPaused(market.pausedOperations, PerpOperation.AMM_FILL);
	} else {
		return false;
	}
}

export function isOperationPaused(
	pausedOperations: number,
	operation: PerpOperation | SpotOperation
): boolean {
	return (pausedOperations & operation) > 0;
}
