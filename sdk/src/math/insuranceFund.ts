import { MarketsAccount, StateAccount } from '../types';
import { BN } from '../';
import { Connection } from '@solana/web3.js';

/**
 * In the case of a levered loss, the exchange first pays out undistributed fees and then the insurance fund.
 * Thus the de facto size of the insurance fund is the amount in the insurance vault plus the sum of each markets
 * undistributed fees.
 *
 * @param connection
 * @param state
 * @param marketsAccount
 * @returns Precision : QUOTE_ASSET_PRECISION
 */
export async function calculateInsuranceFundSize(
	connection: Connection,
	state: StateAccount,
	marketsAccount: MarketsAccount
): Promise<BN> {
	const insuranceVaultPublicKey = state.insuranceVault;
	const insuranceVaultAmount = new BN(
		(
			await connection.getTokenAccountBalance(insuranceVaultPublicKey)
		).value.amount
	);
	return marketsAccount.markets.reduce((insuranceVaultAmount, market) => {
		return insuranceVaultAmount.add(market.amm.totalFee.div(new BN(2)));
	}, insuranceVaultAmount);
}
