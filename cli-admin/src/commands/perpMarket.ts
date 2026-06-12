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

	withGlobalOptions(
		pm
			.command('set-funding-bias-sensitivity <market> <sensitivity>')
			.description(
				'Funding bias sensitivity (u8, hundredths): paying-side spread widens up to 1 + sensitivity/100 while the vAMM pays funding. 50 => up to 1.5x, 0 disables.'
			)
	).action(
		async (market: string, sensitivity: string, _flags, cmd: Command) => {
			const opts = readGlobalOpts(cmd);
			const provider = buildProvider(opts);
			const client = await buildAdminClient(opts);
			try {
				const value = Number.parseInt(sensitivity, 10);
				if (!Number.isInteger(value) || value < 0 || value > 255) {
					throw new Error(
						`sensitivity must be an integer in [0, 255], got "${sensitivity}"`
					);
				}
				const ix = await client.getUpdatePerpMarketFundingBiasSensitivityIx(
					Number.parseInt(market, 10),
					value
				);
				const result = await sendOrPropose(
					provider,
					[ix],
					opts.multisig ? new PublicKey(opts.multisig) : undefined,
					'velocity-admin perp-market set-funding-bias-sensitivity'
				);
				reportDispatch(
					`perp-market[${market}] funding_bias_sensitivity = ${value}`,
					result
				);
			} finally {
				await client.unsubscribe();
			}
		}
	);
}
