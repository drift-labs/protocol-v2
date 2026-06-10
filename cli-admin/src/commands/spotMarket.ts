import { Command } from 'commander';
import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { readGlobalOpts, withGlobalOptions } from '../lib/options';
import { buildAdminClient, buildProvider } from '../lib/provider';
import { reportDispatch, sendOrPropose } from '../lib/squads';

export function registerSpotMarket(parent: Command): void {
	const sm = parent
		.command('spot-market')
		.description('Spot market governance.');

	withGlobalOptions(
		sm
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
			const ix = await client.getUpdateSpotMarketStatusIx(
				Number.parseInt(market, 10),
				enumVariant as never
			);
			const result = await sendOrPropose(
				provider,
				[ix],
				opts.multisig ? new PublicKey(opts.multisig) : undefined,
				'velocity-admin spot-market set-status'
			);
			reportDispatch(`spot-market[${market}] status = ${status}`, result);
		} finally {
			await client.unsubscribe();
		}
	});

	withGlobalOptions(
		sm
			.command('set-guard-threshold <market> <threshold>')
			.description(
				'Per-market withdraw guard threshold (raw u64, in token base units).'
			)
	).action(async (market: string, threshold: string, _flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const provider = buildProvider(opts);
		const client = await buildAdminClient(opts);
		try {
			const ix = await client.getUpdateWithdrawGuardThresholdIx(
				Number.parseInt(market, 10),
				new BN(threshold)
			);
			const result = await sendOrPropose(
				provider,
				[ix],
				opts.multisig ? new PublicKey(opts.multisig) : undefined,
				'velocity-admin spot-market set-guard-threshold'
			);
			reportDispatch(
				`spot-market[${market}] guard-threshold = ${threshold}`,
				result
			);
		} finally {
			await client.unsubscribe();
		}
	});
}
