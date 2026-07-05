import { Command } from 'commander';
import { BN } from '@coral-xyz/anchor';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getInsuranceFundStakeAccountPublicKey } from '@velocity-exchange/sdk';
import { readGlobalOpts, withGlobalOptions } from '../lib/options';
import { buildAdminClient, buildProvider } from '../lib/provider';
import { reportDispatch, sendOrPropose } from '../lib/squads';
import { deriveAssociatedTokenAccount, resolveAuthority } from '../lib/userOps';

export function registerInsuranceFund(parent: Command): void {
	const insuranceFund = parent
		.command('if')
		.description('Insurance fund staking.');

	withGlobalOptions(
		insuranceFund
			.command('stake <market> <amount>')
			.description(
				'Stake into a spot market insurance fund as the authority. <amount> is raw token units. ' +
					'Initializes the stake account if missing (both instructions land in one transaction / proposal). ' +
					'With --multisig the authority defaults to the vault 0 PDA and the stake is proposed as a vault transaction.'
			)
			.option(
				'--authority <pubkey>',
				'stake authority (default: signer, or vault 0 PDA with --multisig)'
			)
			.option(
				'--user-token-account <pubkey>',
				"source token account (default: the authority's ATA for the market mint)"
			)
	).action(async (market: string, amount: string, _flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const local = cmd.opts() as {
			authority?: string;
			userTokenAccount?: string;
		};
		const marketIndex = Number.parseInt(market, 10);
		const authority = resolveAuthority(opts, local.authority);
		const provider = buildProvider(opts);
		const client = await buildAdminClient(opts, true, { authority });
		try {
			const spotMarket = (client as any).getSpotMarketAccountOrThrow(
				marketIndex
			);
			const tokenProgram = (client as any).getTokenProgramForSpotMarket(
				spotMarket
			);
			const userTokenAccount = local.userTokenAccount
				? new PublicKey(local.userTokenAccount)
				: deriveAssociatedTokenAccount(
						spotMarket.mint,
						authority,
						tokenProgram
				  );

			const ixs: TransactionInstruction[] = [];
			const ifStakePk = getInsuranceFundStakeAccountPublicKey(
				client.program.programId,
				authority,
				marketIndex
			);
			const stakeExists = await provider.connection.getAccountInfo(ifStakePk);
			if (!stakeExists) {
				ixs.push(
					await (client as any).getInitializeInsuranceFundStakeIx(marketIndex, {
						authority,
					})
				);
			}
			ixs.push(
				await (client as any).getAddInsuranceFundStakeIx(
					marketIndex,
					new BN(amount),
					userTokenAccount,
					{ authority }
				)
			);

			const result = await sendOrPropose(
				provider,
				ixs,
				opts.multisig ? new PublicKey(opts.multisig) : undefined,
				'velocity-admin if stake'
			);
			reportDispatch(
				`if-stake spot[${marketIndex}] amount=${amount} authority=${authority.toBase58()}${
					stakeExists ? '' : ' (+init stake account)'
				}`,
				result
			);
		} finally {
			await client.unsubscribe();
		}
	});
}
