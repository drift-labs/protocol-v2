/**
 * RPC `getTransaction` response → `RawTransaction` converter.
 *
 * Sibling to `yellowstoneToRawTransaction` — same target shape, different
 * source. Used by the replay script to feed historical transactions through
 * the same `extractOperations` / `extractSignerEvents` pipeline as the live
 * Fumarole consumer.
 *
 * Shape notes (vs Yellowstone):
 *  - account keys arrive as `PublicKey` objects (toBase58 to convert)
 *  - top-level v0 instructions use `compiledInstructions` (Uint8Array data,
 *    `accountKeyIndexes` field). Legacy uses `instructions` (base58 data,
 *    `accounts` field).
 *  - inner instructions are always base58 string data + number[] accounts.
 *  - loaded address tables are surfaced via `meta.loadedAddresses`
 *    {writable, readonly} — append in order to the static account list.
 */
import type { PublicKey, VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import type { CompiledInstruction, InnerInstructionSet, RawTransaction } from '../webhook';

export function rpcResponseToRawTransaction(
	signature: string,
	resp: VersionedTransactionResponse
): RawTransaction {
	const message = resp.transaction.message;

	const staticKeys: PublicKey[] =
		'staticAccountKeys' in message
			? message.staticAccountKeys
			: (message as unknown as { accountKeys: PublicKey[] }).accountKeys;

	const writable = resp.meta?.loadedAddresses?.writable ?? [];
	const readonly = resp.meta?.loadedAddresses?.readonly ?? [];
	const accountKeys = [
		...staticKeys.map((k) => k.toBase58()),
		...writable.map((k) => k.toBase58()),
		...readonly.map((k) => k.toBase58()),
	];

	let topLevel: CompiledInstruction[];
	if ('compiledInstructions' in message) {
		// v0 transaction
		topLevel = message.compiledInstructions.map((ix) => ({
			programIdIndex: ix.programIdIndex,
			accounts: Array.from(ix.accountKeyIndexes),
			data: bs58.encode(ix.data),
		}));
	} else {
		// legacy transaction
		const legacy = message as unknown as {
			instructions: { programIdIndex: number; accounts: number[]; data: string }[];
		};
		topLevel = legacy.instructions.map((ix) => ({
			programIdIndex: ix.programIdIndex,
			accounts: ix.accounts,
			data: ix.data,
		}));
	}

	const innerInstructions: InnerInstructionSet[] | undefined = resp.meta?.innerInstructions
		?.length
		? resp.meta.innerInstructions.map((set) => ({
				index: set.index,
				instructions: set.instructions.map((ix) => ({
					programIdIndex: ix.programIdIndex,
					accounts: ix.accounts,
					data: ix.data,
				})),
		  }))
		: undefined;

	return {
		signature,
		slot: resp.slot,
		blockTime: resp.blockTime ?? null,
		transaction: {
			signatures: resp.transaction.signatures,
			message: { accountKeys, instructions: topLevel },
		},
		meta: resp.meta
			? {
					err: resp.meta.err ?? undefined,
					innerInstructions,
					logMessages: resp.meta.logMessages ?? undefined,
			  }
			: null,
	};
}
