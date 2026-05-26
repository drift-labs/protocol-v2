import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AdminClient, BulkAccountLoader, DriftEnv, initialize } from '@velocity-exchange/sdk';
import * as fs from 'fs';
import * as os from 'os';

export type GlobalOpts = {
	url: string;
	keypair: string;
	env: DriftEnv;
	multisig?: string;
};

export function loadKeypair(path: string): Keypair {
	const expanded = path.startsWith('~')
		? path.replace(/^~/, os.homedir())
		: path;
	const bytes = JSON.parse(fs.readFileSync(expanded, 'utf-8'));
	return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export function buildProvider(opts: GlobalOpts): AnchorProvider {
	const connection = new Connection(opts.url, 'confirmed');
	const wallet = new Wallet(loadKeypair(opts.keypair));
	const provider = new AnchorProvider(connection, wallet, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	anchor.setProvider(provider);
	return provider;
}

/**
 * Build an AdminClient.
 *
 * `subscribe` should be `false` for ops where the State account doesn't yet
 * exist (e.g. `initialize`) or where we don't need cached state — this avoids
 * a network round-trip per command.
 */
export async function buildAdminClient(
	opts: GlobalOpts,
	subscribe = true
): Promise<AdminClient> {
	const provider = buildProvider(opts);
	const sdkConfig = initialize({ env: opts.env });
	const programId = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);

	const client = new AdminClient({
		connection: provider.connection,
		wallet: provider.wallet,
		programID: programId,
		env: opts.env,
		opts: { commitment: 'confirmed', preflightCommitment: 'confirmed' },
		accountSubscription: subscribe
			? {
					type: 'polling',
					accountLoader: new BulkAccountLoader(provider.connection, 'confirmed', 1000),
			  }
			: undefined,
	});

	if (subscribe) {
		await client.subscribe();
	}

	return client;
}
