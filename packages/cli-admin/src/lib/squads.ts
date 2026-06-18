import { AnchorProvider } from '@coral-xyz/anchor';
import {
	PublicKey,
	Transaction,
	TransactionInstruction,
	TransactionMessage,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';

export type DispatchResult =
	| { kind: 'sent'; signature: string }
	| {
			kind: 'proposed';
			multisig: PublicKey;
			transactionIndex: bigint;
			signature: string;
	  };

/**
 * Dispatch admin instructions either directly (signed by the wallet) or via a
 * Squads V4 multisig vault transaction + proposal. Mirrors helium-admin-cli's
 * `sendInstructionsOrSquadsV4`.
 *
 * If `multisigPda` is undefined, instructions are signed and sent directly.
 * Otherwise a `vaultTransactionCreate` + `proposalCreate` is submitted; the
 * wallet pays rent and is recorded as the proposer. Approval/execution still
 * happen through the multisig members (CLI does not auto-approve).
 */
export async function sendOrPropose(
	provider: AnchorProvider,
	instructions: TransactionInstruction[],
	multisigPda: PublicKey | undefined,
	memo: string
): Promise<DispatchResult> {
	if (!multisigPda) {
		const tx = new Transaction().add(...instructions);
		const signature = await provider.sendAndConfirm(tx);
		return { kind: 'sent', signature };
	}

	const info = await multisig.accounts.Multisig.fromAccountAddress(
		provider.connection,
		multisigPda
	);
	const transactionIndex = BigInt(Number(info.transactionIndex) + 1);

	const [vaultPda] = multisig.getVaultPda({
		multisigPda,
		index: 0,
	});

	const { blockhash } = await provider.connection.getLatestBlockhash();
	const transactionMessage = new TransactionMessage({
		payerKey: vaultPda,
		recentBlockhash: blockhash,
		instructions,
	});

	const createIx = multisig.instructions.vaultTransactionCreate({
		multisigPda,
		transactionIndex,
		creator: provider.wallet.publicKey,
		vaultIndex: 0,
		ephemeralSigners: 0,
		transactionMessage,
		memo,
	});

	const proposeIx = multisig.instructions.proposalCreate({
		multisigPda,
		transactionIndex,
		creator: provider.wallet.publicKey,
	});

	const tx = new Transaction().add(createIx, proposeIx);
	const signature = await provider.sendAndConfirm(tx);

	return {
		kind: 'proposed',
		multisig: multisigPda,
		transactionIndex,
		signature,
	};
}

export function reportDispatch(label: string, result: DispatchResult): void {
	if (result.kind === 'sent') {
		console.log(`✓ ${label}`);
		console.log(`  signature: ${result.signature}`);
	} else {
		console.log(
			`✓ ${label} proposed to multisig ${result.multisig.toBase58()}`
		);
		console.log(`  transactionIndex: ${result.transactionIndex.toString()}`);
		console.log(`  signature: ${result.signature}`);
		console.log(
			`  (members must approve + execute via Squads UI / CLI before it lands)`
		);
	}
}
