/**
 * Converts a Yellowstone `SubscribeUpdate` containing a transaction into the
 * `RawTransaction` shape the squads/signer extractors were originally written
 * against (Helius webhook payload). The decoders treat this type as their input
 * boundary, so the rest of the pipeline doesn't need to care about the source.
 *
 * Notes on field shapes:
 *  - signature, account keys, instruction data are raw `Uint8Array` from
 *    Yellowstone; we bs58-encode to match the existing string-typed fields.
 *  - `instruction.accounts` is a `Uint8Array` where each byte is one account
 *    index — convert to `number[]` via `Array.from`.
 *  - For v0 transactions, the full account list is:
 *    `[...message.accountKeys, ...meta.loadedWritableAddresses, ...meta.loadedReadonlyAddresses]`.
 *    Solana orders expanded indices in exactly that sequence.
 */
import type { SubscribeUpdate } from '@triton-one/yellowstone-fumarole';
import bs58 from 'bs58';
import type { CompiledInstruction, InnerInstructionSet, RawTransaction } from '../webhook';

/**
 * Yellowstone's `update.transaction` field. The package barrel doesn't
 * re-export the inner type, so we just pass `SubscribeUpdate` and unwrap
 * inside the function.
 */
export type YellowstoneTransaction = SubscribeUpdate;

export function yellowstoneToRawTransaction(
	update: SubscribeUpdate,
	blockTime: number | null = null
): RawTransaction | null {
	const wrapper = update.transaction;
	if (!wrapper) return null;
	const info = wrapper.transaction;
	if (!info || !info.transaction || !info.transaction.message) return null;

	const slot = Number(wrapper.slot);
	const signature = bs58.encode(info.signature);
	const message = info.transaction.message;

	const staticKeys = message.accountKeys.map((k: Uint8Array) => bs58.encode(k));
	const loadedWritable = (info.meta?.loadedWritableAddresses ?? []).map((k: Uint8Array) =>
		bs58.encode(k)
	);
	const loadedReadonly = (info.meta?.loadedReadonlyAddresses ?? []).map((k: Uint8Array) =>
		bs58.encode(k)
	);
	const accountKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];

	const instructions: CompiledInstruction[] = message.instructions.map(
		(ix: { programIdIndex: number; accounts: Uint8Array; data: Uint8Array }) => ({
			programIdIndex: ix.programIdIndex,
			accounts: Array.from(ix.accounts),
			data: bs58.encode(ix.data),
		})
	);

	const innerInstructions: InnerInstructionSet[] | undefined = info.meta?.innerInstructions
		?.length
		? info.meta.innerInstructions.map(
				(set: {
					index: number;
					instructions: {
						programIdIndex: number;
						accounts: Uint8Array;
						data: Uint8Array;
					}[];
				}) => ({
					index: set.index,
					instructions: set.instructions.map((ix) => ({
						programIdIndex: ix.programIdIndex,
						accounts: Array.from(ix.accounts),
						data: bs58.encode(ix.data),
					})),
				})
		  )
		: undefined;

	return {
		signature,
		slot,
		blockTime,
		transaction: {
			signatures: info.transaction.signatures.map((s: Uint8Array) => bs58.encode(s)),
			message: {
				accountKeys,
				instructions,
			},
		},
		meta: info.meta
			? {
					err: info.meta.err ?? undefined,
					innerInstructions,
					logMessages: info.meta.logMessagesNone ? undefined : info.meta.logMessages,
			  }
			: null,
	};
}
