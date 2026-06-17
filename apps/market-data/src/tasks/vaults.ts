import { bnStringToNumber, getSpotMarkets, logger, simpleSerialize } from '@backend/common';
import { StatsCacheRepository } from '@backend/redis';
import { VaultClient } from '@velocity-exchange/vaults-sdk';
import { BN, PERCENTAGE_PRECISION } from '@velocity-exchange/sdk';
import { Scheduler } from '../services/scheduler';

const SPOT_MARKETS = getSpotMarkets();
const { setVaultStats } = StatsCacheRepository();

export const setupVaultTasks = ({
	vaultClient,
	scheduler,
}: {
	vaultClient: VaultClient;
	scheduler: ReturnType<typeof Scheduler>;
}) => {
	scheduler.scheduleTask(
		'vault-stats',
		'* * * * *',
		async () => {
			logger.info('Fetching vaults');
			const vaults = await vaultClient.program.account.vault.all();

			const serialisedVaults = vaults
				.filter((vault) => vault.account.userShares.gt(new BN(0)))
				.map((vault) => simpleSerialize(vault))
				.map((vault) => {
					const spotMarket = SPOT_MARKETS.find(
						(x) => x.marketIndex === Number(vault.account.spotMarketIndex)
					);
					const spotPrecision = spotMarket?.precision;

					return {
						// Basic identification
						pubkey: vault.publicKey,
						manager: vault.account.manager,
						tokenAccount: vault.account.tokenAccount,
						userStats: vault.account.userStats,
						user: vault.account.user,
						delegate: vault.account.delegate,
						liquidationDelegate: vault.account.liquidationDelegate,

						// Shares information
						userShares: bnStringToNumber(vault.account.userShares),
						totalShares: bnStringToNumber(vault.account.totalShares),
						sharesBase: bnStringToNumber(vault.account.sharesBase),

						// Timestamps and periods
						lastFeeUpdateTs: bnStringToNumber(vault.account.lastFeeUpdateTs),
						liquidationStartTs: bnStringToNumber(vault.account.liquidationStartTs),
						redeemPeriod: bnStringToNumber(vault.account.redeemPeriod),
						initTs: bnStringToNumber(vault.account.initTs),

						// Token amounts
						totalWithdrawRequested: bnStringToNumber(
							vault.account.totalWithdrawRequested,
							spotPrecision
						),
						maxTokens: bnStringToNumber(vault.account.maxTokens, spotPrecision),

						// Deposits and withdrawals
						netDeposits: bnStringToNumber(vault.account.netDeposits, spotPrecision),
						totalDeposits: bnStringToNumber(vault.account.totalDeposits, spotPrecision),
						totalWithdraws: bnStringToNumber(
							vault.account.totalWithdraws,
							spotPrecision
						),

						// Manager financials
						managerNetDeposits: bnStringToNumber(
							vault.account.managerNetDeposits,
							spotPrecision
						),
						managerTotalDeposits: bnStringToNumber(
							vault.account.managerTotalDeposits,
							spotPrecision
						),
						managerTotalWithdraws: bnStringToNumber(
							vault.account.managerTotalWithdraws,
							spotPrecision
						),
						managerTotalFee: bnStringToNumber(
							vault.account.managerTotalFee,
							spotPrecision
						),
						managerTotalProfitShare: bnStringToNumber(
							vault.account.managerTotalProfitShare,
							spotPrecision
						),

						lastManagerWithdrawRequest: {
							shares: bnStringToNumber(
								vault.account.lastManagerWithdrawRequest.shares
							),
							value: bnStringToNumber(
								vault.account.lastManagerWithdrawRequest.value,
								spotPrecision
							),
							ts: bnStringToNumber(vault.account.lastManagerWithdrawRequest.ts),
						},

						minDepositAmount: bnStringToNumber(
							vault.account.minDepositAmount,
							spotPrecision
						),
						profitShare: bnStringToNumber(
							vault.account.profitShare,
							PERCENTAGE_PRECISION
						),
						managementFee: bnStringToNumber(
							vault.account.managementFee,
							PERCENTAGE_PRECISION
						),
						hurdleRate: vault.account.hurdleRate,
						spotMarketIndex: vault.account.spotMarketIndex,
						permissioned: vault.account.permissioned,
					};
				});

			setVaultStats(serialisedVaults);
			logger.info('Stored vaults');
		},
		{
			runImmediately: true,
		}
	);
};
