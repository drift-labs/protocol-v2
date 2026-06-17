import { Program } from '@coral-xyz/anchor';
import {
	BulkAccountLoader,
	ONE,
	ONE_YEAR,
	PERCENTAGE_PRECISION,
	ZERO,
	BN,
} from '@velocity-exchange/sdk';
import { PublicKey } from '@solana/web3.js';
import { DriftVaults } from '../types/drift_vaults';
import { Vault, VaultAccountEvents, VaultProtocol } from '../types/types';
import { PollingVaultSubscriber } from '../accountSubscribers';
import { VaultsProgramAccount } from './vaultsProgramAccount';
import { getVaultAddressSync } from '../addresses';
import { encodeName } from '../name';

export class VaultAccount extends VaultsProgramAccount<
	Vault,
	VaultAccountEvents
> {
	constructor(
		program: Program<DriftVaults>,
		vaultPubkey: PublicKey,
		accountLoader: BulkAccountLoader,
		accountSubscriptionType: 'polling' | 'websocket' = 'polling'
	) {
		super();

		if (accountSubscriptionType === 'polling') {
			this.accountSubscriber = new PollingVaultSubscriber(
				program,
				vaultPubkey,
				accountLoader
			);
		} else {
			throw new Error('Websocket subscription not yet implemented');
		}
	}

	static getAddressSync(programId: PublicKey, vaultName: string): PublicKey {
		return getVaultAddressSync(programId, encodeName(vaultName));
	}

	/**
	 * Calculates the new total shares and management fee shares after a management fee is applied.
	 * Only applies to deposits.
	 * Management fee is applied to a depositor's existing equity, and the total shares are updated (increased) accordingly.
	 * @param vaultEquity - The equity of the vault.
	 * @returns An object containing the new total shares and management fee shares.
	 */
	calcSharesAfterManagementFee(vaultEquity: BN): {
		totalShares: BN;
		managementFeeShares: BN;
	} {
		const accountData = this.accountSubscriber.getAccountAndSlot().data;

		const depositorsEquity = accountData.userShares
			.mul(vaultEquity)
			.div(accountData.totalShares);

		if (accountData.managementFee.eq(ZERO) || depositorsEquity.lte(ZERO)) {
			return {
				totalShares: accountData.totalShares,
				managementFeeShares: ZERO,
			};
		}
		const now = new BN(Date.now() / 1000);
		const sinceLast = now.sub(accountData.lastFeeUpdateTs);

		let managementFeeAmount = depositorsEquity
			.mul(accountData.managementFee)
			.div(PERCENTAGE_PRECISION)
			.mul(sinceLast)
			.div(ONE_YEAR);
		managementFeeAmount = BN.min(
			managementFeeAmount,
			depositorsEquity.sub(ONE)
		);

		const newTotalSharesFactor = depositorsEquity
			.mul(PERCENTAGE_PRECISION)
			.div(depositorsEquity.sub(managementFeeAmount));
		let newTotalShares = accountData.totalShares
			.mul(newTotalSharesFactor)
			.div(PERCENTAGE_PRECISION);
		newTotalShares = BN.max(newTotalShares, accountData.userShares);

		const managementFeeShares = newTotalShares.sub(accountData.totalShares);

		return { totalShares: newTotalShares, managementFeeShares };
	}

	calcSharesAfterManagementAndProtocolFee(
		vaultEquity: BN,
		vaultProtocol: VaultProtocol
	): {
		totalShares: BN;
		managementFeeShares: BN;
		protocolFeeShares: BN;
	} {
		const accountData = this.accountSubscriber.getAccountAndSlot().data;

		if (!accountData.vaultProtocol) {
			throw new Error('VaultProtocol does not exist for vault');
		}

		const depositorsEquity = accountData.userShares
			.mul(vaultEquity)
			.div(accountData.totalShares);

		const now = new BN(Date.now() / 1000);
		const sinceLast = now.sub(accountData.lastFeeUpdateTs);

		if (
			!accountData.managementFee.eq(ZERO) &&
			!vaultProtocol.protocolFee.eq(ZERO) &&
			depositorsEquity.gt(ZERO)
		) {
			const totalFee = accountData.managementFee.add(vaultProtocol.protocolFee);
			const totalFeePayment = depositorsEquity
				.mul(totalFee)
				.div(PERCENTAGE_PRECISION)
				.mul(sinceLast)
				.div(ONE_YEAR);
			const managementFeePayment = depositorsEquity
				.mul(accountData.managementFee)
				.div(PERCENTAGE_PRECISION)
				.mul(sinceLast)
				.div(ONE_YEAR);
			const protocolFeePayment = BN.min(
				totalFeePayment,
				depositorsEquity.sub(new BN(1))
			)
				.mul(vaultProtocol.protocolFee)
				.div(totalFee);

			const newTotalSharesFactor = depositorsEquity
				.mul(PERCENTAGE_PRECISION)
				.div(
					depositorsEquity.sub(managementFeePayment).sub(protocolFeePayment)
				);
			const newTotalShares = BN.max(
				accountData.totalShares
					.mul(newTotalSharesFactor)
					.div(PERCENTAGE_PRECISION),
				accountData.userShares
			);

			if (
				(managementFeePayment.eq(ZERO) && protocolFeePayment.eq(ZERO)) ||
				accountData.totalShares.eq(newTotalShares)
			) {
				return {
					totalShares: accountData.totalShares,
					managementFeeShares: ZERO,
					protocolFeeShares: ZERO,
				};
			}

			const managementFeeShares = newTotalShares.sub(accountData.totalShares);
			const protocolFeeShares = newTotalShares.sub(accountData.totalShares);

			return {
				totalShares: newTotalShares,
				managementFeeShares,
				protocolFeeShares,
			};
		} else if (
			accountData.managementFee.eq(ZERO) &&
			!vaultProtocol.protocolFee.eq(ZERO) &&
			depositorsEquity.gt(ZERO)
		) {
			const protocolFeePayment = depositorsEquity
				.mul(vaultProtocol.protocolFee)
				.div(PERCENTAGE_PRECISION)
				.mul(sinceLast)
				.div(ONE_YEAR);

			const newTotalSharesFactor = depositorsEquity
				.mul(PERCENTAGE_PRECISION)
				.div(depositorsEquity.sub(protocolFeePayment));
			const newTotalShares = BN.max(
				accountData.totalShares
					.mul(newTotalSharesFactor)
					.div(PERCENTAGE_PRECISION),
				accountData.userShares
			);

			if (
				protocolFeePayment.eq(ZERO) ||
				accountData.totalShares.eq(newTotalShares)
			) {
				return {
					totalShares: accountData.totalShares,
					managementFeeShares: ZERO,
					protocolFeeShares: ZERO,
				};
			}

			const protocolFeeShares = newTotalShares.sub(accountData.totalShares);
			return {
				totalShares: newTotalShares,
				managementFeeShares: ZERO,
				protocolFeeShares,
			};
		} else if (
			!accountData.managementFee.eq(ZERO) &&
			vaultProtocol.protocolFee.eq(ZERO) &&
			depositorsEquity.gt(ZERO)
		) {
			const managementFeePayment = BN.min(
				depositorsEquity
					.mul(accountData.managementFee)
					.div(PERCENTAGE_PRECISION)
					.mul(sinceLast)
					.div(ONE_YEAR),
				depositorsEquity.sub(ONE)
			);
			const newTotalSharesFactor = depositorsEquity
				.mul(PERCENTAGE_PRECISION)
				.div(depositorsEquity.sub(managementFeePayment));
			const newTotalShares = BN.max(
				accountData.totalShares
					.mul(newTotalSharesFactor)
					.div(PERCENTAGE_PRECISION),
				accountData.userShares
			);

			if (
				managementFeePayment.eq(ZERO) ||
				accountData.totalShares.eq(newTotalShares)
			) {
				return {
					totalShares: accountData.totalShares,
					managementFeeShares: ZERO,
					protocolFeeShares: ZERO,
				};
			}

			const managementFeeShares = newTotalShares.sub(accountData.totalShares);
			return {
				totalShares: newTotalShares,
				managementFeeShares,
				protocolFeeShares: ZERO,
			};
		} else {
			return {
				totalShares: accountData.totalShares,
				managementFeeShares: ZERO,
				protocolFeeShares: ZERO,
			};
		}
	}
}
