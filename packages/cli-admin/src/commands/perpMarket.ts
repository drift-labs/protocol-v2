import { Command } from 'commander';
import { BN } from '@coral-xyz/anchor';
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
			.command('set-fee-buffer <market> <amount>')
			.description(
				'Pnl-pool retention buffer the streaming fee sweep leaves above live user claims for the IF/AMM-provision drains; the protocol drain is buffer-exempt (raw u64, QUOTE_PRECISION).'
			)
	).action(async (market: string, amount: string, _flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const provider = buildProvider(opts);
		const client = await buildAdminClient(opts);
		try {
			const ix = await client.getUpdatePerpMarketFeePoolBufferTargetIx(
				Number.parseInt(market, 10),
				new BN(amount)
			);
			const result = await sendOrPropose(
				provider,
				[ix],
				opts.multisig ? new PublicKey(opts.multisig) : undefined,
				'velocity-admin perp-market set-fee-buffer'
			);
			reportDispatch(`perp-market[${market}] fee buffer = ${amount}`, result);
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

	withGlobalOptions(
		pm
			.command('set-funding-dead-zone <market> <threshold> <slope>')
			.description(
				'Funding dead zone: threshold (u32, bps) is the noise band where the premium stays zero; slope (u32, PERCENTAGE_PRECISION, 1000000 = 1.0x) is the ramp applied to the spread past the band. 5 / 1000000 reproduces the launch defaults.'
			)
	).action(
		async (
			market: string,
			threshold: string,
			slope: string,
			_flags,
			cmd: Command
		) => {
			const opts = readGlobalOpts(cmd);
			const provider = buildProvider(opts);
			const client = await buildAdminClient(opts);
			try {
				const thresholdValue = Number.parseInt(threshold, 10);
				if (
					!Number.isInteger(thresholdValue) ||
					thresholdValue < 0 ||
					thresholdValue >= 10000
				) {
					throw new Error(
						`threshold must be an integer in [0, 10000) bps, got "${threshold}"`
					);
				}
				const slopeValue = Number.parseInt(slope, 10);
				if (!Number.isInteger(slopeValue) || slopeValue <= 0) {
					throw new Error(
						`slope must be a positive integer (PERCENTAGE_PRECISION), got "${slope}"`
					);
				}
				const ix = await client.getUpdatePerpMarketFundingDeadZoneIx(
					Number.parseInt(market, 10),
					thresholdValue,
					slopeValue
				);
				const result = await sendOrPropose(
					provider,
					[ix],
					opts.multisig ? new PublicKey(opts.multisig) : undefined,
					'velocity-admin perp-market set-funding-dead-zone'
				);
				reportDispatch(
					`perp-market[${market}] funding_clamp_threshold = ${thresholdValue}, funding_ramp_slope = ${slopeValue}`,
					result
				);
			} finally {
				await client.unsubscribe();
			}
		}
	);
}
