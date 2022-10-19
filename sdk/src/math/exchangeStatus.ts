import {
	isOneOfVariant,
	isVariant,
	PerpMarketAccount,
	SpotMarketAccount,
	StateAccount,
} from '../types';

export function exchangePaused(state: StateAccount): boolean {
	return isVariant(state.exchangeStatus, 'paused');
}

export function fillPaused(
	state: StateAccount,
	market: PerpMarketAccount | SpotMarketAccount
): boolean {
	return (
		isOneOfVariant(state.exchangeStatus, ['paused', 'fillPaused']) ||
		isOneOfVariant(market.status, ['paused', 'fillPaused'])
	);
}

export function ammPaused(
	state: StateAccount,
	market: PerpMarketAccount | SpotMarketAccount
): boolean {
	return (
		isOneOfVariant(state.exchangeStatus, ['paused', 'ammPaused']) ||
		isOneOfVariant(market.status, ['paused', 'ammPaused'])
	);
}
