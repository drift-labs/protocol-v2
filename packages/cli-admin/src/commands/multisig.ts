import { Command } from 'commander';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { readGlobalOpts, withGlobalOptions } from '../lib/options';
import { buildProvider } from '../lib/provider';

const { Permission, Permissions } = multisig.types;

export function registerMultisig(parent: Command): void {
	const ms = parent
		.command('multisig')
		.description('Squads V4 multisig management.');

	withGlobalOptions(
		ms
			.command('create')
			.description(
				[
					'Create a Squads V4 multisig with the current wallet as a 1/1 signer',
					'(full Initiate/Vote/Execute permissions) plus a proposer member that',
					'can only Initiate transactions. Intended for devnet bring-up.',
				].join('\n')
			)
			.requiredOption(
				'--proposer <pubkey>',
				'member granted Initiate-only permission (can propose, not vote/execute)'
			)
			.option(
				'--name <name>',
				'multisig name (stored as the create memo)',
				'Velocity Devnet Multisig'
			)
	).action(async (_flags, cmd: Command) => {
		const opts = readGlobalOpts(cmd);
		const provider = buildProvider(opts);
		const localOpts = cmd.optsWithGlobals();
		const proposer = new PublicKey(localOpts.proposer as string);
		const name = localOpts.name as string;

		const creator = provider.wallet.publicKey;

		// The createKey is an ephemeral signer that seeds the multisig PDA.
		const createKey = Keypair.generate();
		const [multisigPda] = multisig.getMultisigPda({
			createKey: createKey.publicKey,
		});
		const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

		// Treasury is read from the on-chain Squads program config.
		const [programConfigPda] = multisig.getProgramConfigPda({});
		const programConfig =
			await multisig.accounts.ProgramConfig.fromAccountAddress(
				provider.connection,
				programConfigPda
			);

		const createIx = multisig.instructions.multisigCreateV2({
			createKey: createKey.publicKey,
			creator,
			multisigPda,
			configAuthority: null,
			timeLock: 0,
			threshold: 1,
			rentCollector: null,
			treasury: programConfig.treasury,
			memo: name,
			members: [
				{ key: creator, permissions: Permissions.all() },
				{
					key: proposer,
					permissions: Permissions.fromPermissions([Permission.Initiate]),
				},
			],
		});

		const tx = new Transaction().add(createIx);
		const signature = await provider.sendAndConfirm(tx, [createKey]);

		console.log(`✓ created multisig "${name}"`);
		console.log(`  multisig PDA: ${multisigPda.toBase58()}`);
		console.log(`  vault (index 0): ${vaultPda.toBase58()}`);
		console.log(`  threshold: 1/1`);
		console.log(`  signer (all perms): ${creator.toBase58()}`);
		console.log(`  proposer (initiate-only): ${proposer.toBase58()}`);
		console.log(`  signature: ${signature}`);
	});
}
