import { Command } from 'commander';
import * as os from 'os';
import { GlobalOpts } from './provider';
import { DriftEnv } from '@velocity-exchange/sdk';

/**
 * Attach shared global options to every subcommand.
 *
 * commander v12 only walks `parent.opts()` once, so options declared on the
 * root must be redeclared on each leaf to surface in `--help` output and in
 * `cmd.opts()`. This helper keeps that consistent.
 */
export function withGlobalOptions(cmd: Command): Command {
	return cmd
		.option(
			'-u, --url <url>',
			'Solana RPC URL',
			'https://api.mainnet-beta.solana.com'
		)
		.option(
			'-k, --keypair <path>',
			'path to signer keypair JSON',
			`${os.homedir()}/.config/solana/id.json`
		)
		.option(
			'-e, --env <env>',
			'Drift env (mainnet-beta or devnet)',
			'mainnet-beta'
		)
		.option(
			'-m, --multisig <pubkey>',
			'Squads V4 multisig PDA — wraps the action in a vault transaction proposal instead of sending directly'
		);
}

export function readGlobalOpts(cmd: Command): GlobalOpts {
	const opts = cmd.optsWithGlobals();
	const env = opts.env as string;
	if (env !== 'mainnet-beta' && env !== 'devnet') {
		throw new Error(`unknown env "${env}" (expected mainnet-beta or devnet)`);
	}
	return {
		url: opts.url as string,
		keypair: opts.keypair as string,
		env: env as DriftEnv,
		multisig: opts.multisig as string | undefined,
	};
}
