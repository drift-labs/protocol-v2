import { Command } from 'commander';
import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { readGlobalOpts, withGlobalOptions } from '../lib/options';
import { buildAdminClient, buildProvider } from '../lib/provider';
import { reportDispatch, sendOrPropose } from '../lib/squads';

export function registerUser(parent: Command): void {
	const user = parent.command('user').description('Per-user admin actions.');

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
