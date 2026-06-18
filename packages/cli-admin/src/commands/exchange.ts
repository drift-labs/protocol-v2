import { Command } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { readGlobalOpts, withGlobalOptions } from '../lib/options';
import { buildAdminClient, buildProvider } from '../lib/provider';
import { reportDispatch, sendOrPropose } from '../lib/squads';

export function registerExchange(parent: Command): void {
	const ex = parent.command('exchange').description('Whole-protocol controls.');

	withGlobalOptions(
		ex
			.command('set-status <bitfield>')
			.description(
				'Set ExchangeStatus bitfield. 0=active. Bits: 1=depositPaused, 2=withdrawPaused, 4=ammPaused, 8=fillPaused, 16=liqPaused, 32=fundingPaused, 64=settlePnlPaused.'
			)
	).action(async (bitfield: string, _flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const provider = buildProvider(opts);
		const client = await buildAdminClient(opts);
		try {
			const ix = await client.getUpdateExchangeStatusIx(
				Number.parseInt(bitfield, 10)
			);
			const result = await sendOrPropose(
				provider,
				[ix],
				opts.multisig ? new PublicKey(opts.multisig) : undefined,
				'velocity-admin exchange set-status'
			);
			reportDispatch(`exchange status = ${bitfield}`, result);
		} finally {
			await client.unsubscribe();
		}
	});
}
