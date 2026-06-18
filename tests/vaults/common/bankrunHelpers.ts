import { BN } from '@coral-xyz/anchor';

// Little-endian u64 reader used by the shares-accounting assertions. Ported
// verbatim from drift-vaults' tests/common/bankrunHelpers.ts.
export function readUnsignedBigInt64LE(buffer: Buffer, offset: number): BN {
	return new BN(buffer.subarray(offset, offset + 8), 10, 'le');
}
