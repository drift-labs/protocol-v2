import { PublicKey } from '@solana/web3.js';
import { OptionValues, Command } from 'commander';
import { getCommandContext } from '../utils';
import {
	BN,
	PERCENTAGE_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	User,
	ZERO,
	convertToNumber,
	decodeName,
} from '@velocity-exchange/sdk';
import { calculateApplyProfitShare } from '../../src/math';
import { VaultDepositor } from '../../src';

export const vaultInvariantChecks = async (
	program: Command,
	cmdOpts: OptionValues
) => {
	let vaultAddress: PublicKey;
	try {
		vaultAddress = new PublicKey(cmdOpts.vaultAddress as string);
	} catch (err) {
		console.error('Invalid vault address');
		process.exit(1);
	}

	const { driftVault, driftClient } = await getCommandContext(program, true);

	/*
    Invariants:
    * sum(vault_depositors.shares) == vault.user_shares
    * sum(vault_depositors.profit_share_paid) == vault.manager_total_profit_share
    */

	const vault = await driftVault.getVault(vaultAddress);
	const spotMarket = driftVault.driftClient.getSpotMarketAccount(
		vault.spotMarketIndex
	);
	const spotPrecision = new BN(10).pow(new BN(spotMarket!.decimals));
	const spotOracle = driftVault.driftClient.getOracleDataForSpotMarket(
		vault.spotMarketIndex
	);
	const spotOraclePriceNum = convertToNumber(spotOracle.price, PRICE_PRECISION);
	const spotSymbol = decodeName(spotMarket!.name);

	const user = new User({
		// accountSubscription,
		driftClient,
		userAccountPublicKey: vault.user,
	});
	await user.subscribe();

	const vaultEquity = await driftVault.calculateVaultEquity({
		vault,
	});
	const vaultEquitySpot = vaultEquity.mul(spotPrecision).div(spotOracle.price);

	const allVaultDepositors = await driftVault.getAllVaultDepositors(
		vaultAddress
	);
	const approxSlot = await driftVault.driftClient.connection.getSlot();
	const now = Date.now();

	// let nonZeroDepositors = allVaultDepositors.filter(vd => vd.account.vaultShares.gt(new BN(0)));
	// nonZeroDepositors = nonZeroDepositors.sort((a, b) => b.account.vaultShares.cmp(a.account.vaultShares));

	let totalUserShares = new BN(0);
	let totalUserProfits = 0;
	let totalUserCumProfits = 0;
	let totalUserProfitSharePaid = new BN(0);
	let totalUserProfitShareSharesPaid = new BN(0);
	let totalPendingProfitShareAmount = new BN(0);
	let totalPendingProfitShareShares = new BN(0);
	let totalUserNetDeposits = new BN(0);

	console.log(
		`Vault ${vaultAddress} vd and invariant check at approx slot: ${approxSlot}, date: ${new Date(
			now
		).toLocaleString()}`
	);
	let nonZero = 0;
	let usersWithoutPendingProfitShare = 0;
	let usersWithPendingProfitShare = 0;
	const sortedVd = allVaultDepositors.sort((a, b) =>
		b.account.vaultShares.cmp(a.account.vaultShares)
	);
	const checkAuths: Array<string> = [];
	for (const vd of sortedVd) {
		const vdAccount = vd.account as VaultDepositor;

		if (vdAccount.vaultShares.gt(new BN(0))) {
			nonZero++;
		}
		totalUserNetDeposits = totalUserNetDeposits.add(vdAccount.netDeposits);

		totalUserShares = totalUserShares.add(vdAccount.vaultShares);
		const vdAuth = vdAccount.authority.toBase58();
		const vdPct =
			vdAccount.vaultShares.toNumber() / vault.totalShares.toNumber();
		console.log(
			`- ${vdAuth} has ${vdAccount.vaultShares.toNumber()} shares (${
				vdPct * 100.0
			}% of vault)`
		);

		if (!vdAccount.lastWithdrawRequest.shares.eq(new BN(0))) {
			const withdrawRequested = vdAccount.lastWithdrawRequest.ts.toNumber();
			const secToWithdrawal =
				withdrawRequested + vault.redeemPeriod.toNumber() - Date.now() / 1000;
			const withdrawAvailable = secToWithdrawal < 0;
			const pct =
				vdAccount.lastWithdrawRequest.shares.toNumber() /
				vd.account.vaultShares.toNumber();
			const daysUntilWithdraw = Math.floor(secToWithdrawal / 86400);
			const hoursUntilWithdraw = Math.floor((secToWithdrawal % 86400) / 3600);

			console.log(
				`  - pending withdrawal: ${vdAccount.lastWithdrawRequest.shares.toString()} ($${convertToNumber(
					vd.account.lastWithdrawRequest.value,
					spotPrecision
				)}), ${(pct * 100.0).toFixed(2)}% of their deposit ${
					withdrawAvailable ? '<--- WITHDRAWABLE' : ''
				}`
			);
			console.log(
				`    - requested at: ${new Date(
					withdrawRequested * 1000
				).toISOString()}`
			);
			console.log(
				`    - can withdraw in: ${daysUntilWithdraw} days and ${hoursUntilWithdraw} hours`
			);
		}

		totalUserProfitSharePaid = totalUserProfitSharePaid.add(
			vdAccount.profitShareFeePaid
		);
		totalUserProfitShareSharesPaid = totalUserProfitShareSharesPaid.add(
			vdAccount.cumulativeProfitShareAmount
		);

		const pendingProfitShares = calculateApplyProfitShare(
			vdAccount,
			vaultEquitySpot,
			vault
		);
		const pendingProfitShareAmtNum = convertToNumber(
			pendingProfitShares.profitShareAmount,
			spotPrecision
		);
		if (pendingProfitShares.profitShareAmount.gt(ZERO)) {
			totalPendingProfitShareAmount = totalPendingProfitShareAmount.add(
				pendingProfitShares.profitShareAmount
			);
			totalPendingProfitShareShares = totalPendingProfitShareShares.add(
				pendingProfitShares.profitShareShares
			);
			console.log(
				`  - pending profit share amount: ${convertToNumber(
					pendingProfitShares.profitShareAmount,
					spotPrecision
				)}`
			);
			usersWithPendingProfitShare++;
		} else {
			console.log(`  - no pending profit share`);
			usersWithoutPendingProfitShare++;
		}

		const userShareValue = vaultEquitySpot
			.mul(vdAccount.vaultShares)
			.div(vault.totalShares);
		const userShareValueNum = convertToNumber(userShareValue, spotPrecision);
		const netDepositsNum = convertToNumber(
			vdAccount.netDeposits,
			spotPrecision
		);
		const vdProfits = userShareValueNum - netDepositsNum;
		const profitSharePaid = convertToNumber(
			vdAccount.profitShareFeePaid,
			spotPrecision
		);
		const cumProfitShareNum = convertToNumber(
			vdAccount.cumulativeProfitShareAmount,
			spotPrecision
		);
		totalUserProfits += vdProfits;
		totalUserCumProfits += cumProfitShareNum;
		console.log(`  - net deposits:       ${netDepositsNum}`);
		console.log(`  - vd profit:          ${vdProfits}`);
		console.log(`  - cumProfitshareAmt:  ${cumProfitShareNum}`);
		console.log(
			`  - profitShareFeePaid: ${convertToNumber(
				vdAccount.profitShareFeePaid,
				spotPrecision
			)}`
		);
		const inclProfitShare =
			((profitSharePaid + pendingProfitShareAmtNum) /
				(cumProfitShareNum + pendingProfitShareAmtNum)) *
			100.0;
		console.log(
			`  - pftSharePaidPct (excl pend): ${(
				(profitSharePaid / cumProfitShareNum) *
				100.0
			).toFixed(2)}%`
		);
		console.log(
			`  - pftSharePaidPct (incl pend): ${inclProfitShare.toFixed(2)}% `
		);
		if (inclProfitShare < 29.9 && inclProfitShare > 0) {
			console.log(`  ^^^ weird: ${inclProfitShare}`);
			checkAuths.push(vdAuth);
		}

		if (vdAccount.vaultSharesBase !== 0) {
			console.log(
				`  - Nonzero vault shares base: ${vdAccount.vaultSharesBase} `
			);
		}
	}
	console.log(`Check these auths:\n${checkAuths.join('\n')}`);
	console.log(
		`Depositors with 0 shares: ${allVaultDepositors.length - nonZero} /${
			allVaultDepositors.length
		}`
	);
	console.log(
		`Depositors with pending profit share:    ${usersWithPendingProfitShare}`
	);
	console.log(
		`Depositors without pending profit share: ${usersWithoutPendingProfitShare}`
	);

	console.log(`==== Vault Depositor Shares == vault.user_shares ====`);
	console.log(`total vd shares:        ${totalUserShares.toString()}`);
	console.log(`total vault usershares: ${vault.userShares.toString()}`);
	console.log(`diff: ${vault.userShares.sub(totalUserShares)}`);

	console.log(``);
	console.log(
		`==== Vault Depositor ProfitSharePaid == vault.manager_total_profit_share ====`
	);
	console.log(
		`total vault d profitshares: ${totalUserProfitSharePaid.toString()}`
	);
	console.log(
		`vault total profit shares:  ${vault.managerTotalProfitShare.toString()}`
	);
	console.log(
		`diff: ${vault.managerTotalProfitShare.sub(totalUserProfitSharePaid)}`
	);

	console.log(``);
	console.log(`==== Pending profit shares to realize ====`);
	const totalPendingProfitShareAmountNum = convertToNumber(
		totalPendingProfitShareAmount,
		spotPrecision
	);
	const totalUserProfitSharePaidNum = convertToNumber(
		totalUserProfitSharePaid,
		spotPrecision
	);
	console.log(`amount: ${totalPendingProfitShareAmountNum}`);
	console.log(`shares: ${totalPendingProfitShareShares.toNumber()}`);
	// console.log(`csv: ${cmdOpts.csv}`);

	console.log(``);
	console.log(`==== Agg user profit share paid ====`);
	console.log(
		`vd total profit (incl unrealized profit share):      ${totalUserProfits}`
	);
	console.log(
		`vd total cum profits (before pending profit share):  ${totalUserCumProfits}`
	);
	console.log(
		`vd total profit share paid):                         ${totalUserProfitSharePaidNum}`
	);
	console.log(
		`vd total pending profit share:                       ${totalPendingProfitShareAmountNum}`
	);
	console.log(
		`vd total net deposits:       ${convertToNumber(
			totalUserNetDeposits,
			spotPrecision
		)}`
	);
	const driftUserDeposits = user.getUserAccount().totalDeposits;
	const driftUserWithdraws = user.getUserAccount().totalWithdraws;
	const driftUserSocialLoss = user.getUserAccount().totalSocialLoss;
	console.log(
		`vd drift user net deposits:  ${convertToNumber(
			driftUserDeposits.sub(driftUserWithdraws).sub(driftUserSocialLoss),
			spotPrecision
		)}`
	);
	console.log(
		`  vd drift user deps: ${convertToNumber(driftUserDeposits, spotPrecision)}`
	);
	console.log(
		`  vd drift user with: ${convertToNumber(
			driftUserWithdraws,
			spotPrecision
		)}`
	);
	console.log(
		`  vd drift user scls: ${convertToNumber(
			driftUserSocialLoss,
			spotPrecision
		)}`
	);

	console.log(``);
	console.log(`==== Manager share ====`);
	console.log(`  Vault total shares: ${vault.totalShares.toNumber()}`);
	const managerShares = vault.totalShares.sub(vault.userShares);
	const managerSharePct =
		managerShares.toNumber() / vault.totalShares.toNumber();
	const managerShareWithPendingPct =
		managerShares.add(totalPendingProfitShareShares).toNumber() /
		vault.totalShares.toNumber();
	console.log(
		`  Manager shares: ${managerShares.toString()} (${(
			managerSharePct * 100.0
		).toFixed(4)}%)`
	);
	const vaultEquityNum = convertToNumber(vaultEquity, spotPrecision);
	const vaultEquitySpotNum = convertToNumber(vaultEquitySpot, spotPrecision);
	const vaultPnlNum = convertToNumber(
		user.getTotalAllTimePnl(),
		QUOTE_PRECISION
	);
	console.log(`vaultEquity (USDC):    $${vaultEquityNum}`);
	console.log(`vaultEquity (deposit asset): ${vaultEquitySpotNum}`);
	const managerValueWoPending = managerSharePct * vaultEquitySpotNum;
	const managerValueWithPending =
		managerShareWithPendingPct * vaultEquitySpotNum;
	console.log(
		`manager share (w/o pending) (deposit asset):  ${managerValueWoPending} (share: ${
			(managerValueWoPending / vaultPnlNum) * 100.0
		}%)`
	);
	console.log(
		`manager share (with pending) (deposit asset): ${managerValueWithPending} (share: ${
			(managerValueWithPending / vaultPnlNum) * 100.0
		}%)`
	);

	console.log(``);
	const profitSharePct = vault.profitShare / PERCENTAGE_PRECISION.toNumber();
	const vdPnlBeforeProfitShare =
		convertToNumber(totalUserProfitSharePaid, spotPrecision) / profitSharePct;
	console.log(
		`back out vault pnl: (userPnl + managerShareValue): ${totalUserProfits} + ${
			managerSharePct * vaultEquitySpotNum
		} = ${totalUserProfits + managerSharePct * vaultEquitySpotNum}`
	);
	console.log(
		`vaultDepositors pnl (before profit share): ${vdPnlBeforeProfitShare}`
	);

	console.log(
		`vault PnL (spot): ${
			vaultEquitySpotNum - convertToNumber(vault.netDeposits, spotPrecision)
		}`
	);
	console.log(`vault PnL (USD)   ${vaultPnlNum}`);
	console.log(`vault PnL (spot)  ${vaultPnlNum / spotOraclePriceNum}`);

	console.log(``);
	console.log(`==== ${decodeName(vault.name)} Profit Summary ====`);
	console.log(
		`Depositors' total PnL:                 ${totalUserProfits} ${spotSymbol}`
	);
	console.log(
		`Depositors' profit share paid to date: ${totalUserProfitSharePaidNum} ${spotSymbol}`
	);
	console.log(
		`Unrealized profit share:               ${totalPendingProfitShareAmountNum} ${spotSymbol}`
	);
	console.log(
		`Vault manager net deposits:          ${convertToNumber(
			vault.managerNetDeposits,
			spotPrecision
		)} ${spotSymbol}`
	);
	console.log(
		`Vault manager profit share received: ${convertToNumber(
			vault.managerTotalProfitShare,
			spotPrecision
		)} ${spotSymbol}`
	);
	console.log(
		`Vault manager share value:           ${managerValueWithPending} ${spotSymbol} (share of vault: ${
			(managerValueWithPending / vaultPnlNum) * 100.0
		}%)`
	);
	if (spotSymbol !== 'USDC') {
		console.log(
			`Vault manager share value:           ${
				managerValueWithPending * spotOraclePriceNum
			} USDC`
		);
	}
};
