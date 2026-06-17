/**
 * Layer-2 enrichment: decode CPI args using bundled Anchor IDLs.
 *
 * For each InnerCpi found by enrichLayer1, look up the bundled IDL for the
 * program and use BorshInstructionCoder to decode. CPIs into programs not
 * in the bundled registry are left with `decoded` undefined — the alert
 * still surfaces the program ID, accounts, and (for execute-time enrichment)
 * the Anchor instruction name from program logs.
 *
 * Why no on-chain IDL fallback: the multisig surface is bounded — Drift +
 * Drift Vaults cover the realistic CPI targets. Adding the on-chain path
 * would reintroduce an RPC dependency and a network failure mode for a
 * marginal benefit. If a new program shows up we can't decode, add its IDL
 * to known-idls.ts.
 */
import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { logError, logInfo } from '../log';
import { getKnownIdls } from './known-idls';
import type { DecodedInstruction, DetectedOperation, InnerCpi } from './types';

interface CachedProgram {
	idl: Idl | null;
	coder: BorshInstructionCoder | null;
}

const programCache = new Map<string, CachedProgram>();

export async function decodeOperations(operations: readonly DetectedOperation[]): Promise<void> {
	const targets = operations
		.filter((op) => op.enrichment && op.enrichment.innerCpis.length > 0)
		.flatMap((op) => op.enrichment!.innerCpis);

	if (targets.length === 0) return;

	await Promise.all(
		targets.map(async (cpi) => {
			try {
				const decoded = await decodeOne(cpi);
				if (decoded) cpi.decoded = decoded;
			} catch (e) {
				logError('layer2 decode failed', {
					programId: cpi.programId,
					error: String(e),
				});
			}
		})
	);
}

async function decodeOne(cpi: InnerCpi): Promise<DecodedInstruction | null> {
	const cached = await getCachedProgram(cpi.programId);
	if (!cached.coder) return null;

	let buf: Buffer;
	try {
		buf = Buffer.from(bs58.decode(cpi.dataB58));
	} catch {
		return null;
	}

	let decoded: { name: string; data: unknown } | null;
	try {
		decoded = cached.coder.decode(buf);
	} catch {
		return null;
	}
	if (!decoded) return null;

	return {
		name: decoded.name,
		args: formatArgs(decoded.data),
	};
}

async function getCachedProgram(programId: string): Promise<CachedProgram> {
	const cached = programCache.get(programId);
	if (cached) return cached;

	const known = await getKnownIdls();
	const knownIdl = known.get(programId);
	if (!knownIdl) {
		const empty: CachedProgram = { idl: null, coder: null };
		programCache.set(programId, empty);
		return empty;
	}

	let coder: BorshInstructionCoder | null = null;
	try {
		coder = new BorshInstructionCoder(knownIdl);
		logInfo('idl loaded from bundle', {
			programId,
			instructions: knownIdl.instructions?.length ?? 0,
		});
	} catch (e) {
		logError('bundled idl coder construction failed', {
			programId,
			error: String(e),
		});
	}

	const entry: CachedProgram = { idl: knownIdl, coder };
	programCache.set(programId, entry);
	return entry;
}

function formatArgs(data: unknown): { name: string; value: string }[] {
	if (!data || typeof data !== 'object') return [];
	return Object.entries(data as Record<string, unknown>).map(([name, value]) => ({
		name,
		value: stringifyValue(value),
	}));
}

function stringifyValue(value: unknown): string {
	if (value === null || value === undefined) return String(value);
	if (typeof value === 'bigint') return value.toString();
	if (typeof value !== 'object') return String(value);

	// PublicKey
	if ('toBase58' in value && typeof (value as { toBase58: unknown }).toBase58 === 'function') {
		return (value as { toBase58: () => string }).toBase58();
	}
	// BN
	if (
		'words' in value &&
		'toString' in value &&
		typeof (value as { toString: unknown }).toString === 'function'
	) {
		return (value as { toString: () => string }).toString();
	}
	// Buffer / Uint8Array
	if (value instanceof Uint8Array) {
		return `0x${Buffer.from(value).toString('hex')}`;
	}
	// Plain object / array — JSON stringify with BigInt safety
	try {
		return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
	} catch {
		return '[unserializable]';
	}
}
