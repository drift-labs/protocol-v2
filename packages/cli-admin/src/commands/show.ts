import { Command } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { HotRole } from '@velocity-exchange/sdk';
import { readGlobalOpts, withGlobalOptions } from '../lib/options';
import { buildAdminClient } from '../lib/provider';

export function registerShow(parent: Command): void {
	const show = parent
		.command('show')
		.description('Read-only inspectors for the live admin authority state.');

	withGlobalOptions(
		show
			.command('config')
			.description(
				'Print the cold admin, warm admin, and every hot-role pubkey from State.'
			)
	).action(async (_flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const client = await buildAdminClient(opts);
		try {
			const state = client.getStateAccount();
			console.log('cold admin:', state.coldAdmin.toBase58());
			console.log('warm admin:', state.warmAdmin.toBase58());
			console.log(
				'pause admin:',
				state.pauseAdmin.equals(PublicKey.default)
					? '(unset)'
					: state.pauseAdmin.toBase58()
			);
			for (const role of Object.values(HotRole)) {
				const key = `hot${role.charAt(0).toUpperCase()}${role.slice(
					1
				)}` as keyof typeof state;
				const value = state[key] as unknown as PublicKey | undefined;
				const display =
					value && !value.equals(PublicKey.default)
						? value.toBase58()
						: '(unset)';
				console.log(`hot.${role}:`, display);
			}
			const recipientPerp = state.protocolFeeRecipientPerp;
			console.log(
				'protocol fee recipient (perp):',
				recipientPerp.equals(PublicKey.default)
					? '(unset)'
					: recipientPerp.toBase58()
			);
			const recipientSpot = state.protocolFeeRecipientSpot;
			console.log(
				'protocol fee recipient (spot):',
				recipientSpot.equals(PublicKey.default)
					? '(unset)'
					: recipientSpot.toBase58()
			);
			console.log(
				'trade-fee split: amm =',
				`${state.perpFeeStructure.ammFeeNumerator}%,`,
				'if =',
				`${state.perpFeeStructure.ifFeeNumerator}%,`,
				'protocol = residual'
			);
		} finally {
			await client.unsubscribe();
		}
	});
}
