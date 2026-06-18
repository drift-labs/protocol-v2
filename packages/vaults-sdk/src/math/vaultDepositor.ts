import {
	BN,
	PERCENTAGE_PRECISION,
	ZERO,
	unstakeSharesToAmount as depositSharesToVaultAmount,
	stakeAmountToShares as vaultAmountToDepositorShares,
} from '@velocity-exchange/sdk';
import { Vault, VaultDepositor, VaultProtocol } from '../types/types';

/**
 * Calculates the unrealized profitShare for a vaultDepositor
 * @param vaultDepositor
 * @param vaultEquity
 * @param vault
 * @returns
 */
export function calculateApplyProfitShare(
	vaultDepositor: VaultDepositor,
	vaultEquity: BN,
	vault: Vault
): {
	profitShareAmount: BN;
	profitShareShares: BN;
} {
	const amount = depositSharesToVaultAmount(
		vaultDepositor.vaultShares,
		vault.totalShares,
		vaultEquity
	);
	const profitShareAmount = calculateProfitShare(vaultDepositor, amount, vault);
	const profitShareShares = vaultAmountToDepositorShares(
		profitShareAmount,
		vault.totalShares,
		vaultEquity
	);
	return {
		profitShareAmount,
		profitShareShares,
	};
}

export function calculateProfitShare(
	vaultDepositor: VaultDepositor,
	totalAmount: BN,
	vault: Vault,
	vaultProtocol?: VaultProtocol
) {
	const profit = totalAmount.sub(
		vaultDepositor.netDeposits.add(vaultDepositor.cumulativeProfitShareAmount)
	);
	let profitShare = vault.profitShare;
	if (vaultProtocol) {
		profitShare += vaultProtocol.protocolProfitShare;
	}
	if (profit.gt(ZERO)) {
		const profitShareAmount = profit
			.mul(new BN(profitShare))
			.div(PERCENTAGE_PRECISION);
		return profitShareAmount;
	}
	return ZERO;
}

/**
 * Calculates the equity across deposits and realized profit for a vaultDepositor
 * @param vaultDepositor vault depositor account
 * @param vaultEquity total vault equity
 * @param vault vault account
 * @param vaultProtocol if vault account has "vaultProtocol" then this is needed
 * @returns
 */
export function calculateRealizedVaultDepositorEquity(
	vaultDepositor: VaultDepositor,
	vaultEquity: BN,
	vault: Vault,
	vaultProtocol?: VaultProtocol
): BN {
	const vdAmount = depositSharesToVaultAmount(
		vaultDepositor.vaultShares,
		vault.totalShares,
		vaultEquity
	);
	const profitShareAmount = calculateProfitShare(
		vaultDepositor,
		vdAmount,
		vault,
		vaultProtocol
	);
	return vdAmount.sub(profitShareAmount);
}
