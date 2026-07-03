import { BN } from '../isomorphic/anchor';

/**
 * Pairs a live oracle price with its 5-minute TWAP so margin/value calculations can pick whichever
 * is more conservative — mirroring the on-chain "strict" price used for collateral valuation, which
 * exists so a transient price spike/dip can't be used to over-value collateral or under-value a
 * liability. All values are PRICE_PRECISION (1e6).
 */
export class StrictOraclePrice {
	current: BN;
	twap?: BN;

	/**
	 * @param current - Live oracle price, PRICE_PRECISION (1e6).
	 * @param twap - 5-minute oracle TWAP, PRICE_PRECISION (1e6). If omitted, `max()`/`min()` both
	 * fall back to `current`.
	 */
	constructor(current: BN, twap?: BN) {
		this.current = current;
		this.twap = twap;
	}

	/**
	 * The higher of `current` and `twap` — use when a higher price is the conservative choice
	 * (e.g. valuing a liability/borrow, where undervaluing it would overstate free collateral).
	 * @returns The larger of `current` and `twap` (or just `current` if no `twap` was provided), PRICE_PRECISION (1e6).
	 */
	public max(): BN {
		return this.twap ? BN.max(this.twap, this.current) : this.current;
	}

	/**
	 * The lower of `current` and `twap` — use when a lower price is the conservative choice (e.g.
	 * valuing a deposit/asset, where overvaluing it would overstate free collateral).
	 * @returns The smaller of `current` and `twap` (or just `current` if no `twap` was provided), PRICE_PRECISION (1e6).
	 */
	public min(): BN {
		return this.twap ? BN.min(this.twap, this.current) : this.current;
	}
}
