import { Program } from '@coral-xyz/anchor';
import {
	BN,
	BulkAccountLoader,
	PERCENTAGE_PRECISION,
	ZERO,
} from '@velocity-exchange/sdk';
import { PublicKey } from '@solana/web3.js';
import { DriftVaults } from '../types/drift_vaults';
import { VaultDepositor, VaultDepositorAccountEvents } from '../types/types';
import { PollingVaultDepositorSubscriber } from '../accountSubscribers';
import { VaultsProgramAccount } from './vaultsProgramAccount';
import { getVaultDepositorAddressSync } from '../addresses';

export class VaultDepositorAccount extends VaultsProgramAccount<
	VaultDepositor,
	VaultDepositorAccountEvents
> {
	constructor(
		program: Program<DriftVaults>,
		vaultDepositorPubkey: PublicKey,
		accountLoader: BulkAccountLoader,
		accountSubscriptionType: 'polling' | 'websocket' = 'polling'
	) {
		super();

		if (accountSubscriptionType === 'polling') {
			this.accountSubscriber = new PollingVaultDepositorSubscriber(
				program,
				vaultDepositorPubkey,
				accountLoader
			);
		} else {
			throw new Error('Websocket subscription not yet implemented');
		}
	}

	static getAddressSync(
		programId: PublicKey,
		vault: PublicKey,
		authority: PublicKey
	): PublicKey {
		return getVaultDepositorAddressSync(programId, vault, authority);
	}

	/**
	 * Calculates the percentage of a depositor's equity that will be paid as profit share fees.
	 *
	 * @param vaultProfitShare Vault's profit share fee
	 * @param depositorEquity Vault depositor's equity amount
	 */
	calcProfitShareFeesPct(vaultProfitShare: BN, depositorEquity: BN): BN {
		const accountData = this.accountSubscriber.getAccountAndSlot().data;

		const profit = depositorEquity
			.sub(accountData.netDeposits)
			.sub(accountData.cumulativeProfitShareAmount);

		if (profit.lte(new BN(0)) || depositorEquity.isZero()) {
			return ZERO;
		}

		const profitShareAmount = profit
			.mul(vaultProfitShare)
			.div(PERCENTAGE_PRECISION);

		if (depositorEquity.eq(new BN(0))) {
			return ZERO;
		}

		const profitShareProportion = profitShareAmount
			.mul(PERCENTAGE_PRECISION)
			.div(depositorEquity);

		return profitShareProportion;
	}
}
