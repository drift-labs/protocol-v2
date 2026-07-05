import { Command } from 'commander';
import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { readGlobalOpts, withGlobalOptions } from '../lib/options';
import { buildAdminClient, buildProvider } from '../lib/provider';
import { reportDispatch, sendOrPropose } from '../lib/squads';
import { deriveAssociatedTokenAccount, resolveAuthority } from '../lib/userOps';

export function registerUser(parent: Command): void {
	const user = parent.command('user').description('Per-user admin actions.');

	withGlobalOptions(
		user
			.command('deposit <market> <amount>')
			.description(
				'Deposit into a spot market as the user authority. <amount> is raw token units. ' +
					'With --multisig the authority defaults to the vault 0 PDA and the deposit is proposed as a vault transaction.'
			)
			.option(
				'--authority <pubkey>',
				'user authority (default: signer, or vault 0 PDA with --multisig)'
			)
			.option('--sub-account <id>', 'user sub-account id', '0')
			.option(
				'--user-token-account <pubkey>',
				"source token account (default: the authority's ATA for the market mint)"
			)
			.option('--reduce-only', 'only reduce an existing borrow', false)
	).action(async (market: string, amount: string, _flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const local = cmd.opts() as {
			authority?: string;
			subAccount: string;
			userTokenAccount?: string;
			reduceOnly: boolean;
		};
		const marketIndex = Number.parseInt(market, 10);
		const subAccountId = Number.parseInt(local.subAccount, 10);
		const authority = resolveAuthority(opts, local.authority);
		const provider = buildProvider(opts);
		const client = await buildAdminClient(opts, true, {
			authority,
			subAccountId,
		});
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
			const ix = await (client as any).getDepositInstruction(
				new BN(amount),
				marketIndex,
				userTokenAccount,
				subAccountId,
				local.reduceOnly,
				true,
				{ authority }
			);
			const result = await sendOrPropose(
				provider,
				[ix],
				opts.multisig ? new PublicKey(opts.multisig) : undefined,
				'velocity-admin user deposit'
			);
			reportDispatch(
				`deposit spot[${marketIndex}] amount=${amount} authority=${authority.toBase58()} sub=${subAccountId}`,
				result
			);
		} finally {
			await client.unsubscribe();
		}
	});

	withGlobalOptions(
		user
			.command('withdraw <market> <amount>')
			.description(
				'Withdraw from a spot market as the user authority. <amount> is raw token units. ' +
					'With --multisig the authority defaults to the vault 0 PDA and the withdraw is proposed as a vault transaction.'
			)
			.option(
				'--authority <pubkey>',
				'user authority (default: signer, or vault 0 PDA with --multisig)'
			)
			.option('--sub-account <id>', 'user sub-account id', '0')
			.option(
				'--user-token-account <pubkey>',
				"destination token account (default: the authority's ATA for the market mint; must exist)"
			)
			.option('--reduce-only', 'never flip the position into a borrow', false)
	).action(async (market: string, amount: string, _flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const local = cmd.opts() as {
			authority?: string;
			subAccount: string;
			userTokenAccount?: string;
			reduceOnly: boolean;
		};
		const marketIndex = Number.parseInt(market, 10);
		const subAccountId = Number.parseInt(local.subAccount, 10);
		const authority = resolveAuthority(opts, local.authority);
		const provider = buildProvider(opts);
		const client = await buildAdminClient(opts, true, {
			authority,
			subAccountId,
		});
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
			const ix = await (client as any).getWithdrawIx(
				new BN(amount),
				marketIndex,
				userTokenAccount,
				local.reduceOnly,
				subAccountId,
				{ authority }
			);
			const result = await sendOrPropose(
				provider,
				[ix],
				opts.multisig ? new PublicKey(opts.multisig) : undefined,
				'velocity-admin user withdraw'
			);
			reportDispatch(
				`withdraw spot[${marketIndex}] amount=${amount} authority=${authority.toBase58()} sub=${subAccountId}`,
				result
			);
		} finally {
			await client.unsubscribe();
		}
	});

	withGlobalOptions(
		user
			.command('set-special-status <user> <status>')
			.description(
				'Toggle a per-user special status flag. <status> is a u8 bitfield.'
			)
	).action(async (userPk: string, status: string, _flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const provider = buildProvider(opts);
		const client = await buildAdminClient(opts);
		try {
			const ix = await (client as any).getUpdateUserSpecialStatusIx(
				new PublicKey(userPk),
				Number.parseInt(status, 10)
			);
			const result = await sendOrPropose(
				provider,
				[ix],
				opts.multisig ? new PublicKey(opts.multisig) : undefined,
				'velocity-admin user set-special-status'
			);
			reportDispatch(`user[${userPk}] special-status = ${status}`, result);
		} finally {
			await client.unsubscribe();
		}
	});

	withGlobalOptions(
		user
			.command('admin-deposit <market> <amount>')
			.description(
				'Admin deposit on behalf of a user. <amount> is raw token units.'
			)
			.requiredOption('--user <pubkey>', 'target user account being credited')
			.requiredOption(
				'--user-token-account <pubkey>',
				'admin signer ATA funding the deposit'
			)
	).action(async (market: string, amount: string, _flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const local = cmd.opts() as { user: string; userTokenAccount: string };
		const provider = buildProvider(opts);
		const client = await buildAdminClient(opts);
		try {
			const ix = await (client as any).getAdminDepositIx(
				Number.parseInt(market, 10),
				new BN(amount),
				new PublicKey(local.user),
				new PublicKey(local.userTokenAccount)
			);
			const result = await sendOrPropose(
				provider,
				[ix],
				opts.multisig ? new PublicKey(opts.multisig) : undefined,
				'velocity-admin user admin-deposit'
			);
			reportDispatch(
				`admin-deposit spot[${market}] amount=${amount} → ${local.user}`,
				result
			);
		} finally {
			await client.unsubscribe();
		}
	});
}
