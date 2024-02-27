import {
	ExchangeStatus,
	isOneOfVariant,
	PerpMarketAccount,
	SpotMarketAccount,
	StateAccount,
} from '../types';

export function exchangePaused(state: StateAccount): boolean {
	return state.exchangeStatus !== ExchangeStatus.ACTIVE;
}

export function fillPaused(
	state: StateAccount,
	market: PerpMarketAccount | SpotMarketAccount
): boolean {
	return (
		(state.exchangeStatus & ExchangeStatus.FILL_PAUSED) ===
			ExchangeStatus.FILL_PAUSED ||
		isOneOfVariant(market.status, ['paused', 'fillPaused'])
	);
}

export function ammPaused(
	state: StateAccount,
	market: PerpMarketAccount | SpotMarketAccount
): boolean {
	return (
		(state.exchangeStatus & ExchangeStatus.AMM_PAUSED) ===
			ExchangeStatus.AMM_PAUSED ||
		isOneOfVariant(market.status, ['paused', 'ammPaused'])
	);
}
