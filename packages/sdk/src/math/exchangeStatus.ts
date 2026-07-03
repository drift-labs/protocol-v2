import {
	DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT,
	PERCENTAGE_PRECISION,
	ONE,
} from '../constants/numericConstants';
import {
	ExchangeStatus,
	PerpMarketAccount,
	PerpOperation,
	SolvencyStatus,
	SpotMarketAccount,
	SpotOperation,
	StateAccount,
	isVariant,
	InsuranceFundOperation,
	MarketConfigFlag,
} from '../types';
import { BN } from '../isomorphic/anchor';

/**
 * True if the exchange-wide status is anything other than fully active, i.e. any bit in
 * `ExchangeStatus` is set (deposits, withdraws, AMM, fills, liquidations, funding, settle-pnl,
 * or AMM-immediate-fill paused).
 *
 * @param {StateAccount} state - The global state account
 * @return {boolean} Whether any exchange-wide pause flag is set
 */
export function exchangePaused(state: StateAccount): boolean {
	return state.exchangeStatus !== ExchangeStatus.ACTIVE;
}

/**
 * Mirror of the program's `State::solvency_repair_paused`. Gates the resolve-bankruptcy /
 * pnl-deficit instructions independently of `ExchangeStatus.WITHDRAW_PAUSED` — an admin can pause
 * solvency repair without also blocking ordinary user withdrawals, or vice versa.
 *
 * @param {StateAccount} state - The global state account
 * @return {boolean} Whether the `SOLVENCY_REPAIR_PAUSED` bit is set in `state.solvencyStatus`
 */
export function solvencyRepairPaused(state: StateAccount): boolean {
	return (
		(state.solvencyStatus & SolvencyStatus.SOLVENCY_REPAIR_PAUSED) ===
		SolvencyStatus.SOLVENCY_REPAIR_PAUSED
	);
}

/**
 * True if deposits are blocked for `market`, either because the exchange-wide
 * `ExchangeStatus.DEPOSIT_PAUSED` flag is set, or because the market's own
 * `pausedOperations` bitmask has `SpotOperation.DEPOSIT` set.
 *
 * @param {StateAccount} state - The global state account
 * @param {SpotMarketAccount} market - The spot market account
 * @return {boolean} Whether deposits are paused for this market
 */
export function depositPaused(
	state: StateAccount,
	market: SpotMarketAccount
): boolean {
	if (
		(state.exchangeStatus & ExchangeStatus.DEPOSIT_PAUSED) ===
		ExchangeStatus.DEPOSIT_PAUSED
	) {
		return true;
	}

	return isOperationPaused(market.pausedOperations, SpotOperation.DEPOSIT);
}

/**
 * True if withdrawals are blocked for `market`, either because the exchange-wide
 * `ExchangeStatus.WITHDRAW_PAUSED` flag is set, or because the market's own
 * `pausedOperations` bitmask has `SpotOperation.WITHDRAW` set. Independent of
 * `solvencyRepairPaused`.
 *
 * @param {StateAccount} state - The global state account
 * @param {SpotMarketAccount} market - The spot market account
 * @return {boolean} Whether withdrawals are paused for this market
 */
export function withdrawPaused(
	state: StateAccount,
	market: SpotMarketAccount
): boolean {
	if (
		(state.exchangeStatus & ExchangeStatus.WITHDRAW_PAUSED) ===
		ExchangeStatus.WITHDRAW_PAUSED
	) {
		return true;
	}

	return isOperationPaused(market.pausedOperations, SpotOperation.WITHDRAW);
}

/**
 * True if fills are blocked for `market`, either because the exchange-wide
 * `ExchangeStatus.FILL_PAUSED` flag is set, or because the market's own `pausedOperations`
 * bitmask has the market-type-appropriate fill flag set (`PerpOperation.FILL` for perp markets,
 * detected via the presence of an `amm` field; `SpotOperation.FILL` otherwise).
 *
 * @param {StateAccount} state - The global state account
 * @param {PerpMarketAccount | SpotMarketAccount} market - The perp or spot market account
 * @return {boolean} Whether fills are paused for this market
 */
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

/**
 * True if AMM fills are blocked for `market`: the exchange-wide `ExchangeStatus.AMM_PAUSED` flag
 * is set, the market's `pausedOperations` has `PerpOperation.AMM_FILL` set (perp markets only),
 * or (perp markets only) the AMM has breached its per-funding-period drawdown limit
 * (`isAmmDrawdownPause`). Always `false` for spot markets beyond the exchange-wide flag, since
 * spot markets have no AMM.
 *
 * @param {StateAccount} state - The global state account
 * @param {PerpMarketAccount | SpotMarketAccount} market - The perp or spot market account
 * @return {boolean} Whether AMM fills are paused for this market
 */
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

/**
 * Bitmask test for whether `operation` is set in a `pausedOperations` field.
 *
 * @param {number} pausedOperations - A market or insurance-fund `pausedOperations` bitmask
 * @param {PerpOperation | SpotOperation | InsuranceFundOperation} operation - The operation flag to test
 * @return {boolean} Whether `operation`'s bit is set
 */
export function isOperationPaused(
	pausedOperations: number,
	operation: PerpOperation | SpotOperation | InsuranceFundOperation
): boolean {
	return (pausedOperations & operation) > 0;
}

/**
 * True if a perp market's AMM has accumulated too much drawdown since its last funding update to
 * keep accepting AMM fills, mirroring `AMM::has_too_much_drawdown`. Uses a two-stage gate: an
 * absolute quote-denominated drawdown floor (contract tier A/B: -$10,000; others: -$5,000, i.e.
 * `DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT` ($25) times 400 or 200) must first be
 * breached, then a tier-specific percentage-of-total-fees drawdown limit (A: 2%, B: ~3%, C: 4%,
 * others: 5%) must also be breached.
 *
 * @param {PerpMarketAccount} market - The perp market account
 * @return {boolean} Whether the AMM should stop accepting fills due to drawdown this funding period
 */
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

/**
 * Bitmask test for whether `flag` is set in a perp market's `marketConfig` field.
 *
 * @param {number} marketConfig - A `PerpMarketAccount.marketConfig` bitmask
 * @param {MarketConfigFlag} flag - The config flag to test
 * @return {boolean} Whether `flag`'s bit is set
 */
export function isMarketConfigFlagSet(
	marketConfig: number,
	flag: MarketConfigFlag
): boolean {
	return (marketConfig & flag) > 0;
}

/**
 * True if formulaic (automatic) `k` (AMM depth) updates are disabled for this market, meaning
 * `k` only changes via explicit admin instructions rather than the keeper-driven repeg/curve
 * update logic.
 *
 * @param {PerpMarketAccount} market - The perp market account
 * @return {boolean} Whether `DISABLE_FORMULAIC_K_UPDATE` is set in `market.marketConfig`
 */
export function isFormulaicKUpdateDisabled(market: PerpMarketAccount): boolean {
	return isMarketConfigFlagSet(
		market.marketConfig,
		MarketConfigFlag.DISABLE_FORMULAIC_K_UPDATE
	);
}
