import { Command } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { readGlobalOpts, withGlobalOptions } from '../lib/options';
import { buildAdminClient, buildProvider } from '../lib/provider';
import { reportDispatch, sendOrPropose } from '../lib/squads';

export function registerPerpMarket(parent: Command): void {
	const pm = parent
		.command('perp-market')
		.description('Perp market governance.');

	withGlobalOptions(
		pm
			.command('set-status <market> <status>')
			.description(
				'Status: Active | Paused | ReduceOnly | Settlement | Delisted | Initialized.'
			)
	).action(async (market: string, status: string, _flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const provider = buildProvider(opts);
		const client = await buildAdminClient(opts);
		try {
			const enumVariant: { [k: string]: Record<string, never> } = {
				[status.charAt(0).toLowerCase() + status.slice(1)]: {},
			};
			const ix = await client.getUpdatePerpMarketStatusIx(
				Number.parseInt(market, 10),
				enumVariant as never
			);
			const result = await sendOrPropose(
				provider,
				[ix],
				opts.multisig ? new PublicKey(opts.multisig) : undefined,
				'velocity-admin perp-market set-status'
			);
			reportDispatch(`perp-market[${market}] status = ${status}`, result);
		} finally {
			await client.unsubscribe();
		}
	});
}
