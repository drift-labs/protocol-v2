import { BN } from '@coral-xyz/anchor';

export class StrictOraclePrice {
	current: BN;
	twap?: BN;

	constructor(current: BN, twap?: BN) {
		this.current = current;
		this.twap = twap;
	}

	public max(): BN {
		return this.twap ? BN.max(this.twap, this.current) : this.current;
	}

	public min(): BN {
		return this.twap ? BN.min(this.twap, this.current) : this.current;
	}
}
