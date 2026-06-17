// ---------------------------------------------------------------------------
// RawTransaction boundary type — shared between webhook and gRPC code paths.
// ---------------------------------------------------------------------------

export interface RawTransaction {
	readonly signature?: string;
	readonly slot?: number;
	readonly blockTime?: number | null;
	readonly indexWithinBlock?: number;
	readonly transaction: TransactionEnvelope;
	readonly meta?: TransactionMeta | null;
}

export interface TransactionEnvelope {
	readonly message: TransactionMessage;
	readonly signatures: readonly string[];
}

export interface TransactionMessage {
	readonly accountKeys: readonly AccountKeyEntry[];
	readonly instructions: readonly CompiledInstruction[];
}

export type AccountKeyEntry =
	| string
	| { readonly pubkey: string; readonly signer?: boolean; readonly writable?: boolean };

export interface CompiledInstruction {
	readonly programIdIndex: number;
	readonly accounts: readonly number[];
	readonly data: string;
}

export interface TransactionMeta {
	readonly err?: unknown;
	readonly innerInstructions?: readonly InnerInstructionSet[];
	readonly logMessages?: readonly string[];
}

export interface InnerInstructionSet {
	readonly index: number;
	readonly instructions: readonly CompiledInstruction[];
}
